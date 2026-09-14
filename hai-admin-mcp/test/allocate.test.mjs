/**
 * Tests allocate (CDC §7, §12.2) : parcours EX-ALL-4, dédup tarifaire, plafond ±
 * dérogation, épuisement → escalade, borne rooms_available_max (EX-ALL-5),
 * règlement par ligne (EX-ALL-6), colonnes §5.7, surclassements PMR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { mkHotel, mkRoom, mkPax, STATION_BKK } from "./helpers.mjs";

const yPax = (pnr) => mkPax(pnr, { cabine: "Y" });
const alloc = (rows, inventories, over = {}) =>
  allocate({ dossiers: buildDossiers(rows, over.policy ?? DEFAULT_POLICY), inventories, policy: DEFAULT_POLICY, station: STATION_BKK, ...over });

test("allocation : dédup des variantes tarifaires — même stock physique (9), pas 27", () => {
  const rooms = [
    mkRoom({ price_per_night: 60, free_cancellation: false }),
    mkRoom({ price_per_night: 66, free_cancellation: true }),
    mkRoom({ price_per_night: 75, free_cancellation: true, breakfast_included: true }),
  ];
  const inv = [mkHotel("eco", { stars: 3 }, rooms)];
  const { summary, plan } = alloc(Array.from({ length: 12 }, (_, i) => yPax(`P${i}`)), inv);
  assert.equal(summary.ok, 9);
  assert.equal(summary.escalade, 3); // épuisement → escalade
  const esc = plan.find((p) => p.statut === "ESCALADE DESK");
  assert.equal(esc.escalade, "DESK (capacité)");
  assert.equal(esc.mode_reglement, "");
});

test("allocation : la variante annulation gratuite est préférée (66 > 60 non remboursable)", () => {
  const rooms = [mkRoom({ price_per_night: 60, free_cancellation: false }), mkRoom({ price_per_night: 66, free_cancellation: true })];
  const { plan } = alloc([yPax("P1")], [mkHotel("eco", { stars: 3 }, rooms)]);
  assert.equal(plan[0].prix_total, 66);
});

test("allocation : PARTIELLE choisie faute de CONFORME, libellé propagé au plan", () => {
  const partiel = mkHotel("p", { stars: 0 }); // étoiles non affichées → PARTIELLE, à confirmer
  const horsBareme = mkHotel("c", { stars: 4 }, [mkRoom({ price_per_night: 200 })]); // > plafond Y
  const { plan } = alloc([yPax("P1")], [partiel, horsBareme]);
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].hotel, "Hôtel p"); // PARTIELLE passe avant HORS_BAREME (EX-ALL-4)
  assert.match(plan[0].conformite, /^PARTIELLE \(étoiles \[non affichées\]\)/);
});

test("allocation : plafond dépassé → HORS BAREME si dérogation, escalade sinon", () => {
  const cher = mkHotel("cher", { stars: 3 }, [mkRoom({ price_per_night: 120 })]);
  const { plan } = alloc([yPax("P1")], [cher]);
  assert.equal(plan[0].statut, "OK");
  assert.match(plan[0].conformite, /HORS BAREME \(\+40 EUR\/nuit\)/);

  const strict = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  strict.cabins.Y.allow_above_cap_if_no_alternative = false;
  const res = allocate({ dossiers: buildDossiers([yPax("P1")], strict), inventories: [cher], policy: strict, station: STATION_BKK });
  assert.equal(res.plan[0].statut, "ESCALADE DESK");
  assert.equal(res.plan[0].escalade, "DESK (capacité)");
});

test("allocation : plafond effectif de l'escale (facteur 1.5) rend conforme un prix sur-plafond", () => {
  const station = { ...STATION_BKK, pricing: { price_cap_factor: 1.5 } }; // Y : 80 → 120
  const inv = [mkHotel("eco", { stars: 3 }, [mkRoom({ price_per_night: 100 })])];
  const { plan } = alloc([yPax("P1")], inv, { station });
  assert.equal(plan[0].conformite, "CONFORME");
});

test("allocation : J-PMR surclassé — hôtel au-dessus de max_stars accepté, marqué surclassé (EX-ALL-2)", () => {
  const policy = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  policy.cabins.J.max_stars = 4;
  const cinqEtoiles = mkHotel("palace", {
    stars: 5,
    amenities: { wifi_free: true, room_service: "24h", workspace: true, airport_shuttle: "gratuite", restaurant_late: true, accessible: true },
  }, [mkRoom({ price_per_night: 220 })]);
  const rows = [mkPax("VIP", { cabine: "J", assistance: "WCHR" })];
  const { plan } = allocate({ dossiers: buildDossiers(rows, policy), inventories: [cinqEtoiles], policy, station: STATION_BKK });
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].cabine, "J");
  assert.equal(plan[0].overlays, "PMR");
  assert.match(plan[0].conformite, /surclassé \(5★ > 4★\)/);
  assert.match(plan[0].notes, /PMR : chambre accessible/);
});

test("allocation : PMR exige accessible — surclassement de tier Y → supérieur si nécessaire", () => {
  const ecoNonAccessible = mkHotel("eco", { stars: 3, amenities: { wifi_free: true, room_service: "non", workspace: false, airport_shuttle: "non", restaurant_late: false, accessible: false } }, [mkRoom({ price_per_night: 50 })]);
  const premiumAccessible = mkHotel("prem", { stars: 5, amenities: { wifi_free: true, room_service: "24h", workspace: true, airport_shuttle: "gratuite", restaurant_late: true, accessible: true } }, [mkRoom({ price_per_night: 180 })]);
  const { plan } = alloc([mkPax("P1", { cabine: "Y", assistance: "WCHR" })], [ecoNonAccessible, premiumAccessible]);
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].hotel, "Hôtel prem");
  assert.match(plan[0].notes, /surclassement de tier Y → (W|J)/);
});

test("allocation : famille 2A+3C → 2 chambres même hôtel, note communicantes", () => {
  const rows = [mkPax("F1"), mkPax("F1"), mkPax("F1", { type_pax: "CHD", age: "5" }), mkPax("F1", { type_pax: "CHD", age: "7" }), mkPax("F1", { type_pax: "CHD", age: "9" })];
  const { plan } = alloc(rows, [mkHotel("eco", { stars: 3 })]);
  assert.equal(plan[0].chambres, 2);
  assert.equal(plan[0].statut, "OK");
  assert.match(plan[0].notes, /communicantes à confirmer/);
  assert.equal(plan[0].overlays, "FAMILLE");
});

test("allocation : unité familiale privilégie une chambre family_capable", () => {
  const rows = [mkPax("F1"), mkPax("F1"), mkPax("F1", { type_pax: "CHD", age: "5" })];
  const inv = [mkHotel("eco", { stars: 3 }, [mkRoom({ price_per_night: 55 }), mkRoom({ room_type: "Family Room", family_capable: true, price_per_night: 75 })])];
  const { plan } = alloc(rows, inv);
  assert.equal(plan[0].chambres, 1);
  assert.equal(plan[0].room_type, "Family Room");
});

test("allocation : borne rooms_available_max — la sonde étend le stock au-delà de l'affichage (EX-ALL-5)", () => {
  const affiché = [mkHotel("h", { stars: 3 }, [mkRoom({ quantity_available: 9, cap_reached: true })])];
  const sondé = [mkHotel("h", { stars: 3 }, [mkRoom({ quantity_available: 9, cap_reached: true, rooms_available_max: 14 })])];
  const quinze = Array.from({ length: 15 }, (_, i) => yPax(`P${i}`));
  const a = alloc(quinze, affiché);
  assert.equal(a.summary.ok, 9); // borne basse : dispo affichée
  assert.match(a.plan[0].notes, /borne basse/);
  const b = alloc(quinze, sondé);
  assert.equal(b.summary.ok, 14); // borne sonde
  assert.equal(b.summary.escalade, 1);
  assert.ok(!/borne basse/.test(b.plan[0].notes)); // sonde faite : plus d'avertissement
});

test("allocation : colonnes §5.7 — mode_reglement, hotel_source, provisoire, session_ref, transfert", () => {
  const contracté = mkHotel("ctr", { stars: 3 });
  contracté.contracted = true;
  const { plan } = alloc([yPax("P1")], [contracté], { provisoire: true, nights: 2 });
  const row = plan[0];
  assert.equal(row.mode_reglement, "compagnie"); // contracté → paiement compagnie (EX-INV-4)
  assert.equal(row.hotel_source, "contracted");
  assert.equal(row.provisoire, true);
  assert.equal(row.session_ref, "sess-ctr");
  assert.equal(row.transfert, "taxi, max 45 min");
  assert.equal(row.prix_total, 70 * 2); // nights appliqué
});

test("allocation : hôtel payable par carte → mode carte_prepayee ; carte désactivée → écarté, escalade motif règlement", () => {
  const surPlace = mkHotel("cash", { stars: 3, payment: { prepayment_online: "non", pay_at_property_only: true } });
  const { plan } = alloc([yPax("P1")], [surPlace]);
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].mode_reglement, "carte_prepayee");

  const sansCarte = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  sansCarte.payment.prepaid_card.enabled = false;
  const res = allocate({ dossiers: buildDossiers([yPax("P1")], sansCarte), inventories: [surPlace], policy: sansCarte, station: STATION_BKK });
  assert.equal(res.plan[0].statut, "ESCALADE DESK");
  assert.equal(res.plan[0].escalade, "DESK (règlement)");
});

test("allocation : pure et rejouable — mêmes entrées, même plan, entrées non mutées (EX-ALL-1)", () => {
  const inv = [mkHotel("eco", { stars: 3 }, [mkRoom({ quantity_available: 2 })])];
  const avant = JSON.stringify(inv);
  const rows = [yPax("P1"), yPax("P2"), yPax("P3")];
  const a = alloc(rows, inv);
  const b = alloc(rows, inv);
  assert.deepEqual(a.plan, b.plan);
  assert.equal(JSON.stringify(inv), avant); // aucun effet de bord sur les relevés
  assert.deepEqual(a.gaps.chambresManquantes, { Y: 1 });
});

test("allocation : l'accessibilité PMR survit à un hôtel non conforme au tier J", () => {
  const gate43 = mkHotel("gate43", {
    stars: 4,
    amenities: { wifi_free: true, room_service: "oui", workspace: false, airport_shuttle: "gratuite", restaurant_late: true, accessible: true },
  }, [mkRoom({ price_per_night: 45 })]);
  const { plan } = alloc([mkPax("P1", { cabine: "Y", assistance: "WCHR" })], [gate43]);
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].hotel, "Hôtel gate43");
});
