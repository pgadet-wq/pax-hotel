/**
 * Politique d'hébergement — modèle, validation, conformité, score (CDC §5.1).
 *
 * La politique est le JSON que le formulaire de l'UI édite. Chaque cabine (J/W/Y)
 * est un « tier » avec exigences dures (étoiles, prestations, plafond par nuit) et
 * préférences ; PMR et famille sont des overlays cumulables (EX-POL-2). Tout est
 * déterministe : les agents relèvent, ce module juge.
 *
 * Modèle v2 repris intégralement, plus les ajouts CDC : `allowances`, `payment`,
 * `extension`, `agents`, `inventory`.
 */
import { z } from "zod";

/** Prestations normalisées, telles que le moteur les manipule. */
export const AMENITY_KEYS = [
  "wifi_free",
  "room_service_24h",
  "workspace",
  "breakfast_available",
  "airport_shuttle",
  "restaurant_late",
  "accessible",
];

export const AMENITY_LABELS = {
  wifi_free: "wifi gratuit",
  room_service_24h: "room service 24h/24",
  workspace: "espace de travail",
  breakfast_available: "petit-déjeuner disponible",
  airport_shuttle: "navette aéroport",
  restaurant_late: "restauration tardive",
  accessible: "accessibilité PMR",
};

const cabinPolicy = z.object({
  min_stars: z.number().int().min(0).max(5),
  max_stars: z.number().int().min(0).max(5).nullable(),
  required_amenities: z.array(z.enum(AMENITY_KEYS)),
  nice_to_have: z.array(z.enum(AMENITY_KEYS)).default([]),
  price_cap_eur: z.number().positive(),
  allow_above_cap_if_no_alternative: z.boolean().default(true),
});

