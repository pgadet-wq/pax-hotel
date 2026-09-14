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
 * Applique le résultat d'une sonde : borne `rooms_available_max` posée sur les
 * types plafonnés de l'hôtel (EX-ALL-5). Non mutant — retourne une copie.
 */
export function applyProbeResult(inventories, hotelKey, probeAnswer) {
  const max = probeAnswer?.found ? probeAnswer.rooms_selectable_max : -1;
  return inventories.map((inv) => {
    if ((inv.hotelKey ?? inv.hotel) !== hotelKey || !inv.answer?.found || max < 0) return inv;
    return {
      ...inv,
      answer: {
        ...inv.answer,
        rooms: inv.answer.rooms.map((r) => (r.cap_reached && r.rooms_available_max == null ? { ...r, rooms_available_max: max } : r)),
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
  const scoped = (type, data, extra = {}) => emit(type, data, { hotel_key: probe.hotelKey, ...extra });
  if (!probe.url) {
    scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "skipped_no_url" });
    return null;
  }
  const url = buildProbeUrl(probe.url, { checkin, checkout, noRooms: probe.requested_rooms });
  scoped("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "starting" });

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
      overrides: { "agent.environments[kind=web].start_url": url },
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
  return answer;
}
