/**
 * Tests hai (CDC §5.6, §6.5) : schémas plats, convertisseurs (payment, cap_reached,
 * observed_at), prompts FR — garde-fous INV-1/INV-2 et EX-PRO-1 (aucune valeur
 * passager dans aucun prompt).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releveSchema, discoverySchema, probeSchema, inventaireHotelSchema,
  toReleveAnswer, toDiscoveryCandidates, toInventaireEntry, agentNameV2,
  promptDiscovery, promptReleve, promptProbe, promptInventaireHotel, buildNflt,
} from "../lib/hai.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { loadStation } from "../lib/stations.mjs";

const flatReleve = {
  hotel: "Hyatt Regency", found: true, currency: "EUR",
  stars: 5, review_score: 8.9, review_count: 2148, distance_km: 1.5,
  amenity_wifi: true, amenity_room_service: "24h", amenity_workspace: "oui",
  amenity_shuttle: "gratuite", amenity_restaurant_late: true, amenity_accessible: true,
  payment_prepayment_online: "oui", payment_pay_at_property_only: "non",
  rooms: [
    { room_type: "Twin", occupancy_adults: 2, occupancy_children: 0, quantity_available: 9, cap_reached: true, price_per_night: 151, free_cancellation: true, breakfast_included: false, family_capable: false },
  ],
  notes: "",
};

test("hai : releveSchema accepte la réponse plate ; toReleveAnswer reconstruit le relevé v2 (§5.6)", () => {
  assert.equal(releveSchema.safeParse(flatReleve).success, true);
  const a = toReleveAnswer(flatReleve, { url: "https://www.booking.com/hotel/th/h.html", checkin: "2026-10-04", checkout: "2026-10-05", observedAt: "2026-10-03T08:00:00Z" });
  assert.equal(a.payment.prepayment_online, "oui");
  assert.equal(a.payment.pay_at_property_only, false); // enum « non » → false
  assert.equal(a.observed_at, "2026-10-03T08:00:00Z"); // EX-REL-2, horodaté côté code
  assert.equal(a.rooms[0].quantity_displayed_max, 9);
  assert.equal(a.rooms[0].cap_reached, true);
  assert.equal(a.price_currency, "EUR");
  // horodatage automatique si absent
  assert.ok(toReleveAnswer(flatReleve, {}).observed_at.includes("T"));
  // pay_at_property non précisé → null
  const np = toReleveAnswer({ ...flatReleve, payment_pay_at_property_only: "non_precise" }, {});
  assert.equal(np.payment.pay_at_property_only, null);
  assert.equal(toReleveAnswer(null, {}), null);
});

test("hai : probeSchema et inventaireHotelSchema valident leurs réponses plates", () => {
  assert.equal(probeSchema.safeParse({ hotel: "H", found: true, requested_rooms: 12, rooms_selectable_max: 14, cap_reached: false, notes: "" }).success, true);
  const flat = {
    hotel: "H", found: true, url: "https://www.booking.com/hotel/th/h.html", stars: 4, review_score: 8.1, review_count: 3120,
    distance_km: 1.2, amenity_wifi: true, amenity_room_service: "24h", amenity_workspace: "oui", amenity_shuttle: "gratuite",
    amenity_restaurant_late: true, amenity_accessible: true, breakfast_available: true, family_capable: true,
    payment_prepayment_online: "oui", payment_pay_at_property_only: "non", indicative_price_from_eur: 92,
    rooms_displayed_max: 9, cap_reached: true, notes: "",
  };
  assert.equal(inventaireHotelSchema.safeParse(flat).success, true);
  const entry = toInventaireEntry(flat, { id: "h-test", observedAt: "2026-09-15T10:00:00Z" });
  assert.equal(entry.id, "h-test");
  assert.equal(entry.amenities.breakfast_available, true);
  assert.deepEqual(entry.capacity_hint, { rooms_displayed_max: 9, cap_reached: true, observed_at: "2026-09-15T10:00:00Z" });
  assert.equal(toInventaireEntry({ ...flat, found: false }, { id: "x" }), null);
});

test("hai : toDiscoveryCandidates normalise les cartes (0 → null, badges → liste)", () => {
  const flat = { currency: "EUR", candidates: [{ name: "A", url: "", stars: 0, review_score: 8.2, price_from_per_night: 0, distance_km: -1, badges: "Wifi, Navette", premium_pass: true, address: "", phone: "", website: "" }], notes: "" };
  assert.equal(discoverySchema.safeParse(flat).success, true);
  const [c] = toDiscoveryCandidates(flat);
  assert.equal(c.stars, null);
  assert.equal(c.price_from_per_night, null);
  assert.equal(c.distance_km, null);
  assert.deepEqual(c.amenities_seen, ["Wifi", "Navette"]);
  assert.equal(c.premium_pass, true);
});

test("hai : discoverySchema accepte une carte d'ANNUAIRE — adresse et téléphone, sans URL ni prix", () => {
  // Contrat de la source `maps` (21/09) : elle ne rend NI fiche réservable NI prix public,
  // mais elle rend le téléphone — la seule donnée qui permette d'appeler un établissement
  // présent sur aucune plateforme.
  const flat = {
    currency: "",
    candidates: [{
      name: "Orchid Garden Place", url: "", stars: 3, review_score: 7.8,
      price_from_per_night: 0, distance_km: -1, badges: "hôtel 3 étoiles", premium_pass: false,
      address: "12 Kingkaew Rd, Bang Phli, Samut Prakan", phone: "+66 2 555 0000", website: "https://orchidgarden.example",
    }],
    notes: "",
  };
  assert.equal(discoverySchema.safeParse(flat).success, true);
  const [c] = toDiscoveryCandidates(flat);
  assert.equal(c.price_from_per_night, null, "aucun prix public depuis un annuaire");
  assert.equal(c.distance_km, null);
});

test("hai : agent v2 nommé par escale, v1 intacte (INV-6)", () => {
  assert.equal(agentNameV2(loadStation("BKK")), "hotel-scout-bkk-v2");
  assert.equal(agentNameV2(loadStation("NOU")), "hotel-scout-nou-v2");
});

test("prompts : garde-fous INV-1/INV-2 présents dans chaque squelette (§6.5)", () => {
  const station = loadStation("BKK");
  const nflt = buildNflt(DEFAULT_POLICY, station);
  const prompts = [
    promptDiscovery({ station, checkin: "2026-10-04", checkout: "2026-10-05", nflt }),
    promptReleve({ hotelName: "Hyatt Regency", hasStartUrl: true, checkin: "2026-10-04", checkout: "2026-10-05" }),
    promptReleve({ hotelName: "Hyatt Regency", hasStartUrl: false, checkin: "2026-10-04", checkout: "2026-10-05" }),
    promptProbe({ hotelName: "Hyatt Regency", requestedRooms: 12, checkin: "2026-10-04", checkout: "2026-10-05" }),
    promptInventaireHotel({ hotelName: "Hyatt Regency", hasStartUrl: true, checkin: "2026-10-04", checkout: "2026-10-05" }),
  ];
  for (const p of prompts) {
    assert.match(p, /réserver/i, "INV-1 : l'interdiction de réserver doit être rappelée");
    assert.match(p, /CAPTCHA/, "INV-2 : la consigne CAPTCHA doit être rappelée");
    assert.match(p, /outcome blocked/);
  }
  // la sonde ne mentionne qu'URL implicite + nombre de chambres (EX-EXT-5)
  assert.match(prompts[3], /12 chambres/);
  assert.match(prompts[3], /24 adultes/);
});

test("prompts : EX-PRO-1 — aucune valeur passager (pnr, nom, prénom, assistance, remarque) dans aucun prompt", () => {
  const { rows } = generatePassengers({ seats: { J: 10, W: 8, Y: 40 }, seed: 42, fill: "exact" });
  const station = loadStation("BKK");
  const nflt = buildNflt(DEFAULT_POLICY, station);
  const corpus = [
    promptDiscovery({ station, checkin: "2026-10-04", checkout: "2026-10-05", nflt }),
    promptReleve({ hotelName: "Novotel Bangkok Suvarnabhumi Airport", hasStartUrl: true, checkin: "2026-10-04", checkout: "2026-10-05" }),
    promptProbe({ hotelName: "Novotel Bangkok Suvarnabhumi Airport", requestedRooms: 30, checkin: "2026-10-04", checkout: "2026-10-05" }),
    promptInventaireHotel({ hotelName: "Novotel Bangkok Suvarnabhumi Airport", hasStartUrl: false, checkin: "2026-10-04", checkout: "2026-10-05" }),
  ].join("\n---\n");
  for (const row of rows) {
    for (const col of ["pnr", "nom", "prenom", "assistance", "remarque"]) {
      const val = String(row[col] ?? "").trim();
      if (val.length < 3) continue; // vides et codes d'une lettre : non significatifs
      assert.ok(!corpus.includes(val), `valeur passager « ${val} » (${col}) trouvée dans un prompt`);
    }
  }
});

/* ----------------------------------------------- phase 5 : client réel, H-9 */

