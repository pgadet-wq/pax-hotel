/**
 * Tests capacite (CDC §6.4, §12.2) : detectCap, planExtension pur et borné
 * (sessions, vagues, coût), probe_same_hotel_first désactivable, applyProbeResult.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCap, planExtension, applyProbeResult } from "../lib/capacite.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { allocate } from "../lib/allocate.mjs";
import { mkRoom, mkHotel, mkRecord, STATION_BKK } from "./helpers.mjs";

const politique = (over = {}) => {
  const p = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  Object.assign(p.extension, over.extension ?? {});
  Object.assign(p.agents, over.agents ?? {});
  return p;
};

const cand = (id, tiers = ["J", "W", "Y"]) => ({ id, name: `Hôtel ${id}`, url: `https://x.test/${id}`, tiers, fallback: false, score: 0.5 });

test("capacite : detectCap — types plafonnés non sondés uniquement", () => {
  const answer = mkHotel("h", {}, [
    mkRoom({ room_type: "A", cap_reached: true }),
    mkRoom({ room_type: "B", cap_reached: false }),
    mkRoom({ room_type: "C", cap_reached: true, rooms_available_max: 14 }), // déjà sondé
  ]).answer;
  assert.deepEqual(detectCap(answer).map((r) => r.room_type), ["A"]);
  assert.deepEqual(detectCap({ found: false, rooms: [mkRoom({ cap_reached: true })] }), []);
});

test("capacite : planExtension — sonde d'abord puis lot de candidats (batch = concurrence)", () => {
  const policy = politique({ agents: { concurrency: 3 } });
  const inv = [mkRecord("plein", {}, [mkRoom({ cap_reached: true, price_per_night: 70 })])];
  const plan = planExtension({
    gaps: { chambresManquantes: { Y: 6 } },
    inventories: inv,
    candidates: [cand("plein"), cand("b"), cand("c"), cand("d"), cand("e")],
    surveyedKeys: new Set(["plein"]),
    probedKeys: new Set(),
    policy, station: STATION_BKK, wave: 1, sessionsUsed: 0, costUsd: 0,
  });
  assert.equal(plan.stop, false);
  assert.equal(plan.probes.length, 1);
  assert.equal(plan.probes[0].hotelKey, "plein");
  assert.equal(plan.probes[0].requested_rooms, 6); // min(manque, probe_no_rooms_max)
  assert.deepEqual(plan.surveys.map((s) => s.id), ["b", "c", "d"]); // lot de 3 (auto = concurrence)
});

test("capacite : requested_rooms plafonné par probe_no_rooms_max ; type hors plafond de tier non sondé", () => {
  const policy = politique();
  const inv = [
    mkRecord("cher", {}, [mkRoom({ cap_reached: true, price_per_night: 200 })]), // > plafond Y (80)
    mkRecord("ok", {}, [mkRoom({ cap_reached: true, price_per_night: 60 })]),
  ];
  const plan = planExtension({
    gaps: { chambresManquantes: { Y: 45 } }, inventories: inv, candidates: [],
    surveyedKeys: new Set(["cher", "ok"]), probedKeys: new Set(),
    policy, station: STATION_BKK, wave: 1, sessionsUsed: 0, costUsd: 0,
  });
  assert.deepEqual(plan.probes.map((p) => p.hotelKey), ["ok"]);
  assert.equal(plan.probes[0].requested_rooms, 30); // probe_no_rooms_max
});

test("capacite : bornes — vagues, sessions, coût, extension désactivée, épuisement (escalade chiffrée)", () => {
  const base = {
    gaps: { chambresManquantes: { Y: 5 } }, inventories: [], candidates: [cand("b")],
    surveyedKeys: new Set(), probedKeys: new Set(), station: STATION_BKK, sessionsUsed: 0, costUsd: 0,
  };
  assert.match(planExtension({ ...base, policy: politique(), wave: 5 }).reason, /max_waves/);
  assert.match(planExtension({ ...base, policy: politique(), wave: 1, sessionsUsed: 18 }).reason, /max_sessions_per_run/);
  assert.match(planExtension({ ...base, policy: politique(), wave: 1, costUsd: 10 }).reason, /max_cost_usd_per_run/);
  assert.match(planExtension({ ...base, policy: politique({ extension: { enabled: false } }), wave: 1 }).reason, /désactivée/);
  // plus rien à tenter → stop épuisé
  const vide = planExtension({ ...base, policy: politique(), wave: 1, candidates: [], surveyedKeys: new Set(["b"]) });
  assert.equal(vide.stop, true);
  assert.match(vide.reason, /épuisé/);
  // aucun manque → couvert
  assert.match(planExtension({ ...base, policy: politique(), wave: 1, gaps: { chambresManquantes: {} } }).reason, /couvert/);
});

test("capacite : probe_same_hotel_first=false ou sonde indisponible → candidats seulement", () => {
  const inv = [mkRecord("plein", {}, [mkRoom({ cap_reached: true, price_per_night: 70 })])];
  const base = {
    gaps: { chambresManquantes: { Y: 6 } }, inventories: inv, candidates: [cand("b")],
    surveyedKeys: new Set(["plein"]), probedKeys: new Set(), station: STATION_BKK, wave: 1, sessionsUsed: 0, costUsd: 0,
  };
  const sans = planExtension({ ...base, policy: politique({ extension: { probe_same_hotel_first: false } }) });
  assert.equal(sans.probes.length, 0);
  assert.deepEqual(sans.surveys.map((s) => s.id), ["b"]);
  const horsLigne = planExtension({ ...base, policy: politique(), allowProbes: false });
  assert.equal(horsLigne.probes.length, 0);
});

test("capacite : le budget de sessions restant limite sondes + relevés planifiés", () => {
  const policy = politique({ extension: { max_sessions_per_run: 3 } });
  const inv = [mkRecord("p1", {}, [mkRoom({ cap_reached: true, price_per_night: 60 })]), mkRecord("p2", {}, [mkRoom({ cap_reached: true, price_per_night: 60 })])];
  const plan = planExtension({
    gaps: { chambresManquantes: { Y: 9 } }, inventories: inv,
    candidates: [cand("b"), cand("c"), cand("d"), cand("e")],
    surveyedKeys: new Set(["p1", "p2"]), probedKeys: new Set(),
    policy, station: STATION_BKK, wave: 1, sessionsUsed: 1, costUsd: 0,
  });
  // budget = 3 - 1 = 2 : 2 sondes passent, plus aucun relevé
  assert.equal(plan.probes.length, 2);
  assert.equal(plan.surveys.length, 0);
});

test("capacite : applyProbeResult borne les types plafonnés sans muter l'entrée (EX-ALL-5)", () => {
  const inv = [mkRecord("plein", {}, [mkRoom({ room_type: "A", cap_reached: true }), mkRoom({ room_type: "B", cap_reached: false })])];
  const avant = JSON.stringify(inv);
  const après = applyProbeResult(inv, "plein", { found: true, rooms_selectable_max: 14, cap_reached: false });
  assert.equal(après[0].answer.rooms[0].rooms_available_max, 14);
  assert.equal(après[0].answer.rooms[1].rooms_available_max, undefined); // non plafonné : intouché
  assert.equal(JSON.stringify(inv), avant); // pur
  // sonde illisible (-1) ou hôtel inconnu : rien ne change
  assert.equal(applyProbeResult(inv, "plein", { found: true, rooms_selectable_max: -1 })[0].answer.rooms[0].rooms_available_max, undefined);
  assert.equal(applyProbeResult(inv, "autre", { found: true, rooms_selectable_max: 9 })[0], inv[0]);
});

/* ------------------------------------------- phase 5 : runProbe côté client */

