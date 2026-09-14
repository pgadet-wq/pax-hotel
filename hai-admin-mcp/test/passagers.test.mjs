/**
 * Tests passagers (CDC §5.5, §12.2) : non-régression seed 42 A330 (CSV identique à
 * data/passagers-test.csv), avion plein exact, déterminisme, PMR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generatePassengers, LEGACY_A330_SEATS } from "../lib/passagers.mjs";
import { parsePassagersCsv } from "../lib/csv.mjs";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { ROOT } from "./helpers.mjs";

test("passagers : seed 42 A330 legacy → CSV identique à data/passagers-test.csv (non-régression v1)", () => {
  const reference = fs.readFileSync(path.join(ROOT, "data", "passagers-test.csv"), "utf8").replace(/\r\n/g, "\n");
  const { csv, stats } = generatePassengers({ seats: LEGACY_A330_SEATS, seed: 42, fill: "legacy" });
  assert.equal(csv, reference);
  assert.equal(stats.pmr, 4);
});

test("passagers : A350 exact = 324 sièges pile, reproductible à seed égal", () => {
  const a = generatePassengers({ seats: { J: 34, W: 24, Y: 266 }, seed: 7, fill: "exact" });
  const b = generatePassengers({ seats: { J: 34, W: 24, Y: 266 }, seed: 7, fill: "exact" });
  assert.equal(a.stats.passagers, 324);
  assert.deepEqual(a.stats.parCabine, { J: 34, W: 24, Y: 266 });
  assert.equal(a.csv, b.csv);
  const c = generatePassengers({ seats: { J: 34, W: 24, Y: 266 }, seed: 8, fill: "exact" });
  assert.notEqual(a.csv, c.csv); // la graine change la liste
});

test("passagers : le CSV généré se re-parse et produit des besoins par tier", () => {
  const { csv } = generatePassengers({ seats: { J: 34, W: 24, Y: 266 }, seed: 42, fill: "exact" });
  const rows = parsePassagersCsv(csv);
  assert.equal(rows.length, 324);
  const needs = computeNeeds(buildDossiers(rows, DEFAULT_POLICY));
  assert.ok(needs.parTier.J.chambres > 0 && needs.parTier.W.chambres > 0 && needs.parTier.Y.chambres > 0);
});

test("passagers : PMR marqués sur des dossiers distincts, PRNG local (pas d'état module)", () => {
  const { rows } = generatePassengers({ seats: { J: 10, W: 10, Y: 60 }, seed: 3, fill: "exact", pmrCount: 4 });
  const pnrsPmr = rows.filter((r) => r.assistance === "WCHR").map((r) => r.pnr);
  assert.equal(pnrsPmr.length, 4);
  assert.equal(new Set(pnrsPmr).size, 4);
  // deux appels successifs identiques : aucun compteur global partagé
  const x = generatePassengers({ seats: { J: 4, W: 0, Y: 0 }, seed: 5 });
  const y = generatePassengers({ seats: { J: 4, W: 0, Y: 0 }, seed: 5 });
  assert.equal(x.csv, y.csv);
  assert.ok(x.rows[0].pnr.startsWith("SB001"));
});