export const PolicySchema = z.object({
  version: z.literal(2).default(2),
  cabins: z.object({ J: cabinPolicy, W: cabinPolicy, Y: cabinPolicy }),
  global: z.object({
    priorities: z.array(z.string()).default(["pmr", "famille", "J", "W", "Y"]),
    rooming: z
      .object({
        family_unit_max: z.object({ adults: z.number().int(), children: z.number().int() }),
        beyond: z.literal("two_rooms_same_hotel").default("two_rooms_same_hotel"),
        infants_no_capacity: z.boolean().default(true),
      })
      .default({ family_unit_max: { adults: 2, children: 2 }, beyond: "two_rooms_same_hotel", infants_no_capacity: true }),
    overlays: z
      .object({
        pmr: z
          .object({
            require_accessible: z.boolean().default(true),
            distance_weight_boost: z.number().default(2),
            allow_tier_upgrade: z.boolean().default(true),
          })
          .default({ require_accessible: true, distance_weight_boost: 2, allow_tier_upgrade: true }),
        famille: z
          .object({
            require_family_room_or_two_rooms_same_hotel: z.boolean().default(true),
          })
          .default({ require_family_room_or_two_rooms_same_hotel: true }),
      })
      // zod retourne la valeur par défaut telle quelle (sans re-parser) : fournir l'objet complet
      .default({
        pmr: { require_accessible: true, distance_weight_boost: 2, allow_tier_upgrade: true },
        famille: { require_family_room_or_two_rooms_same_hotel: true },
      }),
    scoring: z
      .object({
        w_review: z.number().default(0.35),
        w_stars_fit: z.number().default(0.15),
        w_distance: z.number().default(0.25),
        w_price_headroom: z.number().default(0.25),
      })
      .default({ w_review: 0.35, w_stars_fit: 0.15, w_distance: 0.25, w_price_headroom: 0.25 }),
    discovery: z
      .object({
        min_review_score: z.number().default(7),
        n_socle: z.number().int().min(3).max(10).default(8),
        max_candidates: z.number().int().min(3).max(12).default(10),
        max_hotels_stage_b: z.number().int().min(2).max(8).default(5),
        max_hotels_total: z.number().int().min(2).max(15).default(10),
      })
      .default({ min_review_score: 7, n_socle: 8, max_candidates: 10, max_hotels_stage_b: 5, max_hotels_total: 10 }),
    negotiated_rates: z.literal(false).default(false), // verrouillé : prix publics uniquement (INV-3)
    currency: z.literal("EUR").default("EUR"),
    free_cancellation_preferred: z.boolean().default(true),
  }),
  /** Montants d'indemnité — null = « non renseigné » (H-7) : rien n'est estimé (EX-COU-1). */
  allowances: z
    .object({
      meal_eur_per_pax_per_day: z.number().nonnegative().nullable().default(null),
      transport_eur_per_pax: z.number().nonnegative().nullable().default(null),
    })
    .default({ meal_eur_per_pax_per_day: null, transport_eur_per_pax: null }),
  payment: z
    .object({
      default_mode: z.enum(["compagnie", "carte_prepayee"]).default("compagnie"),
      prepaid_card: z
        .object({
          enabled: z.boolean().default(true),
          load_includes: z.array(z.enum(["nuit", "repas", "transport"])).default(["nuit", "repas", "transport"]),
        })
        .default({ enabled: true, load_includes: ["nuit", "repas", "transport"] }),
    })
    .default({ default_mode: "compagnie", prepaid_card: { enabled: true, load_includes: ["nuit", "repas", "transport"] } }),
  /** Bornes d'extension (H-2, fixées le 14/09) — larges, visibles, éditables. */
  extension: z
    .object({
      enabled: z.boolean().default(true),
      probe_same_hotel_first: z.boolean().default(true), // H-3 : tranchée en phase 5
      batch_size: z.union([z.literal("auto"), z.number().int().min(1).max(8)]).default("auto"),
      max_waves: z.number().int().min(0).max(8).default(4),
      max_sessions_per_run: z.number().int().min(0).max(50).default(18),
      max_cost_usd_per_run: z.number().nonnegative().default(10),
      probe_no_rooms_max: z.number().int().min(9).max(50).default(30),
    })
    .default({
      enabled: true, probe_same_hotel_first: true, batch_size: "auto",
      max_waves: 4, max_sessions_per_run: 18, max_cost_usd_per_run: 10, probe_no_rooms_max: 30,
    }),
  /** Vitesse et puissance (CDC §16) — « auto » = maximum du plan H, plafonné à 6.
   * Modèles H-9 (mesuré phase 5) : les ids de MODÈLE sont `holo3-122b-a10b` (Holo3
   * 122B, le plus capable — celui de l'agent h/web-surfer-pro) et `holo3-1-35b-a3b`
   * (Holo3.1 35B, classe flash) — `h/web-surfer-*` sont des AGENTS, pas des modèles
   * (une session dont l'agent porte un modèle inconnu échoue à 0 step, erreur interne). */
  agents: z
    .object({
      concurrency: z.union([z.literal("auto"), z.number().int().min(1).max(6)]).default("auto"),
      stagger_ms: z.number().int().min(0).default(10000),
      model_stage_ab: z.string().default("holo3-122b-a10b"),
      model_probe: z.string().default("holo3-1-35b-a3b"),
    })
    .default({ concurrency: "auto", stagger_ms: 10000, model_stage_ab: "holo3-122b-a10b", model_probe: "holo3-1-35b-a3b" }),
  inventory: z
    .object({
      max_age_days: z.number().int().min(1).default(30), // H-4 : valeur de départ, éditable
      min_candidates_per_tier: z.number().int().min(1).default(2),
    })
    .default({ max_age_days: 30, min_candidates_per_tier: 2 }),
});

