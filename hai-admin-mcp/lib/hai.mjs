/**
 * Intégration H Company (CDC §6) : clé, client (point d'entrée européen, H-6),
 * agent v2 par escale, schémas de réponse plats, convertisseurs vers les formes
 * internes, prompts FR (garde-fous INV-1/INV-2), pompe d'événements.
 *
 * SEUL module de `lib/` autorisé à importer `hai-agents` (INV-7 : vérifié par test).
 * Les fonctions d'URL pures vivent dans `lib/hai-urls.mjs` et sont réexportées ici.
 * Aucune session n'est lancée par ce module lui-même : les appels payants passent
 * par discovery/releve/capacite, derrière la garde DEMO_ALLOW_PAID (INV-8).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HaiAgentsClient, HaiAgentsEnvironment, AnswerValidationError, HaiAgentsTimeoutError, isTerminalSessionStatus } from "hai-agents";
import { translateSessionEvent } from "./events.mjs";

export * from "./hai-urls.mjs";

/* ------------------------------------------------------------- clé, client */

export function readApiKey() {
  if (process.env.HAI_API_KEY) return process.env.HAI_API_KEY;
  const file = path.join(os.homedir(), ".config", "hai", ".env");
  const m = /HAI_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`HAI_API_KEY introuvable dans ${file}`);
  return m[1];
}

/** Origine de l'API H effectivement utilisée (H-6) — sert aussi au proxy de captures. */
export function apiOrigin() {
  return process.env.HAI_API_BASE_URL ?? HaiAgentsEnvironment.Eu;
}

/**
 * Client H sur le point d'entrée EUROPÉEN (H-6, relevé phase 0) : le SDK ne lit
 * pas `HAI_API_BASE_URL` tout seul — on la câble ici (origine SANS `/api/v2`).
 * Le point d'entrée effectif est journalisé au démarrage (vérification phase 5).
 */
export function createClient() {
  const environment = apiOrigin();
  console.error(
    `[hai] client H — point d'entrée ${environment}` +
      `${process.env.HAI_API_BASE_URL ? " (HAI_API_BASE_URL)" : " (défaut européen HaiAgentsEnvironment.Eu)"}`,
  );
  return new HaiAgentsClient({ apiKey: readApiKey(), environment });
}

/* ------------------------------------------------------------------ agent */

/** Nom de l'agent v2 d'une escale — la v1 « hotel-scout-bkk » reste intacte (INV-6). */
export const agentNameV2 = (station) => `hotel-scout-${station.code.toLowerCase()}-v2`;

/**
 * Crée l'agent v2 de l'escale s'il n'existe pas (idempotent). Retourne true s'il a été créé.
 * Phase 5 (H-9) : si l'agent existe avec un autre modèle que `agents.model_stage_ab`,
 * il est aligné par patch — la politique reste la source de vérité du modèle.
 */
export async function ensureAgentV2(client, station, policy) {
  const name = agentNameV2(station);
  const wanted = policy?.agents?.model_stage_ab && policy.agents.model_stage_ab !== "auto" ? policy.agents.model_stage_ab : undefined;
  let existing = null;
  try {
    existing = await client.agents.getAgent({ agentName: name });
  } catch {
    /* absent : création */
  }
  if (existing) {
    if (wanted && existing.model !== wanted) {
      await client.agents.patchAgent({ agentName: name, model: wanted });
      console.error(`[hai] agent ${name} : modèle ${existing.model ?? "(défaut plateforme)"} → ${wanted} (H-9)`);
    }
    return false;
  }
  const model = wanted;
  await client.agents.createAgent({
    name,
    description:
      "Découverte et relevé d'inventaire hôtelier en lecture seule sur les plateformes de réservation, " +
      `pour la prise en charge de passagers en aléa d'exploitation (escale ${station.code}). Ne réserve jamais.`,
    ...(model ? { model } : {}), // « auto » : modèle plateforme par défaut ; correspondance affinée en phase 5 (H-9)
    environments: [
      {
        id: "booking-visual",
        kind: "web",
        startUrl: "https://www.booking.com",
        mode: { type: "visual", width: 1280, height: 900, markdown: true },
      },
    ],
    skills: ["h/answering", "h/planning"],
    instructions:
      "Tu travailles pour un outil de prise en charge de passagers dont le vol est immobilisé : tu découvres des " +
      "hôtels par recherche de zone et tu relèves des inventaires (types de chambres, capacités, quantités affichées, " +
      "prix par nuit toutes taxes comprises, annulation, petit-déjeuner), les équipements déclarés des établissements " +
      "(wifi, service d'étage, espace de travail, navette, restaurant, accessibilité) et les modalités de paiement " +
      "affichées (prépaiement en ligne, paiement à l'établissement). " +
      "Tu ne réserves JAMAIS : aucun clic sur un bouton de réservation finale, aucune création de compte, aucune " +
      "saisie de données personnelles ou de paiement ; tu t'arrêtes à la page de sélection des chambres. " +
      "Tu n'inventes aucun chiffre : chaque valeur vient de l'écran ; une information absente vaut 0, false ou " +
      "non_precise, jamais une déduction. Pour appliquer des filtres de recherche, modifie de préférence " +
      "directement l'URL de résultats ; l'interface de filtres reste permise en repli. " +
      "Face à un CAPTCHA ou un blocage anti-robot : n'essaie pas de le contourner, décris-le dans notes et " +
      "conclus avec outcome blocked.",
  });
  return true;
}

