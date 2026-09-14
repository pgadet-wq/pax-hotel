/**
 * Tests rapport (CDC §8) : colonnes §5.7 du plan CSV, messages CSV échappé,
 * rapport Markdown avec horodatage des relevés (EX-REL-2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanCsv, buildRapportMd, buildMessagesCsv, PLAN_COLS } from "../lib/rapport.mjs";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { mkHotel, mkPax, STATION_BKK } from "./helpers.mjs";

test("rapport : le plan CSV porte les colonnes §5.7 (mode_reglement, hotel_source, provisoire, session_ref, transfert, escalade)", () => {
  for (const col of ["conformite", "mode_reglement", "hotel_source", "provisoire", "session_ref", "transfert", "escalade"]) {
    assert.ok(PLAN_COLS.includes(col), `colonne manquante : ${col}`);
  }
  const inv = [mkHotel("eco", { stars: 3 })];
  const alloc = allocate({ dossiers: buildDossiers([mkPax("P1")], DEFAULT_POLICY), inventories: inv, policy: DEFAULT_POLICY, station: STATION_BKK });
  const csv = buildPlanCsv(alloc.plan);
  const [head, line] = csv.replace(/^﻿/, "").trim().split("\n");
  assert.equal(head, PLAN_COLS.join(";"));
  assert.equal(line.split(";").length, PLAN_COLS.length);
  assert.ok(line.includes("compagnie"));
});

test("rapport : rapport Markdown — horodatage du relevé, plafonds effectifs, synthèse par tier", () => {
  const inv = [mkHotel("eco", { stars: 3 })];
  const alloc = allocate({ dossiers: buildDossiers([mkPax("P1")], DEFAULT_POLICY), inventories: inv, policy: DEFAULT_POLICY, station: STATION_BKK });
  const md = buildRapportMd(alloc, inv, {
    station: STATION_BKK, policy: DEFAULT_POLICY, checkin: "2026-10-04", checkout: "2026-10-05", nights: 1, runId: "test1",
    cost: { per_night: { J: 0, W: 0, Y: 70, total: 70 }, nights: 1, projection_total: 70, upper_bound_at_caps: 32900, allowances: { meal: null, transport: null }, not_determinable: ["repas", "transport"], escalated_rooms: { J: 0, W: 0, Y: 0 } },
  });
  assert.match(md, /prix relevé le 2026-10-03 08:00 UTC/); // EX-REL-2
  assert.match(md, /\| Y \| 1 \| 0 \| 1 \| 80 EUR\/nuit \|/);
  assert.match(md, /non renseigné/); // repas/transport EX-COU-1
  assert.match(md, /Aucune réservation n'a été effectuée/);
});

test("rapport : le CSV des messages échappe les corps multilignes", () => {
  const csv = buildMessagesCsv([{ pnr: "P1", lang: "fr", subject: "Sujet ; avec point-virgule", body: "ligne 1\nligne 2" }]);
  assert.ok(csv.includes('"Sujet ; avec point-virgule"'));
  assert.ok(csv.includes('"ligne 1\nligne 2"'));
  assert.ok(csv.startsWith("﻿pnr;lang;subject;body\n"));
});
