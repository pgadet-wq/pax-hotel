/**
 * Fabriques partagées des tests unitaires — hors ligne, zéro API.
 * (Pas de suffixe .test.mjs : ce fichier n'est pas exécuté par node --test.)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Racine du dépôt (chemins de fixtures indépendants du cwd). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Fiche escale BKK minimale (les fiches complètes arrivent en phase 2). */
export const STATION_BKK = {
  code: "BKK",
  name: "Bangkok Suvarnabhumi",
  country: "TH",
  timezone: "Asia/Bangkok",
  search: { zone_query: "Suvarnabhumi Airport Bangkok", radius_km: 5, distance_ref: "airport", use_distance_filter: true, extra_nflt: [] },
  transfer: { default_mode: "taxi", max_transfer_min: 45, note: "" },
  constraints: { entry_visa_check: true, transit_hotel_airside: true, notes: "" },
  pricing: { price_cap_factor: 1.0 },
  fallback_hotels: [],
  demo_priority: 1,
};

export const mkRoom = (over = {}) => ({
  room_type: "Twin Room",
  occupancy_adults: 2,
  occupancy_children: 0,
  quantity_available: 9,
  quantity_displayed_max: 9,
  cap_reached: false,
  price_per_night: 70,
  free_cancellation: true,
  breakfast_included: false,
  family_capable: false,
  ...over,
});

export const mkHotel = (key, over = {}, rooms = [mkRoom()]) => ({
  hotel: key,
  name: key,
  sessionId: `sess-${key}`,
  status: "completed",
  answer: {
    hotel: `Hôtel ${key}`,
    url: `https://example.test/${key}`,
    found: true,
    checkin: "2026-10-04",
    checkout: "2026-10-05",
    currency: "EUR",
    price_currency: "EUR",
    stars: 4,
    review_score: 8.2,
    review_count: 1200,
    distance_km: 1.2,
    distance_ref: "airport",
    source: "platform",
    amenities: {
      wifi_free: true,
      room_service: "24h",
      workspace: true,
      airport_shuttle: "gratuite",
      restaurant_late: true,
      accessible: false,
    },
    payment: { prepayment_online: "oui", pay_at_property_only: false },
    observed_at: "2026-10-03T08:00:00Z",
    rooms,
    notes: "",
    ...over,
  },
});

export const mkPax = (pnr, over = {}) => ({
  pnr, nom: "TEST", prenom: "Pax", type_pax: "ADT", age: "40",
  cabine: "Y", flying_blue: "NONE", assistance: "", remarque: "", ...over,
});