/* ---------------------------------------------------------------- schémas */
/* Schémas de réponse PLATS et courts : constat des probes du 11/09, un schéma
 * riche (objets imbriqués, champs redondants) fait échouer silencieusement la
 * rédaction de la réponse finale côté plateforme. Les formes internes riches
 * sont reconstruites par les convertisseurs to*(). */

export const discoverySchema = z.object({
  currency: z.string().describe("devise des prix affichés, ex EUR"),
  candidates: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().describe("URL de la fiche hôtel, sans paramètres de session ; vide si illisible"),
        stars: z.number().int().describe("étoiles affichées, 0 si absentes"),
        review_score: z.number().describe("note sur 10, 0 si absente"),
        price_from_per_night: z.number().describe("prix « à partir de » par nuit TTC, 0 si absent"),
        distance_km: z.number().describe("distance affichée en km (aéroport ou centre selon la recherche), -1 si absente"),
        badges: z.string().describe("badges de la carte séparés par des virgules, ex: Navette aéroport, Wi-Fi gratuit"),
        premium_pass: z.boolean().describe("true si vu dans la passe premium"),
      }),
    )
    .describe("établissements dédupliqués par nom, les meilleurs d'abord"),
  notes: z.string().describe("blocages, CAPTCHA, passes sautées ; vide sinon"),
});

const OUI_NON_NP = ["oui", "non", "non_precise"];

export const releveSchema = z.object({
  hotel: z.string(),
  found: z.boolean().describe("false si la page ne correspond pas ou hôtel complet"),
  currency: z.string(),
  stars: z.number().int().describe("0 si non affiché"),
  review_score: z.number().describe("note sur 10, 0 si non affichée"),
  review_count: z.number().int().describe("nombre d'avis, 0 si non affiché"),
  distance_km: z.number().describe("distance affichée en km, -1 si non affichée"),
  amenity_wifi: z.boolean(),
  amenity_room_service: z.enum(["24h", "oui", "non", "non_precise"]),
  amenity_workspace: z.enum(OUI_NON_NP).describe("business center, salles de réunion ou bureau — oui uniquement si écrit"),
  amenity_shuttle: z.enum(["gratuite", "payante", "non", "non_precise"]),
  amenity_restaurant_late: z.boolean(),
  amenity_accessible: z.boolean().describe("équipements PMR mentionnés"),
  payment_prepayment_online: z.enum(OUI_NON_NP).describe("un prépaiement en ligne est proposé sur au moins une variante"),
  payment_pay_at_property_only: z.enum(OUI_NON_NP).describe("oui si TOUTES les variantes affichent « paiement à l'établissement »"),
  rooms: z.array(
    z.object({
      room_type: z.string(),
      occupancy_adults: z.number().int(),
      occupancy_children: z.number().int().describe("0 si non précisé"),
      // les bornes de vraisemblance ne sont PAS posées ici : le schéma est validé par la
      // plateforme sur la réponse ENTIÈRE, une seule ligne hors borne perdrait tout l'hôtel.
      // Elles sont dites à l'agent dans le libellé et appliquées ligne à ligne par
      // filtrerChambresVraisemblables() (C2).
      quantity_available: z.number().int().describe("nombre max de chambres sélectionnables affiché ; -1 si AUCUNE quantité n'est affichée — jamais d'autre valeur négative, jamais un nombre deviné"),
      cap_reached: z.boolean().describe("true si le sélecteur est plafonné (valeur max atteinte ou liste tronquée)"),
      price_per_night: z.number().describe("prix par nuit toutes taxes comprises, tel qu'affiché et strictement positif"),
      free_cancellation: z.boolean(),
      breakfast_included: z.boolean(),
      family_capable: z.boolean().describe("libellé familial, quadruple ou communicant"),
    }),
  ),
  notes: z.string().describe("blocages, CAPTCHA, particularités ; vide sinon"),
});

/** Sonde de capacité (EX-EXT-1, H-3) : lecture de la disponibilité à n chambres. */
export const probeSchema = z.object({
  hotel: z.string(),
  found: z.boolean().describe("false si la page ne correspond pas ou n'affiche rien pour cette demande"),
  requested_rooms: z.number().int(),
  rooms_selectable_max: z.number().int().describe("nombre maximal de chambres réellement sélectionnables affiché pour cette demande, -1 si illisible"),
  cap_reached: z.boolean().describe("true si le maximum affiché reste plafonné (sélecteur tronqué)"),
  notes: z.string(),
});