export const DEFAULT_POLICY = PolicySchema.parse({
  version: 2,
  cabins: {
    J: {
      min_stars: 4, max_stars: 5,
      required_amenities: ["wifi_free", "room_service_24h", "workspace"],
      nice_to_have: ["airport_shuttle", "restaurant_late"],
      price_cap_eur: 250, allow_above_cap_if_no_alternative: true,
    },
    W: {
      min_stars: 3, max_stars: 4,
      required_amenities: ["wifi_free", "breakfast_available"],
      nice_to_have: ["airport_shuttle"],
      price_cap_eur: 130, allow_above_cap_if_no_alternative: true,
    },
    Y: {
      min_stars: 3, max_stars: null,
      required_amenities: ["wifi_free"],
      nice_to_have: ["airport_shuttle", "breakfast_available"],
      price_cap_eur: 80, allow_above_cap_if_no_alternative: true,
    },
  },
  global: {},
});

/** Le tier d'un dossier est sa cabine — Flying Blue ne joue que sur l'ordre intra-tier (EX-POL-2). */
export const tierOf = (dossier) => dossier.cabin;

/**
 * Plafonds effectifs par tier : `price_cap_eur × station.pricing.price_cap_factor`,
 * arrondi à l'euro (EX-POL-1). Sans fiche escale, facteur 1.
 * @returns {{J: number, W: number, Y: number}}
 */
export function effectiveCaps(policy, station = null) {
  const factor = station?.pricing?.price_cap_factor ?? 1;
  const caps = {};
  for (const tier of ["J", "W", "Y"]) caps[tier] = Math.round(policy.cabins[tier].price_cap_eur * factor);
  return caps;
}

/**
 * Normalise le relevé d'un hôtel en prestations booléennes du moteur.
 * `breakfast_available` se calcule depuis `rooms[]`, jamais depuis `amenities` (EX-POL-3).
 * `toConfirm` liste les prestations présentes mais non confirmées par la plateforme
 * (« oui » sans mention 24h, « non_precise ») : elles satisfont l'exigence en PARTIELLE.
 */
export function hotelAmenities(answer) {
  const a = answer?.amenities ?? {};
  const rooms = answer?.rooms ?? [];
  const toConfirm = [];
  const has = {
    wifi_free: a.wifi_free === true,
    room_service_24h: a.room_service === "24h",
    // workspace : booléen (anciennes fixtures) ou enum oui/non/non_precise (agents)
    workspace: a.workspace === true || a.workspace === "oui",
    breakfast_available: rooms.some((r) => r.breakfast_included),
    airport_shuttle: a.airport_shuttle === "gratuite" || a.airport_shuttle === "payante",
    restaurant_late: a.restaurant_late === true,
    accessible: a.accessible === true,
  };
  if (!has.room_service_24h && (a.room_service === "oui" || a.room_service === "non_precise")) {
    has.room_service_24h = "partial";
    toConfirm.push("room_service_24h");
  }
  if (!has.workspace && a.workspace === "non_precise") {
    has.workspace = "partial";
    toConfirm.push("workspace");
  }
  if (!has.airport_shuttle && a.airport_shuttle === "non_precise") {
    has.airport_shuttle = "partial";
    toConfirm.push("airport_shuttle");
  }
  return { has, toConfirm };
}

/**
 * Conformité d'un hôtel relevé pour un tier de la politique (EX-ALL-2).
 * Filtre dur : étoiles min, prestations requises (`room_service_24h` exige « 24h »,
 * `non_precise` → PARTIELLE « à confirmer »), ≥ 1 chambre sous le plafond effectif.
 * `max_stars` dépassé = « surclassé », jamais exclu.
 *
 * @param {object} inv enregistrement d'inventaire {answer: relevé, ...}
 * @param {object} tierPolicy policy.cabins[tier]
 * @param {object} global policy.global
 * @param {object} [opts] {capEur: plafond effectif (défaut : plafond politique), radiusKm: rayon de la fiche escale}
 * @returns {{level: "CONFORME"|"PARTIELLE"|"HORS_BAREME"|"NON_CONFORME", missing: string[], score: number, minPrice: number|null, capEur: number}}
 */
