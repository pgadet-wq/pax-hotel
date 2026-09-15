/**
 * Étage B — Relevés d'inventaire (CDC §6.3), un agent par hôtel retenu.
 * Session démarrée directement sur la fiche (start_url par overrides), schéma
 * enrichi paiement + cap_reached (EX-REL-4). La substitution (candidat suivant du
 * tier) est décidée ICI, en code — l'agent a interdiction d'essayer un autre hôtel.
 * Robustesse §6.6 : retry × 1 avec rattachement par id de session avant relance.
 */
import { agentNameV2, ensureAgentV2, buildHotelUrl, releveSchema, toReleveAnswer, promptReleve, pumpToCompletion } from "./hai.mjs";
import { slugify } from "./inventaire.mjs";

/** Concurrence effective (§16) : « auto » = maximum du plan H, plafonné à 6. */
export const resolveConcurrency = (policy) =>
  policy.agents.concurrency === "auto" ? 6 : policy.agents.concurrency;

/** Repli §16 sur file d'attente ou 429 : concurrence 3, décalage 25 s. */
export const FALLBACK = { concurrency: 3, staggerMs: 25000 };

const isQueueError = (err) => /429|rate.?limit|file d'attente|queue/i.test(String(err?.message ?? err ?? ""));

/**
 * Relevé d'un hôtel. Retourne un enregistrement d'inventaire pour allocate().
 */
export async function runReleve({ client, policy, station, candidate, tiers = [], checkin, checkout, groupId, emit, signal, attempt = 1 }) {
  const hotelKey = candidate.id ?? slugify(candidate.name);
  const url = candidate.url ? buildHotelUrl(candidate.url, { checkin, checkout }) : null;
  // métriques de la session (coût réel, steps) : dernières valeurs vues sur le flux
  const usage = { steps: 0, costUsd: 0 };
  const scoped = (type, data, extra = {}) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      usage.costUsd = data.cost_usd ?? usage.costUsd;
    }
    return emit(type, data, { hotel_key: hotelKey, ...extra });
  };
  scoped("agent_status", { status: "starting", name: candidate.name, tiers, attempt });

  let handle;
  try {
    await ensureAgentV2(client, station, policy);
    handle = await client.startSession({
      agent: agentNameV2(station),
      messages: promptReleve({ hotelName: candidate.name, hasStartUrl: Boolean(url), checkin, checkout }),
      maxSteps: url ? 45 : 55,
      maxTimeS: 900,
      // idleTimeoutS par défaut (null clôturait la session au moindre passage idle)
      groupId,
      answerSchema: releveSchema,
      ...(url ? { overrides: { "agent.environments[kind=web].start_url": url } } : {}),
    });
  } catch (err) {
    if (attempt < 2 && !signal?.aborted && !isQueueError(err)) {
      scoped("warning", { message: `lancement du relevé en échec (${err?.message ?? err}), nouvelle tentative` });
      return runReleve({ client, policy, station, candidate, tiers, checkin, checkout, groupId, emit, signal, attempt: attempt + 1 });
    }
    return { hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: null, status: "error", outcome: null, error: String(err?.message ?? err), answer: null, queueError: isQueueError(err) };
  }
  scoped("agent_status", { status: "running", name: candidate.name }, { session_id: handle.id });

  let result;
  try {
    result = await pumpToCompletion(handle, (type, data) => scoped(type, data, { session_id: handle.id }), { signal });
  } catch (err) {
    // §6.6 : échec de SUIVI ≠ échec de session — rattachement par id avant toute relance
    scoped("warning", { message: `suivi interrompu (${err?.message ?? err}) — rattachement à la session ${handle.id}` });
    try {
      result = await client.session(handle.id).waitForCompletion({ timeoutMs: 40 * 60 * 1000, answerSchema: releveSchema });
    } catch (err2) {
      if (attempt < 2 && !signal?.aborted) {
        scoped("warning", { message: `rattachement en échec (${err2?.message ?? err2}), nouvelle tentative` });
        return runReleve({ client, policy, station, candidate, tiers, checkin, checkout, groupId, emit, signal, attempt: attempt + 1 });
      }
      return { hotel: hotelKey, hotelKey, name: candidate.name, url, tiers, sessionId: handle.id, status: "error", outcome: null, error: String(err2?.message ?? err2), answer: null };
    }
  }

  let answer = result.answer;
  if (typeof answer === "string") {
    try { answer = JSON.parse(answer); } catch { answer = null; }
  }
  const flat = answer; // réponse plate (schéma releveSchema) — archivée par les probes de la phase 5
  answer = toReleveAnswer(answer, { url: candidate.url ?? "", checkin, checkout, candidate });

  const failedHard = result.status === "failed" && !answer;
  if (failedHard && attempt < 2 && !signal?.aborted) {
    scoped("warning", { message: `relevé en échec (${result.error ?? "sans détail"}), nouvelle tentative` });
    return runReleve({ client, policy, station, candidate, tiers, checkin, checkout, groupId, emit, signal, attempt: attempt + 1 });
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
    steps: usage.steps,
    costUsd: usage.costUsd,
  };
}

/**
 * Relevés d'une sélection : pool de `agents.concurrency` (auto → 6), démarrages
 * échelonnés de `agents.stagger_ms` ; repli automatique 3 / 25 s sur 429 ou file
 * d'attente (§16). `found = false` ou inventaire inexploitable → warning et
 * candidat suivant du tier (EX-REL-3, files `substitutes`). `onInventory` est
 * appelé à chaque relevé terminé (allocation incrémentale, EX-ALL-1).
 */
export async function runReleves({
  client, policy, station, selection, substitutes = {}, checkin, checkout, groupId, emit, signal,
  onInventory = null, runReleveFn = runReleve,
}) {
  const state = {
    concurrency: resolveConcurrency(policy),
    staggerMs: policy.agents.stagger_ms,
    degraded: false,
  };
  const queue = selection.map((s) => ({ candidate: s.candidate ?? s, tiers: s.tiers ?? s.candidate?.tiers ?? [] }));
  const inventories = [];
  const usedNames = new Set(queue.map((q) => q.candidate.name));
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

  async function worker(index) {
    for (;;) {
      if (signal?.aborted) return;
      if (index >= state.concurrency) return; // repli : les travailleurs excédentaires s'arrêtent
      const job = queue.shift();
      if (!job) return;
      const delay = started * state.staggerMs;
      started += 1;
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, state.staggerMs)));

      const inv = await runReleveFn({ client, policy, station, candidate: job.candidate, tiers: job.tiers, checkin, checkout, groupId, emit, signal });
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
      if (!usable && !signal?.aborted) {
        const sub = substituteFor(job.tiers);
        if (sub) {
          emit("warning", {
            message: `« ${job.candidate.name} » sans inventaire exploitable → substitution par « ${sub.candidate.name} » (tier ${sub.tiers.join("/")})`,
          });
          queue.push(sub);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, state.concurrency) }, (_, i) => worker(i)));
  return inventories;
}
