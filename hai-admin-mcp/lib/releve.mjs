/**
 * Étage B — Relevés d'inventaire (CDC §6.3), un agent par hôtel retenu.
 * Session démarrée directement sur la fiche (start_url par overrides), schéma
 * enrichi paiement + cap_reached (EX-REL-4). La substitution (candidat suivant du
 * tier) est décidée ICI, en code — l'agent a interdiction d'essayer un autre hôtel.
 * Robustesse §6.6 : retry × 1 avec rattachement par id de session avant relance.
 * Bornes C2/C5 : les lignes de chambres invraisemblables sont écartées par le
 * convertisseur (avertissement nommé par ligne), et tout le suivi — première attente
 * comme rattachement — tient dans le résiduel d'horloge du run quand l'appelant le passe.
 */
import {
  agentNameV2, ensureAgentV2, buildHotelUrl, releveSchema, toReleveAnswer, promptReleve,
  pumpToCompletion, budgetRestantMs, resolvePumpTimeout,
} from "./hai.mjs";
import { slugify } from "./inventaire.mjs";

/** Plafond de concurrence du CDC §16 — la politique ne va pas au-delà (schéma : max 6). */
export const CONCURRENCE_PLAFOND = 6;

/**
 * Concurrence retenue pour « auto » SANS interroger le plan : un REPLI, pas une
 * mesure. Le maximum réel du plan se lit par `resolveConcurrencyLive` (un appel
 * quota) ; ici, hors ligne ou sans client, on assume le plafond du CDC.
 */
export const CONCURRENCE_AUTO_REPLI = CONCURRENCE_PLAFOND;

/**
 * Concurrence effective (§16), version synchrone : « auto » → repli documenté.
 * Conservée telle quelle pour les appelants qui n'ont pas de client (pipeline, capacité).
 */
export const resolveConcurrency = (policy) =>
  policy.agents.concurrency === "auto" ? CONCURRENCE_AUTO_REPLI : policy.agents.concurrency;

/**
 * Concurrence effective MESURÉE : quand la politique dit « auto », interroge le quota
 * de sessions concurrentes du plan H (`client.sessions.getSessionQuota()`, lecture
 * seule, aucune session lancée) et retient `min(limite du plan, plafond §16)`.
 * Tout échec — client factice, méthode absente, réseau — retombe sur le repli avec
 * un avertissement : on ne prétend jamais avoir mesuré ce qu'on n'a pas mesuré.
 *
 * @param {object} policy
 * @param {object} client client H (ou factice)
 * @param {{emit?: ((type: string, data: object) => void)|null}} [opts]
 * @returns {Promise<{concurrency: number, source: "politique"|"plan"|"repli", quota: object|null}>}
 */
export async function resolveConcurrencyLive(policy, client, { emit = null } = {}) {
  if (policy.agents.concurrency !== "auto") {
    return { concurrency: policy.agents.concurrency, source: "politique", quota: null };
  }
  try {
    const quota = await client?.sessions?.getSessionQuota?.();
    const limite = Number(quota?.limit);
    if (!Number.isFinite(limite) || limite < 1) throw new Error(`quota illisible (${JSON.stringify(quota ?? null)})`);
    const concurrency = Math.max(1, Math.min(Math.floor(limite), CONCURRENCE_PLAFOND));
    emit?.("log", {
      message:
        `concurrence « auto » : plan H ${limite} session(s) simultanée(s)` +
        `${Number.isFinite(Number(quota?.available)) ? `, ${quota.available} libre(s)` : ""} → ${concurrency} (plafond §16 ${CONCURRENCE_PLAFOND})`,
    });
    return { concurrency, source: "plan", quota: quota ?? null };
  } catch (err) {
    emit?.("warning", {
      message: `quota de sessions du plan non lisible (${err?.message ?? err}) — repli sur la concurrence ${CONCURRENCE_AUTO_REPLI}`,
    });
    return { concurrency: CONCURRENCE_AUTO_REPLI, source: "repli", quota: null };
  }
}

/** C5 — sous ce résiduel, lancer une session payante ne peut plus produire de relevé. */
export const MIN_DEMARRAGE_MS = 120_000;

/** Budget serveur d'une session de relevé (s) — sert aussi de borne au suivi. */
export const RELEVE_MAX_TIME_S = 900;

/** Repli §16 sur file d'attente ou 429 : concurrence 3, décalage 25 s. */
export const FALLBACK = { concurrency: 3, staggerMs: 25000 };

const isQueueError = (err) => /429|rate.?limit|file d'attente|queue/i.test(String(err?.message ?? err ?? ""));

