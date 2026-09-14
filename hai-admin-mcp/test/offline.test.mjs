/**
 * Intégration hors ligne (critère d'acceptation phase 1) : dossiers A350 + fixtures
 * data/simulate/releves-demo.json → plan avec conformite et mode_reglement, messages
 * FR/EN sans {{ résiduel, coût avec not_determinable ["repas","transport"].
 * Vérifie aussi qu'aucun module de la phase n'importe hai-agents (INV-7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generatePassengers } from "../lib/passagers.mjs";
import { parsePassagersCsv } from "../lib/csv.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { allocate } from "../lib/allocate.mjs";
import { computeCost } from "../lib/cout.mjs";
import { buildMessages } from "../lib/messages.mjs";
import { buildPlanCsv, buildRapportMd, buildMessagesCsv } from "../lib/rapport.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { DEFAULT_AVION } from "../lib/scenario.mjs";
import { ROOT, STATION_BKK } from "./helpers.mjs";

const releves = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "simulate", "releves-demo.json"), "utf8"));

test("fixtures : releves-demo.json au format v2 — payment, cap_reached, observed_at présents", () => {
  assert.equal(releves.length, 4);
  for (const rec of releves) {
    assert.ok(rec.answer.observed_at, `${rec.hotel} : observed_at manquant`);
    assert.ok(rec.answer.payment, `${rec.hotel} : payment manquant`);
    for (const room of rec.answer.rooms) {
      assert.equal(typeof room.cap_reached, "boolean", `${rec.hotel}/${room.room_type} : cap_reached manquant`);
      assert.equal(typeof room.quantity_displayed_max, "number");
    }
  }
  // le relevé found=false du POC est conservé (méridien introuvable)
  assert.equal(releves.filter((r) => !r.answer.found).length, 1);
});

test("offline : A350 plein + fixtures → plan incrémental avec conformite et mode_reglement", () => {
  const rows = parsePassagersCsv(generatePassengers({ seats: DEFAULT_AVION.seats, seed: 42, fill: "exact" }).csv);
  const dossiers = buildDossiers(rows, DEFAULT_POLICY);
  const { plan, summary } = allocate({ dossiers, inventories: releves, policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });

  assert.equal(plan.length, dossiers.length);
  assert.ok(summary.ok > 0, "aucun dossier logé depuis les fixtures");
  assert.ok(summary.escalade > 0, "324 passagers pour ~60 chambres affichées : l'escalade est attendue");
  for (const row of plan.filter((p) => p.statut === "OK")) {
    assert.ok(row.conformite.length > 0, `conformite vide pour ${row.pnr}`);
    assert.ok(["compagnie", "carte_prepayee", "compagnie_a_confirmer"].includes(row.mode_reglement), `mode_reglement invalide : ${row.mode_reglement}`);
    assert.equal(row.transfert, "taxi, max 45 min");
  }
  // les trois hôtels exploitables des fixtures couvrent les trois modes de règlement
  const modes = new Set(plan.filter((p) => p.statut === "OK").map((p) => p.mode_reglement));
  assert.ok(modes.has("compagnie"), "Hyatt (prépaiement oui) → compagnie attendu");
  assert.ok(modes.has("carte_prepayee"), "Divalux (paiement sur place) → carte attendue");
});

test("offline : messages FR/EN et coût sur le plan des fixtures", () => {
  const rows = parsePassagersCsv(generatePassengers({ seats: DEFAULT_AVION.seats, seed: 42, fill: "exact" }).csv);
  const dossiers = buildDossiers(rows, DEFAULT_POLICY);
  const alloc = allocate({ dossiers, inventories: releves, policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });

  const msgs = buildMessages(alloc.plan, STATION_BKK, { next_update_minutes: 30 }, DEFAULT_POLICY, { now: new Date(2026, 9, 4, 20, 0) });
  assert.equal(msgs.length, alloc.plan.length * 2);
  for (const m of msgs) assert.ok(!m.subject.includes("{{") && !m.body.includes("{{"), `{{ résiduel (${m.pnr}/${m.lang})`);

  const cost = computeCost(alloc.plan, DEFAULT_POLICY, { nights: 1 }, { avion: DEFAULT_AVION, station: STATION_BKK });
  assert.deepEqual(cost.not_determinable, ["repas", "transport"]);
  assert.equal(cost.upper_bound_at_caps, 32900);
  assert.ok(cost.per_night.total > 0 && cost.projection_total === cost.per_night.total);

  // les trois livrables se construisent sans erreur
  assert.ok(buildPlanCsv(alloc.plan).length > 1000);
  assert.ok(buildMessagesCsv(msgs).startsWith("﻿pnr;lang;subject;body"));
  const md = buildRapportMd(alloc, releves, { station: STATION_BKK, policy: DEFAULT_POLICY, checkin: "2026-10-04", checkout: "2026-10-05", nights: 1, cost });
  assert.match(md, /prix relevé le 2026-08-31/);
});

test("INV-7 : aucun module de la phase 1 n'importe hai-agents", () => {
  const libDir = path.join(ROOT, "hai-admin-mcp", "lib");
  for (const f of fs.readdirSync(libDir)) {
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    assert.ok(!/from\s+["']hai-agents["']/.test(src), `${f} importe hai-agents`);
  }
});