test("hai : ensureAgentV2 aligne le modèle d'un agent existant sur la politique (H-9)", async () => {
  const { ensureAgentV2 } = await import("../lib/hai.mjs");
  const station = loadStation("BKK");
  const calls = [];
  const clientAvec = (model) => ({
    agents: {
      getAgent: async () => ({ name: "hotel-scout-bkk-v2", model }),
      patchAgent: async (req) => calls.push(["patch", req]),
      createAgent: async (req) => calls.push(["create", req]),
    },
  });

  // modèle différent → patch vers agents.model_stage_ab
  const created = await ensureAgentV2(clientAvec(null), station, DEFAULT_POLICY);
  assert.equal(created, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "patch");
  assert.deepEqual(calls[0][1], { agentName: "hotel-scout-bkk-v2", model: DEFAULT_POLICY.agents.model_stage_ab });

  // modèle déjà aligné → aucun appel
  calls.length = 0;
  await ensureAgentV2(clientAvec(DEFAULT_POLICY.agents.model_stage_ab), station, DEFAULT_POLICY);
  assert.equal(calls.length, 0);

  // « auto » → jamais de patch (modèle plateforme respecté)
  calls.length = 0;
  await ensureAgentV2(clientAvec("autre-modele"), station, { ...DEFAULT_POLICY, agents: { ...DEFAULT_POLICY.agents, model_stage_ab: "auto" } });
  assert.equal(calls.length, 0);

  // absent → création avec le modèle de la politique
  calls.length = 0;
  const clientSans = {
    agents: {
      getAgent: async () => { throw new Error("404"); },
      patchAgent: async (req) => calls.push(["patch", req]),
      createAgent: async (req) => calls.push(["create", req]),
    },
  };
  const wasCreated = await ensureAgentV2(clientSans, station, DEFAULT_POLICY);
  assert.equal(wasCreated, true);
  assert.equal(calls[0][0], "create");
  assert.equal(calls[0][1].model, DEFAULT_POLICY.agents.model_stage_ab);
});

