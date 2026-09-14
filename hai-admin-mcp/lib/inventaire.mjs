/**
 * Inventaire hôtelier par escale (CDC §5.3) — schéma, chargement, fusion,
 * péremption, candidats. Tout est hors ligne : l'Étage 0 par agents (phase 3)
 * produira des inventaires « frais » passés à `mergeInventaire`.
 *
 * Règles : EX-INV-1 (le manuel n'est jamais modifié, les drapeaux utilisateur
 * survivent), EX-INV-2 (péremption), EX-INV-3 (ordre des candidats + repli fiche
 * escale), EX-INV-4 (`company_payment_possible` — recalculé, jamais lu de confiance).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { companyPaymentPossible } from "./reglement.mjs";
import { effectiveCaps } from "./policy.mjs";
import { KNOWN_STATIONS } from "./scenario.mjs";

/** Répertoire des inventaires (résolu depuis ce fichier, jamais le cwd). */
export const INVENTAIRE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "inventaire");

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "horodatage ISO 8601 UTC attendu");

const HotelEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/, "id en minuscules [a-z0-9-]"),
  name: z.string().min(1),
  url: z.string().default(""),
  source: z.enum(["agent", "manuel"]),
  contracted: z.boolean().default(false),
  preferred: z.boolean().default(false),
  excluded: z.boolean().default(false),
  stars: z.number().int().min(0).max(5).nullable().default(null),
  review_score: z.number().min(0).max(10).nullable().default(null),
  review_count: z.number().int().min(0).nullable().default(null),
  distance_km: z.number().nullable().default(null),
  distance_ref: z.enum(["airport", "zone_center"]).nullable().default(null),
  amenities: z
    .object({
      wifi_free: z.boolean().nullable().default(null),
      room_service: z.enum(["24h", "oui", "non", "non_precise"]).nullable().default(null),
      workspace: z.enum(["oui", "non", "non_precise"]).nullable().default(null),
      airport_shuttle: z.enum(["gratuite", "payante", "non", "non_precise"]).nullable().default(null),
      restaurant_late: z.boolean().nullable().default(null),
      accessible: z.boolean().nullable().default(null),
      breakfast_available: z.boolean().nullable().default(null),
      family_capable: z.boolean().nullable().default(null),
    })
    .default({}),
  payment: z
    .object({
      prepayment_online: z.enum(["oui", "non", "non_precise"]).default("non_precise"),
      pay_at_property_only: z.boolean().nullable().default(null),
      // recalculé par normalisation (EX-INV-4) : une valeur stockée n'est jamais crue
      company_payment_possible: z.enum(["oui", "non", "a_confirmer"]).optional(),
    })
    .default({}),
  indicative_price_from_eur: z.number().positive().nullable().default(null),
  capacity_hint: z
    .object({
      rooms_displayed_max: z.number().int().min(0).nullable().default(null),
      cap_reached: z.boolean().nullable().default(null),
      observed_at: iso.nullable().default(null),
    })
    .nullable()
    .default(null),
  contact: z.object({ phone: z.string().nullable().default(null), email: z.string().nullable().default(null) }).default({}),
  notes: z.string().default(""),
  last_survey_at: iso.nullable().default(null),
});

export const InventaireSchema = z.object({
  station: z.enum(KNOWN_STATIONS),
  updated_at: iso.nullable().default(null), // null = jamais rafraîchi (inventaire vide valide)
  reference: z.object({ checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), nights: z.number().int().min(1) }).nullable().default(null),
  hotels: z.array(HotelEntrySchema).default([]),
});

/** Valide un inventaire et recalcule `company_payment_possible` sur chaque entrée (EX-INV-4). */
export function normalizeInventaire(raw, sourceName = "inventaire") {
  const parsed = InventaireSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ");
    throw new Error(`${sourceName} invalide : ${detail}`);
  }
  const inv = parsed.data;
  const ids = new Set();
  for (const h of inv.hotels) {
    if (ids.has(h.id)) throw new Error(`${sourceName} : id d'hôtel en double (${h.id})`);
    ids.add(h.id);
    h.payment.company_payment_possible = companyPaymentPossible({
      contracted: h.contracted,
      payment: { prepayment_online: h.payment.prepayment_online, pay_at_property_only: h.payment.pay_at_property_only },
    });
  }
  return inv;
}

