/**
 * C4/C6 — étalement des convocations au comptoir.
 *
 * Le planificateur de créneaux vivait dans `allocate.mjs` sans qu'aucun appelant ne lui
 * fournisse sa consigne : la fonction était morte et les 157 dossiers d'un A350 restaient
 * convoqués à la même minute. Ces tests verrouillent le câblage `policy → pipeline →
 * allocate → messages`, et surtout la règle du projet : **aucun horaire n'est inventé**
 * quand la consigne manque ou n'est pas exploitable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { consignePresentation } from "../lib/pipeline.mjs";
import { allocate } from "../lib/allocate.mjs";

const BKK = { timezone: "Asia/Bangkok", transfer: { default_mode: "taxi", max_transfer_min: 45 }, search: { radius_km: 5 } };
/** 2026-09-21T19:00Z = 2026-09-22 02:00 à Bangkok (UTC+7). */
const NOW = new Date("2026-09-21T19:00:00Z");

test("consigne : l'heure de début est calculée sur l'horloge de l'ESCALE, pas du serveur", () => {
  const c = consignePresentation(DEFAULT_POLICY, BKK, NOW);
  // 02:00 à Bangkok + delai_min (30) = 02:30 — et surtout pas l'heure UTC (19:00)
  assert.equal(c.debut, "02:30");
  assert.equal(c.timezone, "Asia/Bangkok");
  assert.equal(c.pas_minutes, DEFAULT_POLICY.global.presentation.pas_minutes);
});

test("consigne : une heure saisie prime sur le calcul", () => {
  const policy = PolicySchema.parse({
    ...DEFAULT_POLICY,
    global: { ...DEFAULT_POLICY.global, presentation: { ...DEFAULT_POLICY.global.presentation, debut: "05:45" } },
  });
  assert.equal(consignePresentation(policy, BKK, NOW).debut, "05:45");
});

test("consigne : option coupée = aucune consigne, donc aucun horaire (pas de repli inventé)", () => {
  const policy = PolicySchema.parse({
    ...DEFAULT_POLICY,
    global: { ...DEFAULT_POLICY.global, presentation: { ...DEFAULT_POLICY.global.presentation, enabled: false } },
  });
  assert.equal(consignePresentation(policy, BKK, NOW), null);
});

test("consigne : sans fiche escale exploitable, aucun horaire n'est produit", () => {
  // pas de fuseau → stationClock ne peut pas situer l'escale : on préfère l'absence de
  // créneau à un horaire calculé sur l'horloge d'un serveur qui peut être à Paris.
  const c = consignePresentation(DEFAULT_POLICY, { timezone: "Fuseau/Inexistant" }, NOW);
  assert.equal(c, null);
});

/** Deux hôtels relevés, de quoi loger tout le monde : le plan sert de support aux créneaux. */
function inventaireDeTest() {
  const hotel = (key, nom, chambres) => ({
    hotelKey: key,
    hotel: nom,
    answer: {
      found: true, name: nom, stars: 4, review_score: 8.4, distance_km: 3,
      amenities: { wifi_free: true, room_service: "24h", workspace: true, airport_shuttle: "gratuite", restaurant_late: true, accessible: true },
      rooms: [{ room_type: "Standard Double", price_per_night: 60, quantity_available: chambres, occupancy_adults: 2, occupancy_children: 0, breakfast_included: true, free_cancellation: true, cap_reached: false }],
      payment: { prepayment_online: "oui", pay_at_property_only: false },
    },
  });
  return [hotel("h1", "Hotel Alpha", 40), hotel("h2", "Hotel Beta", 40)];
}

const dossiers = Array.from({ length: 12 }, (_, i) => ({
  pnr: `PNR${String(i).padStart(3, "0")}`,
  cabin: "Y", adults: 1, children: 0, infants: 0, rooms: 1, pax: 1,
  occupants: [`Passager ${i}`], overlays: {}, familyUnit: false,
}));

test("allocation : sans consigne, aucune ligne ne porte de créneau", () => {
  const alloc = allocate({ dossiers, inventories: inventaireDeTest(), policy: DEFAULT_POLICY, station: BKK, nights: 1 });
  assert.ok(alloc.plan.length > 0);
  assert.ok(alloc.plan.every((r) => !r.creneau_presentation), "un créneau est apparu sans consigne");
});

test("allocation : avec consigne, tout dossier convoqué reçoit un créneau, et ils sont ÉTALÉS", () => {
  const presentation = consignePresentation(DEFAULT_POLICY, BKK, NOW);
  const alloc = allocate({ dossiers, inventories: inventaireDeTest(), policy: DEFAULT_POLICY, station: BKK, nights: 1, presentation });

  const convoques = alloc.plan.filter((r) => !r.hors_plan);
  assert.ok(convoques.length > 0);
  // forme CANONIQUE du contrat : un objet {debut, fin} en HH:MM locale escale.
  // C'est `creneauTexte()` (rapport.mjs) qui le met en « 02:30–02:45 » dans les CSV.
  for (const r of convoques) {
    const c = r.creneau_presentation;
    assert.ok(c && typeof c === "object", `créneau absent sur ${r.pnr}`);
    assert.match(c.debut, /^\d{2}:\d{2}$/);
    assert.match(c.fin, /^\d{2}:\d{2}$/);
  }

  // le point de tout l'exercice : plusieurs créneaux distincts, pas une convocation unique
  const distincts = new Set(convoques.map((r) => `${r.creneau_presentation.debut}–${r.creneau_presentation.fin}`));
  assert.ok(distincts.size > 1, `tous les dossiers convoqués à la même minute (${[...distincts]})`);

  // le premier créneau part bien de l'heure calculée pour l'escale
  assert.ok([...distincts].some((c) => c.startsWith(presentation.debut)), `aucun créneau ne commence à ${presentation.debut}`);
});

test("allocation : une consigne fournie mais illisible ne passe JAMAIS en silence", () => {
  const alloc = allocate({
    dossiers, inventories: inventaireDeTest(), policy: DEFAULT_POLICY, station: BKK, nights: 1,
    presentation: { debut: "pas une heure", pas_minutes: 15 },
  });
  assert.ok(alloc.plan.every((r) => !r.creneau_presentation), "un horaire a été inventé sur une consigne illisible");
  const dit = (alloc.summary?.avertissements ?? []).some((m) => /créneau/i.test(m));
  assert.ok(dit, "aucun avertissement sur une consigne de créneaux illisible");
});
