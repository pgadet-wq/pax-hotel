/**
 * Étage C — Extension au plafond d'affichage (CDC §6.4).
 * `detectCap` et `planExtension` sont PURS : la boucle d'extension du pipeline
 * les rejoue à chaque vague. `runProbe` lance la sonde de capacité (EX-EXT-1,
 * H-3 : paramètres no_rooms/group_adults à confirmer en phase 5 ; désactivable
 * par `extension.probe_same_hotel_first = false`).
 *
 * COURONNES — une sonde n'a pas la même valeur selon l'endroit où elle porte : sonder un
 * hôtel PROCHE débloque des dossiers que personne d'autre ne peut servir (ceux dont le
 * budget de trajet interdit les couronnes lointaines), alors que sonder un hôtel à 40 km
 * ne rend que des chambres déjà disponibles pour les dossiers sans contrainte. À budget
 * de sessions égal, la sonde qui libère des chambres CAPTIVES passe la première.
 */
import { agentNameV2, ensureAgentV2, buildProbeUrl, probeSchema, promptProbe, pumpToCompletion, budgetRestantMs } from "./hai.mjs";
import { effectiveCaps } from "./policy.mjs";
import { couronnesDe } from "./stations.mjs";
import { couronneDeCandidat } from "./discovery.mjs";
import { resolveConcurrency, MIN_DEMARRAGE_MS } from "./releve.mjs";

/** Budget serveur d'une sonde (s) — une page, un sélecteur : bien plus court qu'un relevé. */
export const PROBE_MAX_TIME_S = 400;

/**
 * Types de chambres d'un relevé dont l'affichage est plafonné et non encore sondé.
 * @returns {Array<{room_type, quantity, price_per_night}>}
 */
export function detectCap(answer) {
  if (!answer?.found) return [];
  return (answer.rooms ?? [])
    .filter((r) => r.cap_reached === true && (r.rooms_available_max === undefined || r.rooms_available_max === null))
    .map((r) => ({
      room_type: r.room_type,
      quantity: r.quantity_available ?? r.quantity_displayed_max ?? 0,
      price_per_night: r.price_per_night,
    }));
}

/**
 * Planification PURE d'une vague d'extension (bornes H-2 : vagues, sessions, coût).
 *
 * @param {object} args
 * @param {object} args.gaps `{chambresManquantes: {tier: n}, couchagesManquants?: {tier: n}}` (sortie d'allocate)
 * @param {Array} args.inventories relevés effectués (records {hotelKey, name, url, answer})
 * @param {Array} args.candidates sortie de candidatesFrom (ordonnée, `tiers` par candidat)
 * @param {Set<string>} args.surveyedKeys hotelKey déjà relevés
 * @param {Set<string>} args.probedKeys hotelKey déjà sondés
 * @param {number} args.wave numéro de vague (1..)
 * @param {number} args.sessionsUsed sessions consommées par l'extension
 * @param {number} args.costUsd coût agrégé du run
 * @param {number} [args.minutesUsed] horloge du run, en minutes (borne C5 `max_minutes_per_run`) ;
 *   0 par défaut : sans horloge fournie, l'extension ne s'arrête jamais sur ce critère
 * @param {boolean} [args.couvrirCouchages] compter aussi `gaps.couchagesManquants` comme un
 *   manque à couvrir (défaut false : comportement actuel, l'extension ne poursuit que les
 *   dossiers SANS chambre)
 * @param {Array|null} [args.parCouronne] ventilation par couronne
 *   (`discoveryNeeded().couverture.parCouronne`) : elle dit, couronne par couronne, combien
 *   de chambres CAPTIVES manquent. ADDITIVE — absente, l'ordre des sondes et des relevés est
 *   exactement celui d'avant les couronnes.
 * @returns {{stop: boolean, reason: string, probes: Array, surveys: Array, limits: object,
 *   exhausted?: boolean, rediscover?: boolean}} chaque sonde et chaque relevé porte en plus
 *   `couronne` (rang) et `valeur_captive` : les chambres captives que cette session peut
 *   libérer, et que rien d'autre ne libérera.
 */