/** Charge l'inventaire d'une escale ; null si le fichier n'existe pas encore. */
export function loadInventaire(code, { dir = INVENTAIRE_DIR } = {}) {
  const upper = String(code ?? "").toUpperCase();
  const file = path.join(dir, `${upper}.json`);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Inventaire ${upper} illisible (${file}) : ${err.message}`);
  }
  const inv = normalizeInventaire(raw, `data/inventaire/${upper}.json`);
  if (inv.station !== upper) throw new Error(`Inventaire ${file} : champ station (${inv.station}) ≠ nom du fichier`);
  return inv;
}

/** EX-INV-2 : périmé si absent, jamais rafraîchi, ou plus vieux que inventory.max_age_days. */
export function isStale(inv, policy, now = new Date()) {
  if (!inv || !inv.updated_at) return true;
  const age = now.getTime() - new Date(inv.updated_at).getTime();
  return age > policy.inventory.max_age_days * 86_400_000;
}

/**
 * EX-INV-1 : fusion d'un inventaire frais (Étage 0 ou fixtures) dans l'existant.
 * - une entrée `source: "manuel"` existante n'est NI supprimée NI modifiée ;
 * - une entrée `agent` existante est mise à jour par `id`, ses drapeaux
 *   `contracted / preferred / excluded` (posés par l'utilisateur) sont conservés ;
 * - une entrée nouvelle est ajoutée ; une entrée existante absente du frais est
 *   conservée (la péremption se juge par `updated_at`, pas par disparition).
 */
export function mergeInventaire(existing, fresh) {
  const freshInv = normalizeInventaire(fresh, "inventaire frais");
  const existingInv = existing === null || existing === undefined ? null : normalizeInventaire(existing, "inventaire existant");
  if (existingInv && existingInv.station !== freshInv.station) {
    throw new Error(`mergeInventaire : escales différentes (${existingInv.station} ≠ ${freshInv.station})`);
  }

  const merged = {
    station: freshInv.station,
    updated_at: freshInv.updated_at ?? existingInv?.updated_at ?? null,
    reference: freshInv.reference ?? existingInv?.reference ?? null,
    hotels: [],
  };

  const freshById = new Map(freshInv.hotels.map((h) => [h.id, h]));
  const seen = new Set();
  for (const prev of existingInv?.hotels ?? []) {
    seen.add(prev.id);
    const next = freshById.get(prev.id);
    if (prev.source === "manuel" || !next) {
      merged.hotels.push(prev); // manuel intouchable ; agent non revisité conservé
    } else {
      merged.hotels.push({ ...next, contracted: prev.contracted, preferred: prev.preferred, excluded: prev.excluded });
    }
  }
  for (const h of freshInv.hotels) if (!seen.has(h.id)) merged.hotels.push(h);

  return normalizeInventaire(merged, "inventaire fusionné");
}

/** Slug d'un nom d'hôtel (ids des entrées de repli). */
export function slugify(name) {
  return String(name)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 60) || "hotel";
}

/** Valeur d'une prestation d'inventaire pour une exigence de la politique : true / "partial" / false. */
function amenityState(entry, key) {
  const a = entry.amenities ?? {};
  switch (key) {
    case "wifi_free": return a.wifi_free === true ? true : a.wifi_free === false ? false : "partial";
    case "room_service_24h":
      return a.room_service === "24h" ? true : a.room_service === "non" ? false : "partial";
    case "workspace": return a.workspace === "oui" ? true : a.workspace === "non" ? false : "partial";
    case "breakfast_available":
      return a.breakfast_available === true ? true : a.breakfast_available === false ? false : "partial";
    case "airport_shuttle":
      return a.airport_shuttle === "gratuite" || a.airport_shuttle === "payante" ? true : a.airport_shuttle === "non" ? false : "partial";
    case "restaurant_late": return a.restaurant_late === true ? true : a.restaurant_late === false ? false : "partial";
    case "accessible": return a.accessible === true ? true : a.accessible === false ? false : "partial";
    default: throw new Error(`prestation inconnue : ${key}`);
  }
}

/**
 * Tiers auxquels une entrée d'inventaire peut prétendre : étoiles connues sous le
 * minimum ou prestation requise explicitement absente → tier exclu ; l'inconnu
 * (`null`, `non_precise`) reste compatible « à confirmer » (EX-DIS-1, phase 3).
 */
export function compatibleTiers(entry, policy) {
  const tiers = [];
  for (const tier of ["J", "W", "Y"]) {
    const tp = policy.cabins[tier];
    if (entry.stars !== null && entry.stars > 0 && entry.stars < tp.min_stars) continue;
    if (tp.required_amenities.some((req) => amenityState(entry, req) === false)) continue;
    tiers.push(tier);
  }
  return tiers;
}

/** Score souple d'une entrée d'inventaire pour un tier (mêmes poids qu'EX-ALL-3). */
function entryScore(entry, tier, policy, station, caps) {
  const w = policy.global.scoring;
  const tp = policy.cabins[tier];
  const review = entry.review_score === null ? 0 : Math.max(0, Math.min(10, entry.review_score)) / 10;
  const fitStars = (() => {
    if (!entry.stars) return 0.5;
    const max = tp.max_stars ?? 5;
    if (entry.stars >= tp.min_stars && entry.stars <= max) return 1;
    return entry.stars > max ? 0.6 : 0;
  })();
  const radius = station?.search?.radius_km ?? 5;
  const distScore = entry.distance_km !== null && entry.distance_km >= 0 ? Math.max(0, 1 - entry.distance_km / radius) : 0.5;
  const price = entry.indicative_price_from_eur;
  const headroom = price !== null && price <= caps[tier] ? Math.max(0, (caps[tier] - price) / caps[tier]) : 0;
  let score = w.w_review * review + w.w_stars_fit * fitStars + w.w_distance * distScore + w.w_price_headroom * headroom;
  for (const nice of tp.nice_to_have) if (amenityState(entry, nice) === true) score += 0.02;
  return score;
}

/**
 * EX-INV-3 : candidats aux relevés — hôtels non `excluded`, ordonnés
 * `contracted` → `preferred` → score souple décroissant (meilleur tier en besoin).
 * Les `fallback_hotels` de la fiche escale sont ajoutés en fin de liste s'ils n'y
 * figurent pas (entrées minimales marquées `fallback: true`).
 *
 * @param {object|null} inv inventaire normalisé (null accepté : liste de replis seule)
 * @param {object} policy politique validée
 * @param {object} [opts] {station : fiche escale (replis, rayon, facteur), needs : computeNeeds().parTier}
 */
export function candidatesFrom(inv, policy, { station = null, needs = null } = {}) {
  const caps = effectiveCaps(policy, station);
  const needyTiers = needs
    ? ["J", "W", "Y"].filter((t) => (needs[t]?.chambres ?? 0) > 0)
    : ["J", "W", "Y"];
  const tiersToScore = needyTiers.length ? needyTiers : ["J", "W", "Y"];

  const entries = (inv?.hotels ?? [])
    .filter((h) => !h.excluded)
    .map((h) => ({
      ...h,
      fallback: false,
      tiers: compatibleTiers(h, policy),
      score: Math.max(...tiersToScore.map((t) => entryScore(h, t, policy, station, caps))),
    }))
    .sort((a, b) => {
      const rank = (x) => (x.contracted ? 0 : x.preferred ? 1 : 2);
      return rank(a) - rank(b) || b.score - a.score;
    });

  const known = new Set();
  for (const e of entries) {
    if (e.url) known.add(e.url.toLowerCase().replace(/\/+$/, ""));
    known.add(e.name.toLowerCase());
  }
  const fallbacks = (station?.fallback_hotels ?? [])
    .filter((f) => !known.has(f.url.toLowerCase().replace(/\/+$/, "")) && !known.has(f.name.toLowerCase()))
    .map((f) => ({
      id: slugify(f.name),
      name: f.name,
      url: f.url,
      source: "agent",
      contracted: false,
      preferred: false,
      excluded: false,
      fallback: true,
      tiers: ["J", "W", "Y"], // rien de connu : à relever avant de juger
      score: 0,
    }));

  return [...entries, ...fallbacks];
}
