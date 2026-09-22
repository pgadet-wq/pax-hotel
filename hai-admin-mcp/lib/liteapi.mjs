/**
 * Adaptateur d'approvisionnement LiteAPI — source d'inventaire hôtelier en libre-service.
 *
 * Il produit EXACTEMENT la forme de fixture que `fixturesCollect()` consomme déjà
 * (`{ hotel, sessionId, createdAt, status, outcome, error, answer }`, `answer` = relevé v2).
 * Le moteur d'allocation, les couronnes, la politique et les livrables sont donc inchangés :
 * seule la provenance des chambres change.
 *
 * INV-1 — aucune réservation : ce module n'appelle que `/data/hotels` et `/hotels/rates`.
 *   Ni `prebook`, ni `book`, ni moyen de paiement. Vérifié par test.
 * INV-2 — aucun contournement : API publique, clé, usage prévu. Rien à émuler.
 * INV-3 — prix PUBLICS : on retient `retailRate.total` (tarif de vente au public, taxes
 *   comprises), jamais `commission` ni le net fournisseur. Le verrou `negotiated_rates`
 *   reste donc entier.
 * INV-4 — la clé vit hors du code, même convention que celle de H.
 *
 * TROIS RÈGLES NÉES DE LA MESURE (sonde du 22/09/2026, `tools/sonde-api.mjs`) :
 *  1. `limit` ≤ 40. Au-delà, une demande multi-chambres casse.
 *  2. Tout appel se rejoue : l'API est intermittente (même requête, 0 puis 38 hôtels).
 *  3. Un ZÉRO ne vaut pas mesure. L'API répond « no availability found » quand elle a
 *     simplement échoué — mesuré : 5 chambres, limit=40 → 38 hôtels ; limit=200 → 0.
 *     Un zéro est donc recoupé à `limit` plus bas avant d'être cru. Sans cette règle,
 *     l'outil annoncerait « aucune chambre à Bangkok » alors qu'il y en a des centaines.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/* ------------------------------------------------------------------ constantes */

export const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";

/** Plus grande valeur de `limit` qui sert une demande multi-chambres (mesurée). */
export const LIMIT_MAX = 40;
/** Valeur de recoupement d'un zéro (règle 3). */
export const LIMIT_RECOUPE = 20;
/** Tentatives par appel (règle 2). */
export const ESSAIS = 3;

/** Régimes de pension qui incluent le petit-déjeuner. `RO` = chambre seule. */
const PENSION_AVEC_PDJ = new Set(["BB", "HB", "FB", "AI", "HBP", "FBP"]);
/** Libellés qui dénotent une chambre familiale, à défaut d'un drapeau explicite. */
const RE_FAMILIALE = /famil|quadrup|triple|connecting|communicant|suite|apartment|appart/i;

/* ------------------------------------------------------------------------ clé */

/**
 * Clé LiteAPI : environnement d'abord, sinon `~/.config/hai/.env` — MÊME convention que
 * `readApiKey()` pour H (INV-4). Erreur explicite si absente, jamais de défaut silencieux.
 */
