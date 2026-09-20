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
import { normalizePaxRows, splitPaxRows } from "./paxlist.mjs";
import { allocate } from "./allocate.mjs";
import { computeCost } from "./cout.mjs";
import { buildMessages } from "./messages.mjs";
import { buildPlanCsv, buildRapportMd, buildMessagesCsv, buildRoomingCsv } from "./rapport.mjs";
import { loadInventaire, mergeInventaire, isStale, candidatesFrom, slugify } from "./inventaire.mjs";
import { discoveryNeeded, candidateToEntry } from "./discovery.mjs";
import { planExtension, applyProbeResult } from "./capacite.mjs";
import { resolveConcurrency } from "./releve.mjs";
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

/** Exécute `fn` sur chaque élément avec au plus `n` en vol, en conservant l'ordre. */
async function runPool(items, fn, n = 3) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

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
  rows = null, dossiers = null, inventaire = undefined, ingestion: ingestionIn = null, preflight = null,
  emit = () => {}, signal = null, extensionSignal = null, collect = null, now = new Date(),
}) {
  // les avertissements émis pendant le run alimentent la section « Avertissements » du rapport
  const runWarnings = [];
  const emitRaw = emit;
  emit = (type, data, extra) => {
    if (type === "warning" && data?.message) runWarnings.push(data.message);
    return emitRaw(type, data, extra);
  };

  const runId = newRunId(now);
  const { checkin, checkout } = resolveDates(scenario, now, station?.timezone ?? null);
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

  // Normalisation de la liste QUELLE QUE SOIT SA SOURCE (téléversée ou générée) :
  // les valeurs sont traduites, l'équipage et les non-embarqués sortent du plan
  // passagers. Idempotent sur une liste déjà canonique.
  let ingestion = ingestionIn;
  if (!dossiers && rows) {
    // l'appelant a déjà ingéré (CLI --in, téléversement UI) : on garde SON rapport,
    // qui porte les vraies traductions de valeurs ; sinon on normalise ici
    let normalized = rows;
    if (!ingestion) {
      const res = normalizePaxRows(rows);
      normalized = res.rows;
      ingestion = res.rapport;
    }
    const rapport = ingestion;
    const split = splitPaxRows(normalized);
    rows = split.pax;
    emit("log", {
      message: `liste passagers : ${rows.length} à loger sur ${rapport.lignes.lues} ligne(s)`,
      // compteurs seulement : aucun nom de groupe ni valeur nominative dans le flux
      ingestion: { ...rapport.compteurs, groupes: rapport.compteurs.groupes.length },
    });
    if (rapport.refus.length) emit("warning", { message: `${rapport.refus.length} ligne(s) passager illisibles écartées — voir le rapport d'ingestion` });
    if (split.equipage.length) emit("warning", { message: `${split.equipage.length} membre(s) d'équipage hors plan passagers : une chambre individuelle par personne, à traiter au desk` });
    if (split.exclus.length) emit("warning", { message: `${split.exclus.length} passager(s) non à loger (non embarqués, autonomes, déjà logés) : écartés du plan` });
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
  let candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });

  // Pré-vol HTTP GRATUIT (aucun agent, hors INV-8) : une fiche morte coûterait une
  // session payante puis une substitution en cascade. Seuls 404/410 et une
  // redirection vers un autre établissement écartent un candidat ; un blocage
  // anti-robot reste « indéterminé » et la fiche est conservée.
  if (typeof preflight === "function" && candidates.length) {
    emit("phase", { phase: "prevol", candidats: candidates.length });
    try {
      const res = (await preflight(candidates.map((c) => ({ id: c.id, name: c.name, url: c.url })))) ?? [];
      // Seul 404/410 est un verdict ferme. Une « redirection » peut etre une fusion de
      // fiches, un mur de consentement ou une page traduite : on retrograde, on n'ecarte pas.
      const ecartes = new Map();
      for (const r of res) if (r.verdict === "morte") ecartes.set(r.id ?? r.url, r);
      const redirigees = res.filter((r) => r.verdict === "redirigee");
      // PLANCHER : un filet qui vide l'inventaire est en panne, pas efficace. Au-dela du
      // tiers des candidats, on ne filtre rien et on laisse l'operateur trancher.
      const tropNombreux = ecartes.size > Math.floor(candidates.length / 3);
      emit("preflight", {
        verifies: res.length,
        ecartes: [...ecartes.values()].map((r) => ({ name: r.name, verdict: r.verdict, detail: r.detail })),
        redirigees: redirigees.map((r) => ({ name: r.name, detail: r.detail })),
        indeterminees: res.filter((r) => r.verdict === "indeterminee").length,
        applique: !tropNombreux,
      });
      for (const r of redirigees) {
        emit("warning", { message: `fiche a verifier : « ${r.name} » — ${r.detail} (conservee, relevee en dernier)` });
      }
      if (tropNombreux) {
        emit("warning", {
          message: `pre-vol ignore : ${ecartes.size} fiches sur ${candidates.length} declarees mortes — au-dela du tiers, c'est le controle qui est suspect, pas l'inventaire. Aucun candidat n'est ecarte.`,
        });
      } else {
        for (const r of ecartes.values()) {
          emit("warning", { message: `fiche ecartee avant tout agent : « ${r.name} » — ${r.detail}` });
        }
        if (ecartes.size) candidates = candidates.filter((c) => !ecartes.has(c.id ?? c.url));
        if (redirigees.length) {
          const suspects = new Set(redirigees.map((r) => r.id ?? r.url));
          candidates = [...candidates.filter((c) => !suspects.has(c.id ?? c.url)), ...candidates.filter((c) => suspects.has(c.id ?? c.url))];
        }
      }
    } catch (err) {
      emit("warning", { message: `pré-vol des fiches impossible (${String(err?.message ?? err)}) — les relevés partent sans ce filet` });
    }
  }
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
  // le coût des SONDES est suivi à part : il était écrasé à chaque vague par le total
  // des relevés, donc la borne `max_cost_usd_per_run` ne le voyait jamais et le bandeau
  // affichait deux chiffres contradictoires
  let probeCostUsd = 0;
  const concurrence = resolveConcurrency(policy);
  const totalCost = () => probeCostUsd + inventories.reduce((s2, r) => s2 + (r.costUsd ?? 0), 0);
  let costUsd = totalCost();
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

    // Sondes EN PARALLÈLE (elles étaient strictement séquentielles : 5 sondes en file
    // indienne pendant que les créneaux de concurrence dormaient, ~7 min de séance).
    const probesAJouer = plan.probes.filter(() => !aborted() && !extensionSignal?.aborted);
    for (const probe of probesAJouer) probedKeys.add(probe.hotelKey);
    if (probesAJouer.length) {
      const answers = await runPool(probesAJouer, (probe) => collect.probe(ctx, probe), concurrence);
      sessionsUsed += probesAJouer.length;
      for (const answer of answers) probeCostUsd += answer?.costUsd ?? 0;
      let applique = false;
      answers.forEach((answer, i) => {
        if (!answer) return;
        const updated = applyProbeResult(inventories, probesAJouer[i].hotelKey, answer, { emit, maxPlausible: policy.extension.probe_no_rooms_max });
        inventories.length = 0;
        inventories.push(...updated);
        applique = true;
      });
      costUsd = totalCost();
      if (applique) {
        alloc = allocate({ dossiers, inventories, policy, station, nights, provisoire: true });
        emitPlan(alloc, true);
      }
    }
    if (plan.surveys.length && !extensionSignal?.aborted) {
      const before = inventories.length;
      await collect.releves(ctx, plan.surveys.map((c) => ({ candidate: c, tiers: c.tiers })), {}, onInventory);
      for (const c of plan.surveys) surveyedKeys.add(c.id);
      sessionsUsed += inventories.length - before;
      costUsd = totalCost();
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
      station, policy, checkin, checkout, nights, runId, cost, warnings: runWarnings, ingestion,
      extension: { waves: wave - 1, probes: probedKeys.size, surveys: Math.max(0, surveyedKeys.size - selection.length), limits: { sessions_used: sessionsUsed, sessions_max: policy.extension.max_sessions_per_run, cost_usd: costUsd, cost_max: policy.extension.max_cost_usd_per_run } },
    }),
    messagesCsv: buildMessagesCsv(messages),
    roomingCsv: buildRoomingCsv(alloc.plan),
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