export function planExtension({
  gaps, inventories = [], candidates = [], surveyedKeys = new Set(), probedKeys = new Set(),
  policy, station = null, wave, sessionsUsed = 0, costUsd = 0, allowProbes = true,
  minutesUsed = 0, couvrirCouchages = false, parCouronne = null,
}) {
  const ext = policy.extension;
  const limits = {
    sessions_used: sessionsUsed, sessions_max: ext.max_sessions_per_run,
    cost_usd: Math.round(costUsd * 100) / 100, cost_max: ext.max_cost_usd_per_run,
    wave, max_waves: ext.max_waves,
    minutes_used: Math.round(minutesUsed * 10) / 10, minutes_max: ext.max_minutes_per_run ?? null,
  };
  // manques : dossiers SANS chambre, plus (sur demande) les dossiers logés dont les
  // couchages ne suffisent pas — un lit manquant est un manque, pas un détail
  const besoins = {};
  for (const [tier, n] of Object.entries(gaps?.chambresManquantes ?? {})) besoins[tier] = (besoins[tier] ?? 0) + n;
  if (couvrirCouchages) {
    for (const [tier, n] of Object.entries(gaps?.couchagesManquants ?? {})) besoins[tier] = (besoins[tier] ?? 0) + n;
  }
  const manques = Object.entries(besoins).filter(([, n]) => n > 0);
  const done = (reason, extra = {}) => ({ stop: true, reason, probes: [], surveys: [], limits, ...extra });
  if (!manques.length) return done("couvert : aucun manque");
  if (!ext.enabled) return done("extension désactivée");
  if (wave > ext.max_waves) return done(`borne atteinte : max_waves (${ext.max_waves})`);
  if (sessionsUsed >= ext.max_sessions_per_run) return done(`borne atteinte : max_sessions_per_run (${ext.max_sessions_per_run})`);
  // Un coût non mesuré n'est pas un budget disponible : sans chiffre, la borne
  // `max_cost_usd_per_run` ne peut plus se déclencher — on arrête plutôt que de courir sans frein.
  if (costUsd === null) return done("coût des sessions NON MESURÉ par la plateforme — budget non contrôlable, extension arrêtée");
  if (costUsd >= ext.max_cost_usd_per_run) return done(`borne atteinte : max_cost_usd_per_run (${ext.max_cost_usd_per_run} $)`);
  if (Number.isFinite(ext.max_minutes_per_run) && minutesUsed >= ext.max_minutes_per_run) {
    return done(`borne atteinte : max_minutes_per_run (${ext.max_minutes_per_run} min)`);
  }

  const caps = effectiveCaps(policy, station);
  const needyTiers = manques.map(([tier]) => tier);
  const missingTotal = manques.reduce((s, [, n]) => s + n, 0);
  let budget = ext.max_sessions_per_run - sessionsUsed;

  /* COURONNES — de quoi classer une session par ce qu'elle DÉBLOQUE, pas seulement par
   * son volume. `manque_captif` d'une couronne = les chambres qui doivent rester à sa
   * portée et que le stock connu à cette portée ne couvre pas : aucune couronne plus
   * lointaine ne les logera. Sans ventilation fournie, tout vaut 0 et l'ordre ne bouge pas. */
  const { couronnes } = couronnesDe(station);
  const refStation = station?.search?.distance_ref ?? null;
  const manqueCaptif = new Map((parCouronne ?? []).map((l) => [l.rang, Math.max(0, Number(l.manque_captif) || 0)]));
  const discriminer = manqueCaptif.size > 0 && [...manqueCaptif.values()].some((n) => n > 0);
  /** Rang de couronne d'un hôtel, MÊME RÈGLE qu'à l'allocation (passe → distance → prudence). */
  const rangDeHotel = (x) => (couronnes.length ? couronneDeCandidat(x, couronnes, refStation).rang : null);
  /** Chambres captives qu'une session sur cet hôtel peut libérer — 0 si sa couronne n'est pas le point de pincement. */
  const valeurCaptive = (rang, volume) => (rang === null ? 0 : Math.min(volume, manqueCaptif.get(rang) ?? 0));

  // 1) sondes : hôtels relevés avec cap_reached sur un type compatible avec un tier
  //    en manque (prix sous le plafond effectif du tier), non encore sondés (EX-EXT-1)
  const probes = [];
  if (ext.probe_same_hotel_first && allowProbes) {
    const candidatsSonde = [];
    for (const inv of inventories) {
      const key = inv.hotelKey ?? inv.hotel;
      if (probedKeys.has(key)) continue;
      const capped = detectCap(inv.answer).filter((room) => needyTiers.some((tier) => room.price_per_night <= caps[tier]));
      if (!capped.length) continue;
      const rang = rangDeHotel(inv);
      const gain = capped.reduce((n, room) => n + (Number(room.quantity) > 0 ? Number(room.quantity) : 1), 0);
      candidatsSonde.push({
        probe: {
          hotelKey: key,
          name: inv.name ?? inv.answer.hotel,
          url: inv.answer.url ?? inv.url ?? "",
          room_types: capped.map((room) => room.room_type),
          requested_rooms: Math.min(missingTotal, ext.probe_no_rooms_max),
          couronne: rang,
          valeur_captive: valeurCaptive(rang, gain),
        },
        // Gain attendu = VOLUME DE NIVEAU 2 de cet hôtel (C2) : les chambres adossées à un
        // sélecteur plafonné, donc planifiables mais « à confirmer ». Sonder cet hôtel les
        // fait passer en niveau 1 (fermes) : c'est là que la dépense d'agent rapporte le
        // plus, et c'est pourquoi les hôtels les plus porteurs de niveau 2 passent d'abord.
        // Un type plafonné SANS quantité affichée compte pour 1 (et non 0) : il est non
        // mesuré lui aussi, l'ignorer reviendrait à ne jamais sonder un hôtel qui n'affiche
        // aucun nombre — exactement celui dont le plan est le plus incertain.
        gain,
        types: capped.length,
        captif: valeurCaptive(rang, gain),
      });
    }
    // COURONNES d'abord : une sonde qui libère des chambres CAPTIVES sert des dossiers que
    // rien d'autre ne servira. À valeur captive égale (ou nulle, faute de budgets connus),
    // l'ordre est celui d'avant : volume de niveau 2, puis nombre de TYPES plafonnés —
    // une seule sonde y débloque le plus grand nombre de lignes de stock.
    candidatsSonde.sort((a, b) => b.captif - a.captif || b.gain - a.gain || b.types - a.types);
    for (const c of candidatsSonde.slice(0, Math.max(0, budget))) probes.push(c.probe);
  }
  budget -= probes.length;

  // 2) candidats suivants non relevés, compatibles avec les tiers en manque,
  //    par lots de batch_size (« auto » = concurrence effective, §16)
  const batch = ext.batch_size === "auto" ? resolveConcurrency(policy) : ext.batch_size;
  const retenus = candidates.filter((c) => !surveyedKeys.has(c.id) && c.tiers.some((tier) => needyTiers.includes(tier)));
  let surveys;
  if (!discriminer) {
    surveys = retenus.slice(0, Math.max(0, Math.min(batch, budget)));
  } else {
    // un candidat non relevé n'a pas de volume connu : sa valeur captive se juge sur le
    // seul manque de sa couronne, jamais sur un stock qu'aucun relevé n'a vu.
    // `couronne_jugee` n'est PAS `couronne` : c'est le rang déduit (passe, distance ou
    // règle de prudence), pas une affirmation de la recherche — l'allocation ne le lit pas.
    const notes = retenus.map((c) => {
      const rang = rangDeHotel(c);
      return { candidate: c, rang, valeur: rang === null ? 0 : manqueCaptif.get(rang) ?? 0 };
    });
    // relever un hôtel PROCHE d'abord quand c'est là que les chambres manquent : le tri est
    // STABLE, donc à valeur égale l'ordre de `candidatesFrom` (contracté, préféré, score) tient
    notes.sort((a, b) => b.valeur - a.valeur);
    surveys = notes
      .slice(0, Math.max(0, Math.min(batch, budget)))
      .map((e) => ({ ...e.candidate, couronne_jugee: e.rang, valeur_captive: e.valeur }));
  }

  // épuisement : ce qui manque, ce sont des HÔTELS, pas du budget. `rediscover` dit à
  // l'appelant s'il doit relancer une découverte élargie (C2) plutôt que s'arrêter là.
  if (!probes.length && !surveys.length) {
    return done("épuisé : plus de sonde possible ni de candidat à relever", {
      exhausted: true,
      rediscover: ext.rediscover_on_exhaustion === true,
      manques: Object.fromEntries(manques),
    });
  }
  return { stop: false, reason: "gaps", probes, surveys, limits };
}

