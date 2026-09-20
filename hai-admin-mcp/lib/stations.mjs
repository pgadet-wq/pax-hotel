/**
 * Fiches escale (CDC §5.2) — schéma, chargement, liste ordonnée.
 *
 * La fiche escale porte tout ce qui varie d'une destination à l'autre (zone de
 * recherche, rayon, filtre distance, transfert, facteur de plafond, hôtels de
 * repli) : la trame du pipeline ne change pas. Une fiche invalide bloque le
 * démarrage avec un message explicite (EX-STA-4) — jamais un défaut silencieux.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const DEFAULT_STATION = "BKK";

/** Répertoire des fiches livrées (résolu depuis ce fichier, jamais le cwd). */
export const STATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "stations");

/** Nom de fiche valide : un code IATA sur 3 lettres majuscules. */
const FICHIER_FICHE = /^[A-Z]{3}\.json$/;

/**
 * Codes des fiches présentes sur disque, SANS charger ni valider leur contenu : une
 * fiche cassée n'empêche pas d'énumérer les autres (c'est `loadStation()` qui dira
 * pourquoi elle est cassée). Répertoire absent = liste vide, jamais une erreur :
 * l'appelant qui a besoin des fiches complètes utilise `listStations()`.
 * @returns {string[]} codes triés
 */
export function listStationCodes({ dir = STATIONS_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => FICHIER_FICHE.test(f))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Une fiche existe-t-elle pour ce code ? Existence du fichier seulement — la validité
 * du contenu reste du ressort de `loadStation()`.
 * @returns {boolean}
 */
export function stationExists(code, { dir = STATIONS_DIR } = {}) {
  const upper = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) return false;
  return fs.existsSync(path.join(dir, `${upper}.json`));
}

/**
 * Aide à afficher quand une escale est refusée : ce qui est disponible, et comment
 * ajouter une escale — le cas nominal d'un déroutement est une escale imprévue.
 * @returns {string}
 */
export function stationsHelp({ dir = STATIONS_DIR } = {}) {
  const codes = listStationCodes({ dir });
  // le modèle cité doit exister : désigner BKK.json quand il n'est pas là enverrait
  // l'opérateur sur un fichier absent
  const modele = codes.includes(DEFAULT_STATION) ? DEFAULT_STATION : (codes[0] ?? null);
  const suite = modele ? ` sur le modèle de ${path.join(dir, `${modele}.json`)}` : "";
  return `escales fichées : ${codes.length ? codes.join(", ") : "aucune"} — pour une escale non fichée, déposer ${path.join(dir, "<IATA>.json")}${suite}`;
}

/**
 * Couronnes effectives d'une escale, de la plus proche a la plus lointaine.
 *
 * Rend les couronnes DECLAREES dans la fiche quand il y en a, sinon une couronne unique
 * DERIVEE de `radius_km` et `max_transfer_min` — c'est-a-dire le comportement d'avant les
 * couronnes, explicitement nomme. `source` dit laquelle des deux, pour que l'interface et
 * le rapport ne fassent jamais passer un repli pour une declaration d'exploitation.
 *
 * @param {object} station fiche escale validee
 * @returns {{couronnes: Array<{rang, rayon_m, trajet_min, mode, note}>, source: "declaree"|"derivee"}}
 */
export function couronnesDe(station) {
  const declarees = station?.search?.couronnes ?? [];
  if (declarees.length) {
    const triees = [...declarees].sort((a, b) => a.rang - b.rang || a.rayon_m - b.rayon_m);
    return { couronnes: triees, source: "declaree" };
  }
  return {
    couronnes: [
      {
        rang: 1,
        rayon_m: Math.round((station?.search?.radius_km ?? 5) * 1000),
        trajet_min: station?.transfer?.max_transfer_min ?? 45,
        mode: station?.transfer?.default_mode ?? "taxi",
        note: "couronne unique dérivée du rayon de la fiche — aucune couronne déclarée",
      },
    ],
    source: "derivee",
  };
}

export const StationSchema = z
  .object({
    code: z.string().regex(/^[A-Z]{3}$/, "code IATA sur 3 lettres majuscules"),
    name: z.string().min(1),
    country: z.string().length(2),
    timezone: z.string().min(1),
    search: z.object({
      zone_query: z.string().min(1),
      radius_km: z.number().positive(),
      distance_ref: z.enum(["airport", "zone_center"]),
      use_distance_filter: z.boolean(),
      extra_nflt: z.array(z.string()).default([]),
      /** COURONNES de recherche, de la plus proche a la plus lointaine.
       * `trajet_min` est un temps DECLARE par l'exploitation, jamais mesure : l'outil
       * n'a aucun service de routage et ne convertit pas une distance en duree. Il doit
       * etre presente comme declare partout ou il s'affiche.
       * Liste vide = une seule couronne derivee de `radius_km` / `max_transfer_min`. */
      couronnes: z
        .array(
          z.object({
            rang: z.number().int().min(1).max(9),
            rayon_m: z.number().int().min(500).max(200000),
            trajet_min: z.number().int().min(1).max(600),
            mode: z.string().min(1),
            note: z.string().default(""),
          }),
        )
        .default([]),
    }),
    transfer: z.object({
      default_mode: z.string().min(1),
      max_transfer_min: z.number().int().positive(),
      note: z.string().default(""),
    }),
    constraints: z.object({
      entry_visa_check: z.boolean(),
      transit_hotel_airside: z.boolean(),
      notes: z.string().default(""),
    }),
    pricing: z.object({ price_cap_factor: z.number().positive() }),
    fallback_hotels: z.array(z.object({ name: z.string().min(1), url: z.string().min(1) })).default([]),
    demo_priority: z.number().int().positive(),
  })
  // EX-STA-2 : quand la référence est le centre de zone, aucun filtre distance= n'est ajouté
  .refine((s) => s.search.distance_ref !== "zone_center" || s.search.use_distance_filter === false, {
    message: "use_distance_filter doit être false quand distance_ref = zone_center (EX-STA-2)",
  });

/**
 * Charge et valide une fiche escale. Erreur explicite si le fichier manque ou si
 * la fiche est invalide (EX-STA-4).
 */
export function loadStation(code, { dir = STATIONS_DIR } = {}) {
  const upper = String(code ?? "").toUpperCase();
  const file = path.join(dir, `${upper}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Fiche escale introuvable : ${file} (${stationsHelp({ dir })})`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Fiche escale ${upper} illisible (${file}) : ${err.message}`);
  }
  const parsed = StationSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ");
    throw new Error(`Fiche escale ${upper} invalide (${file}) : ${detail}`);
  }
  if (parsed.data.code !== upper) {
    throw new Error(`Fiche escale ${file} : le champ code (${parsed.data.code}) ne correspond pas au nom du fichier`);
  }
  return parsed.data;
}

/** Toutes les fiches valides, triées par demo_priority croissant (EX-STA-1). */
export function listStations({ dir = STATIONS_DIR } = {}) {
  if (!fs.existsSync(dir)) throw new Error(`Répertoire des fiches escale introuvable : ${dir}`);
  const stations = listStationCodes({ dir }).map((code) => loadStation(code, { dir }));
  return stations.sort((a, b) => a.demo_priority - b.demo_priority);
}
