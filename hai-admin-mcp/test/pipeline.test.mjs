/**
 * Tests pipeline (CDC §6.4, fiche 3) — client factice, zéro session :
 * plafond → sonde puis lot ; bornes atteintes → escalade chiffrée ; substitution
 * found=false ; annulation ; rejeu complet sur les fixtures livrées.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runPipeline, fixturesCollect } from "../lib/pipeline.mjs";
import { normalizeInventaire } from "../lib/inventaire.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { mkPax, mkRoom, mkRecord, mkInv, mkInvEntry, STATION_BKK, ROOT } from "./helpers.mjs";

const NOW = new Date("2026-09-15T12:00:00Z");
const SCENARIO = { station: "BKK", checkin: "2026-10-04", nights: 1, seed: 42, simulate: false, force_discovery: false, next_update_minutes: 30 };

const politique = (over = {}) => {
  const p = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  Object.assign(p.global.discovery, over.discovery ?? {});
  Object.assign(p.extension, over.extension ?? {});
  Object.assign(p.agents, over.agents ?? {});
  return p;
};

const collecteur = ({ record, probeAnswer = null, calls }) => ({
  discovery: null,
  async releves(ctx, selection, substitutes, onInventory) {
    calls.push(`releves:${selection.map((s) => (s.candidate ?? s).id).join(",")}`);
    const out = [];
    for (const s of selection) {
      const c = s.candidate ?? s;
      const rec = record(c, ctx);
      out.push(rec);
      if (onInventory) onInventory(rec, out);
    }
    return out;
  },
  async probe(ctx, probe) {
    calls.push(`probe:${probe.hotelKey}`);
    return probeAnswer ? probeAnswer(probe) : null;
  },
});

const foundRecord = (c, rooms) => ({ ...mkRecord(c.id, {}, rooms), name: c.name, url: c.url });
const notFound = (c, ctx) => ({
  hotel: c.id, hotelKey: c.id, name: c.name, url: c.url ?? "", tiers: c.tiers, sessionId: null, status: "completed",
  outcome: null, error: null, costUsd: 0,
  answer: { hotel: c.name, url: c.url ?? "", found: false, checkin: ctx.checkin, checkout: ctx.checkout, currency: "EUR", rooms: [], notes: "complet", observed_at: "2026-09-15T12:00:00Z" },
});

const invCinq = () =>
  normalizeInventaire(mkInv([
    mkInvEntry("plein", { review_score: 9 }),
    mkInvEntry("b"), mkInvEntry("c"), mkInvEntry("d"), mkInvEntry("e"),
  ]));

test("pipeline : relevé au plafond → sonde du même hôtel puis lot de 3 candidats (§6.4)", async () => {
  const calls = [];
  const events = [];
  const rows = Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`));
  const collect = collecteur({
    calls,
    record: (c, ctx) =>
      c.id === "plein" ? foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })])
      : c.id === "b" ? foundRecord(c, [mkRoom({ room_type: "Eco", quantity_available: 2, price_per_night: 60 })])
      : notFound(c, ctx),
    probeAnswer: () => ({ hotel: "plein", found: true, requested_rooms: 6, rooms_selectable_max: 14, cap_reached: false, notes: "" }),
  });
  const res = await runPipeline({
    policy: politique({ discovery: { max_hotels_stage_b: 1 }, agents: { concurrency: 3 } }),
    station: STATION_BKK, scenario: SCENARIO, rows, inventaire: invCinq(),
    emit: (type, data, extra) => events.push({ type, data, ...extra }), collect, now: NOW,
  });
  assert.equal(calls[0], "releves:plein");
  assert.equal(calls[1], "probe:plein"); // la sonde passe AVANT le lot de candidats
  assert.equal(calls[2], "releves:b,c,d"); // lot de 3 (batch auto = concurrence 3)
  const ext1 = events.find((e) => e.type === "extension");
  assert.deepEqual(ext1.data.planned, { probes: 1, surveys: 3 });
  assert.deepEqual(ext1.data.gaps, [{ tier: "Y", rooms_missing: 6 }]); // 15 - 9 affichées
  assert.equal(res.alloc.summary.ok, 15); // 14 (sonde) + 2 (candidat b) couvrent tout
  assert.equal(res.alloc.summary.escalade, 0);
  assert.equal(res.sessionsUsed, 4); // 1 sonde + 3 relevés d'extension (EX-EXT-2)
  const derniere = events.filter((e) => e.type === "extension").at(-1);
  assert.match(derniere.data.reason, /couvert/);
});

test("pipeline : bornes atteintes → arrêt et escalade chiffrée (warning + lignes DESK)", async () => {
  const calls = [];
  const events = [];
  const rows = Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`));
  const collect = collecteur({
    calls,
    record: (c, ctx) => (c.id === "plein" ? foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]) : notFound(c, ctx)),
  });
  const res = await runPipeline({
    policy: politique({ discovery: { max_hotels_stage_b: 1 }, extension: { max_sessions_per_run: 0 } }),
    station: STATION_BKK, scenario: SCENARIO, rows, inventaire: invCinq(),
    emit: (type, data, extra) => events.push({ type, data, ...extra }), collect, now: NOW,
  });
  assert.match(res.extensionStopReason, /max_sessions_per_run/);
  assert.equal(calls.length, 1); // aucun appel d'extension
  const warn = events.find((e) => e.type === "warning" && /escalade DESK/.test(e.data.message));
  assert.ok(warn, "warning d'escalade chiffrée attendu");
  assert.match(warn.data.message, /Y: 6 ch\./);
  assert.equal(res.alloc.summary.escalade, 6);
  assert.ok(res.alloc.plan.some((r) => r.escalade === "DESK (capacité)"));
});

test("pipeline : probe_same_hotel_first=false → pas de sonde, extension par candidats seulement", async () => {
  const calls = [];
  const rows = Array.from({ length: 12 }, (_, i) => mkPax(`P${i}`));
  const collect = collecteur({
    calls,
    record: (c, ctx) => (c.id === "plein" ? foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]) : notFound(c, ctx)),
  });
  await runPipeline({
    policy: politique({ discovery: { max_hotels_stage_b: 1 }, agents: { concurrency: 3 }, extension: { probe_same_hotel_first: false, max_waves: 1 } }),
    station: STATION_BKK, scenario: SCENARIO, rows, inventaire: invCinq(),
    collect, now: NOW,
  });
  assert.ok(!calls.some((c) => c.startsWith("probe:")), "aucune sonde ne doit être lancée");
  assert.equal(calls[1], "releves:b,c,d");
});

test("pipeline : substitution sur found=false (fixtures) — warning et candidat suivant relevé", async () => {
  const events = [];
  const inv = normalizeInventaire(mkInv([
    mkInvEntry("absent", { review_score: 9.5, url: "https://www.booking.com/hotel/th/absent.html" }),
    mkInvEntry("present", { url: "https://www.booking.com/hotel/th/present.html" }),
  ]));
  const records = [{ hotel: "present", sessionId: "s1", status: "completed", answer: mkRecord("present").answer }];
  const station = { ...STATION_BKK, fallback_hotels: [] };
  const res = await runPipeline({
    policy: politique({ discovery: { max_hotels_stage_b: 1 } }),
    station, scenario: SCENARIO, rows: [mkPax("P1"), mkPax("P2")], inventaire: inv,
    emit: (type, data) => events.push({ type, data }), collect: fixturesCollect(records), now: NOW,
  });
  assert.ok(events.some((e) => e.type === "warning" && /substitution/.test(e.data.message)));
  assert.deepEqual(res.inventories.map((r) => r.hotelKey), ["absent", "present"]);
  assert.equal(res.alloc.summary.ok, 2); // logés chez le substitut
});

test("pipeline : annulation totale via signal → done {cancelled}", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const events = [];
  const res = await runPipeline({
    policy: politique(), station: STATION_BKK, scenario: SCENARIO, rows: [mkPax("P1")],
    inventaire: invCinq(), emit: (type, data) => events.push({ type, data }),
    collect: collecteur({ calls: [], record: (c, ctx) => notFound(c, ctx) }), signal: ctrl.signal, now: NOW,
  });
  assert.equal(res.cancelled, true);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).data.cancelled, true);
});

test("pipeline : arrêt de l'extension seule (EX-EXT-4) — le run va au bout, escalade chiffrée", async () => {
  const extCtrl = new AbortController();
  extCtrl.abort();
  const rows = Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`));
  const collect = collecteur({
    calls: [],
    record: (c, ctx) => (c.id === "plein" ? foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]) : notFound(c, ctx)),
  });
  const res = await runPipeline({
    policy: politique({ discovery: { max_hotels_stage_b: 1 } }),
    station: STATION_BKK, scenario: SCENARIO, rows, inventaire: invCinq(),
    collect, extensionSignal: extCtrl.signal, now: NOW,
  });
  assert.equal(res.cancelled, false);
  assert.match(res.extensionStopReason, /interrompue/);
  assert.equal(res.alloc.summary.escalade, 6);
  assert.ok(res.outputs.planCsv.length > 0); // les sorties sont produites malgré l'arrêt
});

test("pipeline : rejeu complet sur les fixtures livrées — phases §5.8 ordonnées, 0 $, sorties complètes", async () => {
  const releves = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "simulate", "releves-demo.json"), "utf8"));
  const inv = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "inventaire", "BKK.json"), "utf8"));
  const rows = generatePassengers({ seats: { J: 4, W: 4, Y: 40 }, seed: 42, fill: "exact" }).rows;
  const events = [];
  const res = await runPipeline({
    policy: DEFAULT_POLICY, station: STATION_BKK, scenario: SCENARIO, rows,
    inventaire: normalizeInventaire(inv), emit: (type, data) => events.push({ type, data }),
    collect: fixturesCollect(releves), now: NOW,
  });
  const phases = events.filter((e) => e.type === "phase").map((e) => e.data.phase);
  assert.deepEqual(phases.slice(0, 6), ["preparation", "generation", "besoins", "inventaire", "discovery_skipped", "releves"]);
  assert.ok(phases.includes("allocation") && phases.includes("sorties"));
  assert.ok(phases.indexOf("sorties") > phases.indexOf("allocation"));
  assert.equal(events.at(-1).type, "done");
  assert.equal(res.costUsd, 0);
  assert.ok(res.alloc.summary.ok > 0);
  assert.equal(res.messages.length, res.alloc.plan.length * 2);
  assert.ok(!res.outputs.messagesCsv.includes("{{"));
  assert.deepEqual(res.cost.not_determinable, ["repas", "transport"]);
  const status = events.find((e) => e.type === "inventory_status");
  // l'état d'inventaire suit le fichier livré (rafraîchi par agents en phase 5)
  assert.deepEqual(status.data, { station: "BKK", updated_at: inv.updated_at, hotels_count: inv.hotels.length, stale: false, used: true });
});
