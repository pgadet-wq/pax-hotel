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
    const known = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).join(", ") : "aucune";
    throw new Error(`Fiche escale introuvable : ${file} (escales connues : ${known})`);
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
  const codes = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const stations = codes.map((code) => loadStation(code, { dir }));
  return stations.sort((a, b) => a.demo_priority - b.demo_priority);
}
