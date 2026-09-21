/**
 * Tests policy (CDC §12.2) : défauts valides, plafond effectif × facteur escale,
 * conformité 3 niveaux, non_precise → PARTIELLE, petit-déjeuner depuis rooms[].
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, PolicySchema, conformityOf, conformityLabel, effectiveCaps, tierOf, hotelAmenities } from "../lib/policy.mjs";
import { mkHotel, mkRoom, STATION_BKK } from "./helpers.mjs";

test("policy : DEFAULT_POLICY valide, ajouts CDC présents (allowances, payment, extension, agents, inventory)", () => {
  const p = PolicySchema.parse(DEFAULT_POLICY);
  assert.equal(p.version, 2);
  assert.equal(p.allowances.meal_eur_per_pax_per_day, null); // H-7 : non renseigné
  assert.equal(p.allowances.transport_eur_per_pax, null);
  assert.equal(p.payment.default_mode, "compagnie");
  assert.equal(p.payment.prepaid_card.enabled, true);
  assert.deepEqual(
    { waves: p.extension.max_waves, sessions: p.extension.max_sessions_per_run, cost: p.extension.max_cost_usd_per_run },
    { waves: 4, sessions: 50, cost: 15 }, // H-2 fixée le 14/09, relevée le 21/09 (multi-sources, 40 hôtels)
  );
  assert.equal(p.agents.concurrency, "auto");
  assert.equal(p.inventory.max_age_days, 30);
  assert.equal(p.global.negotiated_rates, false);
});

test("policy : negotiated_rates=true rejeté (INV-3, verrouillé)", () => {
  const bad = structuredClone(DEFAULT_POLICY);
  bad.global.negotiated_rates = true;
  assert.throws(() => PolicySchema.parse(bad));
});

test("policy : effectiveCaps × facteur escale, arrondi à l'euro (EX-POL-1)", () => {
  assert.deepEqual(effectiveCaps(DEFAULT_POLICY, STATION_BKK), { J: 250, W: 130, Y: 80 });
  const chère = { ...STATION_BKK, pricing: { price_cap_factor: 1.15 } };
  assert.deepEqual(effectiveCaps(DEFAULT_POLICY, chère), { J: 288, W: 150, Y: 92 }); // 287.5 → 288
  assert.deepEqual(effectiveCaps(DEFAULT_POLICY, null), { J: 250, W: 130, Y: 80 });
});

test("policy : tierOf = cabine (EX-POL-2)", () => {
  assert.equal(tierOf({ cabin: "W" }), "W");
});

test("conformité : hôtel complet vs politique J = CONFORME", () => {
  const c = conformityOf(mkHotel("h", { stars: 5 }, [mkRoom({ price_per_night: 200 })]), DEFAULT_POLICY.cabins.J, DEFAULT_POLICY.global);
  assert.equal(c.level, "CONFORME");
  assert.equal(conformityLabel(c), "CONFORME");
});

test("conformité : room service « oui » sans mention 24h = PARTIELLE à confirmer", () => {
  const h = mkHotel("h", { amenities: { wifi_free: true, room_service: "oui", workspace: true, airport_shuttle: "non", restaurant_late: false, accessible: false } });
  const c = conformityOf(h, DEFAULT_POLICY.cabins.J, DEFAULT_POLICY.global);
  assert.equal(c.level, "PARTIELLE");
  assert.ok(c.missing.some((m) => m.includes("room_service_24h") && m.includes("non précisé")));
});

test("conformité : workspace non_precise = PARTIELLE, prestation absente = NON_CONFORME", () => {
  const partial = mkHotel("h", { stars: 5, amenities: { wifi_free: true, room_service: "24h", workspace: "non_precise", airport_shuttle: "gratuite", restaurant_late: true, accessible: true } });
  assert.equal(conformityOf(partial, DEFAULT_POLICY.cabins.J, DEFAULT_POLICY.global).level, "PARTIELLE");
  const absent = mkHotel("h", { amenities: { wifi_free: false, room_service: "24h", workspace: true, airport_shuttle: "non", restaurant_late: false, accessible: false } });
  assert.equal(conformityOf(absent, DEFAULT_POLICY.cabins.J, DEFAULT_POLICY.global).level, "NON_CONFORME");
});

test("conformité : aucun prix sous plafond = HORS_BAREME ; plafond effectif escale appliqué", () => {
  const h = mkHotel("h", {}, [mkRoom({ price_per_night: 100 })]);
  assert.equal(conformityOf(h, DEFAULT_POLICY.cabins.Y, DEFAULT_POLICY.global).level, "HORS_BAREME"); // 100 > 80
  // facteur 1.5 → plafond effectif Y 120 → conforme
  const c = conformityOf(h, DEFAULT_POLICY.cabins.Y, DEFAULT_POLICY.global, { capEur: 120 });
  assert.equal(c.level, "CONFORME");
});

test("conformité : étoiles sous minimum = NON_CONFORME ; étoiles 0 = non filtrant (PARTIELLE)", () => {
  assert.equal(conformityOf(mkHotel("h", { stars: 2 }), DEFAULT_POLICY.cabins.Y, DEFAULT_POLICY.global).level, "NON_CONFORME");
  assert.equal(conformityOf(mkHotel("h", { stars: 0 }), DEFAULT_POLICY.cabins.Y, DEFAULT_POLICY.global).level, "PARTIELLE");
});

test("conformité : max_stars dépassé = surclassé, jamais exclu (EX-ALL-2)", () => {
  const h = mkHotel("h", { stars: 5 }, [mkRoom({ price_per_night: 110, breakfast_included: true })]); // W exige le petit-déj
  const c = conformityOf(h, DEFAULT_POLICY.cabins.W, DEFAULT_POLICY.global, { capEur: 130 });
  assert.equal(c.level, "PARTIELLE");
  assert.ok(c.missing.some((m) => m.includes("surclassé")));
});

test("conformité : breakfast_available depuis rooms[], jamais depuis amenities (EX-POL-3)", () => {
  // amenities sans petit-déj mais une variante en propose → exigence W satisfaite
  const h = mkHotel("h", { stars: 4, amenities: { wifi_free: true, room_service: "non", workspace: false, airport_shuttle: "non", restaurant_late: false, accessible: false } },
    [mkRoom({ price_per_night: 90 }), mkRoom({ price_per_night: 110, breakfast_included: true })]);
  assert.equal(hotelAmenities(h.answer).has.breakfast_available, true);
  assert.equal(conformityOf(h, DEFAULT_POLICY.cabins.W, DEFAULT_POLICY.global).level, "CONFORME");
  // aucune variante avec petit-déj → NON_CONFORME pour W (exigence dure absente)
  const sans = mkHotel("h", { stars: 4, amenities: { wifi_free: true, room_service: "non", workspace: false, airport_shuttle: "non", restaurant_late: false, accessible: false } },
    [mkRoom({ price_per_night: 90 })]);
  assert.equal(conformityOf(sans, DEFAULT_POLICY.cabins.W, DEFAULT_POLICY.global).level, "NON_CONFORME");
});