/** Étage 0 (EX-INV-5) : équipements + paiement + prix indicatif + capacité, PAS de chambres détaillées. */
export const inventaireHotelSchema = z.object({
  hotel: z.string(),
  found: z.boolean(),
  url: z.string().describe("URL de la fiche, sans paramètres de session"),
  stars: z.number().int().describe("0 si non affiché"),
  review_score: z.number().describe("0 si non affichée"),
  review_count: z.number().int().describe("0 si non affiché"),
  distance_km: z.number().describe("-1 si non affichée"),
  amenity_wifi: z.boolean(),
  amenity_room_service: z.enum(["24h", "oui", "non", "non_precise"]),
  amenity_workspace: z.enum(OUI_NON_NP),
  amenity_shuttle: z.enum(["gratuite", "payante", "non", "non_precise"]),
  amenity_restaurant_late: z.boolean(),
  amenity_accessible: z.boolean(),
  breakfast_available: z.boolean().describe("au moins une offre avec petit-déjeuner visible"),
  family_capable: z.boolean().describe("chambres familiales/quadruples visibles"),
  payment_prepayment_online: z.enum(OUI_NON_NP),
  payment_pay_at_property_only: z.enum(OUI_NON_NP),
  indicative_price_from_eur: z.number().describe("prix « à partir de » par nuit TTC en EUR, 0 si absent"),
  rooms_displayed_max: z.number().int().describe("plus grande quantité sélectionnable vue, 0 si aucune"),
  cap_reached: z.boolean(),
  notes: z.string(),
});

/* ------------------------------------------------ bornes de vraisemblance */
/* C2 — un agent peut rapporter n'importe quel nombre : le schéma envoyé à la
 * plateforme ne peut pas porter ces bornes (une seule ligne hors borne ferait
 * échouer la réponse ENTIÈRE, donc perdre l'hôtel sans le dire). Les bornes
 * vivent donc ici, appliquées CHAMBRE PAR CHAMBRE par le convertisseur, qui
 * rejette la ligne et nomme le rejet. Filet 1 sur 2 : l'allocation borne aussi.
 *
 * Partage des rôles entre les deux filets, tel que la politique l'écrit :
 * - ce que l'allocation ne peut PAS rattraper (prix nul, négatif ou délirant,
 *   quantité illisible, occupation impossible) est ÉCARTÉ ici ;
 * - une quantité au-dessus de `policy.extension.room_qty_sane_max` est CONSERVÉE et
 *   signalée : la politique dit « ramenée à hotel_cap_without_probe avec
 *   avertissement », et c'est l'allocation qui le fait (`buildStock`). L'écarter ici
 *   détruirait une capacité réelle — un type de chambre entier — sur la foi d'un seul
 *   nombre mal lu, et rendrait le second filet inatteignable. */

/** Prix par nuit TTC au-delà duquel une ligne est jugée invraisemblable (EUR). */
export const PRIX_NUIT_MAX_EUR = 5000;

/** Repli de quantité quand `policy.extension.room_qty_sane_max` n'est pas accessible. */
export const ROOM_QTY_MAX_DEFAUT = 60;

/** Occupation affichée au-delà de laquelle la ligne n'est plus une chambre d'hôtel. */
export const OCCUPANCY_MAX = 12;

/**
 * Schéma de VRAISEMBLANCE d'une ligne de chambre (usage interne, jamais envoyé à
 * la plateforme). `quantity_available = -1` reste le sentinel « quantité non
 * affichée » que l'allocation sait traiter (stock supposé, prise à confirmer) :
 * seules les valeurs < -1 sont rejetées.
 * @param {{maxQty?: number, maxPrice?: number}} [bornes]
 * @returns {import("zod").ZodType} schéma à `safeParse` par ligne
 */
export function roomSaneSchema({ maxQty = ROOM_QTY_MAX_DEFAUT, maxPrice = PRIX_NUIT_MAX_EUR } = {}) {
  return z.object({
    room_type: z.string().min(1),
    occupancy_adults: z.number().int().min(0).max(OCCUPANCY_MAX),
    occupancy_children: z.number().int().min(0).max(OCCUPANCY_MAX),
    quantity_available: z.number().int().min(-1).max(maxQty),
    price_per_night: z.number().positive().max(maxPrice),
  });
}

/** Bornes effectives : politique si elle est fournie, repli documenté sinon. */
export function bornesChambres({ policy = null, maxQty = null, maxPrice = null } = {}) {
  const qty = Number.isFinite(maxQty) ? maxQty : policy?.extension?.room_qty_sane_max;
  return {
    maxQty: Number.isFinite(qty) && qty > 0 ? qty : ROOM_QTY_MAX_DEFAUT,
    maxPrice: Number.isFinite(maxPrice) && maxPrice > 0 ? maxPrice : PRIX_NUIT_MAX_EUR,
  };
}

/** Motif de rejet en clair — jamais « valeur invalide » : la valeur vue est nommée. */
function motifRejet(room, { maxQty, maxPrice }) {
  const p = room?.price_per_night;
  const q = room?.quantity_available;
  if (!(typeof p === "number" && Number.isFinite(p))) return `prix illisible (${JSON.stringify(p)})`;
  if (p <= 0) return `prix ${p} EUR/nuit — un prix nul ou négatif n'est pas un prix relevé`;
  if (p > maxPrice) return `prix ${p} EUR/nuit au-delà de la borne ${maxPrice}`;
  if (!(typeof q === "number" && Number.isInteger(q))) return `quantité illisible (${JSON.stringify(q)})`;
  if (q < -1) return `quantité ${q} — une quantité négative n'existe pas (-1 = non affichée)`;
  const a = room?.occupancy_adults;
  const c = room?.occupancy_children;
  if (!Number.isInteger(a) || a < 0 || a > OCCUPANCY_MAX) return `occupation adultes ${JSON.stringify(a)} hors [0 ; ${OCCUPANCY_MAX}]`;
  if (!Number.isInteger(c) || c < 0 || c > OCCUPANCY_MAX) return `occupation enfants ${JSON.stringify(c)} hors [0 ; ${OCCUPANCY_MAX}]`;
  if (!room?.room_type) return "type de chambre vide";
  // en dernier : une ligne dont c'est le SEUL défaut n'arrive jamais ici (elle est
  // conservée et signalée), ce motif ne sert donc qu'aux lignes à défauts multiples
  if (q > maxQty) return `quantité ${q} au-delà de la borne ${maxQty}`;
  return "ligne non conforme au schéma de vraisemblance";
}

