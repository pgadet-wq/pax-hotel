/**
 * Produit un fichier de relevés depuis LiteAPI, rejouable tel quel par
 * `rebooking-v2.mjs --offline`. Aucune session d'agent, aucune réservation (INV-1).
 *
 * Le moteur ne sait pas d'où viennent les chambres : il consomme une fixture. Cet outil
 * en fabrique une depuis une API au lieu d'un agent — c'est toute la bascule.
 *
 * Usage :
 *   node hai-admin-mcp/tools/liteapi-releves.mjs --station BKK --checkin 2026-09-22
 *   node hai-admin-mcp/tools/liteapi-releves.mjs --station BKK --chambres 5 --rayon 40
 *   node hai-admin-mcp/tools/liteapi-releves.mjs --station BKK --balayage
 *
 * Puis :
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --offline out/releves-liteapi-<run>.json \
 *     --in <liste.csv> --checkin 2026-09-22
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLiteApiKey, chercherHotels, chercherOffres, chercherFacilites, toReleveRecords, toInventaireEntries, LIMIT_MAX,
} from "../lib/liteapi.mjs";
import { loadInventaire, mergeInventaire, reconcileIds, slugify } from "../lib/inventaire.mjs";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, "..", "..");

/**
 * Coordonnées d'escale. Les fiches `data/stations/*.json` ne portent PAS encore de
 * latitude/longitude — elles décrivent la zone par une requête texte, ce qui suffisait à
 * une recherche par agent. Une API de géolocalisation en a besoin. En attendant que les
 * fiches les portent, elles sont ici, et `--lat/--lon` permet toute autre escale.
 */
const COORD = {
  BKK: { lat: 13.69, lon: 100.7501, nom: "Bangkok Suvarnabhumi" },
  NOU: { lat: -22.0146, lon: 166.213, nom: "Noumea La Tontouta" },
  CDG: { lat: 49.0097, lon: 2.5479, nom: "Paris Charles de Gaulle" },
};

/** Paliers du balayage : peu de chambres chez beaucoup d'hôtels, puis l'inverse. */
const PALIERS = [1, 2, 3, 5, 8];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (has("--help")) {
  console.log(`Relevés hôteliers depuis LiteAPI — aucun agent, aucune réservation.

  --station <IATA>     escale (BKK, NOU, CDG) ou --lat/--lon
  --lat <n> --lon <n>  coordonnées explicites
  --checkin AAAA-MM-JJ arrivée (défaut 2026-09-22)
  --nights <n>         nuits (défaut 1)
  --rayon <km>         rayon de recherche (défaut 40)
  --chambres <n>       chambres demandées par hôtel (défaut 2)
  --balayage           joue ${PALIERS.join(", ")} chambres et garde le meilleur par hôtel
  --devise <ISO>       défaut EUR
  --limit <n>          hôtels par appel, plafonné à ${LIMIT_MAX} (mesure du 22/09/2026)
`);
  process.exit(0);
}

const STATION = (opt("--station", "BKK") || "BKK").toUpperCase();
const base = COORD[STATION];
const LAT = Number(opt("--lat", base?.lat));
const LON = Number(opt("--lon", base?.lon));
if (!Number.isFinite(LAT) || !Number.isFinite(LON)) {
  console.error(`Coordonnées inconnues pour « ${STATION} ». Connues : ${Object.keys(COORD).join(", ")}. Sinon --lat et --lon.`);
  process.exit(2);
}

