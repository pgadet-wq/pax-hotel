/**
 * Adaptateur LiteAPI : invariants, sémantique de capacité, et les trois règles nées de
 * la mesure du 22/09/2026.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  distanceKm, chambresDeHotel, toReleveRecord, toReleveRecords,
  chercherOffres, LIMIT_MAX, LIMIT_RECOUPE,
} from "../lib/liteapi.mjs";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(ICI, "..", "lib", "liteapi.mjs"), "utf8");

/* ------------------------------------------------------------------- INV-1 */

test("INV-1 : l'adaptateur n'appelle aucun point d'entrée de réservation", () => {
  // seuls /data/hotels et /hotels/rates sont permis ; toute apparition d'un verbe
  // transactionnel dans du CODE (hors commentaire) doit faire échouer ce test
  const code = SRC.split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  for (const interdit of ["/prebook", "/book", "/payments", "/orders"]) {
    assert.equal(code.includes(interdit), false, `point d'entrée interdit trouvé : ${interdit}`);
  }
  assert.ok(code.includes("/hotels/rates"), "le point d'entrée de recherche doit être présent");
});

test("INV-3 : le prix retenu est le tarif public, jamais la commission", () => {
  const rooms = chambresDeHotel(
    {
      roomTypes: [{
        rates: [{
          name: "Deluxe", occupancyNumber: 1, adultCount: 2, maxOccupancy: 2,
          retailRate: { total: [{ amount: 120, currency: "EUR" }] },
          commission: [{ amount: 18, currency: "EUR" }],
        }],
      }],
    },
    { chambresDemandees: 1, nuits: 1 },
  );
  assert.equal(rooms[0].price_per_night, 120);
});

/* --------------------------------------------------------------- géométrie */

test("distanceKm mesure, et rend null sans coordonnées", () => {
  // Suvarnabhumi -> Novotel de l'aérogare : environ 1 km
  const d = distanceKm(13.69, 100.7501, 13.6966, 100.7501);
  assert.ok(d !== null && d > 0 && d < 2, `distance inattendue : ${d}`);
  assert.equal(distanceKm(13.69, 100.75, null, undefined), null);
  assert.equal(distanceKm(undefined, undefined, 1, 2), null);
});

/* ----------------------------------------------- capacité : créneaux servis */

test("la quantité est le nombre de CRÉNEAUX servis, la seule mesure possible", () => {
  const rate = (n, nom, prix) => ({
    name: nom, occupancyNumber: n, adultCount: 2, maxOccupancy: 2,
    retailRate: { total: [{ amount: prix, currency: "EUR" }] },
  });
  const rooms = chambresDeHotel(
    { roomTypes: [{ rates: [rate(1, "Twin", 100), rate(2, "Twin", 100), rate(3, "Twin", 100)] }] },
    { chambresDemandees: 5, nuits: 1 },
  );
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].quantity_available, 3, "trois créneaux distincts servis");
  assert.equal(rooms[0].cap_reached, false, "3 < 5 demandées : c'est une MESURE FERME");
});

test("un type qui sert tous les créneaux demandés est une BORNE BASSE, pas une mesure", () => {
  const rate = (n) => ({
    name: "Twin", occupancyNumber: n, adultCount: 2, maxOccupancy: 2,
    retailRate: { total: [{ amount: 100, currency: "EUR" }] },
  });
  const rooms = chambresDeHotel({ roomTypes: [{ rates: [rate(1), rate(2)] }] }, { chambresDemandees: 2, nuits: 1 });
  assert.equal(rooms[0].quantity_available, 2);
  assert.equal(rooms[0].cap_reached, true, "on a demandé 2 et obtenu 2 : il y en a peut-être plus");
});

test("le prix est ramené à la NUIT (retailRate.total est un total de séjour)", () => {
  const rooms = chambresDeHotel(
    {
      roomTypes: [{
        rates: [{
          name: "Suite", occupancyNumber: 1, adultCount: 2, maxOccupancy: 2,
          retailRate: { total: [{ amount: 300, currency: "EUR" }] },
        }],
      }],
    },
    { chambresDemandees: 1, nuits: 3 },
  );
  assert.equal(rooms[0].price_per_night, 100);
});

test("une ligne sans prix lisible est écartée, jamais complétée", () => {
  const rooms = chambresDeHotel(
    { roomTypes: [{ rates: [{ name: "Sans prix", occupancyNumber: 1 }, { name: "Avec prix", occupancyNumber: 1, retailRate: { total: [{ amount: 90, currency: "EUR" }] } }] }] },
    { chambresDemandees: 1, nuits: 1 },
  );
  assert.deepEqual(rooms.map((r) => r.room_type), ["Avec prix"]);
});

/* ------------------------------------------------------- forme de la fixture */

const hotelBrut = {
  hotelId: "lp123",
  roomTypes: [{
    rates: [{
      name: "Superior Twin", occupancyNumber: 1, adultCount: 2, childCount: 0, maxOccupancy: 2,
      boardType: "BB", retailRate: { total: [{ amount: 95, currency: "EUR" }] },
      cancellationPolicies: { refundableTag: "RFN" },
    }],
  }],
};

