/**
 * Tests dossiers (CDC §12.2) : tiers + surcouches, famille 2A+3C, nourrissons sans capacité.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { mkPax } from "./helpers.mjs";

test("dossiers : cabine = tier, PMR et famille = overlays, file de priorité pmr → famille → J → W → Y", () => {
  const rows = [
    mkPax("P1", { cabine: "Y" }),
    mkPax("P2", { cabine: "J", flying_blue: "GOLD" }),
    mkPax("P3", { cabine: "Y", assistance: "WCHR" }),
    mkPax("P4", { cabine: "W" }), mkPax("P4", { type_pax: "CHD", age: "8" }),
    mkPax("P5", { cabine: "W" }),
  ];
  const dossiers = buildDossiers(rows, DEFAULT_POLICY);
  assert.deepEqual(dossiers.map((d) => d.pnr), ["P3", "P4", "P2", "P5", "P1"]);
  const p3 = dossiers.find((d) => d.pnr === "P3");
  assert.equal(p3.cabin, "Y"); // l'overlay PMR ne change pas le tier
  assert.equal(p3.overlays.pmr, true);
  const p4 = dossiers.find((d) => d.pnr === "P4");
  assert.deepEqual({ familyUnit: p4.familyUnit, cabin: p4.cabin, famille: p4.overlays.famille }, { familyUnit: true, cabin: "W", famille: true });
});

test("dossiers : intra-tier, Flying Blue Gold+ passe d'abord (EX-POL-2)", () => {
  const rows = [mkPax("A", { cabine: "J" }), mkPax("B", { cabine: "J", flying_blue: "PLATINUM" }), mkPax("C", { cabine: "J", flying_blue: "SILVER" })];
  assert.deepEqual(buildDossiers(rows, DEFAULT_POLICY).map((d) => d.pnr), ["B", "C", "A"]);
});

test("dossiers : famille 2A+3C dépasse l'unité familiale → 2 chambres", () => {
  const rows = [
    mkPax("F1"), mkPax("F1"),
    mkPax("F1", { type_pax: "CHD", age: "5" }), mkPax("F1", { type_pax: "CHD", age: "7" }), mkPax("F1", { type_pax: "CHD", age: "9" }),
  ];
  const [d] = buildDossiers(rows, DEFAULT_POLICY);
  assert.equal(d.familyUnit, false);
  assert.equal(d.rooms, 2);
});

test("dossiers : nourrissons sans capacité — 2A+2C+1INF reste une unité familiale d'une chambre", () => {
  const rows = [
    mkPax("F2"), mkPax("F2"),
    mkPax("F2", { type_pax: "CHD", age: "4" }), mkPax("F2", { type_pax: "CHD", age: "6" }),
    mkPax("F2", { type_pax: "INF", age: "0" }),
  ];
  const [d] = buildDossiers(rows, DEFAULT_POLICY);
  assert.equal(d.familyUnit, true);
  assert.equal(d.rooms, 1);
  assert.equal(d.infants, 1);
});

test("dossiers : computeNeeds agrège par file et par tier", () => {
  const rows = [mkPax("A", { cabine: "J" }), mkPax("B"), mkPax("B"), mkPax("C", { cabine: "Y", assistance: "WCHR" })];
  const needs = computeNeeds(buildDossiers(rows, DEFAULT_POLICY));
  assert.equal(needs.parFile.pmr.dossiers, 1);
  assert.equal(needs.parTier.J.chambres, 1);
  assert.equal(needs.parTier.Y.dossiers, 2); // B (couple) + C (pmr, tier Y)
});