/**
 * Relevé d'un hôtel. Retourne un enregistrement d'inventaire pour allocate().
 *
 * C5 : `deadlineAt` (échéance absolue du run, epoch ms) ou `budgetRemainingMs`
 * (résiduel, converti en échéance dès l'entrée pour qu'il décroisse) bornent le suivi
 * ET interdisent de lancer une session qui ne pourrait plus finir — statut
 * `skipped_budget`. Sans l'un ni l'autre, comportement inchangé.
 * `queue` (défaut : absent, donc défaut plateforme) décide si une session acceptée
 * au-dessus du quota attend en file au lieu de rendre un 429.
 *
 * @param {{client: object, policy: object, station: object, candidate: object, tiers?: string[],
 *          checkin: string, checkout: string, groupId?: string,
 *          emit: (type: string, data: object, meta?: object) => void, signal?: AbortSignal,
 *          attempt?: number, deadlineAt?: number|null, budgetRemainingMs?: number|null,
 *          queue?: boolean|null}} args
 */
export async function runReleve({
  client, policy, station, candidate, tiers = [], checkin, checkout, groupId, emit, signal, attempt = 1,
  deadlineAt = null, budgetRemainingMs = null, queue = null,
}) {
  const hotelKey = candidate.id ?? slugify(candidate.name);
  // C5 : un résiduel est une PHOTO ; figé en échéance absolue dès l'entrée, il décroît
  // pour de bon — sinon la deuxième tentative, le rattachement et la pompe repartiraient
  // tous les trois avec le même « il reste 20 minutes », et la borne ne bornerait rien.
  const echeance = Number.isFinite(deadlineAt)
    ? deadlineAt
    : Number.isFinite(budgetRemainingMs)
      ? Date.now() + budgetRemainingMs
      : null;
  const suite = (n) => ({
    client, policy, station, candidate, tiers, checkin, checkout, groupId, emit, signal,
    attempt: n, deadlineAt: echeance, budgetRemainingMs: null, queue,
  });
  const url = candidate.url ? buildHotelUrl(candidate.url, { checkin, checkout }) : null;
  // métriques de la session (coût réel, steps) : dernières valeurs vues sur le flux
  // `costUsd: null` = session lancee dont la plateforme n'a PAS rapporte de cout.
  // Zero serait un mensonge : la session facture, le budget du run ne peut plus etre controle.
  const usage = { steps: 0, costUsd: null };
  const scoped = (type, data, extra = {}) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      // seule une mesure remplace la precedente : une absence ne ramene pas le total a 0
      if (typeof data.cost_usd === "number" && Number.isFinite(data.cost_usd)) usage.costUsd = data.cost_usd;
    }
    return emit(type, data, { hotel_key: hotelKey, ...extra });
  };
  scoped("agent_status", { status: "starting", name: candidate.name, tiers, attempt });

  // C5 : pas de session payante avec un résiduel qui ne permet plus de la mener à bout
  const restantMs = budgetRestantMs({ deadlineAt: echeance });
  if (restantMs !== null && restantMs < MIN_DEMARRAGE_MS) {
    scoped("warning", {
      message: `budget d'horloge du run épuisé (${Math.max(0, Math.round(restantMs / 1000))} s) — relevé de « ${candidate.name} » non lancé`,
    });
    scoped("agent_status", { status: "skipped", reason: "budget" });
    return {
      hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: null,
      status: "skipped_budget", outcome: null, error: "budget d'horloge du run épuisé", answer: null,
    };
  }

  let handle;
  try {
    await ensureAgentV2(client, station, policy);
    handle = await client.startSession({
      agent: agentNameV2(station),
      messages: promptReleve({ hotelName: candidate.name, hasStartUrl: Boolean(url), checkin, checkout }),
      maxSteps: url ? 45 : 55,
      maxTimeS: RELEVE_MAX_TIME_S,
      // idleTimeoutS par défaut (null clôturait la session au moindre passage idle)
      groupId,
      answerSchema: releveSchema,
      // `queue` absent = défaut de la plateforme, qui n'est pas documenté : le SDK dit
      // seulement que `false` rend un 429 immédiat au lieu d'attendre un créneau
      // (index.d.ts L2272). Une session en file consomme du temps d'horloge sans le dire,
      // donc l'option est exposée ici ; le défaut reste l'actuel tant que ce n'est pas
      // observé sur un run réel (statut `queued` dans le flux).
      ...(queue === null || queue === undefined ? {} : { queue }),
      ...(url ? { overrides: { "agent.environments[kind=web].start_url": url } } : {}),
    });
  } catch (err) {
    if (attempt < 2 && !signal?.aborted && !isQueueError(err)) {
      scoped("warning", { message: `lancement du relevé en échec (${err?.message ?? err}), nouvelle tentative` });
      return runReleve(suite(attempt + 1));
    }
    return { hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: null, status: "error", outcome: null, error: String(err?.message ?? err), answer: null, queueError: isQueueError(err) };
  }
  scoped("agent_status", { status: "running", name: candidate.name }, { session_id: handle.id });

  let result;
  try {
    result = await pumpToCompletion(handle, (type, data) => scoped(type, data, { session_id: handle.id }), {
      signal, maxTimeS: RELEVE_MAX_TIME_S, deadlineAt: echeance,
    });
  } catch (err) {
    // §6.6 : échec de SUIVI ≠ échec de session — rattachement par id avant toute relance,
    // mais sur le RÉSIDUEL du run : le rattachement attendait 40 min de plus, soit bien
    // au-delà du budget entier (C5).
    const rattrapage = resolvePumpTimeout({ maxTimeS: RELEVE_MAX_TIME_S, deadlineAt: echeance });
    if (rattrapage.exhausted) {
      scoped("warning", { message: `suivi interrompu (${err?.message ?? err}) — budget épuisé, session ${handle.id} abandonnée` });
      Promise.resolve(handle.cancel?.()).catch(() => {});
      return { hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: handle.id, status: "error", outcome: null, error: `budget d'horloge épuisé après ${err?.message ?? err}`, answer: null };
    }
    scoped("warning", {
      message: `suivi interrompu (${err?.message ?? err}) — rattachement à la session ${handle.id} (${Math.round(rattrapage.timeoutMs / 1000)} s)`,
    });
    try {
      result = await client.session(handle.id).waitForCompletion({ timeoutMs: rattrapage.timeoutMs, answerSchema: releveSchema });
    } catch (err2) {
      if (attempt < 2 && !signal?.aborted) {
        scoped("warning", { message: `rattachement en échec (${err2?.message ?? err2}), nouvelle tentative` });
        return runReleve(suite(attempt + 1));
      }
      return { hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: handle.id, status: "error", outcome: null, error: String(err2?.message ?? err2), answer: null };
    }
  }

  let answer = result.answer;
  if (typeof answer === "string") {
    try { answer = JSON.parse(answer); } catch { answer = null; }
  }
  const flat = answer; // réponse plate (schéma releveSchema) — archivée par les probes de la phase 5
  // C2 : les lignes invraisemblables (prix nul ou négatif, quantité hallucinée) sont
  // écartées ICI, avant que le tri croissant de l'allocation ne les PRÉFÈRE.
  answer = toReleveAnswer(answer, { url: candidate.url ?? "", checkin, checkout, candidate, policy });
  for (const message of answer?.quality_warnings ?? []) scoped("warning", { message });

  const failedHard = result.status === "failed" && !answer;
  if (failedHard && attempt < 2 && !signal?.aborted) {
    scoped("warning", { message: `relevé en échec (${result.error ?? "sans détail"}), nouvelle tentative` });
    return runReleve(suite(attempt + 1));
  }

  scoped("agent_status", {
    status: result.status === "failed" ? "failed" : "done",
    outcome: result.outcome ?? null,
    found: answer?.found ?? false,
    rooms: answer?.rooms?.length ?? 0,
  });
  return {
    hotel: hotelKey,
    hotelKey,
    name: candidate.name,
    url,
    tiers,
    sessionId: handle.id,
    status: result.status,
    outcome: result.outcome ?? null,
    error: result.error ?? null,
    answer,
    flat,
    // C2 — trace des lignes écartées, pour le rapport et l'escalade (vide si tout est sain)
    roomsRejected: answer?.rooms_rejected ?? [],
    // C2 — lignes gardées mais dont la quantité dépasse la borne : c'est l'allocation
    // qui les ramènera au plafond de prudence, le rapport doit pouvoir le dire
    roomsOverCap: answer?.rooms_over_cap ?? [],
    steps: usage.steps,
    costUsd: usage.costUsd,
  };
}

