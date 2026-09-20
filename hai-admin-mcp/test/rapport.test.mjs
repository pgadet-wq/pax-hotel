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

test("rapport : la liste d'appel par hôtel regroupe le plan et totalise chambres et personnes", async () => {
  const { buildRoomingCsv, ROOMING_COLS } = await import("../lib/rapport.mjs");
  const plan = [
    { pnr: "A1", occupants: "Jean MARTIN, Marie MARTIN", pax: 2, cabine: "J", overlays: "", hotel: "Hyatt", hotel_url: "https://x/hyatt", room_type: "Twin", chambres: 1, prix_total: 151, devise: "EUR", conformite: "CONFORME", mode_reglement: "compagnie", statut: "OK", notes: "" },
    { pnr: "A2", occupants: "Luc DUPONT", pax: 1, cabine: "Y", overlays: "PMR", hotel: "Hyatt", hotel_url: "https://x/hyatt", room_type: "King", chambres: 2, prix_total: 120, devise: "EUR", conformite: "CONFORME", mode_reglement: "compagnie", statut: "OK", notes: "PMR" },
    { pnr: "A3", occupants: "Ana SOLO", pax: 1, cabine: "Y", overlays: "", hotel: "Canalis", hotel_url: "https://x/canalis", room_type: "Double", chambres: 1, prix_total: 60, devise: "EUR", conformite: "PARTIELLE", mode_reglement: "carte_prepayee", statut: "OK", notes: "" },
    { pnr: "A4", occupants: "Non logé", pax: 3, cabine: "Y", overlays: "", hotel: "", chambres: 2, statut: "ESCALADE DESK", escalade: "DESK (capacité)", notes: "" },
  ];
  const csv = buildRoomingCsv(plan).replace(/^﻿/, "");
  const lignes = csv.trim().split("\n");
  assert.equal(lignes[0], ROOMING_COLS.join(";"));
  assert.equal(lignes.length, 4, "3 dossiers logés + en-tête ; l'escalade n'a pas d'hôtel à appeler");
  // l'hôtel le plus chargé d'abord, avec ses totaux répétés sur chaque ligne
  assert.ok(lignes[1].startsWith("Hyatt;https://x/hyatt;3;3;"), lignes[1]);
  assert.ok(lignes[3].startsWith("Canalis;https://x/canalis;1;1;"), lignes[3]);
  assert.ok(lignes[1].includes("Jean MARTIN"), "titulaire = premier occupant");
});