export function readLiteApiKey() {
  if (process.env.LITEAPI_KEY) return process.env.LITEAPI_KEY.trim();
  const file = path.join(os.homedir(), ".config", "hai", ".env");
  let brut;
  try {
    brut = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`LITEAPI_KEY introuvable : ni dans l'environnement, ni dans ${file}`);
  }
  const m = /^\s*LITEAPI_KEY\s*=\s*(.+)$/m.exec(brut);
  if (!m) throw new Error(`LITEAPI_KEY absente de ${file}`);
  const cle = m[1].trim().replace(/^["']|["']$/g, "");
  if (!cle) throw new Error(`LITEAPI_KEY vide dans ${file}`);
  return cle;
}

/* -------------------------------------------------------------------- schémas */
/* Toute entrée externe passe par zod (convention du dépôt). Les schémas sont
 * PERMISSIFS sur ce qu'on n'utilise pas : un champ ajouté par le fournisseur ne doit
 * pas faire échouer un run. Ils sont STRICTS sur ce dont on tire un chiffre. */

const montantSchema = z.object({ amount: z.number(), currency: z.string() }).passthrough();

const rateSchema = z
  .object({
    rateId: z.string().optional(),
    occupancyNumber: z.number().int().optional(),
    name: z.string().optional(),
    maxOccupancy: z.number().int().optional(),
    adultCount: z.number().int().optional(),
    childCount: z.number().int().optional(),
    boardType: z.string().optional(),
    retailRate: z
      .object({
        total: z.array(montantSchema).optional(),
      })
      .passthrough()
      .optional(),
    cancellationPolicies: z.object({ refundableTag: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const roomTypeSchema = z.object({ rates: z.array(rateSchema).optional() }).passthrough();

export const ratesResponseSchema = z
  .object({
    data: z.array(z.object({ hotelId: z.string().optional(), roomTypes: z.array(roomTypeSchema).optional() }).passthrough()).optional(),
    error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
    sandbox: z.boolean().optional(),
  })
  .passthrough();

export const hotelsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            latitude: z.number().nullable().optional(),
            longitude: z.number().nullable().optional(),
            stars: z.number().nullable().optional(),
            rating: z.number().nullable().optional(),
            reviewCount: z.number().nullable().optional(),
            address: z.string().nullable().optional(),
            accessibilityAttributes: z.any().optional(),
          })
          .passthrough(),
      )
      .optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ géométrie */

/**
 * Distance orthodromique en km. C'est elle qui donne enfin une distance MESURÉE avec sa
 * référence : le défaut `distance_ref: null` du convertisseur d'inventaire venait de ce
 * qu'aucune source ne fournissait de coordonnées. Ici, elles sont dans la fiche.
 */
export function distanceKm(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/* -------------------------------------------------------------- appels fiables */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Appel HTTP rejoué (règle 2). Rend `{ ok, statut, json, texte, essais }`.
 * La clé n'est jamais journalisée ni incluse dans un message d'erreur.
 */
export async function appelRejoue(url, { method = "GET", cle, body = null, essais = ESSAIS, fetchImpl = fetch, attenteMs = 800 } = {}) {
  let dernier = null;
  for (let n = 1; n <= essais; n += 1) {
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          "X-API-Key": cle,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const texte = await res.text();
      let json = null;
      try {
        json = JSON.parse(texte);
      } catch {
        /* réponse non JSON : conservée en texte, traitée comme un échec */
      }
      if (res.ok && json) return { ok: true, statut: res.status, json, texte, essais: n };
      dernier = { ok: false, statut: res.status, json, texte, essais: n };
    } catch (err) {
      dernier = { ok: false, statut: 0, json: null, texte: String(err?.message ?? err), essais: n };
    }
    if (n < essais) await dormir(attenteMs * n);
  }
  return dernier ?? { ok: false, statut: 0, json: null, texte: "aucune réponse", essais };
}

/* ---------------------------------------------------------------- recherches */

/** Fiches d'établissement d'une zone : noms, coordonnées, étoiles, notes. */
export async function chercherHotels({ lat, lon, rayonM, limit = LIMIT_MAX, cle, fetchImpl = fetch }) {
  const l = Math.min(limit, LIMIT_MAX);
  const url = `${LITEAPI_BASE}/data/hotels?latitude=${lat}&longitude=${lon}&radius=${rayonM}&limit=${l}`;
  const r = await appelRejoue(url, { cle, fetchImpl });
  if (!r.ok) throw new Error(`LiteAPI /data/hotels : HTTP ${r.statut} après ${r.essais} essai(s)`);
  const parsed = hotelsResponseSchema.parse(r.json);
  return parsed.data ?? [];
}

/**
 * Offres pour `chambres` chambres dans la zone. Applique les trois règles.
 *
 * Rend `{ hotels, chambresDemandees, limitUtilise, sandbox, avertissements }`.
 * `avertissements` porte en toutes lettres tout zéro recoupé : c'est ce que l'opérateur
 * doit voir, jamais un vivier silencieusement vidé.
 */
export async function chercherOffres({
  lat, lon, rayonM, checkin, checkout, chambres = 1, devise = "EUR", nationalite = "FR",
  limit = LIMIT_MAX, cle, fetchImpl = fetch,
}) {
  const avertissements = [];
  const corps = (l) => ({
    checkin, checkout, currency: devise, guestNationality: nationalite,
    occupancies: Array.from({ length: chambres }, () => ({ adults: 2 })),
    latitude: lat, longitude: lon, radius: rayonM, limit: l,
  });

  // Règle 1 : jamais au-dessus de la valeur mesurée comme fiable.
  const l0 = Math.min(limit, LIMIT_MAX);
  if (limit > LIMIT_MAX) {
    avertissements.push(`limit ramené de ${limit} à ${LIMIT_MAX} : au-delà, une demande multi-chambres casse et l'API rend « no availability found » (mesuré le 22/09/2026)`);
  }

  const lire = async (l) => {
    const r = await appelRejoue(`${LITEAPI_BASE}/hotels/rates`, { method: "POST", cle, body: corps(l), fetchImpl });
    if (!r.ok) return { hotels: [], sandbox: undefined, echec: `HTTP ${r.statut}` };
    const parsed = ratesResponseSchema.parse(r.json);
    return {
      hotels: (parsed.data ?? []).filter((h) => (h.roomTypes ?? []).length > 0),
      sandbox: parsed.sandbox,
      echec: parsed.error?.message ?? null,
    };
  };

  let res = await lire(l0);

  // Règle 3 : un zéro se recoupe avant d'être cru.
  if (res.hotels.length === 0 && l0 > LIMIT_RECOUPE) {
    const recoupe = await lire(LIMIT_RECOUPE);
    if (recoupe.hotels.length > 0) {
      avertissements.push(
        `zéro non mérité : limit=${l0} a rendu « ${res.echec ?? "aucun hôtel"} », limit=${LIMIT_RECOUPE} en rend ${recoupe.hotels.length}. ` +
          "Le résultat retenu est celui du recoupement — l'absence de chambre n'a PAS été mesurée.",
      );
      return { hotels: recoupe.hotels, chambresDemandees: chambres, limitUtilise: LIMIT_RECOUPE, sandbox: recoupe.sandbox, avertissements };
    }
    avertissements.push(`aucune offre à ${chambres} chambre(s), confirmé par recoupement à limit=${LIMIT_RECOUPE}`);
  }

  return { hotels: res.hotels, chambresDemandees: chambres, limitUtilise: l0, sandbox: res.sandbox, avertissements };
}

/* ------------------------------------------------------------- équipements */

/**
 * Les fiches portent des `facilityIds` numériques ; `/data/facilities` en donne le
 * libellé. On classe par LIBELLÉ et non par identifiant codé en dur : 820 identifiants
 * gravés dans le code seraient faux au premier changement de catalogue.
 *
 * Règle conservatrice, la même qu'on impose aux agents : ce qui n'est pas ÉCRIT n'est pas
 * déduit. « WiFi available » ne vaut pas « Free WiFi ». Une navette dont la gratuité n'est
 * pas dite reste « non_precise », jamais « gratuite ».
 */
const CLASSES = {
  wifi_free: /free\s*wi-?fi/i,
  room_service_24h: /24.?hour.*room service|room service.*24.?hour/i,
  room_service: /room service/i,
  workspace: /business cent(er|re)|meeting room|coworking|workspace/i,
  shuttle_free: /airport shuttle \(free\)|free airport shuttle/i,
  shuttle_paid: /airport shuttle \((additional charge|surcharge)\)/i,
  shuttle: /airport shuttle/i,
  restaurant_late: /24.?hour.*restaurant|restaurant.*24.?hour/i,
  accessible: /wheelchair[- ]accessible|facilities for disabled|accessible bathroom|in-room accessibility/i,
  breakfast: /breakfast/i,
};

/** Dictionnaire des équipements, une fois par run. */
export async function chercherFacilites({ cle, fetchImpl = fetch }) {
  const r = await appelRejoue(`${LITEAPI_BASE}/data/facilities`, { cle, fetchImpl });
  if (!r.ok) return null; // absence de dictionnaire : tout restera non_precise, jamais deviné
  const data = r.json?.data ?? [];
  const classes = Object.fromEntries(Object.keys(CLASSES).map((k) => [k, new Set()]));
  for (const f of data) {
    const id = f?.facility_id ?? f?.id;
    const nom = String(f?.facility ?? f?.name ?? "");
    if (id === undefined || !nom) continue;
    for (const [cle2, re] of Object.entries(CLASSES)) if (re.test(nom)) classes[cle2].add(id);
  }
  return classes;
}

/**
 * Équipements d'un établissement, lus sur ses `facilityIds`.
 * Sans dictionnaire, ou sans identifiant correspondant : `non_precise` / `false`.
 */
export function amenitesDeFiche(fiche, classes) {
  const ids = new Set(Array.isArray(fiche?.facilityIds) ? fiche.facilityIds : []);
  const a = (k) => Boolean(classes?.[k] && [...ids].some((id) => classes[k].has(id)));
  const pmrAttr = Array.isArray(fiche?.accessibilityAttributes)
    ? fiche.accessibilityAttributes.length > 0
    : Boolean(fiche?.accessibilityAttributes);
  return {
    wifi_free: a("wifi_free"),
    room_service: a("room_service_24h") ? "24h" : a("room_service") ? "oui" : "non_precise",
    workspace: a("workspace") ? "oui" : "non_precise",
    airport_shuttle: a("shuttle_free") ? "gratuite" : a("shuttle_paid") ? "payante" : a("shuttle") ? "non_precise" : "non_precise",
    restaurant_late: a("restaurant_late"),
    accessible: a("accessible") || pmrAttr,
    breakfast_available: a("breakfast"),
  };
}

/* ------------------------------------------------------- conversion en relevé */

/** Prix par NUIT, taxes comprises : `retailRate.total` est un total de SÉJOUR. */
function prixParNuit(rate, nuits) {
  const t = rate?.retailRate?.total?.[0];
  if (!t || typeof t.amount !== "number" || !(t.amount > 0)) return null;
  const n = Number.isInteger(nuits) && nuits > 0 ? nuits : 1;
  return Math.round((t.amount / n) * 100) / 100;
}

/**
 * Chambres d'un hôtel, regroupées par TYPE, avec la seule mesure de capacité que cette
 * API permette.
 *
 * LiteAPI ne rend AUCUN champ de quantité (vérifié : ni allotment, ni available, ni
 * stock). La capacité ne se lit donc pas, elle se MESURE : on a demandé N chambres, et
 * chaque tarif porte le créneau d'occupation qu'il sert (`occupancyNumber`). Le nombre
 * de créneaux DISTINCTS qu'un type couvre est donc sa quantité constatée.
 *
 * `cap_reached` reprend la sémantique déjà en place dans le moteur : un type qui couvre
 * les N créneaux demandés est une BORNE BASSE (il en a peut-être plus, on n'a pas demandé
 * davantage) — stock « à confirmer ». Un type qui en couvre moins est une MESURE FERME.
 */
export function chambresDeHotel(hotelData, { chambresDemandees = 1, nuits = 1 } = {}) {
  const parType = new Map();
  for (const rt of hotelData?.roomTypes ?? []) {
    for (const rate of rt?.rates ?? []) {
      const nom = String(rate?.name ?? "").trim() || "Chambre (type non précisé)";
      const prix = prixParNuit(rate, nuits);
      if (prix === null) continue; // pas de prix lisible : la ligne ne vaut rien pour un plan chiffré
      if (!parType.has(nom)) parType.set(nom, { creneaux: new Set(), rates: [] });
      const g = parType.get(nom);
      if (Number.isInteger(rate.occupancyNumber)) g.creneaux.add(rate.occupancyNumber);
      g.rates.push({ ...rate, _prix: prix });
    }
  }

  const rooms = [];
  for (const [nom, g] of parType) {
    // le moins cher du type fait foi, comme à la lecture d'écran
    const r = g.rates.reduce((a, b) => (b._prix < a._prix ? b : a));
    const quantite = g.creneaux.size > 0 ? g.creneaux.size : 1;
    const board = String(r.boardType ?? "").toUpperCase();
    const maxOcc = Number.isInteger(r.maxOccupancy) ? r.maxOccupancy : (r.adultCount ?? 2) + (r.childCount ?? 0);
    rooms.push({
      room_type: nom,
      occupancy_adults: Number.isInteger(r.adultCount) && r.adultCount > 0 ? r.adultCount : 2,
      occupancy_children: Number.isInteger(r.childCount) ? r.childCount : 0,
      quantity_available: quantite,
      // borne basse : on a demandé N, ce type a servi les N — il en a peut-être plus
      cap_reached: quantite >= chambresDemandees,
      price_per_night: r._prix,
      // absent = non remboursable, jamais déduit dans l'autre sens
      free_cancellation: String(r.cancellationPolicies?.refundableTag ?? "").toUpperCase() === "RFN",
      breakfast_included: PENSION_AVEC_PDJ.has(board),
      family_capable: maxOcc >= 3 || RE_FAMILIALE.test(nom),
    });
  }
  return rooms.sort((a, b) => a.price_per_night - b.price_per_night);
}

/**
 * Un enregistrement de fixture, forme consommée telle quelle par `fixturesCollect()`.
 *
 * Ce que l'API NE dit pas reste `non_precise` ou `false` — jamais une déduction. C'est la
 * même règle que celle imposée aux agents, et elle vaut pour une source de données comme
 * pour un écran.
 */
export function toReleveRecord(hotelData, fiche, ctx) {
  const {
    checkin = "", checkout = "", nuits = 1, devise = "EUR", chambresDemandees = 1,
    station = null, observedAt = null, sandbox = false,
  } = ctx ?? {};

  const rooms = chambresDeHotel(hotelData, { chambresDemandees, nuits });
  const nom = fiche?.name ?? hotelData?.hotelId ?? "";
  const dist = distanceKm(station?.lat, station?.lon, fiche?.latitude, fiche?.longitude);
  const am = amenitesDeFiche(fiche, ctx?.facilites ?? null);

  const notes = [
    `Source : LiteAPI (${sandbox ? "BAC À SABLE — données de test, PAS l'inventaire réel" : "production"}).`,
    "Lecture seule, aucune réservation (INV-1). Prix de vente au public, taxes comprises (INV-3).",
    `Capacité MESURÉE par créneaux servis sur une demande de ${chambresDemandees} chambre(s) : cette API ne publie aucune quantité.`,
    dist === null ? "Distance non calculable : coordonnées absentes de la fiche." : `Distance calculée depuis les coordonnées de la fiche (${dist} km).`,
    ctx?.facilites ? "Équipements lus sur les identifiants déclarés par la fiche." : "Dictionnaire d'équipements indisponible : tout reste non_precise, rien n'est déduit.",
  ].join(" ");

  return {
    hotel: fiche?.id ?? hotelData?.hotelId ?? nom,
    sessionId: null, // aucune session d'agent : cet inventaire vient d'une API
    createdAt: observedAt ?? new Date().toISOString(),
    status: "completed",
    outcome: rooms.length ? "ok" : "no_rooms",
    error: null,
    answer: {
      hotel: nom,
      url: "",
      found: rooms.length > 0,
      checkin,
      checkout,
      currency: devise,
      price_currency: devise,
      source: "platform",
      stars: Number.isFinite(fiche?.stars) ? fiche.stars : 0,
      review_score: Number.isFinite(fiche?.rating) ? fiche.rating : 0,
      review_count: Number.isFinite(fiche?.reviewCount) ? fiche.reviewCount : 0,
      distance_km: dist ?? -1,
      // la référence est enfin PORTÉE : sans elle, l'hôtel part par prudence
      // dans la couronne la plus lointaine, même mesuré à 1,8 km
      distance_ref: dist === null ? null : "airport",
      amenities: {
        wifi_free: am.wifi_free,
        room_service: am.room_service,
        workspace: am.workspace,
        airport_shuttle: am.airport_shuttle,
        restaurant_late: am.restaurant_late,
        accessible: am.accessible,
      },
      payment: {
        prepayment_online: "oui",
        pay_at_property_only: false,
      },
      observed_at: observedAt ?? new Date().toISOString(),
      rooms,
      rooms_rejected: [],
      rooms_rejected_all: false,
      rooms_over_cap: [],
      quality_warnings: [],
      notes,
    },
  };
}

/** Jointure offres × fiches, en enregistrements de fixture. */
export function toReleveRecords({ offres, fiches, ctx }) {
  const parId = new Map((fiches ?? []).map((f) => [f.id, f]));
  return (offres ?? [])
    .map((h) => toReleveRecord(h, parId.get(h.hotelId) ?? null, ctx))
    .filter((r) => r.answer.rooms.length > 0);
}

/* ------------------------------------------------- construction du vivier */

/**
 * Coordonnées d'escale. Les fiches `data/stations/*.json` ne les portent pas encore :
 * elles décrivent la zone par une requête texte, ce qui suffisait à une recherche par
 * agent. Une API de géolocalisation en a besoin. À rapatrier dans les fiches.
 */
export const COORD_ESCALES = {
  BKK: { lat: 13.69, lon: 100.7501, nom: "Bangkok Suvarnabhumi" },
  NOU: { lat: -22.0146, lon: 166.213, nom: "Noumea La Tontouta" },
  CDG: { lat: 49.0097, lon: 2.5479, nom: "Paris Charles de Gaulle" },
};

/** Paliers du balayage : peu de chambres chez beaucoup d'hôtels, puis l'inverse. */
export const PALIERS_DEFAUT = [1, 2, 3, 5, 8];

/**
 * Construit un vivier complet depuis LiteAPI : fiches, équipements, puis offres à
 * plusieurs paliers de chambres. Rend les enregistrements de fixture — directement
 * consommables par `fixturesCollect()` — ET les entrées d'inventaire correspondantes.
 *
 * UN SEUL chemin de code pour la ligne de commande et pour le serveur : deux
 * implémentations dériveraient, et la démonstration ne montrerait pas ce que l'outil fait.
 */
export async function construireVivier({
  station, coord, checkin, checkout, nuits = 1, rayonM = 40000,
  paliers = PALIERS_DEFAUT, devise = "EUR", limit = LIMIT_MAX,
  cle, slugify, onProgress = null, fetchImpl = fetch,
}) {
  const dire = (etape, data = {}) => { try { onProgress?.(etape, data); } catch { /* le progrès ne fait jamais échouer un run */ } };

  const fiches = await chercherHotels({ lat: coord.lat, lon: coord.lon, rayonM, limit, cle, fetchImpl });
  dire("fiches", { hotels: fiches.length });

  const facilites = await chercherFacilites({ cle, fetchImpl });
  dire("equipements", { charge: Boolean(facilites) });

  const meilleurReleve = new Map();
  const meilleureEntree = new Map();
  const avertissements = [];
  let sandbox = false;

  for (const n of paliers) {
    const r = await chercherOffres({
      lat: coord.lat, lon: coord.lon, rayonM, checkin, checkout,
      chambres: n, devise, limit, cle, fetchImpl,
    });
    if (r.sandbox) sandbox = true;
    for (const a of r.avertissements) avertissements.push(`${n} chambre(s) : ${a}`);

    const ctx = { checkin, checkout, nuits, devise, chambresDemandees: n, station: coord, sandbox: Boolean(r.sandbox), facilites };
    const cumul = (rec) => rec.answer.rooms.reduce((t, c) => t + c.quantity_available, 0);
    for (const rec of toReleveRecords({ offres: r.hotels, fiches, ctx })) {
      const vu = meilleurReleve.get(rec.hotel);
      if (!vu || cumul(rec) > cumul(vu)) meilleurReleve.set(rec.hotel, rec);
    }
    for (const e of toInventaireEntries({ offres: r.hotels, fiches, ctx, slugify })) {
      const vu = meilleureEntree.get(e.id);
      if (!vu || (e.capacity_hint.rooms_displayed_max ?? 0) > (vu.capacity_hint.rooms_displayed_max ?? 0)) meilleureEntree.set(e.id, e);
    }
    dire("palier", { chambres: n, hotels: r.hotels.length });
  }

  const records = [...meilleurReleve.values()];
  const entrees = [...meilleureEntree.values()];
  const chambres = records.reduce((s, r) => s + r.answer.rooms.reduce((t, c) => t + c.quantity_available, 0), 0);
  dire("termine", { hotels: records.length, chambres, sandbox });

  return {
    records, entrees, avertissements, sandbox, chambres,
    inventaire: { station, updated_at: new Date().toISOString(), reference: { checkin, nights: nuits }, hotels: entrees },
  };
}

/* --------------------------------------------------- entrées d'inventaire */

/**
 * Entrées d'inventaire correspondantes.
 *
 * Nécessaire, et pas seulement commode : le moteur choisit ses CANDIDATS dans
 * `data/inventaire/<escale>.json`, puis cherche leur relevé dans la fixture. Une fixture
 * dont les hôtels sont inconnus de l'inventaire ne loge personne — constaté au premier
 * rejeu. Un adaptateur d'approvisionnement doit donc alimenter les DEUX.
 *
 * `source: "api"` et non `"agent"` : aucune session n'a été lancée, et le dire faux
 * rendrait l'audit d'un run impossible.
 */
export function toInventaireEntries({ offres, fiches, ctx, slugify }) {
  const parId = new Map((fiches ?? []).map((f) => [f.id, f]));
  const { station = null, devise = "EUR", chambresDemandees = 1, nuits = 1, observedAt = null } = ctx ?? {};
  const obs = observedAt ?? new Date().toISOString();
  const out = [];

  for (const h of offres ?? []) {
    const fiche = parId.get(h.hotelId) ?? null;
    const nom = fiche?.name ?? h.hotelId ?? "";
    if (!nom) continue;
    const rooms = chambresDeHotel(h, { chambresDemandees, nuits });
    if (!rooms.length) continue;

    const dist = distanceKm(station?.lat, station?.lon, fiche?.latitude, fiche?.longitude);
    const total = rooms.reduce((s, r) => s + r.quantity_available, 0);
    // borne basse dès qu'un type a servi tous les créneaux demandés : on n'a pas demandé plus
    const borneBasse = rooms.some((r) => r.cap_reached);
    const am = amenitesDeFiche(fiche, ctx?.facilites ?? null);

    out.push({
      id: slugify(nom),
      name: nom,
      url: "",
      source: "api",
      source_cle: "liteapi",
      adresse: String(fiche?.address ?? ""),
      contracted: false,
      preferred: false,
      excluded: false,
      stars: Number.isFinite(fiche?.stars) ? Math.max(0, Math.min(5, Math.round(fiche.stars))) : null,
      review_score: Number.isFinite(fiche?.rating) ? Math.max(0, Math.min(10, fiche.rating)) : null,
      review_count: Number.isFinite(fiche?.reviewCount) ? Math.max(0, Math.round(fiche.reviewCount)) : null,
      distance_km: dist,
      // la référence PORTÉE : c'est ce qui range enfin l'hôtel dans la bonne couronne
      distance_ref: dist === null ? null : "airport",
      amenities: {
        wifi_free: am.wifi_free,
        room_service: am.room_service,
        workspace: am.workspace,
        airport_shuttle: am.airport_shuttle,
        restaurant_late: am.restaurant_late,
        accessible: am.accessible,
        // un petit-déjeuner inclus dans un tarif vaut mieux qu'un équipement déclaré
        breakfast_available: am.breakfast_available || rooms.some((r) => r.breakfast_included),
        family_capable: rooms.some((r) => r.family_capable),
      },
      payment: { prepayment_online: "oui", pay_at_property_only: false },
      indicative_price_from_eur: devise === "EUR" ? Math.round(rooms[0].price_per_night) : null,
      capacity_hint: { rooms_displayed_max: total, cap_reached: borneBasse, observed_at: obs },
      contact: { phone: null, email: null },
      notes:
        `Relevé par API (liteapi), aucune session d'agent. Capacité constatée sur une demande de ${chambresDemandees} chambre(s) : ` +
        `${total} chambre(s)${borneBasse ? " — BORNE BASSE, on n'a pas demandé davantage" : " — mesure ferme"}. ` +
        (dist === null ? "Distance non calculable." : `Distance calculée depuis les coordonnées de la fiche.`),
      last_survey_at: obs,
    });
  }
  return out;
}