const CHECKIN = opt("--checkin", "2026-09-22");
const NUITS = Math.max(1, Number(opt("--nights", "1")) || 1);
const CHECKOUT = (() => {
  const d = new Date(`${CHECKIN}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + NUITS);
  return d.toISOString().slice(0, 10);
})();
const RAYON_M = Math.round((Number(opt("--rayon", "40")) || 40) * 1000);
const DEVISE = opt("--devise", "EUR");
const LIMIT = Number(opt("--limit", String(LIMIT_MAX))) || LIMIT_MAX;
const CHAMBRES = Math.max(1, Number(opt("--chambres", "2")) || 2);
const BALAYAGE = has("--balayage");

async function main() {
  const cle = readLiteApiKey();
  const station = { lat: LAT, lon: LON, code: STATION };

  console.log(`Relevés LiteAPI — ${base?.nom ?? STATION} · nuit du ${CHECKIN} au ${CHECKOUT} · rayon ${RAYON_M / 1000} km`);
  console.log("INV-1 : aucune réservation. Seuls /data/hotels et /hotels/rates sont appelés.\n");

  console.log("Fiches d'établissement…");
  const fiches = await chercherHotels({ lat: LAT, lon: LON, rayonM: RAYON_M, limit: LIMIT, cle });
  console.log(`  ${fiches.length} fiche(s) — noms, coordonnées, étoiles, notes`);

  // sans ce dictionnaire, tout équipement reste « non_precise » et la politique de cabine
  // déclare chaque hôtel NON CONFORME : le vivier existe mais rien ne s'y loge
  const facilites = await chercherFacilites({ cle });
  console.log(facilites
    ? `  équipements : dictionnaire chargé (wifi gratuit, service d'étage, navette, accessibilité)\n`
    : `  équipements : dictionnaire INDISPONIBLE — tout restera « non_precise », rien ne sera déduit\n`);

  const paliers = BALAYAGE ? PALIERS : [CHAMBRES];
  /** Meilleur relevé par hôtel : celui qui a constaté le plus de chambres. */
  const meilleur = new Map();
  /** Entrées d'inventaire du même palier retenu — les deux doivent rester cohérents. */
  const inventaireParHotel = new Map();
  const avertissements = [];
  let sandbox = false;

  for (const n of paliers) {
    const r = await chercherOffres({
      lat: LAT, lon: LON, rayonM: RAYON_M, checkin: CHECKIN, checkout: CHECKOUT,
      chambres: n, devise: DEVISE, limit: LIMIT, cle,
    });
    if (r.sandbox) sandbox = true;
    for (const a of r.avertissements) avertissements.push(`${n} ch. : ${a}`);

    const ctx = {
      checkin: CHECKIN, checkout: CHECKOUT, nuits: NUITS, devise: DEVISE,
      chambresDemandees: n, station, sandbox: Boolean(r.sandbox), facilites,
    };
    const records = toReleveRecords({ offres: r.hotels, fiches, ctx });
    for (const e of toInventaireEntries({ offres: r.hotels, fiches, ctx, slugify })) {
      const vu = inventaireParHotel.get(e.id);
      if (!vu || (e.capacity_hint.rooms_displayed_max ?? 0) > (vu.capacity_hint.rooms_displayed_max ?? 0)) {
        inventaireParHotel.set(e.id, e);
      }
    }
    const total = records.reduce((s, x) => s + x.answer.rooms.reduce((t, c) => t + c.quantity_available, 0), 0);
    console.log(`  ${String(n).padStart(2)} chambre(s)/hôtel -> ${String(records.length).padStart(3)} hôtel(s), ${String(total).padStart(4)} chambre(s) constatée(s)`);

    for (const rec of records) {
      const cumul = (x) => x.answer.rooms.reduce((t, c) => t + c.quantity_available, 0);
      const vu = meilleur.get(rec.hotel);
      if (!vu || cumul(rec) > cumul(vu)) meilleur.set(rec.hotel, rec);
    }
  }

  const records = [...meilleur.values()];
  const chambres = records.reduce((s, r) => s + r.answer.rooms.reduce((t, c) => t + c.quantity_available, 0), 0);
  const mesurees = records.reduce((s, r) => s + r.answer.rooms.filter((c) => !c.cap_reached).reduce((t, c) => t + c.quantity_available, 0), 0);
  const aConfirmer = chambres - mesurees;
  const avecDistance = records.filter((r) => r.answer.distance_ref !== null).length;

  console.log("");
  if (avertissements.length) {
    console.log(`Avertissements (${avertissements.length}) :`);
    for (const a of avertissements) console.log(`  - ${a}`);
    console.log("");
  }

  console.log(`Vivier constitué : ${records.length} hôtel(s), ${chambres} chambre(s)`);
  console.log(`  dont ${mesurees} mesurée(s) FERME et ${aConfirmer} à CONFIRMER (borne basse : on n'a pas demandé plus)`);
  console.log(`  ${avecDistance}/${records.length} hôtel(s) avec distance mesurée et référencée`);
  if (sandbox) {
    console.log("");
    console.log("  ATTENTION — clé BAC À SABLE : ces volumes sont des données de TEST,");
    console.log("  pas l'inventaire réel de l'escale. Le protocole est prouvé, pas le stock.");
  }

  const runId = Math.random().toString(36).slice(2, 10);
  const dir = path.join(RACINE, "out");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `releves-liteapi-${runId}.json`);
  fs.writeFileSync(f, JSON.stringify(records, null, 2));
  const rel = path.relative(RACINE, f).replace(/\\/g, "/");

  // Le moteur choisit ses CANDIDATS dans l'inventaire de l'escale, puis cherche leur
  // relevé dans la fixture. Sans entrée d'inventaire, une fixture ne loge personne.
  const entrees = [...inventaireParHotel.values()];
  // `reference` = la nuit sur laquelle l'inventaire a été relevé (schéma : objet, pas texte)
  const inv = { station: STATION, updated_at: new Date().toISOString(), reference: { checkin: CHECKIN, nights: NUITS }, hotels: entrees };
  const fi = path.join(dir, `inventaire-liteapi-${runId}.json`);
  fs.writeFileSync(fi, JSON.stringify(inv, null, 2));

  console.log("");
  console.log(`Relevés écrits   : ${rel}`);
  console.log(`Inventaire écrit : ${path.relative(RACINE, fi).replace(/\\/g, "/")} (${entrees.length} entrée(s), source « api »)`);

  if (has("--ecrire-inventaire")) {
    const cible = path.join(RACINE, "data", "inventaire", `${STATION}.json`);
    const existant = loadInventaire(STATION);
    // aligne les ids frais sur ceux de l'inventaire existant (URL puis nom) : un hôtel
    // déjà fiché sous un autre slug est MIS À JOUR, jamais dupliqué
    const alignes = reconcileIds(existant, entrees);
    const fusion = mergeInventaire(existant, { ...inv, hotels: alignes });
    fs.writeFileSync(cible, JSON.stringify(fusion, null, 2));
    console.log("");
    console.log(`INVENTAIRE DE L'ESCALE MIS À JOUR : data/inventaire/${STATION}.json — ${fusion.hotels.length} hôtel(s)`);
    console.log("  Ce fichier est VERSIONNÉ. Pour revenir en arrière :");
    console.log(`  git checkout data/inventaire/${STATION}.json`);
  } else {
    console.log("");
    console.log("Pour que le moteur puisse LOGER dans ces hôtels, il faut qu'ils entrent dans");
    console.log("l'inventaire de l'escale — sinon il ne les prendra jamais comme candidats :");
    console.log(`  node hai-admin-mcp/tools/liteapi-releves.mjs --station ${STATION} --checkin ${CHECKIN}${BALAYAGE ? " --balayage" : ""} --ecrire-inventaire`);
    console.log("  (data/inventaire/<escale>.json est versionné — restaurable par git checkout)");
  }

  console.log("");
  console.log("Rejouer dans le moteur (gratuit, aucun agent) :");
  console.log(`  node hai-admin-mcp/tools/rebooking-v2.mjs --offline ${rel} --checkin ${CHECKIN}`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
