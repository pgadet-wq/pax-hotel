/**
 * Mode simulation (phase 4) — run complet 0 €, phases §5.8 dans l'ordre,
 * extension vague 1 « sonde + 1 relevé », INV-5 sur les événements d'agent,
 * annulation totale et annulation d'extension seule (EX-EXT-4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../lib/pipeline.mjs";
import { loadStation } from "../lib/stations.mjs";
import { mergeConfig } from "../lib/scenario.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { createSimulation, loadSimInventaire, simAvailable, SIM_ANSWERS } from "../../demo/simulate.mjs";

const SPEED = 1000; // ~90 s réels → ~150 ms de test

function setup() {
  const station = loadStation("BKK");
  const { policy, avion, scenario } = mergeConfig({ scenario: { station: "BKK" } });
  return { station, policy, avion, scenario };
}

async function runSim({ signal = null, extensionSignal = null } = {}) {
  const { station, policy, avion, scenario } = setup();
  const events = [];
  const emit = (type, data = {}, extra = {}) => events.push({ type, data, ...extra });
  const collect = createSimulation({ speed: SPEED, signal, extensionSignal });
  const result = await runPipeline({
    policy, station, scenario, avion,
    inventaire: loadSimInventaire(),
    emit, signal, extensionSignal, collect,
  });
  return { result, events };
}

test("simAvailable : BKK seulement (EX-UI-1)", () => {
  assert.ok(simAvailable("BKK"));
  assert.ok(simAvailable("bkk"));
  assert.ok(!simAvailable("CDG"));
  assert.ok(!simAvailable("NOU"));
});

test("run simulé complet : phases §5.8 ordonnées, vague 1 = 1 sonde + 1 relevé, 0 €", async () => {
  const { result, events } = await runSim();

  const phases = events.filter((e) => e.type === "phase").map((e) => e.data.phase);
  assert.deepEqual(
    phases,
    ["preparation", "generation", "besoins", "inventaire", "discovery_skipped", "releves", "allocation", "extension", "sorties"],
    "ordre §5.8 (une seule vague d'extension)",
  );

  // inventaire fixtures : frais, utilisé (EX-INV-9)
  const inv = events.find((e) => e.type === "inventory_status").data;
  assert.equal(inv.station, "BKK");
  assert.equal(inv.stale, false);
  assert.equal(inv.used, true);
  assert.equal(inv.hotels_count, 4);

  // extension : vague 1 planifie 1 sonde + 1 relevé, puis « couvert »
  const ext = events.filter((e) => e.type === "extension").map((e) => e.data);
  assert.equal(ext[0].wave, 1);
  assert.deepEqual(ext[0].planned, { probes: 1, surveys: 1 });
  assert.deepEqual(ext[0].limits, { sessions_used: 0, sessions_max: 18, cost_usd: 0, cost_max: 10, wave: 1, max_waves: 4 });
  assert.equal(ext.at(-1).reason, "couvert : aucun manque");

  // sonde : starting puis completed avec résultat borné (EX-EXT-1)
  const probes = events.filter((e) => e.type === "probe").map((e) => e.data);
  assert.equal(probes[0].status, "starting");
  assert.deepEqual(probes.at(-1).result, { rooms_available_max: 30, cap_reached: false });

  // agents : 6 relevés (5 étage B + amaranth en vague 1), pensées FR, captures, métriques 0 $
  const agentKeys = new Set(events.filter((e) => e.type === "agent_status").map((e) => e.hotel_key));
  assert.equal(agentKeys.size, 6);
  assert.ok(agentKeys.has("amaranth-suvarnabhumi-hotel"));
  const thoughts = events.filter((e) => e.type === "agent_thought");
  assert.ok(thoughts.length >= 25, `pensées scriptées attendues (${thoughts.length})`);
  assert.ok(thoughts.every((t) => typeof t.data.text === "string" && t.data.text.length > 0));
  const shots = events.filter((e) => e.type === "screenshot");
  assert.ok(shots.length >= 6, "captures attendues");
  assert.ok(shots.every((s) => /^sim-assets\/capture-[a-z]+\.png$/.test(s.data.source)));
  const metrics = events.filter((e) => e.type === "metrics" && e.hotel_key);
  assert.ok(metrics.every((m) => m.data.cost_usd === 0), "coût agent nul en simulation");

  // fin : tous logés, 2 sessions d'extension, 0 $
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.data.escalade, 0);
  assert.equal(done.data.ok, 157);
  assert.equal(done.data.sessions_used, 2);
  assert.equal(done.data.cost_usd, 0);
  assert.equal(result.extensionWaves, 1);

  // sorties complètes : plan, rapport, messages FR+EN, coût
  assert.equal(result.messages.length, 2 * result.alloc.plan.length);
  assert.ok(result.outputs.planCsv.includes("pnr"));
  assert.ok(result.cost.per_night.total > 0);
});

test("INV-5 : aucune donnée passager dans les événements d'AGENT", async () => {
  const { events } = await runSim();
  const { rows } = generatePassengers({ seats: { J: 34, W: 24, Y: 266 }, seed: 42, fill: "exact" });
  const agentEvents = events.filter((e) => ["agent_status", "agent_thought", "screenshot", "probe"].includes(e.type) || (e.type === "metrics" && e.hotel_key));
  const blob = JSON.stringify(agentEvents);
  assert.doesNotMatch(blob, /SB\d{3}[A-Z]{3}/, "aucun PNR dans les événements d'agent");
  for (const r of rows.slice(0, 20)) {
    assert.ok(!blob.includes(`${r.prenom} ${r.nom}`), `identité ${r.prenom} ${r.nom} absente des événements d'agent`);
  }
});

test("réponses scriptées : les 3 compléments couvrent novotel, méridien, amaranth", () => {
  assert.deepEqual(Object.keys(SIM_ANSWERS).sort(), [
    "amaranth-suvarnabhumi-hotel",
    "le-meridien-suvarnabhumi-golf-resort-spa",
    "novotel-bkk-airport",
  ]);
  for (const a of Object.values(SIM_ANSWERS)) {
    assert.equal(a.found, true);
    assert.ok(a.rooms.every((r) => r.price_per_night > 0));
  }
});

test("annulation totale pendant les relevés : done {cancelled} sans sorties", async () => {
  const ac = new AbortController();
  const { station, policy, avion, scenario } = setup();
  const events = [];
  const emit = (type, data = {}, extra = {}) => {
    events.push({ type, data, ...extra });
    if (type === "phase" && data.phase === "releves") ac.abort();
  };
  const collect = createSimulation({ speed: SPEED, signal: ac.signal });
  const result = await runPipeline({
    policy, station, scenario, avion, inventaire: loadSimInventaire(),
    emit, signal: ac.signal, collect,
  });
  assert.equal(result.cancelled, true);
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.data.cancelled, true);
  assert.ok(!("outputs" in result) || result.outputs === undefined);
});

test("annulation d'extension seule : le plan reste en l'état, escalade chiffrée (EX-EXT-4)", async () => {
  const extAc = new AbortController();
  extAc.abort(); // interrompue dès la première vague
  const { result, events } = await runSim({ extensionSignal: extAc.signal });
  assert.equal(result.cancelled, false);
  assert.equal(result.extensionStopReason, "interrompue par l'utilisateur");
  assert.ok(
    events.some((e) => e.type === "warning" && /extension interrompue par l'utilisateur/.test(e.data.message)),
    "avertissement d'interruption attendu",
  );
  const done = events.at(-1).data;
  assert.ok(done.escalade > 0, "les manques restent en escalade chiffrée");
  // vague 1 émise (bornes visibles) mais aucune sonde exécutée
  assert.ok(events.some((e) => e.type === "extension" && e.data.wave === 1));
  assert.ok(!events.some((e) => e.type === "probe" && e.data.status !== "starting" && e.data.result));
});