test("hai : DEFAULT_POLICY porte les modèles du plan H relevés en phase 0 (§16, H-9)", () => {
  assert.equal(DEFAULT_POLICY.agents.model_stage_ab, "holo3-122b-a10b"); // Holo3 122B (§16)
  assert.equal(DEFAULT_POLICY.agents.model_probe, "holo3-1-35b-a3b"); // Holo3.1 35B, classe flash
  assert.equal(DEFAULT_POLICY.agents.concurrency, "auto"); // maximum du plan, plafond 6
  assert.equal(DEFAULT_POLICY.agents.stagger_ms, 10000);
});

test("hai : pumpToCompletion annule la session à l'abandon du signal (annulation réelle)", async () => {
  const { pumpToCompletion } = await import("../lib/hai.mjs");
  const ac = new AbortController();
  let cancelled = false;
  const handle = {
    id: "sess-x",
    async *stream() {
      yield { type: "AgentRunStatusChangeEvent", data: { status: "running" } };
      ac.abort();
    },
    async waitForCompletion() {
      return { id: "sess-x", status: "cancelled", answer: null };
    },
    async cancel() {
      cancelled = true;
    },
  };
  const result = await pumpToCompletion(handle, () => {}, { signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, true, "cancel() attendu à l'abandon du signal");
  assert.equal(result.status, "cancelled");
});
