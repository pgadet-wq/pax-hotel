/**
 * Fixtures RÉELLES de la phase 5 (Étage 0 BKK du 15/09, run mu2gsy9c, 0,99 $) :
 * `data/simulate/inventaire-reel-bkk.json` est la sortie réelle reformatée en
 * fixtures (EX-INV-6 : rejouable par `tools/inventaire.mjs --offline`), et les
 * 4 captures de `demo/sim-assets/` sont désormais de vraies captures Booking
 * (remplacement phase 5 — le test PNG de demo-invariants garde la signature).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { normalizeInventaire, mergeInventaire, candidatesFrom } from "../lib/inventaire.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { loadStation } from "../lib/stations.mjs";

const FILE = path.join(ROOT, "data", "simulate", "inventaire-reel-bkk.json");

test("fixtures réelles : inventaire BKK valide (schéma §5.3), ≥ 5 hôtels agents avec paiement et capacité", () => {
  const inv = normalizeInventaire(JSON.parse(fs.readFileSync(FILE, "utf8")), "inventaire-reel-bkk.json");
  assert.equal(inv.station, "BKK");
  assert.ok(inv.updated_at, "updated_at posé (run réel horodaté)");
  assert.ok(inv.reference?.checkin, "référence H-4 posée");
  const agents = inv.hotels.filter((h) => h.source === "agent");
  assert.ok(agents.length >= 5, `≥ 5 hôtels source agent (reçu : ${agents.length})`);
  for (const h of agents) {
    assert.ok(["oui", "non", "non_precise"].includes(h.payment.prepayment_online), `${h.id} : prepayment_online renseigné`);
    assert.ok(h.capacity_hint?.observed_at, `${h.id} : capacity_hint observé`);
    assert.ok(h.last_survey_at, `${h.id} : relevé horodaté`);
    assert.ok(["oui", "non", "a_confirmer"].includes(h.payment.company_payment_possible), `${h.id} : H-1 recalculée`);
  }
});

test("fixtures réelles : rejouables par mergeInventaire et exploitables par candidatesFrom", () => {
  const fresh = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const merged = mergeInventaire(null, fresh);
  assert.equal(merged.hotels.length, fresh.hotels.length);
  const candidates = candidatesFrom(merged, DEFAULT_POLICY, { station: loadStation("BKK") });
  // chaque hôtel réel relevé reste candidat d'au moins un tier (Y au minimum : 3★+, wifi)
  const reels = candidates.filter((c) => !c.fallback);
  assert.ok(reels.length >= 5, `candidats réels attendus (reçu : ${reels.length})`);
  assert.ok(reels.some((c) => c.tiers.length > 0), "au moins un hôtel compatible avec un tier");
});
