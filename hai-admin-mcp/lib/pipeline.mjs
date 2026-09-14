/**
 * Orchestrateur du run v2 (CDC §5.8, §6) : phases `preparation → generation →
 * besoins → inventaire → discovery|discovery_skipped → releves → allocation →
 * extension (0..n) → sorties → done`, allocation incrémentale (EX-ALL-1) et
 * boucle d'extension bornée (§6.4).
 *
 * `collect` est injectable : `realCollect(client)` lance les vraies sessions
 * (phases 5-6), `fixturesCollect(records)` rejoue des fixtures (offline, tests,
 * simulation phase 4). Le pipeline lui-même n'importe pas le SDK.
 */
import { generatePassengers } from "./passagers.mjs";
import { buildDossiers, computeNeeds } from "./dossiers.mjs";
import { allocate } from "./allocate.mjs";
import { computeCost } from "./cout.mjs";
import { buildMessages } from "./messages.mjs";
import { buildPlanCsv, buildRapportMd, buildMessagesCsv } from "./rapport.mjs";
import { loadInventaire, mergeInventaire, isStale, candidatesFrom, slugify } from "./inventaire.mjs";
import { discoveryNeeded, candidateToEntry } from "./discovery.mjs";
import { planExtension, applyProbeResult } from "./capacite.mjs";
import { resolveDates, newRunId, DEFAULT_AVION } from "./scenario.mjs";

/** Collecteurs réels (sessions payantes — phases 5-6, INV-8 gardé par les CLI). */
export function realCollect(client) {
  return {
    async discovery(ctx) {
      const { runDiscovery } = await import("./discovery.mjs");
      return runDiscovery({ client, ...ctx });
    },
    async releves(ctx, selection, substitutes, onInventory) {
      const { runReleves } = await import("./releve.mjs");
      return runReleves({ client, ...ctx, selection, substitutes, onInventory });
    },
    async probe(ctx, probe) {
      const { runProbe } = await import("./capacite.mjs");
      return runProbe({ client, ...ctx, probe });
    },
  };
}

const cleanUrl = (u) => String(u ?? "").toLowerCase().split("?")[0].replace(/\/+$/, "");

/**
 * Collecteur de fixtures (0 €) : sert les relevés depuis un tableau
 * `[{hotel, sessionId, status, answer}]` (format `data/simulate/releves-demo.json`).
 * Un candidat hors fixtures reçoit `found=false` (la substitution du pipeline joue).
 * La sonde est indisponible hors ligne (retourne null, la vague passe aux candidats).
 */
export function fixturesCollect(records) {
  const findRecord = (candidate) =>
    records.find((r) => r.hotel === candidate.id) ??
    records.find((r) => cleanUrl(r.answer?.url) && cleanUrl(r.answer.url) === cleanUrl(candidate.url)) ??
    records.find((r) => (r.answer?.hotel ?? "").toLowerCase() === candidate.name.toLowerCase());

  return {
    discovery: null, // hors ligne : pas de découverte possible
    async releves(ctx, selection, substitutes, onInventory) {
      const out = [];
      const queue = selection.map((s) => ({ candidate: s.candidate ?? s, tiers: s.tiers ?? (s.candidate ?? s).tiers ?? [] }));
      const usedNames = new Set(queue.map((q) => q.candidate.name));
      while (queue.length) {
        const { candidate, tiers } = queue.shift();
        const rec = findRecord(candidate);
        const hotelKey = candidate.id ?? slugify(candidate.name);
        const inv = rec
          ? { hotel: hotelKey, hotelKey, name: candidate.name, url: candidate.url ?? "", tiers, sessionId: rec.sessionId ?? null, status: rec.status ?? "completed", outcome: rec.outcome ?? null, error: rec.error ?? null, answer: rec.answer, costUsd: 0 }
          : {
              hotel: hotelKey, hotelKey, name: candidate.name, url: candidate.url ?? "", tiers, sessionId: null, status: "completed", outcome: null, error: null, costUsd: 0,
              answer: { hotel: candidate.name, url: candidate.url ?? "", found: false, checkin: ctx.checkin, checkout: ctx.checkout, currency: "EUR", rooms: [], notes: "hors fixtures (mode hors ligne)", observed_at: new Date().toISOString() },
            };
        out.push(inv);
        if (onInventory) onInventory(inv, out);
        const usable = inv.answer?.found && (inv.answer.rooms ?? []).some((r) => r.price_per_night > 0);
        if (!usable) {
          ctx.emit("warning", { message: `« ${candidate.name} » sans inventaire exploitable (fixtures) → substitution si possible` });
          for (const tier of tiers) {
            const next = (substitutes?.[tier] ?? []).find((c) => !usedNames.has(c.name));
            if (next) {
              usedNames.add(next.name);
              queue.push({ candidate: next, tiers: [tier] });
              break;
            }
          }
        }
      }
      return out;
    },
    probe: null, // pas de sonde hors ligne : l'extension passe directement aux candidats
  };
}

