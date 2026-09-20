/**
 * Gestionnaire de run (phase 4) — singleton 409 (INV-10), agrégat snapshot
 * re-rendable (EX-UI-2), captures privées (§11), annulations, sorties §8.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunManager, HttpError } from "../../demo/run-manager.mjs";
import { createSimulation, loadSimInventaire } from "../../demo/simulate.mjs";
import { loadStation } from "../lib/stations.mjs";
import { mergeConfig } from "../lib/scenario.mjs";

const SPEED = 1000;

function recordingHub(onEvent = null) {
  const events = [];
  return {
    events,
    publish(type, ev) {
      events.push({ type, ev });
      onEvent?.(type, ev);
      return events.length;
    },
  };
}

function simStart(manager, overrides = {}) {
  const station = loadStation("BKK");
  const { policy, avion, scenario } = mergeConfig({ scenario: { station: "BKK" } });
  return manager.start({
    policy, avion, scenario, station,
    inventaire: loadSimInventaire(),
    simulate: true,
    collectFactory: ({ signal, extensionSignal }) => createSimulation({ speed: SPEED, signal, extensionSignal }),
    ...overrides,
  });
}

const tmpOut = () => fs.mkdtempSync(path.join(os.tmpdir(), "pax-out-"));

test("run simulé via le manager : snapshot complet, sorties §8, captures privées", async () => {
  const outDir = tmpOut();
  const hub = recordingHub();
  const manager = createRunManager({ hub, outDir });

  const { runId } = simStart(manager);
  assert.ok(runId);
  assert.ok(manager.isRunning());
  await manager.wait();
  assert.ok(!manager.isRunning());

  const snap = manager.snapshot();
  assert.equal(snap.state, "done");
  assert.equal(snap.runId, runId);
  assert.equal(snap.runInProgress, false);
  assert.equal(snap.simulate, true);
  assert.equal(snap.station, "BKK");
  // snapshot re-rendable : phases, agents, plan complet, extension, coût, messages
  assert.ok(snap.phases.length >= 9);
  assert.equal(snap.phase, "sorties");
  assert.equal(Object.keys(snap.agents).length, 6);
  assert.equal(snap.plan.length, 157);
  assert.ok(snap.plan.every((r) => r.pnr && r.statut === "OK"));
  assert.deepEqual(snap.planSummary, { ok: 157, escalade: 0 });
  assert.equal(snap.extension.reason, "couvert : aucun manque");
  assert.ok(snap.cost.per_night.total > 0);
  assert.equal(snap.messagesReady.count_fr, 157);
  assert.ok(snap.metricsTotals.steps > 0);
  assert.equal(snap.metricsTotals.cost_usd, 0);

  // sorties §8 : 7 fichiers écrits et référencés (dont la liste d'appel par hôtel)
  assert.equal(snap.outputs.length, 7);
  assert.ok(snap.outputs.some((f) => f.startsWith("rooming-")), "liste d'appel par hôtel produite");
  for (const name of snap.outputs) {
    assert.ok(fs.existsSync(path.join(outDir, name)), `${name} écrit`);
    assert.ok(manager.isOutputAllowed(name));
  }
  assert.ok(!manager.isOutputAllowed("plan-autre.csv"));
  assert.ok(snap.outputs.includes(`plan-${runId}.csv`));

  // résultat pour l'API messages / coût
  const result = manager.result(runId);
  assert.equal(result.messages.length, 314);
  assert.ok(result.cost.upper_bound_at_caps > 0);

  // captures : les événements publiés ne portent JAMAIS la source (§11)
  const shots = hub.events.filter((e) => e.type === "screenshot");
  assert.ok(shots.length >= 6);
  for (const s of shots) {
    assert.equal(s.ev.data.source, undefined, "source jamais publiée");
    assert.ok(Number.isInteger(s.ev.data.seq));
  }
  const src = manager.captureSource("hyatt-regency-bkk-airport", 0);
  assert.ok(src && /^sim-assets\//.test(src.source), "source disponible côté serveur uniquement");
  assert.equal(manager.captureSource("hyatt-regency-bkk-airport", 999), null);
  assert.equal(manager.captureSource("inconnu", 0), null);
  // le snapshot n'expose aucune source de capture
  assert.doesNotMatch(JSON.stringify(snap), /sim-assets\//);
});

test("INV-10 : deuxième run refusé à 409 pendant un run", async () => {
  const manager = createRunManager({ hub: recordingHub(), outDir: tmpOut() });
  simStart(manager);
  assert.throws(() => simStart(manager), (err) => err instanceof HttpError && err.status === 409);
  await manager.wait();
  // après la fin, un nouveau run repart
  const again = simStart(manager);
  assert.ok(again.runId);
  await manager.wait();
});

test("annulation totale : état cancelled, aucune sortie écrite", async () => {
  const outDir = tmpOut();
  let manager;
  const hub = recordingHub((type, ev) => {
    if (type === "phase" && ev.data.phase === "releves") manager.cancel();
  });
  manager = createRunManager({ hub, outDir });
  simStart(manager);
  await manager.wait();
  const snap = manager.snapshot();
  assert.equal(snap.state, "cancelled");
  assert.deepEqual(snap.outputs, []);
  assert.equal(fs.readdirSync(outDir).length, 0);
  assert.equal(snap.done.cancelled, true);
});

test("annulation d'extension seule : run terminé, escalade chiffrée (EX-EXT-4)", async () => {
  let manager;
  const hub = recordingHub((type, ev) => {
    if (type === "extension" && ev.data.wave === 1 && ev.data.reason === "gaps") manager.cancelExtension();
  });
  manager = createRunManager({ hub, outDir: tmpOut() });
  simStart(manager);
  await manager.wait();
  const snap = manager.snapshot();
  assert.equal(snap.state, "done", "le run se termine malgré l'arrêt de l'extension");
  assert.ok(snap.done.escalade > 0);
  assert.equal(snap.done.extension_stop, "interrompue par l'utilisateur");
  assert.ok(snap.warnings.some((w) => /extension interrompue/.test(w.message)));
});

test("cancel / cancelExtension hors run : 409", () => {
  const manager = createRunManager({ hub: recordingHub(), outDir: tmpOut() });
  assert.throws(() => manager.cancel(), (e) => e instanceof HttpError && e.status === 409);
  assert.throws(() => manager.cancelExtension(), (e) => e instanceof HttpError && e.status === 409);
});

test("plan_row réémis : la ligne est remplacée par pnr, pas dupliquée", async () => {
  const manager = createRunManager({ hub: recordingHub(), outDir: tmpOut() });
  simStart(manager);
  await manager.wait();
  const snap = manager.snapshot();
  const pnrs = snap.plan.map((r) => r.pnr);
  assert.equal(new Set(pnrs).size, pnrs.length, "aucun doublon de PNR");
  assert.ok(snap.plan.every((r) => r.provisoire === false), "dernière réémission non provisoire");
});