/**
 * Filtre de vraisemblance des lignes de chambres d'un relevé (C2).
 * Pur. Ne corrige RIEN : une ligne hors borne est écartée et nommée, jamais ramenée
 * à une valeur inventée. Le relevé survit à ses mauvaises lignes ; si l'hôtel entier
 * disparaît, l'avertissement le dit. Seule exception, voulue par la politique : une
 * quantité au-dessus de `room_qty_sane_max` reste dans `rooms` et part dans `overCap`
 * — l'allocation la ramènera au plafond de prudence, elle seule sait le faire sans
 * inventer de capacité.
 *
 * @param {Array<object>} rooms lignes plates du relevé
 * @param {{policy?: object, maxQty?: number, maxPrice?: number, hotel?: string}} [opts]
 * @returns {{rooms: Array<object>, rejected: Array<{room_type: string, reason: string, price_per_night: *, quantity_available: *}>, overCap: Array<{room_type: string, quantity_available: number, borne: number}>, warnings: string[], allRejected: boolean, bornes: {maxQty: number, maxPrice: number}}}
 */
export function filtrerChambresVraisemblables(rooms, opts = {}) {
  const bornes = bornesChambres(opts);
  const schema = roomSaneSchema(bornes);
  // même schéma, quantité délibérément non bornée : sert à distinguer « ligne dont le
  // SEUL défaut est une quantité trop grande » d'une ligne réellement inexploitable
  const schemaHorsQuantite = roomSaneSchema({ ...bornes, maxQty: Number.MAX_SAFE_INTEGER });
  const hotel = opts.hotel ? `« ${opts.hotel} » : ` : "";
  const kept = [];
  const rejected = [];
  const overCap = [];
  const warnings = [];
  for (const r of rooms ?? []) {
    const objet = r && typeof r === "object";
    if (objet && schema.safeParse(r).success) {
      kept.push(r);
      continue;
    }
    const type = String(r?.room_type ?? "(type illisible)");
    if (objet && schemaHorsQuantite.safeParse(r).success) {
      // quantité seule en cause : conservée, signalée, plafonnée par l'allocation
      kept.push(r);
      overCap.push({ room_type: type, quantity_available: r.quantity_available, borne: bornes.maxQty });
      warnings.push(
        `${hotel}chambre « ${type} » : ${r.quantity_available} chambres annoncées pour un seul type, au-delà de la ` +
          `borne de vraisemblance ${bornes.maxQty} — ligne CONSERVÉE, l'allocation la ramènera au plafond de prudence`,
      );
      continue;
    }
    const reason = motifRejet(r ?? {}, bornes);
    rejected.push({ room_type: type, reason, price_per_night: r?.price_per_night ?? null, quantity_available: r?.quantity_available ?? null });
    warnings.push(`${hotel}chambre « ${type} » écartée — ${reason}`);
  }
  const allRejected = rejected.length > 0 && kept.length === 0;
  if (allRejected) {
    warnings.push(`${hotel}toutes les chambres relevées (${rejected.length}) sont hors bornes — hôtel sans inventaire exploitable`);
  }
  return { rooms: kept, rejected, overCap, warnings, allRejected, bornes };
}

/* ----------------------------------------------------------- conversions */

const enumToBool = (v) => (v === "oui" ? true : v === "non" ? false : null);

/**
 * Réponse plate de relevé → relevé v2 riche (§5.6), horodaté côté code (EX-REL-2).
 * C2 : les lignes de chambres passent par `filtrerChambresVraisemblables` — prix
 * strictement positif et borné, quantité entière lisible, occupation plausible. Les
 * rejets sont ADDITIFS (`rooms_rejected`, `rooms_rejected_all`, `rooms_over_cap`,
 * `quality_warnings`) : l'appelant les remonte en avertissements nommés, le reste du
 * relevé est inchangé. Une quantité au-dessus de `room_qty_sane_max` reste dans
 * `rooms` (l'allocation la plafonne) et se lit dans `rooms_over_cap`.
 *
 * @param {object|null} flat réponse plate (releveSchema)
 * @param {{url?: string, checkin?: string, checkout?: string, candidate?: object|null,
 *          observedAt?: string|null, policy?: object|null, maxQty?: number|null,
 *          maxPrice?: number|null}} [opts] `policy` fournit `extension.room_qty_sane_max`
 * @returns {object|null} relevé v2
 */