/**
 * Applique le résultat d'une sonde (EX-ALL-5). Non mutant — retourne une copie.
 *
 * `rooms_selectable_max` est le maximum sélectionnable observé POUR L'HÔTEL, pas par
 * type de chambre : le recopier sur chaque type plafonné multiplierait la capacité
 * par le nombre de types (mesuré : un hôtel à 23 chambres réelles et 3 types
 * plafonnés en déclarait 90, et le plan affichait des chambres qui n'existent pas).
 * Il est donc posé comme PLAFOND D'HÔTEL (`rooms_available_max_hotel`), que
 * l'allocation applique au TOTAL pris chez cet hôtel ; les types plafonnés reçoivent
 * la borne pour ne plus être bloqués à leur quantité affichée.
 */
export function applyProbeResult(inventories, hotelKey, probeAnswer, { emit = null, maxPlausible = null, policy = null } = {}) {
  // Seuil de vraisemblance : celui que l'appelant fournit, sinon `room_qty_sane_max`
  // de la politique quand elle est passee, sinon le plafond historique.
  const nombre = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const seuil = nombre(maxPlausible) ?? nombre(policy?.extension?.room_qty_sane_max) ?? 50;
  let max = probeAnswer?.found ? probeAnswer.rooms_selectable_max : -1;
  // Un agent web peut confondre un prix, un nombre d'avis ou un numero de chambre avec
  // un nombre de chambres. Le selecteur Booking peut legitimement afficher plus que le
  // nombre demande, mais jamais des centaines : on borne au plafond configure.
  if (max > seuil) {
    emit?.("warning", {
      message: `sonde invraisemblable sur « ${probeAnswer.hotel ?? hotelKey} » : ${max} chambres selectionnables annoncees — valeur ramenee a ${seuil} (plafond de sonde)`,
    });
    max = seuil;
  }
  // `cap_reached` porte toute la semantique : selecteur ENCORE plafonne = borne BASSE
  // (l'hotel en a au moins `max`) ; selecteur non plafonne = mesure FERME (il n'en a
  // pas plus). Confondre les deux, c'est promettre des chambres qui n'existent pas.
  const borneFerme = probeAnswer?.cap_reached === false;
  return inventories.map((inv) => {
    if ((inv.hotelKey ?? inv.hotel) !== hotelKey || !inv.answer?.found || max < 0) return inv;
    return {
      ...inv,
      answer: {
        ...inv.answer,
        rooms_available_max_hotel: max,
        rooms_probe_ferme: borneFerme,
        rooms_probe_demande: Number.isFinite(Number(probeAnswer?.requested_rooms)) ? Number(probeAnswer.requested_rooms) : null,
        rooms: inv.answer.rooms.map((r) =>
          r.cap_reached && r.rooms_available_max == null ? { ...r, rooms_available_max: max, rooms_max_is_hotel_cap: true } : r,
        ),
      },
    };
  });
}

