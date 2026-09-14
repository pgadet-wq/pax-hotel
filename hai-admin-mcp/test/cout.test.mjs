/**
 * Tests cout (CDC §8.1, §12.2) : somme par tier, projection N nuits,
 * not_determinable (EX-COU-1), borne haute 32 900 € pour 34/24/266 aux plafonds par défaut.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCost } from "../lib/cout.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { STATION_BKK } from "./helpers.mjs";

const row = (over = {}) => ({
  pnr: "P1", cabine: "Y", statut: "OK", prix_total: 80, chambres: 1, pax: 2, ...over,
});

test("cout : somme par tier et projection N nuits", () => {
  const plan = [
    row({ pnr: "A", cabine: "J", prix_total: 400 }),   // 2 nuits → 200/nuit
    row({ pnr: "B", cabine: "W", prix_total: 200 }),   // 100/nuit
    row({ pnr: "C", cabine: "Y", prix_total: 120 }),   // 60/nuit
    row({ pnr: "D", cabine: "Y", prix_total: 140 }),   // 70/nuit
  ];
  const c = computeCost(plan, DEFAULT_POLICY, { nights: 2 });
  assert.deepEqual(c.per_night, { J: 200, W: 100, Y: 130, total: 430 });
  assert.equal(c.nights, 2);
  assert.equal(c.projection_total, 860);
});

test("cout : borne haute 32 900 € — Σ sièges × plafond, une chambre par passager (34/24/266)", () => {
  const c = computeCost([], DEFAULT_POLICY, { nights: 1 });
  assert.equal(c.upper_bound_at_caps, 34 * 250 + 24 * 130 + 266 * 80);
  assert.equal(c.upper_bound_at_caps, 32900);
  // le facteur d'escale s'applique aussi à la borne
  const station = { ...STATION_BKK, pricing: { price_cap_factor: 2 } };
  assert.equal(computeCost([], DEFAULT_POLICY, { nights: 1 }, { station }).upper_bound_at_caps, 65800);
});

test("cout : EX-COU-1 — repas et transport non renseignés → not_determinable, jamais estimés", () => {
  const c = computeCost([row()], DEFAULT_POLICY, { nights: 1 });
  assert.deepEqual(c.not_determinable, ["repas", "transport"]);
  assert.deepEqual(c.allowances, { meal: null, transport: null });
});

test("cout : montants renseignés → allowances calculées, not_determinable vide", () => {
  const policy = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  policy.allowances.meal_eur_per_pax_per_day = 25;
  policy.allowances.transport_eur_per_pax = 10;
  const plan = [row({ pax: 2 }), row({ pnr: "P2", pax: 3, statut: "ESCALADE DESK", prix_total: "" })];
  const c = computeCost(plan, policy, { nights: 2 });
  assert.deepEqual(c.not_determinable, []);
  assert.equal(c.allowances.meal, 25 * 5 * 2); // 5 pax × 2 nuits — les escalades mangent aussi
  assert.equal(c.allowances.transport, 10 * 5);
});

test("cout : escalated_rooms par tier, lignes escaladées hors coût", () => {
  const plan = [
    row(),
    row({ pnr: "P2", cabine: "J", statut: "ESCALADE DESK", prix_total: "", chambres: 2 }),
    row({ pnr: "P3", cabine: "J", statut: "ESCALADE DESK", prix_total: "", chambres: 1 }),
  ];
  const c = computeCost(plan, DEFAULT_POLICY, { nights: 1 });
  assert.deepEqual(c.escalated_rooms, { J: 3, W: 0, Y: 0 });
  assert.equal(c.per_night.total, 80);
});