export function toReleveAnswer(
  flat,
  { url = "", checkin = "", checkout = "", candidate = null, observedAt = null, policy = null, maxQty = null, maxPrice = null } = {},
) {
  if (!flat) return null;
  const filtre = filtrerChambresVraisemblables(flat.rooms, { policy, maxQty, maxPrice, hotel: flat.hotel });
  return {
    hotel: flat.hotel,
    url: url || candidate?.url || "",
    found: flat.found,
    checkin,
    checkout,
    currency: flat.currency,
    price_currency: flat.currency,
    source: "platform",
    stars: flat.stars || candidate?.stars || 0,
    review_score: flat.review_score || candidate?.review_score || 0,
    review_count: flat.review_count || candidate?.review_count || 0,
    distance_km: flat.distance_km >= 0 ? flat.distance_km : candidate?.distance_km ?? -1,
    distance_ref: candidate?.distance_ref ?? "airport",
    amenities: {
      wifi_free: flat.amenity_wifi,
      room_service: flat.amenity_room_service,
      workspace: flat.amenity_workspace,
      airport_shuttle: flat.amenity_shuttle,
      restaurant_late: flat.amenity_restaurant_late,
      accessible: flat.amenity_accessible,
    },
    payment: {
      prepayment_online: flat.payment_prepayment_online,
      pay_at_property_only: enumToBool(flat.payment_pay_at_property_only),
    },
    observed_at: observedAt ?? new Date().toISOString(),
    rooms: filtre.rooms.map((r) => ({ ...r, quantity_displayed_max: r.quantity_available, cap_reached: Boolean(r.cap_reached) })),
    /** C2 — lignes écartées pour invraisemblance, avec leur motif (additif). */
    rooms_rejected: filtre.rejected,
    /** C2 — l'hôtel n'a plus une seule ligne exploitable après filtrage. */
    rooms_rejected_all: filtre.allRejected,
    /** C2 — lignes CONSERVÉES dont la quantité dépasse `room_qty_sane_max` : l'allocation
     * les ramène à `hotel_cap_without_probe` (politique), le rapport doit les montrer. */
    rooms_over_cap: filtre.overCap,
    /** C2 — avertissements nommés à remonter tels quels au flux d'événements. */
    quality_warnings: filtre.warnings,
    notes: flat.notes ?? "",
  };
}