/**
 * Sonde de capacité : session courte sur la fiche hôtel à `no_rooms = n`,
 * `group_adults = 2 × n` (H-3). Une sonde ne substitue jamais un hôtel : l'agent
 * reçoit une URL et un nombre de chambres, rien d'autre (EX-EXT-5).
 *
 * C5 : `deadlineAt` (échéance absolue du run, epoch ms) ou `budgetRemainingMs` bornent
 * le suivi ET interdisent de lancer une sonde qui ne pourrait plus finir. `maxTimeS`
 * (défaut `PROBE_MAX_TIME_S`) est le budget serveur, relayé au suivi : le défaut
 * historique de la pompe (15 min) dépassait à lui seul la durée de la sonde.
 *
 * CONTRAT DE RETOUR (lu par la boucle d'extension du pipeline) :
 * - objet avec `started === false` → aucune session n'a été lancée : ni coût, ni
 *   session consommée, et l'hôtel n'est PAS définitivement réputé sondé ;
 * - objet avec `started === true` → une session a tourné (`found` dit si elle a
 *   conclu), `costUsd` porte son coût réel ;
 * - `null` n'est plus rendu : un échec rend un objet nommé, jamais une absence muette.
 *
 * @param {{deadlineAt?: number|null, budgetRemainingMs?: number|null, maxTimeS?: number}} args
 */