/**
 * Relevés d'une sélection : pool de `agents.concurrency` (« auto » = quota du plan,
 * plafonné §16, repli documenté si le quota n'est pas lisible), démarrages
 * échelonnés de `agents.stagger_ms` ; repli automatique 3 / 25 s sur 429 ou file
 * d'attente (§16). `found = false` ou inventaire inexploitable → warning et
 * candidat suivant du tier (EX-REL-3, files `substitutes`). `onInventory` est
 * appelé à chaque relevé terminé (allocation incrémentale, EX-ALL-1).
 *
 * C5 : `deadlineAt` / `budgetRemainingMs` bornent le pool ; le résiduel est converti
 * UNE fois en échéance absolue, c'est elle qui est transmise aux relevés (`deadlineAt`).
 * Le pool s'arrête de lui-même quand l'échéance du run est atteinte (`skipped_budget`).
 * Sans budget passé, comportement inchangé. `sessionQueue` (booléen, défaut : absent)
 * est relayé tel quel à `startSession` : rien à voir avec la file de travail locale.
 */
export async function runReleves({
  client, policy, station, selection, substitutes = {}, checkin, checkout, groupId, emit, signal,
  onInventory = null, runReleveFn = runReleve, deadlineAt = null, budgetRemainingMs = null, sessionQueue = null,
}) {
  const mesure = await resolveConcurrencyLive(policy, client, { emit });
  // même règle qu'en relevé : le résiduel devient une échéance absolue, une fois, ici —
  // c'est elle qui est transmise aux relevés, pour qu'elle décroisse vraiment (C5)
  const echeance = Number.isFinite(deadlineAt)
    ? deadlineAt
    : Number.isFinite(budgetRemainingMs)
      ? Date.now() + budgetRemainingMs
      : null;
  const state = {
    concurrency: mesure.concurrency,
    staggerMs: policy.agents.stagger_ms,
    degraded: false,
  };
  // file de TRAVAIL (à ne pas confondre avec `sessionQueue`, la mise en file côté plateforme)
  const jobs = selection.map((s) => ({ candidate: s.candidate ?? s, tiers: s.tiers ?? s.candidate?.tiers ?? [] }));
  const inventories = [];
  const usedNames = new Set(jobs.map((q) => q.candidate.name));
  let started = 0;

  const degrade = (why) => {
    if (state.degraded) return;
    state.degraded = true;
    state.concurrency = FALLBACK.concurrency;
    state.staggerMs = FALLBACK.staggerMs;
    emit("warning", { message: `file d'attente/429 détecté (${why}) — repli concurrence ${FALLBACK.concurrency}, décalage ${FALLBACK.staggerMs / 1000} s` });
  };

  const substituteFor = (tiers) => {
    for (const tier of tiers) {
      const next = (substitutes[tier] ?? []).find((c) => !usedNames.has(c.name));
      if (next) {
        usedNames.add(next.name);
        return { candidate: next, tiers: [tier] };
      }
    }
    return null;
  };

  // C5 : à l'échéance du run, le pool s'arrête au lieu d'aligner des relevés mort-nés ;
  // les hôtels non lancés sont dits UNE fois, avec leur nom.
  let budgetEpuise = false;
  const budgetRestant = () => budgetRestantMs({ deadlineAt: echeance });
  const stopSiBudgetEpuise = () => {
    const restant = budgetRestant();
    if (restant === null || restant >= MIN_DEMARRAGE_MS) return false;
    if (!budgetEpuise) {
      budgetEpuise = true;
      const nonLances = jobs.map((j) => j.candidate.name);
      emit("warning", {
        message:
          `budget d'horloge du run épuisé (${Math.max(0, Math.round(restant / 1000))} s) — ` +
          `${nonLances.length} relevé(s) non lancé(s)${nonLances.length ? ` : ${nonLances.join(", ")}` : ""}`,
      });
    }
    return true;
  };

  async function worker(index) {
    for (;;) {
      if (signal?.aborted) return;
      if (index >= state.concurrency) return; // repli : les travailleurs excédentaires s'arrêtent
      if (stopSiBudgetEpuise()) return;
      const job = jobs.shift();
      if (!job) return;
      const delay = started * state.staggerMs;
      started += 1;
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, state.staggerMs)));

      const inv = await runReleveFn({
        client, policy, station, candidate: job.candidate, tiers: job.tiers, checkin, checkout, groupId, emit, signal,
        deadlineAt: echeance, budgetRemainingMs: null, queue: sessionQueue,
      });
      if (inv.queueError) degrade(inv.error ?? "429");
      inventories.push(inv);
      if (onInventory) {
        try {
          onInventory(inv, inventories);
        } catch {
          /* l'affichage incrémental ne doit jamais casser le run */
        }
      }
      const usable = inv.answer?.found && (inv.answer.rooms ?? []).some((r) => r.price_per_night > 0);
      // un relevé non lancé faute de temps n'appelle pas de substitut : le substitut
      // manquerait de temps lui aussi (C5)
      if (!usable && !signal?.aborted && inv.status !== "skipped_budget") {
        const sub = substituteFor(job.tiers);
        if (sub) {
          emit("warning", {
            message: `« ${job.candidate.name} » sans inventaire exploitable → substitution par « ${sub.candidate.name} » (tier ${sub.tiers.join("/")})`,
          });
          jobs.push(sub);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, state.concurrency) }, (_, i) => worker(i)));
  return inventories;
}