export function toDiscoveryCandidates(flat) {
  return (flat?.candidates ?? []).map((c) => ({
    name: c.name,
    url: c.url || "",
    stars: c.stars || null,
    review_score: c.review_score || null,
    review_count: null,
    price_from_per_night: c.price_from_per_night || null,
    distance_km: c.distance_km >= 0 ? c.distance_km : null,
    amenities_seen: String(c.badges ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    premium_pass: Boolean(c.premium_pass),
  }));
}

/** Réponse plate d'Étage 0 → entrée d'inventaire §5.3 (id fourni par l'appelant). */
export function toInventaireEntry(flat, { id, observedAt = null } = {}) {
  if (!flat?.found) return null;
  const obs = observedAt ?? new Date().toISOString();
  return {
    id,
    name: flat.hotel,
    url: flat.url || "",
    source: "agent",
    contracted: false, preferred: false, excluded: false,
    stars: flat.stars || null,
    review_score: flat.review_score || null,
    review_count: flat.review_count || null,
    distance_km: flat.distance_km >= 0 ? flat.distance_km : null,
    distance_ref: null,
    amenities: {
      wifi_free: flat.amenity_wifi,
      room_service: flat.amenity_room_service,
      workspace: flat.amenity_workspace === "oui" ? "oui" : flat.amenity_workspace === "non" ? "non" : "non_precise",
      airport_shuttle: flat.amenity_shuttle,
      restaurant_late: flat.amenity_restaurant_late,
      accessible: flat.amenity_accessible,
      breakfast_available: flat.breakfast_available,
      family_capable: flat.family_capable,
    },
    payment: {
      prepayment_online: flat.payment_prepayment_online,
      pay_at_property_only: enumToBool(flat.payment_pay_at_property_only),
    },
    indicative_price_from_eur: flat.indicative_price_from_eur > 0 ? flat.indicative_price_from_eur : null,
    capacity_hint: { rooms_displayed_max: flat.rooms_displayed_max || null, cap_reached: flat.cap_reached, observed_at: obs },
    contact: { phone: null, email: null },
    notes: flat.notes ?? "",
    last_survey_at: obs,
  };
}

/* ---------------------------------------------------------------- prompts */
/* Squelettes FR (CDC §6.5). INV-5 : les prompts ne reçoivent que des URL, des
 * dates, des nombres de chambres et des éléments de politique — jamais une donnée
 * passager (vérifié par test EX-PRO-1). Garde-fous INV-1/INV-2 dans chacun. */

const GARDE_FOUS =
  `Interdits absolus : réserver, créer un compte, saisir des données personnelles ou de paiement — tu t'arrêtes à ` +
  `la page de sélection des chambres. Face à un CAPTCHA ou un blocage anti-robot : ne contourne pas, décris-le ` +
  `dans notes et conclus outcome blocked.`;

export function promptDiscovery({ station, checkin, checkout, nflt, nSocle = 8, maxCandidates = 10 }) {
  return (
    `Tu prépares l'hébergement d'urgence de passagers dont le vol est immobilisé à ${station.name} (${station.code}). ` +
    `Séjour du ${checkin} au ${checkout}, base 2 adultes, 1 chambre, devise EUR. Travaille sur Booking.com par ` +
    `RECHERCHE DE ZONE — aucun hôtel n'est imposé.\n\n` +
    `MÉTHODE (unique) :\n` +
    `1. Ferme les fenêtres surgissantes (connexion Genius ; cookies : refuse les non essentiels).\n` +
    `2. Recherche à la main : tape « ${station.search.zone_query} » dans le champ de destination et SÉLECTIONNE la ` +
    `suggestion correspondante dans la liste déroulante avant de valider ; règle les dates ${checkin} → ${checkout} ` +
    `et 2 adultes, lance la recherche. Si les résultats montrent une autre zone, corrige la destination via le ` +
    `champ — une seule fois.\n` +
    `3. Une fois sur la page de résultats (la bonne zone), MODIFIE L'URL DE CETTE PAGE en y ajoutant à la fin : ` +
    `&nflt=${nflt.socle}\n` +
    `   C'est le moyen fiable d'appliquer tous les filtres d'un coup. N'utilise JAMAIS le panneau de filtres latéral.\n` +
    `4. Relève les ${nSocle} meilleurs établissements du classement, depuis les CARTES de résultats uniquement — ` +
    `n'ouvre AUCUNE fiche : nom, étoiles, note/10, nombre d'avis, prix « à partir de » par nuit TTC, distance ` +
    `affichée, badges d'équipements, URL de la fiche (sans paramètres de session).\n\n` +
    `À partir d'ici ta mission est remplie : la réponse prime sur toute exploration supplémentaire.\n\n` +
    `5. Passe premium, FACULTATIVE : modifie l'URL COURANTE en remplaçant son bloc nflt par : ${nflt.premium}\n` +
    `   Les nouveaux établissements (2 maximum) vont DANS candidates avec toutes leurs données de carte et ` +
    `premium_pass=true. AU PREMIER incident sur cette passe (redirection, autre zone, erreur), abandonne-la ` +
    `DÉFINITIVEMENT et rédige immédiatement ta réponse avec les candidats de l'étape 4, passe signalée dans notes.\n\n` +
    `Maximum ${maxCandidates} candidats dédupliqués par nom. ${GARDE_FOUS}`
  );
}

export function promptReleve({ hotelName, hasStartUrl, checkin, checkout }) {
  const intro = hasStartUrl
    ? `Tu es déjà sur la fiche Booking.com attendue : « ${hotelName} ». Vérifie que la page correspond bien à cet ` +
      `hôtel et que les dates ${checkin} → ${checkout} (2 adultes, 1 chambre, devise EUR) sont appliquées ; ` +
      `corrige-les si besoin.`
    : `Sur Booking.com, ferme les fenêtres surgissantes (cookies : refuse les non essentiels), cherche l'hôtel ` +
      `« ${hotelName} » par son nom exact, sélectionne-le dans les suggestions, règle les dates ${checkin} → ` +
      `${checkout} (2 adultes, 1 chambre, devise EUR) et ouvre sa fiche.`;
  return (
    `${intro} Si la page ne correspond pas à cet hôtel, ou s'il est complet à ces dates, réponds found=false et ` +
    `explique dans notes — n'essaie PAS un autre hôtel.\n\n` +
    `Relève DANS L'ORDRE DE LA PAGE, en une seule descente, sans jamais remonter :\n` +
    `1) En haut de fiche : étoiles, note/10, nombre d'avis, distance affichée.\n` +
    `2) Le bloc « Équipements les plus populaires » (sous la galerie photo, AVANT le tableau des chambres) : wifi ` +
    `gratuit, service d'étage (24h/24 uniquement si écrit), business/espace de travail, navette aéroport (gratuite ` +
    `ou payante), restaurant, accessibilité PMR. Déclarations de la plateforme : rapporte ce qui est écrit, ne ` +
    `déduis rien, mets non_precise sinon.\n` +
    `3) Le tableau des chambres : AU PLUS 8 types DISTINCTS, les premiers du tableau (leurs variantes tarifaires — ` +
    `annulable, avec petit-déjeuner — comptent pour le même type : 2 par type maximum). Pour chaque ligne : type, ` +
    `capacité (adultes+enfants), nombre maximal de chambres sélectionnables affiché ET cap_reached=true si ce ` +
    `sélecteur est plafonné (il s'arrête à sa valeur maximale), prix par nuit toutes taxes comprises, annulation ` +
    `gratuite, petit-déjeuner, caractère familial/quadruple/communicant. Si un prix couvre plusieurs nuits, divise ` +
    `et signale-le dans notes.\n` +
    `4) Les modalités de paiement affichées sur ces variantes : prépaiement en ligne proposé (oui/non/non_precise) ` +
    `et « paiement à l'établissement » sur TOUTES les variantes (oui/non/non_precise). Rapporte ce qui est écrit.\n` +
    `5) RÉDIGE immédiatement ta réponse. La réponse prime sur l'exhaustivité : au moindre doute sur ton budget de ` +
    `pas, réponds avec ce que tu as (les manques en non_precise ou dans notes).\n\n` +
    GARDE_FOUS
  );
}

export function promptProbe({ hotelName, requestedRooms, checkin, checkout }) {
  return (
    `Tu es sur la fiche Booking.com de « ${hotelName} », demande réglée sur ${requestedRooms} chambres ` +
    `(${2 * requestedRooms} adultes), séjour du ${checkin} au ${checkout}, devise EUR. NE change PAS d'hôtel, ` +
    `n'ouvre aucune autre fiche.\n\n` +
    `Objectif UNIQUE — mesurer la capacité affichée à ce volume :\n` +
    `1) Vérifie que la page affiche bien cette demande (${requestedRooms} chambres) ; corrige les paramètres si besoin.\n` +
    `2) Dans le tableau des chambres, relève le nombre MAXIMAL de chambres réellement sélectionnables pour la ` +
    `demande (rooms_selectable_max ; -1 si illisible), et cap_reached=true si le sélecteur reste plafonné à sa ` +
    `valeur maximale. Ne relève ni prix détaillés ni équipements.\n` +
    `3) Si la page indique qu'il n'y a pas assez de chambres pour la demande, rapporte le maximum proposé.\n` +
    `4) RÉDIGE immédiatement ta réponse.\n\n` +
    GARDE_FOUS
  );
}

export function promptInventaireHotel({ hotelName, hasStartUrl, checkin, checkout }) {
  const intro = hasStartUrl
    ? `Tu es déjà sur la fiche Booking.com de « ${hotelName} » (dates ${checkin} → ${checkout}, 2 adultes, 1 chambre, EUR) ; vérifie et corrige si besoin.`
    : `Sur Booking.com, cherche l'hôtel « ${hotelName} » par son nom exact, sélectionne-le dans les suggestions, règle ${checkin} → ${checkout} (2 adultes, 1 chambre, EUR) et ouvre sa fiche.`;
  return (
    `${intro} Si la page ne correspond pas, réponds found=false — n'essaie PAS un autre hôtel.\n\n` +
    `Relevé d'INVENTAIRE DE RÉFÉRENCE (rapide, sans détail des chambres) :\n` +
    `1) Haut de fiche : étoiles, note/10, nombre d'avis, distance affichée, URL propre de la fiche.\n` +
    `2) Équipements déclarés (bloc « les plus populaires ») : wifi, service d'étage (24h/24 uniquement si écrit), ` +
    `espace de travail, navette (gratuite/payante), restaurant, accessibilité PMR — non_precise si non écrit. ` +
    `Note aussi si un petit-déjeuner est proposé sur au moins une offre et si des chambres familiales/quadruples ` +
    `sont visibles.\n` +
    `3) Prix « à partir de » par nuit TTC en EUR (0 si absent) et modalités de paiement affichées : prépaiement en ` +
    `ligne (oui/non/non_precise), « paiement à l'établissement » sur toutes les variantes (oui/non/non_precise).\n` +
    `4) Capacité observée : plus grande quantité sélectionnable vue dans le tableau (rooms_displayed_max) et ` +
    `cap_reached si le sélecteur est plafonné.\n` +
    `5) RÉDIGE immédiatement ta réponse — pas de liste détaillée des chambres.\n\n` +
    GARDE_FOUS
  );
}

/* ------------------------------------------------------------------ pompe */
/* C5 — le suivi d'une session ne doit jamais durer plus longtemps que la session
 * elle-même : le défaut historique (40 min) dépassait à lui seul le budget du run
 * entier (`policy.extension.max_minutes_per_run`, 45 min), et deux sessions
 * enchaînées immobilisaient un créneau de 80 minutes. Le défaut est maintenant
 * adossé au budget SERVEUR de la session (`maxTimeS`), et le résiduel du run,
 * quand l'appelant le passe, tranche toujours plus court. */

/** Budget serveur supposé d'une session quand l'appelant ne le donne pas (s) — valeur du relevé. */
export const SESSION_MAX_TIME_S_DEFAUT = 900;

/** Marge d'horloge au-dessus du budget serveur : provisionnement, dernier événement, clôture. */
export const POMPE_MARGE_MS = 120_000;

/** Plancher de suivi : en dessous, la session est annulée plutôt que suivie. */
export const POMPE_TIMEOUT_MIN_MS = 15_000;

/** Échéance de suivi atteinte — le SDK a sa classe, le libellé sert de repli. */
export const estTimeout = (err) =>
  err instanceof HaiAgentsTimeoutError || /timed?.?out|timeout|délai dépassé/i.test(String(err?.message ?? err ?? ""));

/**
 * Résiduel d'horloge d'un run, en ms. `deadlineAt` (epoch ms) prime sur
 * `budgetRemainingMs` : une échéance absolue ne dérive pas d'un travailleur à l'autre.
 * @returns {number|null} ms restantes, ou null si aucun budget n'est imposé
 */
export function budgetRestantMs({ deadlineAt = null, budgetRemainingMs = null } = {}) {
  if (Number.isFinite(deadlineAt)) return deadlineAt - Date.now();
  if (Number.isFinite(budgetRemainingMs)) return budgetRemainingMs;
  return null;
}

/**
 * Budget de suivi effectif d'une session : le plus court de ce que l'appelant impose
 * (`timeoutMs`), du budget serveur de la session (`maxTimeS` + marge) et du résiduel
 * du run (`budgetRemainingMs` / `deadlineAt`).
 * @returns {{timeoutMs: number, exhausted: boolean, restantMs: number|null}}
 */
export function resolvePumpTimeout({ timeoutMs = null, maxTimeS = null, budgetRemainingMs = null, deadlineAt = null, margeMs = POMPE_MARGE_MS } = {}) {
  const base =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : (Number.isFinite(maxTimeS) && maxTimeS > 0 ? maxTimeS : SESSION_MAX_TIME_S_DEFAUT) * 1000 + margeMs;
  const restantMs = budgetRestantMs({ deadlineAt, budgetRemainingMs });
  const ms = restantMs === null ? base : Math.min(base, restantMs);
  return { timeoutMs: Math.max(POMPE_TIMEOUT_MIN_MS, ms), exhausted: restantMs !== null && restantMs <= POMPE_TIMEOUT_MIN_MS, restantMs };
}

/**
 * Pompe d'événements d'une session H : diffuse le flux en direct via emit, puis
 * retourne le résultat final. Flux et attente sont séquentiels (même curseur API)
 * mais partagent une SEULE échéance : le flux ne peut plus consommer le budget une
 * première fois et l'attente une seconde.
 * Une réponse absente ou non conforme au schéma est un échec de RÉPONSE, pas une
 * exception fatale — l'appelant décide du retry.
 *
 * Annulation RÉELLE (phase 5) : l'abandon du signal appelle `handle.cancel()` —
 * la session s'arrête côté plateforme (facturation comprise), `waitForCompletion`
 * rend alors son statut terminal. Une échéance atteinte annule de la même façon,
 * puis relaie l'erreur : l'appelant décide du rattachement ou de l'abandon.
 *
 * @param {object} handle handle de session du SDK
 * @param {(type: string, data: object) => void} emit
 * @param {{timeoutMs?: number|null, signal?: AbortSignal, maxTimeS?: number|null,
 *          budgetRemainingMs?: number|null, deadlineAt?: number|null, margeMs?: number}} [opts]
 */
export async function pumpToCompletion(
  handle,
  emit,
  { timeoutMs = null, signal, maxTimeS = null, budgetRemainingMs = null, deadlineAt = null, margeMs = POMPE_MARGE_MS } = {},
) {
  const budget = resolvePumpTimeout({ timeoutMs, maxTimeS, budgetRemainingMs, deadlineAt, margeMs });
  if (budget.exhausted) {
    emit("warning", {
      message:
        `budget d'horloge du run épuisé (${Math.round((budget.restantMs ?? 0) / 1000)} s restantes) — suivi limité à ` +
        `${Math.round(budget.timeoutMs / 1000)} s, la session est annulée si elle n'a pas répondu d'ici là`,
    });
  }
  const echeance = Date.now() + budget.timeoutMs;
  const restant = () => Math.max(5000, echeance - Date.now());
  const onAbort = () => {
    Promise.resolve(handle.cancel()).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      for await (const ev of handle.stream({ until: "settled", timeoutMs: budget.timeoutMs })) {
        if (signal?.aborted) break;
        for (const e of translateSessionEvent(ev)) emit(e.type, e.data);
      }
    } catch (err) {
      // le flux est un confort d'affichage : une coupure ne condamne pas la session
      emit("warning", { message: `flux d'événements interrompu (${err?.message ?? err}) — attente du résultat` });
    }
    try {
      const result = await handle.waitForCompletion({ timeoutMs: restant() });
      // la session peut rester idle après sa réponse (timeout d'inactivité par défaut) :
      // on la ferme pour libérer le slot de concurrence, sans conséquence sur le résultat
      if (!isTerminalSessionStatus(result.status)) handle.cancel().catch(() => {});
      return result;
    } catch (err) {
      if (err instanceof AnswerValidationError) {
        emit("warning", { message: "réponse finale absente ou non conforme au schéma" });
        return { id: handle.id, status: "completed", answer: null, outcome: null, error: "réponse non conforme au schéma", events: [] };
      }
      // Échéance atteinte. Deux cas, et un seul justifie d'annuler :
      // - le budget du run est épuisé : personne ne reviendra chercher cette session,
      //   elle continuerait de courir et de facturer — on l'annule (C5) ;
      // - il reste du budget : l'appelant a un rattachement §6.6 à jouer sur cette
      //   session, l'annuler ici lui ferait perdre une réponse peut-être déjà écrite.
      //   Le budget SERVEUR (`maxTimeS`) la ferme de toute façon côté plateforme.
      if (estTimeout(err)) {
        const restantMs = budgetRestantMs({ deadlineAt, budgetRemainingMs });
        const plusDeBudget = restantMs !== null && restantMs <= POMPE_TIMEOUT_MIN_MS;
        emit("warning", {
          message:
            `échéance de suivi atteinte (${Math.round(budget.timeoutMs / 1000)} s) — session ${handle.id} ` +
            (plusDeBudget ? "annulée, budget du run épuisé" : "laissée vivante pour rattachement (§6.6)"),
        });
        if (plusDeBudget) Promise.resolve(handle.cancel()).catch(() => {});
      }
      throw err;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