export async function runProbe({
  client, policy, station, probe, checkin, checkout, groupId, emit, signal,
  deadlineAt = null, budgetRemainingMs = null, maxTimeS = PROBE_MAX_TIME_S,
}) {
  // `costUsd: null` = session lancee dont la plateforme n'a PAS rapporte de cout.
  // Zero serait un mensonge : la session facture, le budget du run ne peut plus etre controle.
  const usage = { steps: 0, costUsd: null };
  const scoped = (type, data, extra = {}) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      // seule une mesure remplace la precedente : une absence ne ramene pas le total a 0
      if (typeof data.cost_usd === "number" && Number.isFinite(data.cost_usd)) usage.costUsd = data.cost_usd;
    }
    return emit(type, data, { hotel_key: probe.hotelKey, ...extra });
  };
  if (!probe.url) {
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "skipped_no_url" });
    // sans URL, aucune sonde ne réussira jamais sur cet hôtel : définitif, mais gratuit
    return { hotel: probe.hotelKey, found: false, started: false, definitif: true, status: "skipped_no_url", costUsd: 0 };
  }

  // C5 : pas de session payante avec un résiduel qui ne permet plus de la mener à bout.
  // L'échéance est figée une fois ici quand l'appelant n'a donné qu'un résiduel.
  const echeance = Number.isFinite(deadlineAt)
    ? deadlineAt
    : Number.isFinite(budgetRemainingMs)
      ? Date.now() + budgetRemainingMs
      : null;
  const restantMs = budgetRestantMs({ deadlineAt: echeance });
  if (restantMs !== null && restantMs < MIN_DEMARRAGE_MS) {
    scoped("warning", {
      message: `budget d'horloge du run épuisé (${Math.max(0, Math.round(restantMs / 1000))} s) — sonde de « ${probe.name ?? probe.hotelKey} » non lancée`,
    });
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "skipped_budget" });
    return { hotel: probe.hotelKey, found: false, started: false, definitif: false, status: "skipped_budget", costUsd: 0 };
  }
  const url = buildProbeUrl(probe.url, { checkin, checkout, noRooms: probe.requested_rooms });
  scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "starting" });

  // §16 : sonde = tâche courte, une page → modèle rapide (classe flash), par override
  // de session — l'agent v2 garde le modèle A/B pour la découverte et les relevés.
  const modelProbe = policy?.agents?.model_probe && policy.agents.model_probe !== "auto" ? policy.agents.model_probe : null;
  let handle;
  try {
    await ensureAgentV2(client, station, policy);
    handle = await client.startSession({
      agent: agentNameV2(station),
      messages: promptProbe({ hotelName: probe.name, requestedRooms: probe.requested_rooms, checkin, checkout }),
      maxSteps: 20,
      maxTimeS,
      groupId,
      answerSchema: probeSchema,
      overrides: {
        "agent.environments[kind=web].start_url": url,
        ...(modelProbe ? { "agent.model": modelProbe } : {}),
      },
    });
  } catch (err) {
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: `error: ${err?.message ?? err}` });
    // lancement refusé : rien n'a tourné, rien n'est facturé — l'hôtel reste sondable
    return { hotel: probe.hotelKey, found: false, started: false, definitif: false, status: "error_lancement", error: String(err?.message ?? err), costUsd: 0 };
  }
  let result;
  try {
    result = await pumpToCompletion(
      handle,
      (type, data) => scoped(type, data, { session_id: handle.id }),
      { signal, maxTimeS, deadlineAt: echeance },
    );
  } catch (err) {
    // échéance de suivi ou coupure : la session a bien tourné et coûté, on le dit
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: `suivi interrompu : ${err?.message ?? err}` }, { session_id: handle.id });
    return {
      hotel: probe.hotelKey, found: false, started: true, definitif: false,
      status: "suivi_interrompu", error: String(err?.message ?? err), costUsd: usage.costUsd, steps: usage.steps, sessionId: handle.id,
    };
  }
  let answer = result.answer;
  if (typeof answer === "string") {
    try { answer = JSON.parse(answer); } catch { answer = null; }
  }
  scoped("probe", {
    hotel: probe.hotelKey,
    requested_rooms: probe.requested_rooms,
    result: answer?.found ? { rooms_available_max: answer.rooms_selectable_max, cap_reached: answer.cap_reached } : null,
    status: result.status,
  }, { session_id: handle.id });
  if (answer && typeof answer === "object") {
    // coût réel de la sonde (EX-EXT-2) : agrégé par la boucle d'extension du pipeline
    answer.costUsd = usage.costUsd;
    answer.steps = usage.steps;
    answer.sessionId = handle.id;
    answer.started = true;
    return answer;
  }
  // réponse absente ou illisible : la session a tourné et coûté — le coût ne doit pas
  // disparaître avec elle (il était perdu quand ce cas rendait `null`)
  return {
    hotel: probe.hotelKey, found: false, started: true, definitif: false,
    status: result.status ?? "sans_reponse", error: result.error ?? "réponse de sonde absente ou illisible",
    costUsd: usage.costUsd, steps: usage.steps, sessionId: handle.id,
  };
}
