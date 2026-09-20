/**
 * Scénario de démo (CDC §5.4) — défauts avion/scénario et fusion/validation
 * de la configuration envoyée par l'UI ou la CLI. Aucun défaut silencieux :
 * une valeur hors bornes ou une escale inconnue est rejetée avec une erreur zod.
 */
import { z } from "zod";
import { PolicySchema, DEFAULT_POLICY } from "./policy.mjs";
import { DEFAULT_STATION, listStationCodes, stationExists, stationsHelp } from "./stations.mjs";

/**
 * C1 — escales acceptées : le répertoire `data/stations/` fait foi, pas une liste
 * figée dans le code. Le cas nominal d'un déroutement est une escale IMPRÉVUE : une
 * fiche déposée sur disque doit être acceptée sans toucher au code.
 *
 * `KNOWN_STATIONS` reste exporté (et non vide, pour les appelants qui en font un
 * `z.enum` — `lib/inventaire.mjs`) mais il est désormais RELEVÉ À L'IMPORT : il
 * photographie le disque au démarrage. La validation d'un scénario, elle, passe par
 * `stationCodeSchema()` qui relit le disque À CHAQUE parse.
 */
export const KNOWN_STATIONS = (() => {
  const codes = listStationCodes();
  return codes.length ? codes : [DEFAULT_STATION];
})();

/**
 * Schéma d'un code escale : 3 lettres IATA (normalisées en majuscules) ET fiche
 * présente. Le message d'erreur dit ce qui est disponible et comment ajouter une
 * escale — jamais un repli silencieux sur BKK.
 * @param {{dir?: string}} [opts] répertoire de fiches (défaut : `data/stations/`)
 */
export function stationCodeSchema({ dir } = {}) {
  const where = dir ? { dir } : {};
  return z
    .string()
    .transform((s) => String(s).trim().toUpperCase())
    .superRefine((code, ctx) => {
      if (!/^[A-Z]{3}$/.test(code)) {
        ctx.addIssue({ code: "custom", message: `code escale « ${code} » invalide : un code IATA s'écrit en 3 lettres majuscules (ex. BKK) — ${stationsHelp(where)}` });
        return;
      }
      if (!stationExists(code, where)) {
        ctx.addIssue({ code: "custom", message: `escale ${code} sans fiche escale — ${stationsHelp(where)}` });
      }
    });
}

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

/** Schéma de scénario, lié à un répertoire de fiches escale (défaut : le livré). */
export function scenarioSchemaFor({ dir } = {}) {
  return z.object({
    station: stationCodeSchema({ dir }).default(DEFAULT_SCENARIO.station),
    checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    nights: z.number().int().min(1).max(7).default(1),
    seed: z.number().int().min(0).default(42),
    simulate: z.boolean().default(false),
    force_discovery: z.boolean().default(false),
    next_update_minutes: z.number().int().min(5).max(240).default(30),
  });
}

/** Schéma de configuration de run, lié au même répertoire de fiches. */
export function runConfigSchemaFor({ dir } = {}) {
  return z.object({
    policy: PolicySchema,
    avion: AvionSchema,
    scenario: scenarioSchemaFor({ dir }),
  });
}

const RunConfigSchema = runConfigSchemaFor();

/**
 * Fusionne le payload de l'UI avec les défauts et valide le tout (nights 1-7, seed
 * entier, escale fichée). `stationsDir` permet aux tests de viser un autre
 * répertoire de fiches ; sans lui, comportement inchangé.
 * @param {object} [payload]
 * @param {{stationsDir?: string|null}} [opts]
 */
export function mergeConfig(payload = {}, { stationsDir = null } = {}) {
  const schema = stationsDir ? runConfigSchemaFor({ dir: stationsDir }) : RunConfigSchema;
  return schema.parse({
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
/**
 * Decalage UTC de l'escale, en minutes, a l'instant donne (l'heure d'ete en depend).
 *
 * Sert a comparer un horaire de correspondance qui porte LUI-MEME un fuseau avec
 * l'horloge murale de l'escale. Rend `null` quand le fuseau est absent ou inexploitable :
 * on prefere ne pas comparer plutot que comparer faux.
 *
 * @param {Date} [now]
 * @param {string|null} [timezone]
 * @returns {number|null} minutes (ex. +420 pour Asia/Bangkok)
 */
export function stationOffsetMin(now = new Date(), timezone = null) {
  if (!timezone) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
    const nom = fmt.formatToParts(now).find((x) => x.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(nom);
    if (!m) return nom === "GMT" ? 0 : null;
    const signe = m[1] === "-" ? -1 : 1;
    return signe * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/**
 * Contexte d'escale attendu par `ingestPassagers({escale})` (PAXLIST v3).
 *
 * Sans lui, un horaire de correspondance donne en `HH:MM` seul reste indate et les deux
 * controles de plausibilite (« anterieur a l'arrivee », « au-dela de 72 h ») ne tournent
 * pas. L'heure d'arrivee du vol deroute est prise sur l'horloge de l'ESCALE, jamais sur
 * celle du serveur : le poste qui lance le run n'est pas a Bangkok.
 *
 * @param {object|null} station fiche escale
 * @param {Date} [now] instant de reference (injectable : testable)
 * @returns {{code: string, timezone: string|null, arrivee_locale: string, offset_min: number|null}}
 */
export function contexteEscale(station, now = new Date()) {
  const tz = station?.timezone ?? null;
  const { date, heure } = stationClock(now, tz);
  return {
    code: station?.code ?? "",
    timezone: tz,
    arrivee_locale: heure ? `${date}T${heure}` : "",
    offset_min: stationOffsetMin(now, tz),
  };
}

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