test("capacite : runProbe — start_url de sonde + modèle flash par override (§16), coût réel attaché", async () => {
  const { runProbe } = await import("../lib/capacite.mjs");
  const policy = politique();
  let startArgs = null;
  const client = {
    agents: { getAgent: async () => ({ name: "hotel-scout-bkk-v2", model: policy.agents.model_stage_ab }) },
    async startSession(args) {
      startArgs = args;
      return {
        id: "sess-probe",
        async *stream() {
          yield { type: "MetricsUpdateEvent", data: { metrics: { steps: 7, totalCost: 0.11, costPerModel: [] } } };
        },
        async waitForCompletion() {
          return {
            id: "sess-probe", status: "completed", outcome: "success",
            answer: { hotel: "novotel", found: true, requested_rooms: 12, rooms_selectable_max: 14, cap_reached: false, notes: "" },
          };
        },
        async cancel() {},
      };
    },
  };
  const events = [];
  const answer = await runProbe({
    client, policy, station: STATION_BKK,
    probe: { hotelKey: "novotel", name: "novotel", url: "https://www.booking.com/hotel/th/novotel.html", requested_rooms: 12 },
    checkin: "2026-10-04", checkout: "2026-10-05", groupId: "g", emit: (type, data) => events.push({ type, data }),
  });
  assert.match(startArgs.overrides["agent.environments[kind=web].start_url"], /no_rooms=12/);
  assert.match(startArgs.overrides["agent.environments[kind=web].start_url"], /group_adults=24/);
  assert.equal(startArgs.overrides["agent.model"], "holo3-1-35b-a3b"); // §16 : sonde en classe flash (Holo3.1 35B)
  assert.equal(startArgs.maxSteps, 20);
  assert.equal(answer.rooms_selectable_max, 14);
  assert.equal(answer.costUsd, 0.11); // EX-EXT-2 : agrégé au coût du run
  assert.equal(answer.sessionId, "sess-probe");
  assert.ok(events.some((e) => e.type === "probe" && e.data.result?.rooms_available_max === 14));
});

