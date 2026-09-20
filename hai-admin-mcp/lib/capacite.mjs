/**
 * Étage C — Extension au plafond d'affichage (CDC §6.4).
 * `detectCap` et `planExtension` sont PURS : la boucle d'extension du pipeline
 * les rejoue à chaque vague. `runProbe` lance la sonde de capacité (EX-EXT-1,
 * H-3 : paramètres no_rooms/group_adults à confirmer en phase 5 ; désactivable
 * par `extension.probe_same_hotel_first = false`).
 */
import { agentNameV2, ensureAgentV2, buildProbeUrl, probeSchema, promptProbe, pumpToCompletion } from "./hai.mjs";
import { effectiveCaps } from "./policy.mjs";
import { resolveConcurrency } from "./releve.mjs";

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
 * @param {object} args.gaps `{chambresManquantes: {tier: n}}` (sortie d'allocate)
 * @param {Array} args.inventories relevés effectués (records {hotelKey, name, url, answer})
 * @param {Array} args.candidates sortie de candidatesFrom (ordonnée, `tiers` par candidat)
 * @param {Set<string>} args.surveyedKeys hotelKey déjà relevés
 * @param {Set<string>} args.probedKeys hotelKey déjà sondés
 * @param {number} args.wave numéro de vague (1..)
 * @param {number} args.sessionsUsed sessions consommées par l'extension
 * @param {number} args.costUsd coût agrégé du run
 * @returns {{stop: boolean, reason: string, probes: Array, surveys: Array, limits: object}}
 */
export function planExtension({
  gaps, inventories = [], candidates = [], surveyedKeys = new Set(), probedKeys = new Set(),
  policy, station = null, wave, sessionsUsed = 0, costUsd = 0, allowProbes = true,
}) {
  const ext = policy.extension;
  const limits = {
    sessions_used: sessionsUsed, sessions_max: ext.max_sessions_per_run,
    cost_usd: Math.round(costUsd * 100) / 100, cost_max: ext.max_cost_usd_per_run,
    wave, max_waves: ext.max_waves,
  };
  const manques = Object.entries(gaps?.chambresManquantes ?? {}).filter(([, n]) => n > 0);
  const done = (reason) => ({ stop: true, reason, probes: [], surveys: [], limits });
  if (!manques.length) return done("couvert : aucun manque");
  if (!ext.enabled) return done("extension désactivée");
  if (wave > ext.max_waves) return done(`borne atteinte : max_waves (${ext.max_waves})`);
  if (sessionsUsed >= ext.max_sessions_per_run) return done(`borne atteinte : max_sessions_per_run (${ext.max_sessions_per_run})`);
  if (costUsd >= ext.max_cost_usd_per_run) return done(`borne atteinte : max_cost_usd_per_run (${ext.max_cost_usd_per_run} $)`);

  const caps = effectiveCaps(policy, station);
  const needyTiers = manques.map(([tier]) => tier);
  const missingTotal = manques.reduce((s, [, n]) => s + n, 0);
  let budget = ext.max_sessions_per_run - sessionsUsed;

  // 1) sondes : hôtels relevés avec cap_reached sur un type compatible avec un tier
  //    en manque (prix sous le plafond effectif du tier), non encore sondés (EX-EXT-1)
  const probes = [];
  if (ext.probe_same_hotel_first && allowProbes) {
    for (const inv of inventories) {
      if (probes.length >= budget) break;
      const key = inv.hotelKey ?? inv.hotel;
      if (probedKeys.has(key)) continue;
      const capped = detectCap(inv.answer).filter((room) => needyTiers.some((tier) => room.price_per_night <= caps[tier]));
      if (!capped.length) continue;
      probes.push({
        hotelKey: key,
        name: inv.name ?? inv.answer.hotel,
        url: inv.answer.url ?? inv.url ?? "",
        room_types: capped.map((room) => room.room_type),
        requested_rooms: Math.min(missingTotal, ext.probe_no_rooms_max),
      });
    }
  }
  budget -= probes.length;

  // 2) candidats suivants non relevés, compatibles avec les tiers en manque,
  //    par lots de batch_size (« auto » = concurrence effective, §16)
  const batch = ext.batch_size === "auto" ? resolveConcurrency(policy) : ext.batch_size;
  const surveys = candidates
    .filter((c) => !surveyedKeys.has(c.id) && c.tiers.some((tier) => needyTiers.includes(tier)))
    .slice(0, Math.max(0, Math.min(batch, budget)));

  if (!probes.length && !surveys.length) return done("épuisé : plus de sonde possible ni de candidat à relever");
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
export function applyProbeResult(inventories, hotelKey, probeAnswer, { emit = null, maxPlausible = 50 } = {}) {
  let max = probeAnswer?.found ? probeAnswer.rooms_selectable_max : -1;
  // Un agent web peut confondre un prix, un nombre d'avis ou un numero de chambre avec
  // un nombre de chambres. Le selecteur Booking peut legitimement afficher plus que le
  // nombre demande, mais jamais des centaines : on borne au plafond configure.
  if (max > maxPlausible) {
    emit?.("warning", {
      message: `sonde invraisemblable sur « ${probeAnswer.hotel ?? hotelKey} » : ${max} chambres selectionnables annoncees — valeur ramenee a ${maxPlausible} (plafond de sonde)`,
    });
    max = maxPlausible;
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
 */
export async function runProbe({ client, policy, station, probe, checkin, checkout, groupId, emit, signal }) {
  const usage = { steps: 0, costUsd: 0 };
  const scoped = (type, data, extra = {}) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      usage.costUsd = data.cost_usd ?? usage.costUsd;
    }
    return emit(type, data, { hotel_key: probe.hotelKey, ...extra });
  };
  if (!probe.url) {
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "skipped_no_url" });
    return null;
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
      maxTimeS: 400,
      groupId,
      answerSchema: probeSchema,
      overrides: {
        "agent.environments[kind=web].start_url": url,
        ...(modelProbe ? { "agent.model": modelProbe } : {}),
      },
    });
  } catch (err) {
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: `error: ${err?.message ?? err}` });
    return null;
  }
  const result = await pumpToCompletion(handle, (type, data) => scoped(type, data, { session_id: handle.id }), { signal });
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
  }
  return answer;
}