export function conformityOf(inv, tierPolicy, global, opts = {}) {
  const capEur = opts.capEur ?? tierPolicy.price_cap_eur;
  const radiusKm = opts.radiusKm ?? 5;
  const a = inv.answer;
  if (!a?.found) return { level: "NON_CONFORME", missing: ["indisponible"], score: 0, minPrice: null, capEur };

  const missing = [];
  let partial = false;

  // étoiles : min dur ; max souple (surclassé, jamais exclu) ; 0 = non affiché → non filtrant, à confirmer
  const stars = Number(a.stars) || 0;
  if (stars === 0) {
    partial = true;
    missing.push("étoiles [non affichées]");
  } else if (stars < tierPolicy.min_stars) {
    return { level: "NON_CONFORME", missing: [`étoiles ${stars} < ${tierPolicy.min_stars}`], score: 0, minPrice: null, capEur };
  }

  const { has } = hotelAmenities(a);
  for (const req of tierPolicy.required_amenities) {
    if (has[req] === true) continue;
    partial = true;
    missing.push(has[req] === "partial" ? `${req} [non précisé]` : req);
  }

  // prix : au moins une chambre sous le plafond effectif
  const prices = (a.rooms ?? []).map((r) => r.price_per_night).filter((p) => p > 0);
  const minPrice = prices.length ? Math.min(...prices) : null;
  if (minPrice === null) return { level: "NON_CONFORME", missing: ["aucune chambre relevée"], score: 0, minPrice, capEur };
  const underCap = minPrice <= capEur;

  // les prestations réellement ABSENTES (pas seulement « à confirmer ») dégradent en NON_CONFORME
  const hardMissing = tierPolicy.required_amenities.filter((req) => has[req] !== true && has[req] !== "partial");
  if (hardMissing.length) {
    return { level: "NON_CONFORME", missing, score: 0, minPrice, capEur };
  }

  // score souple (EX-ALL-3) — le rayon est celui de la fiche escale
  const w = global.scoring;
  const fitStars = (() => {
    if (!stars) return 0.5;
    const max = tierPolicy.max_stars ?? 5;
    if (stars >= tierPolicy.min_stars && stars <= max) return 1;
    return 0.6; // surclassé
  })();
  const dist = Number(a.distance_km ?? a.distance_to_airport_km);
  const distScore = dist >= 0 ? Math.max(0, 1 - dist / radiusKm) : 0.5;
  const headroom = underCap ? Math.max(0, (capEur - minPrice) / capEur) : 0;
  const review = Math.max(0, Math.min(10, Number(a.review_score) || 0)) / 10;
  let score = w.w_review * review + w.w_stars_fit * fitStars + w.w_distance * distScore + w.w_price_headroom * headroom;
  for (const nice of tierPolicy.nice_to_have) if (has[nice] === true) score += 0.02;
  const parts = { review, fitStars, distScore, headroom };

  if (!underCap) {
    return { level: "HORS_BAREME", missing, score, minPrice, capEur, parts, has };
  }
  if (stars !== 0 && tierPolicy.max_stars !== null && stars > tierPolicy.max_stars) {
    missing.push(`surclassé (${stars}★ > ${tierPolicy.max_stars}★)`);
    partial = true;
  }
  return { level: partial ? "PARTIELLE" : "CONFORME", missing, score, minPrice, capEur, parts, has };
}

/** Libellé de conformité pour le plan et le rapport. */
export function conformityLabel(conf) {
  switch (conf.level) {
    case "CONFORME":
      return "CONFORME";
    case "PARTIELLE":
      return `PARTIELLE (${conf.missing.map((m) => AMENITY_LABELS[m] ?? m).join(", ")})`;
    case "HORS_BAREME": {
      const over = conf.minPrice !== null ? ` (+${Math.round(conf.minPrice - conf.capEur)} EUR/nuit)` : "";
      return `HORS BAREME${over}`;
    }
    default:
      return "NON CONFORME";
  }
}