test("capacite : runProbe — model_probe « auto » : aucun override de modèle", async () => {
  const { runProbe } = await import("../lib/capacite.mjs");
  const policy = politique({ agents: { model_probe: "auto" } });
  let startArgs = null;
  const client = {
    agents: { getAgent: async () => ({ name: "hotel-scout-bkk-v2", model: policy.agents.model_stage_ab }) },
    async startSession(args) {
      startArgs = args;
      return {
        id: "s",
        async *stream() {},
        async waitForCompletion() {
          return { id: "s", status: "completed", answer: { hotel: "h", found: false, requested_rooms: 12, rooms_selectable_max: -1, cap_reached: false, notes: "" } };
        },
        async cancel() {},
      };
    },
  };
  await runProbe({
    client, policy, station: STATION_BKK,
    probe: { hotelKey: "h", name: "h", url: "https://www.booking.com/hotel/th/h.html", requested_rooms: 12 },
    checkin: "2026-10-04", checkout: "2026-10-05", groupId: "g", emit: () => {},
  });
  assert.equal("agent.model" in startArgs.overrides, false);
});

test("sonde : le maximum observé est un supplément PARTAGÉ, jamais recopié par type ni plafond global", () => {
  const rooms = ["King", "Twin", "Suite"].map((t) =>
    mkRoom({ room_type: t, quantity_available: 9, quantity_displayed_max: 9, cap_reached: true, price_per_night: 60 }),
  );
  const inv = mkHotel("h1", {}, rooms);
  const dossiers = Array.from({ length: 80 }, (_, i) => ({
    pnr: `P${i}`, occupants: "x", adults: 1, children: 0, infants: 0, cabin: "Y", fb: "NONE",
    overlays: { pmr: false, famille: false }, familyUnit: false, rooms: 1, file: "Y",
  }));

  // sans sonde : on ne prend que ce qui est affiché (3 × 9)
  const sans = allocate({ dossiers, inventories: [inv], policy: DEFAULT_POLICY, station: STATION_BKK });
  assert.equal(sans.summary.ok, 27, "quantité affichée");

  // avec une sonde à 30 : 27 affichées + 30 de supplément partagé = 57 — et surtout PAS 90
  const sonde = applyProbeResult([inv], "h1", { found: true, rooms_selectable_max: 30 });
  const avec = allocate({ dossiers, inventories: sonde, policy: DEFAULT_POLICY, station: STATION_BKK });
  assert.equal(avec.summary.ok, 57, "le maximum de sonde est partagé entre les types, pas multiplié par leur nombre");
  assert.ok(avec.summary.ok >= sans.summary.ok, "une sonde ne doit jamais faire DISPARAÎTRE du stock affiché");
  assert.equal(sonde[0].answer.rooms_available_max_hotel, 30);
});