/**
 * Exécute le pipeline complet.
 * @param {object} args
 * @param {object} args.policy politique validée ; args.station fiche escale ; args.scenario scénario validé
 * @param {object} [args.avion] défaut A350-900
 * @param {Array} [args.rows] passagers (sinon générés : avion plein exact, seed du scénario)
 * @param {object|null} [args.inventaire] inventaire injecté (défaut : data/inventaire/{code}.json)
 * @param {Function} [args.emit] (type, data, extra) → void
 * @param {AbortSignal} [args.signal] annulation totale ; [args.extensionSignal] arrêt de l'extension seule (EX-EXT-4)
 * @param {object} [args.collect] collecteurs injectés (défaut : realCollect(client))
 */
export async function runPipeline({
  client = null, policy, station, scenario, avion = DEFAULT_AVION,
  rows = null, dossiers = null, inventaire = undefined,
  emit = () => {}, signal = null, extensionSignal = null, collect = null, now = new Date(),
}) {
  const runId = newRunId(now);
  const { checkin, checkout } = resolveDates(scenario, now);
  const nights = scenario.nights;
  const groupId = `${station.code.toLowerCase()}-v2-${checkin}-${runId}`;
  const ctx = { policy, station, scenario, checkin, checkout, groupId, emit, signal };
  collect ??= realCollect(client);
  const aborted = () => signal?.aborted === true;

  emit("phase", { phase: "preparation", runId, station: station.code, checkin, checkout, nights });

  /* generation */
  emit("phase", { phase: "generation" });
  if (!dossiers && !rows) {
    const gen = generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" });
    rows = gen.rows;
    emit("log", { message: `liste générée : ${gen.stats.passagers} passagers (seed ${scenario.seed})` });
  }

  /* besoins */
  emit("phase", { phase: "besoins" });
  dossiers ??= buildDossiers(rows, policy);
  const needs = computeNeeds(dossiers);
  emit("log", { message: `${dossiers.length} dossiers`, needs });

  /* inventaire */
  emit("phase", { phase: "inventaire" });
  let inv = inventaire !== undefined ? inventaire : loadInventaire(station.code);
  const stale = isStale(inv, policy, now);
  emit("inventory_status", {
    station: station.code,
    updated_at: inv?.updated_at ?? null,
    hotels_count: inv?.hotels?.length ?? 0,
    stale,
    used: Boolean(inv?.hotels?.length),
  });

  /* discovery */
  const decision = discoveryNeeded({ inv, policy, station, needs: needs.parTier, force: scenario.force_discovery, now });
  let discoveryResult = null;
  if (aborted()) return finishCancelled();
  if (decision.run && collect.discovery) {
    emit("phase", { phase: "discovery", reason: decision.reason });
    discoveryResult = await collect.discovery(ctx);
    const entries = (discoveryResult?.candidates ?? []).map((c) => candidateToEntry(c));
    if (entries.length) {
      // EX-DIS-2 : fusion EN MÉMOIRE uniquement (l'écriture disque est une action UI explicite)
      inv = mergeInventaire(inv, { station: station.code, updated_at: null, reference: null, hotels: entries });
    }
  } else {
    if (decision.run) emit("warning", { message: `découverte requise (${decision.reason}) mais indisponible dans ce mode — repli inventaire + hôtels de secours` });
    emit("phase", { phase: "discovery_skipped", reason: decision.reason });
  }

  /* candidats et sélection étage B (ordre EX-REL-3) */
  const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });
  const maxB = policy.global.discovery.max_hotels_stage_b;
  const selection = candidates.slice(0, maxB).map((c) => ({ candidate: c, tiers: c.tiers }));
  const rest = candidates.slice(maxB);
  const substitutes = { J: [], W: [], Y: [] };
  for (const c of rest) for (const tier of c.tiers) substitutes[tier].push(c);

  /* relevés (allocation incrémentale à chaque relevé, EX-ALL-1) */
  emit("phase", { phase: "releves", selection: selection.map((s) => s.candidate.name) });
  const inventories = [];
  const surveyedKeys = new Set();
  let alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: true });
  const emitPlan = (a, provisoire) => {
    for (const row of a.plan) emit("plan_row", { ...row, provisoire });
    emit("metrics", { ok: a.summary.ok, escalade: a.summary.escalade });
  };
  const onInventory = (rec) => {
    inventories.push(rec);
    surveyedKeys.add(rec.hotelKey ?? rec.hotel);
    alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: true });
    emitPlan(alloc, true);
  };
  if (aborted()) return finishCancelled();
  await collect.releves(ctx, selection, substitutes, onInventory);
  for (const s of selection) surveyedKeys.add(s.candidate.id ?? slugify(s.candidate.name));

  /* allocation (avant extension) */
  emit("phase", { phase: "allocation" });
  alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: true });

  /* extension (CDC §6.4) */
  let wave = 1;
  let sessionsUsed = 0;
  let costUsd = inventories.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const probedKeys = new Set();
  let extensionStopReason = null;
  for (;;) {
    if (aborted()) return finishCancelled();
    const plan = planExtension({
      gaps: alloc.gaps, inventories, candidates, surveyedKeys, probedKeys,
      policy, station, wave, sessionsUsed, costUsd,
      allowProbes: typeof collect.probe === "function", // hors ligne : pas de sonde possible
    });
    const gapsList = Object.entries(alloc.gaps.chambresManquantes ?? {}).map(([tier, n]) => ({ tier, rooms_missing: n }));
    emit("extension", {
      wave, reason: plan.reason, gaps: gapsList,
      planned: { probes: plan.probes.length, surveys: plan.surveys.length },
      limits: plan.limits,
    });
    if (plan.stop) {
      extensionStopReason = plan.reason;
      if (gapsList.length) {
        emit("warning", { message: `extension arrêtée (${plan.reason}) — escalade DESK : ${gapsList.map((g) => `${g.tier}: ${g.rooms_missing} ch.`).join(", ")}` });
      }
      break;
    }
    if (extensionSignal?.aborted) {
      extensionStopReason = "interrompue par l'utilisateur";
      emit("warning", { message: "extension interrompue par l'utilisateur — le plan reste en l'état (escalade chiffrée)" });
      break;
    }
    emit("phase", { phase: "extension", wave });

    for (const probe of plan.probes) {
      if (aborted()) return finishCancelled();
      if (extensionSignal?.aborted) break;
      probedKeys.add(probe.hotelKey);
      const answer = await collect.probe(ctx, probe);
      sessionsUsed += 1;
      costUsd += answer?.costUsd ?? 0;
      if (answer) {
        const updated = applyProbeResult(inventories, probe.hotelKey, answer);
        inventories.length = 0;
        inventories.push(...updated);
        alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: true });
        emitPlan(alloc, true);
      }
    }
    if (plan.surveys.length && !extensionSignal?.aborted) {
      const before = inventories.length;
      await collect.releves(ctx, plan.surveys.map((c) => ({ candidate: c, tiers: c.tiers })), {}, onInventory);
      for (const c of plan.surveys) surveyedKeys.add(c.id);
      sessionsUsed += inventories.length - before;
      costUsd = inventories.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    }
    wave += 1;
  }

  /* sorties */
  emit("phase", { phase: "sorties" });
  alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: false });
  emitPlan(alloc, false);
  const cost = computeCost(alloc.plan, policy, scenario, { avion, station });
  emit("cost", cost);
  const messages = buildMessages(alloc.plan, station, scenario, policy, { now });
  emit("messages_ready", {
    count_fr: messages.filter((m) => m.lang === "fr").length,
    count_en: messages.filter((m) => m.lang === "en").length,
    sample: messages.slice(0, 3).map((m) => ({ pnr: m.pnr, lang: m.lang, subject: m.subject })),
  });
  const outputs = {
    planCsv: buildPlanCsv(alloc.plan),
    rapportMd: buildRapportMd(alloc, inventories, {
      station, policy, checkin, checkout, nights, runId, cost,
      extension: { waves: wave - 1, probes: probedKeys.size, surveys: Math.max(0, surveyedKeys.size - selection.length), limits: { sessions_used: sessionsUsed, sessions_max: policy.extension.max_sessions_per_run, cost_usd: costUsd, cost_max: policy.extension.max_cost_usd_per_run } },
    }),
    messagesCsv: buildMessagesCsv(messages),
  };
  emit("done", { runId, ok: alloc.summary.ok, escalade: alloc.summary.escalade, sessions_used: sessionsUsed, cost_usd: costUsd, extension_stop: extensionStopReason });

  return {
    runId, checkin, checkout, groupId, dossiers, needs, decision, discoveryResult,
    candidates, selection, inventories, alloc, cost, messages, outputs,
    sessionsUsed, costUsd, extensionWaves: wave - 1, extensionStopReason, cancelled: false,
  };

  function finishCancelled() {
    emit("done", { runId, cancelled: true });
    return { runId, checkin, checkout, groupId, cancelled: true, dossiers, inventories: [], alloc: null };
  }
}
