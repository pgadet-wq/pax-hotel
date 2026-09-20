/**
 * Scénario de démo (CDC §5.4) — défauts avion/scénario et fusion/validation
 * de la configuration envoyée par l'UI ou la CLI. Aucun défaut silencieux :
 * une valeur hors bornes ou une escale inconnue est rejetée avec une erreur zod.
 */
import { z } from "zod";
import { PolicySchema, DEFAULT_POLICY } from "./policy.mjs";

/** Escales connues (fiches `data/stations/` livrées en phase 2). */
export const KNOWN_STATIONS = ["BKK", "CDG", "NOU"];

export const DEFAULT_AVION = {
  nom: "A350-900",
  seats: { J: 34, W: 24, Y: 266 }, // tri-classe long-courrier, avion plein (éditable)
};

export const DEFAULT_SCENARIO = {
  station: "BKK",
  checkin: null, // null = aujourd'hui (vol immobilisé maintenant), résolu par resolveDates()
  nights: 1,
  seed: 42,
  simulate: false,
  force_discovery: false,
  next_update_minutes: 30,
};

const AvionSchema = z.object({
  nom: z.string().max(40).default(DEFAULT_AVION.nom),
  seats: z.object({
    J: z.number().int().min(0).max(600),
    W: z.number().int().min(0).max(600),
    Y: z.number().int().min(0).max(600),
  }),
});

const ScenarioSchema = z.object({
  station: z.enum(KNOWN_STATIONS).default(DEFAULT_SCENARIO.station),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  nights: z.number().int().min(1).max(7).default(1),
  seed: z.number().int().min(0).default(42),
  simulate: z.boolean().default(false),
  force_discovery: z.boolean().default(false),
  next_update_minutes: z.number().int().min(5).max(240).default(30),
});

const RunConfigSchema = z.object({
  policy: PolicySchema,
  avion: AvionSchema,
  scenario: ScenarioSchema,
});

/** Fusionne le payload de l'UI avec les défauts et valide le tout (nights 1-7, seed entier, station connue). */
export function mergeConfig(payload = {}) {
  return RunConfigSchema.parse({
    policy: payload.policy ?? DEFAULT_POLICY,
    avion: payload.avion ?? DEFAULT_AVION,
    scenario: {
      ...DEFAULT_SCENARIO,
      ...(payload.scenario ?? {}),
      // `simulate` accepté aussi au niveau racine (POST /api/run {..., simulate})
      ...(payload.simulate === undefined ? {} : { simulate: Boolean(payload.simulate) }),
    },
  });
}

const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Date du jour DANS le fuseau de l'escale (défaut : fuseau du serveur). */
export function localDateIn(now = new Date(), timezone = null) {
  if (!timezone) return localIso(now);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return localIso(now);
  }
}

/** Heure locale de l'escale, pour que l'opérateur confirme LA BONNE NUIT (« 03:14 à Bangkok »). */
export function stationClock(now = new Date(), timezone = null) {
  if (!timezone) return { date: localIso(now), heure: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, timezone: null };
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, heure: `${parts.hour}:${parts.minute}`, timezone };
  } catch {
    return { date: localIso(now), heure: "", timezone };
  }
}

/**
 * Résout les dates effectives du run : arrivée du vol (défaut : AUJOURD'HUI dans le
 * fuseau DE L'ESCALE — le vol y est immobilisé maintenant) et fin d'hébergement.
 * Sans fuseau, repli sur l'heure du serveur ; c'était le comportement d'avant, et il
 * fait relever la nuit SUIVANTE dès que serveur et escale ne sont pas le même jour
 * (Nouméa UTC+11 ou Paris UTC+2 vs Bangkok UTC+7).
 */
export function resolveDates(scenario, now = new Date(), timezone = null) {
  const checkin = scenario.checkin ?? localDateIn(now, timezone);
  const d = new Date(`${checkin}T00:00:00`);
  d.setDate(d.getDate() + scenario.nights);
  return { checkin, checkout: localIso(d) };
}

/** Identifiant de run court, lisible, sans collision entre runs du même jour. */
export function newRunId(now = new Date()) {
  return now.getTime().toString(36);
}