test("l'enregistrement a la forme que fixturesCollect consomme", () => {
  const rec = toReleveRecord(hotelBrut, { id: "lp123", name: "Hôtel Test", latitude: 13.6966, longitude: 100.7501, stars: 4, rating: 8.1, reviewCount: 900 }, {
    checkin: "2026-09-22", checkout: "2026-09-23", nuits: 1, chambresDemandees: 1,
    station: { lat: 13.69, lon: 100.7501 },
  });
  for (const k of ["hotel", "sessionId", "createdAt", "status", "outcome", "error", "answer"]) {
    assert.ok(k in rec, `clé manquante : ${k}`);
  }
  for (const k of ["hotel", "url", "found", "checkin", "checkout", "currency", "source", "stars", "review_score", "distance_km", "distance_ref", "amenities", "payment", "rooms", "notes"]) {
    assert.ok(k in rec.answer, `clé de relevé manquante : ${k}`);
  }
  assert.equal(rec.sessionId, null, "aucune session d'agent");
  assert.equal(rec.answer.rooms[0].breakfast_included, true, "BB = petit-déjeuner");
  assert.equal(rec.answer.rooms[0].free_cancellation, true, "RFN = remboursable");
});

test("la distance PORTE sa référence — c'est ce qui manquait aux fiches d'inventaire", () => {
  const avec = toReleveRecord(hotelBrut, { id: "lp123", name: "H", latitude: 13.6966, longitude: 100.7501 }, {
    station: { lat: 13.69, lon: 100.7501 }, chambresDemandees: 1, nuits: 1,
  });
  assert.ok(avec.answer.distance_km > 0);
  assert.equal(avec.answer.distance_ref, "airport", "sans référence, l'hôtel part en couronne la plus lointaine");

  const sans = toReleveRecord(hotelBrut, { id: "lp123", name: "H" }, { station: { lat: 13.69, lon: 100.7501 }, chambresDemandees: 1, nuits: 1 });
  assert.equal(sans.answer.distance_km, -1);
  assert.equal(sans.answer.distance_ref, null, "pas de coordonnées : on ne prétend pas avoir mesuré");
});

test("ce que l'API ne publie pas reste non_precise, jamais déduit", () => {
  const rec = toReleveRecord(hotelBrut, { id: "lp123", name: "H" }, { chambresDemandees: 1, nuits: 1 });
  assert.equal(rec.answer.amenities.room_service, "non_precise");
  assert.equal(rec.answer.amenities.workspace, "non_precise");
  assert.equal(rec.answer.amenities.airport_shuttle, "non_precise");
  assert.equal(rec.answer.amenities.wifi_free, false);
});

test("le bac à sable est DIT dans les notes du relevé", () => {
  const rec = toReleveRecord(hotelBrut, { id: "lp123", name: "H" }, { chambresDemandees: 1, nuits: 1, sandbox: true });
  assert.match(rec.answer.notes, /BAC À SABLE/);
});

test("un hôtel sans chambre exploitable ne pollue pas le vivier", () => {
  const recs = toReleveRecords({
    offres: [hotelBrut, { hotelId: "vide", roomTypes: [] }],
    fiches: [{ id: "lp123", name: "H" }, { id: "vide", name: "Vide" }],
    ctx: { chambresDemandees: 1, nuits: 1 },
  });
  assert.equal(recs.length, 1);
});

/* ------------------------------------------- les trois règles de la mesure */

/** fetch factice : rend `data` selon le `limit` reçu. */
const faussefetch = (parLimit) => async (_url, init) => {
  const body = JSON.parse(init.body);
  const data = parLimit[body.limit] ?? [];
  return { ok: true, status: 200, text: async () => JSON.stringify({ data, sandbox: true }) };
};

test("règle 1 : limit est plafonné à 40, avec avertissement", async () => {
  const vu = [];
  const f = async (_url, init) => {
    vu.push(JSON.parse(init.body).limit);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ hotelId: "a", roomTypes: [{}] }] }) };
  };
  const r = await chercherOffres({ lat: 1, lon: 2, rayonM: 1000, checkin: "2026-09-22", checkout: "2026-09-23", chambres: 5, limit: 200, cle: "x", fetchImpl: f });
  assert.equal(vu[0], LIMIT_MAX);
  assert.match(r.avertissements.join(" "), /limit ramené de 200 à 40/);
});

test("règle 3 : un ZÉRO est recoupé, et le mensonge est dit en toutes lettres", async () => {
  // exactement le comportement mesuré : rien à 40, mais 2 hôtels à 20
  const f = faussefetch({ [LIMIT_MAX]: [], [LIMIT_RECOUPE]: [{ hotelId: "a", roomTypes: [{}] }, { hotelId: "b", roomTypes: [{}] }] });
  const r = await chercherOffres({ lat: 1, lon: 2, rayonM: 1000, checkin: "2026-09-22", checkout: "2026-09-23", chambres: 5, cle: "x", fetchImpl: f });
  assert.equal(r.hotels.length, 2, "le résultat du recoupement doit primer sur le zéro");
  assert.equal(r.limitUtilise, LIMIT_RECOUPE);
  assert.match(r.avertissements.join(" "), /zéro non mérité/);
});

test("règle 3 : un zéro CONFIRMÉ par recoupement est annoncé comme tel", async () => {
  const f = faussefetch({ [LIMIT_MAX]: [], [LIMIT_RECOUPE]: [] });
  const r = await chercherOffres({ lat: 1, lon: 2, rayonM: 1000, checkin: "2026-09-22", checkout: "2026-09-23", chambres: 9, cle: "x", fetchImpl: f });
  assert.equal(r.hotels.length, 0);
  assert.match(r.avertissements.join(" "), /confirmé par recoupement/);
});

test("règle 2 : un échec transitoire est rejoué et non propagé", async () => {
  let n = 0;
  const f = async () => {
    n += 1;
    if (n < 3) throw new Error("réseau");
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ hotelId: "a", roomTypes: [{}] }] }) };
  };
  const r = await chercherOffres({ lat: 1, lon: 2, rayonM: 1000, checkin: "2026-09-22", checkout: "2026-09-23", chambres: 2, cle: "x", fetchImpl: f });
  assert.equal(r.hotels.length, 1);
  assert.equal(n, 3, "les deux premiers essais ont échoué, le troisième a réussi");
});
