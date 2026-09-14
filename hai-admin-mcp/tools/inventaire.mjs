#!/usr/bin/env node
/**
 * Étage 0 — inventaire hôtelier par escale (CDC §6.1), partie HORS LIGNE (phase 2).
 *
 *   node hai-admin-mcp/tools/inventaire.mjs --station BKK --dry-run
 *   node hai-admin-mcp/tools/inventaire.mjs --station BKK --offline data/simulate/inventaire-demo.json
 *
 *   --station <code>    escale (défaut BKK)
 *   --checkin <date>    dates de référence (défaut : J+14, H-4)
 *   --nights <n>        nuits de référence (défaut 1)
 *   --dry-run           affiche zone, nflt et URL de recherche ; n'écrit rien (EX-INV-6)
 *   --offline <json>    fusionne un inventaire de fixtures dans data/inventaire/{code}.json
 *   --refresh, --max    Étage 0 par agents : câblés en phase 3 (payant) — refusés ici
 *
 * Aucun import de hai-agents, aucun agent, aucun réseau.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStation } from "../lib/stations.mjs";
import { loadInventaire, mergeInventaire, normalizeInventaire, isStale, INVENTAIRE_DIR } from "../lib/inventaire.mjs";
import { buildNflt, buildSearchUrl, buildHotelUrl } from "../lib/hai-urls.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (flag("refresh") || opt("max", null) !== null) {
  console.error("non disponible avant la phase 3 : l'Étage 0 par agents (--refresh, --max) est payant et sera câblé en phase 3.");
  console.error("Options hors ligne disponibles : --dry-run, --offline <fixtures.json>.");
  process.exit(1);
}

const station = loadStation(opt("station", "BKK"));
const policy = DEFAULT_POLICY;

const NIGHTS = Number(opt("nights", "1"));
if (!Number.isInteger(NIGHTS) || NIGHTS < 1 || NIGHTS > 7) throw new Error(`--nights doit être un entier de 1 à 7 (reçu : ${opt("nights", "1")})`);
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const CHECKIN = opt("checkin", null) ?? localIso(new Date(Date.now() + 14 * 86_400_000)); // H-4 : référence J+14
if (!/^\d{4}-\d{2}-\d{2}$/.test(CHECKIN)) throw new Error(`--checkin doit être au format YYYY-MM-DD (reçu : ${CHECKIN})`);
const CHECKOUT = (() => {
  const d = new Date(`${CHECKIN}T00:00:00`);
  d.setDate(d.getDate() + NIGHTS);
  return localIso(d);
})();

const existing = loadInventaire(station.code);

/* ------------------------------------------------------------------ dry-run */

if (flag("dry-run")) {
  const nflt = buildNflt(policy, station);
  console.log(`Escale ${station.code} — ${station.name} (${station.search.zone_query})`);
  console.log(`  zone : « ${station.search.zone_query} » · rayon ${station.search.radius_km} km (réf. ${station.search.distance_ref})` +
    ` · filtre distance : ${station.search.use_distance_filter ? "oui" : "non (EX-STA-2)"}`);
  console.log(`  transfert : ${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min · facteur de plafond ${station.pricing.price_cap_factor}`);
  console.log(`  référence : du ${CHECKIN} au ${CHECKOUT} (${NIGHTS} nuit${NIGHTS > 1 ? "s" : ""}, H-4 : J+14 par défaut)`);
  console.log(`  inventaire : ${existing ? `${existing.hotels.length} hôtel(s), mis à jour le ${existing.updated_at ?? "jamais"}` : "absent"}` +
    ` · périmé : ${isStale(existing, policy) ? "oui" : "non"}`);
  console.log("");
  console.log(`nflt socle   : ${nflt.socle}`);
  console.log(`nflt premium : ${nflt.premium}`);
  console.log("");
  console.log(`URL passe socle   : ${buildSearchUrl({ station, checkin: CHECKIN, checkout: CHECKOUT, nflt: nflt.socle })}`);
  console.log(`URL passe premium : ${buildSearchUrl({ station, checkin: CHECKIN, checkout: CHECKOUT, nflt: nflt.premium })}`);
  if (station.fallback_hotels.length) {
    console.log("");
    console.log("Hôtels de repli (fiche escale) :");
    for (const f of station.fallback_hotels) console.log(`  - ${f.name} : ${buildHotelUrl(f.url, { checkin: CHECKIN, checkout: CHECKOUT })}`);
  }
  console.log("\nDry-run : aucune écriture, aucun agent.");
  process.exit(0);
}

/* ------------------------------------------------------------------ offline */

const offline = opt("offline", null);
if (offline) {
  const file = path.resolve(offline);
  if (!fs.existsSync(file)) throw new Error(`Fixtures introuvables : ${file}`);
  const fresh = normalizeInventaire(JSON.parse(fs.readFileSync(file, "utf8")), offline);
  if (fresh.station !== station.code) throw new Error(`Les fixtures ${offline} portent l'escale ${fresh.station}, pas ${station.code}`);

  const merged = mergeInventaire(existing, fresh);
  const before = new Map((existing?.hotels ?? []).map((h) => [h.id, h]));
  const freshIds = new Set(fresh.hotels.map((h) => h.id));
  const manuels = merged.hotels.filter((h) => h.source === "manuel").length;
  const misAJour = merged.hotels.filter((h) => h.source !== "manuel" && before.has(h.id) && freshIds.has(h.id)).length;
  const ajoutes = merged.hotels.filter((h) => !before.has(h.id)).length;
  const conserves = merged.hotels.filter((h) => h.source !== "manuel" && before.has(h.id) && !freshIds.has(h.id)).length;

  const dest = path.join(INVENTAIRE_DIR, `${station.code}.json`);
  fs.mkdirSync(INVENTAIRE_DIR, { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`Écrit ${dest} — ${merged.hotels.length} hôtel(s) (mis à jour le ${merged.updated_at})`);
  console.log(`  manuels intouchés : ${manuels} · agents mis à jour : ${misAJour} · ajoutés : ${ajoutes} · conservés hors fixtures : ${conserves}`);
  process.exit(0);
}

console.error("non disponible avant la phase 3 : sans --dry-run ni --offline, l'outil lancerait l'Étage 0 par agents (payant).");
console.error("Options hors ligne disponibles : --dry-run, --offline <fixtures.json>.");
process.exit(1);
