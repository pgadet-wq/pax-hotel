/**
 * Banc de sonde des API hôtelières en libre-service.
 *
 * Objet : répondre par la MESURE aux trois inconnues laissées ouvertes par l'analyse
 * d'architecture — couverture réelle autour d'une escale, existence d'un seuil « groupe »
 * quand on demande beaucoup de chambres, et profondeur d'inventaire par établissement.
 *
 * ÉTAT DU MARCHÉ MESURÉ LE 22/09/2026 (préflight sans clé, T0) :
 *   LiteAPI · Duffel Stays · RateHawk · Hotelbeds (test)  -> VIVANTS, 401 propre
 *   Amadeus Self-Service                                   -> MORT, décommissionné le
 *     17/07/2026 ; `test.api.amadeus.com` ne résout plus en DNS. Il reste au banc pour
 *     que sa disparition soit mesurée à chaque passage, et non supposée.
 *
 * INV-1 : ce banc ne réserve JAMAIS. Il n'appelle que des points d'entrée de recherche et
 * de disponibilité. Aucun `book`, aucun `prebook`, aucun moyen de paiement.
 * INV-2 : aucune émulation de navigateur, aucun contournement. Ce sont des API publiques
 * appelées avec une clé, par leur usage prévu.
 * Les clés sont lues dans l'environnement et ne sont JAMAIS journalisées.
 *
 * Usage :
 *   node hai-admin-mcp/tools/sonde-api.mjs --preflight
 *   node hai-admin-mcp/tools/sonde-api.mjs --liteapi --station BKK
 *   node hai-admin-mcp/tools/sonde-api.mjs --liteapi --escales-minces
 *   node hai-admin-mcp/tools/sonde-api.mjs --amadeus --station BKK
 *
 * Variables d'environnement :
 *   LITEAPI_KEY                  clé LiteAPI (sandbox `sand_...` ou production `prod_...`)
 *   AMADEUS_CLIENT_ID / _SECRET  identifiants Amadeus Self-Service
 *   AMADEUS_ENV                  `test` (défaut) ou `prod`
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* ------------------------------------------------------------------ constantes */

const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const AMADEUS_BASE = { test: "https://test.api.amadeus.com", prod: "https://api.amadeus.com" };

/** Escales du réseau. `ville` = code ville IATA pour Amadeus ; `iata` = code aéroport. */
const ESCALES = {
  BKK: { nom: "Bangkok Suvarnabhumi", iata: "BKK", ville: "BKK", pays: "TH", lat: 13.6900, lon: 100.7501 },
  NOU: { nom: "Noumea La Tontouta", iata: "NOU", ville: "NOU", pays: "NC", lat: -22.0146, lon: 166.2130 },
  CDG: { nom: "Paris Charles de Gaulle", iata: "CDG", ville: "PAR", pays: "FR", lat: 49.0097, lon: 2.5479 },
  // escales minces : c'est la que la couverture des agregateurs se juge
  WLS: { nom: "Wallis Hihifo", iata: "WLS", ville: "WLS", pays: "WF", lat: -13.2383, lon: -176.1991 },
  VLI: { nom: "Port-Vila Bauerfield", iata: "VLI", ville: "VLI", pays: "VU", lat: -17.6993, lon: 168.3197 },
  NAN: { nom: "Nadi", iata: "NAN", ville: "NAN", pays: "FJ", lat: -17.7554, lon: 177.4434 },
  PPT: { nom: "Papeete Faaa", iata: "PPT", ville: "PPT", pays: "PF", lat: -17.5537, lon: -149.6070 },
};

/** Échelle de la sonde de seuil : combien de chambres demande-t-on d'un coup. */
const ECHELLE = [1, 2, 5, 8, 9, 10, 15, 20, 30, 40];

/* ------------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const STATION = (opt("--station", "BKK") || "BKK").toUpperCase();
const CHECKIN = opt("--checkin", "2026-09-22");
const CHECKOUT = opt("--checkout", "2026-09-23");
const NATIONALITE = opt("--nationalite", "FR");
const DEVISE = opt("--devise", "EUR");
const RAYON_KM = Number(opt("--rayon", "40"));
const BESOIN = Number(opt("--besoin", "209")); // chambres demandees par la liste SB800

/* --------------------------------------------------------------------- sorties */

const trace = [];
const dire = (s = "") => { console.log(s); };
const noter = (evt) => { trace.push({ at: new Date().toISOString(), ...evt }); };

/** Appel HTTP journalise, SANS jamais ecrire la cle. */
async function appel(url, { method = "GET", headers = {}, body = null, brut = null, label = "" } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(brut ? { body: brut } : body ? { body: JSON.stringify(body) } : {}),
    });
    const texte = await res.text();
    let json = null;
    try { json = JSON.parse(texte); } catch { /* reponse non JSON : gardee en texte */ }
    const ms = Date.now() - t0;
    noter({ label, url, method, statut: res.status, ms, taille: texte.length });
    return { ok: res.ok, statut: res.status, ms, json, texte, erreur: null };
  } catch (err) {
    const ms = Date.now() - t0;
    const message = String(err?.message ?? err);
    noter({ label, url, method, erreur: message, ms });
    return { ok: false, statut: 0, ms, json: null, texte: "", erreur: message };
  }
}

/* ------------------------------------------------------- T0 : preflight sans cle */

/**
 * Verifie SANS cle que les points d'entree existent, que l'URL et le nom d'en-tete sont
 * les bons, et releve la forme exacte du refus d'authentification. Un 401/403 est ici un
 * SUCCES : il prouve que le serveur a compris la requete et n'a rejete que la cle.
 */
async function preflight() {
  dire("=== T0 - preflight sans cle : les points d'entree repondent-ils ? ===");
  dire("");
  const essais = [
    {
      nom: "LiteAPI · POST /hotels/rates",
      url: `${LITEAPI_BASE}/hotels/rates`,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "" },
      body: {
        checkin: CHECKIN, checkout: CHECKOUT, currency: DEVISE, guestNationality: NATIONALITE,
        occupancies: [{ adults: 2 }], cityName: "Bangkok", countryCode: "TH",
      },
    },
    {
      nom: "LiteAPI · GET /data/hotels",
      url: `${LITEAPI_BASE}/data/hotels?countryCode=TH&cityName=Bangkok&limit=5`,
      method: "GET", headers: { "X-API-Key": "" },
    },
    {
      nom: "Duffel Stays · POST /stays/search",
      url: "https://api.duffel.com/stays/search",
      method: "POST",
      headers: { "Content-Type": "application/json", "Duffel-Version": "v2", Authorization: "Bearer " },
      body: {},
    },
    {
      nom: "RateHawk · POST /search/serp/geo",
      url: "https://api.worldota.net/api/b2b/v3/search/serp/geo/",
      method: "POST", headers: { "Content-Type": "application/json" }, body: {},
    },
    {
      nom: "Hotelbeds · GET /hotel-api/1.0/status",
      url: "https://api.test.hotelbeds.com/hotel-api/1.0/status",
      method: "GET", headers: { "Api-key": "" },
    },
    {
      // Décommissionné le 17/07/2026 : gardé au banc pour que la panne soit MESURÉE
      // et non supposée. `test.api.amadeus.com` ne résout plus en DNS.
      nom: "Amadeus Self-Service · POST /v1/security/oauth2/token (décommissionné 17/07/2026)",
      url: `${AMADEUS_BASE.test}/v1/security/oauth2/token`,
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      brut: "grant_type=client_credentials&client_id=&client_secret=",
    },
  ];

  const resultats = [];
  for (const e of essais) {
    const r = await appel(e.url, { method: e.method, headers: e.headers, body: e.body ?? null, brut: e.brut ?? null, label: e.nom });
    // 400/401/403 = le serveur a compris et rejette la cle : l'adresse est bonne.
    // 404 = mauvaise URL. 0 = injoignable.
    const verdict = r.statut === 0 ? "INJOIGNABLE"
      : r.statut === 404 ? "URL FAUSSE"
      : [400, 401, 403].includes(r.statut) ? "ATTEINT (refus d'authentification, attendu)"
      : r.ok ? "ATTEINT (repond sans cle)"
      : `ATTEINT (HTTP ${r.statut})`;
    const extrait = (r.texte || r.erreur || "").replace(/\s+/g, " ").slice(0, 160);
    dire(`  ${e.nom}`);
    dire(`    -> HTTP ${r.statut} en ${r.ms} ms — ${verdict}`);
    if (extrait) dire(`    -> ${extrait}`);
    dire("");
    resultats.push({ nom: e.nom, statut: r.statut, ms: r.ms, verdict, extrait });
  }
  return resultats;
}

/* ------------------------------------------------- T1/T3 : couverture LiteAPI */

/**
 * Clé LiteAPI. Lue d'abord dans l'environnement, sinon dans `~/.config/hai/.env` —
 * MÊME convention que `readApiKey()` pour la clé H. L'opérateur dépose sa clé dans un
 * fichier : elle ne transite jamais par une ligne de commande ni par un journal.
 */
const cleLite = () => {
  if (process.env.LITEAPI_KEY) return process.env.LITEAPI_KEY;
  try {
    const f = path.join(os.homedir(), ".config", "hai", ".env");
    const m = /^\s*LITEAPI_KEY\s*=\s*(\S+)/m.exec(fs.readFileSync(f, "utf8"));
    return m ? m[1] : null;
  } catch { return null; }
};

async function liteRates({ occupancies, hotelIds = null, escale, rayonKm = RAYON_KM }) {
  const key = cleLite();
  const body = {
    checkin: CHECKIN, checkout: CHECKOUT, currency: DEVISE, guestNationality: NATIONALITE,
    occupancies,
    ...(hotelIds ? { hotelIds } : { latitude: escale.lat, longitude: escale.lon, radius: Math.round(rayonKm * 1000) }),
    limit: 200,
  };
  return appel(`${LITEAPI_BASE}/hotels/rates`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body,
    label: `liteapi rates ${escale?.iata ?? "?"} x${occupancies.length}`,
  });
}

/** Compte les hotels et les offres d'une reponse LiteAPI, quelle que soit sa forme exacte. */
function depouillerLite(json) {
  const data = json?.data ?? json?.hotels ?? json ?? [];
  const liste = Array.isArray(data) ? data : Array.isArray(data?.hotels) ? data.hotels : [];
  let offres = 0, typesMax = 0;
  for (const h of liste) {
    const rb = h?.roomTypes ?? h?.rooms ?? h?.rates ?? [];
    const n = Array.isArray(rb) ? rb.length : 0;
    offres += n; typesMax = Math.max(typesMax, n);
  }
  return { hotels: liste.length, offres, typesMax };
}

async function t1Couverture(escale) {
  dire(`=== T1 - couverture LiteAPI autour de ${escale.nom} (${escale.iata}), rayon ${RAYON_KM} km ===`);
  dire("");
  const r = await liteRates({ occupancies: [{ adults: 2 }], escale });
  if (!r.ok) {
    dire(`  ECHEC HTTP ${r.statut} — ${(r.texte || r.erreur || "").replace(/\s+/g, " ").slice(0, 200)}`);
    dire("");
    return { escale: escale.iata, ok: false, statut: r.statut };
  }
  const d = depouillerLite(r.json);
  dire(`  ${d.hotels} hotel(s), ${d.offres} offre(s) de chambre, jusqu'a ${d.typesMax} type(s) sur un meme hotel`);
  dire(`  reponse en ${r.ms} ms`);
  dire("");
  return { escale: escale.iata, ok: true, ...d, ms: r.ms };
}

/* ------------------------------------------------ T2 : l'echelle, le seuil groupe */

/**
 * LA mesure qui decide de tout : jusqu'a combien de chambres l'API repond-elle ?
 * On envoie N occupancies (une par chambre) et on regarde si des tarifs reviennent.
 * Si la reponse tient jusqu'a 40, le plafond de 9 des sites grand public n'existe pas ici.
 */
async function t2Echelle(escale, hotelIds = null) {
  dire("=== T2 - echelle d'occupancies : ou est le seuil groupe ? ===");
  dire("");
  const lignes = [];
  for (const n of ECHELLE) {
    const occupancies = Array.from({ length: n }, () => ({ adults: 2 }));
    const r = await liteRates({ occupancies, hotelIds, escale });
    const d = r.ok ? depouillerLite(r.json) : { hotels: 0, offres: 0, typesMax: 0 };
    const verdict = !r.ok ? `REFUS HTTP ${r.statut}` : d.hotels === 0 ? "aucune offre" : `${d.hotels} hotel(s), ${d.offres} offre(s)`;
    dire(`  ${String(n).padStart(2)} chambre(s) -> ${verdict} (${r.ms} ms)`);
    if (!r.ok) dire(`      ${(r.texte || r.erreur || "").replace(/\s+/g, " ").slice(0, 160)}`);
    lignes.push({ chambres: n, ok: r.ok, statut: r.statut, hotels: d.hotels, offres: d.offres, ms: r.ms });
    await new Promise((s) => setTimeout(s, 350)); // courtoisie : on n'inonde pas le fournisseur
  }
  const dernierOk = [...lignes].reverse().find((l) => l.ok && l.hotels > 0);
  dire("");
  dire(dernierOk
    ? `  Plus grande demande servie : ${dernierOk.chambres} chambre(s) en un seul appel.`
    : "  Aucune demande servie — cle, couverture ou dates a verifier.");
  if (dernierOk && dernierOk.chambres >= 9) dire("  Le plafond de 9 des sites grand public ne s'applique PAS ici.");
  dire("");
  return lignes;
}

/* -------------------------------------------------- T4 : escales minces */

async function t4EscalesMinces() {
  dire("=== T4 - couverture des escales minces ===");
  dire("");
  const out = [];
  for (const code of ["NOU", "WLS", "VLI", "NAN", "PPT"]) {
    const e = ESCALES[code];
    const r = await liteRates({ occupancies: [{ adults: 2 }], escale: e });
    const d = r.ok ? depouillerLite(r.json) : { hotels: 0, offres: 0 };
    dire(`  ${code} ${e.nom.padEnd(26)} -> ${r.ok ? `${d.hotels} hotel(s), ${d.offres} offre(s)` : `HTTP ${r.statut}`} (${r.ms} ms)`);
    out.push({ escale: code, nom: e.nom, ok: r.ok, statut: r.statut, hotels: d.hotels, offres: d.offres });
    await new Promise((s) => setTimeout(s, 350));
  }
  dire("");
  return out;
}

/* --------------------------------------------------------- T5 : Amadeus */

async function amadeusToken() {
  const id = process.env.AMADEUS_CLIENT_ID, secret = process.env.AMADEUS_CLIENT_SECRET;
  if (!id || !secret) return null;
  const base = AMADEUS_BASE[process.env.AMADEUS_ENV === "prod" ? "prod" : "test"];
  const r = await appel(`${base}/v1/security/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    brut: `grant_type=client_credentials&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
    label: "amadeus token",
  });
  return r.json?.access_token ?? null;
}

async function t5Amadeus(escale) {
  dire(`=== T5 - Amadeus Self-Service sur ${escale.iata} ===`);
  dire("");
  const token = await amadeusToken();
  if (!token) { dire("  (identifiants Amadeus absents — test non joue)"); dire(""); return { joue: false }; }
  const base = AMADEUS_BASE[process.env.AMADEUS_ENV === "prod" ? "prod" : "test"];
  const auth = { Authorization: `Bearer ${token}` };

  const rl = await appel(
    `${base}/v1/reference-data/locations/hotels/by-city?cityCode=${escale.ville}&radius=${RAYON_KM}&radiusUnit=KM`,
    { headers: auth, label: "amadeus by-city" },
  );
  const hotels = rl.json?.data ?? [];
  dire(`  ${hotels.length} hotel(s) reference(s) autour de ${escale.ville} (${rl.ms} ms)`);
  if (!hotels.length) { dire(""); return { joue: true, hotels: 0 }; }

  // l'equivalent Amadeus de l'echelle : le parametre roomQuantity
  const ids = hotels.slice(0, 20).map((h) => h.hotelId).join(",");
  const paliers = [];
  for (const q of [1, 5, 9, 10, 15, 20]) {
    const r = await appel(
      `${base}/v3/shopping/hotel-offers?hotelIds=${ids}&adults=2&roomQuantity=${q}&checkInDate=${CHECKIN}&checkOutDate=${CHECKOUT}&currency=${DEVISE}`,
      { headers: auth, label: `amadeus offers q=${q}` },
    );
    const n = (r.json?.data ?? []).length;
    const msg = r.ok ? `${n} hotel(s) avec offre` : `REFUS HTTP ${r.statut} — ${(r.texte || "").replace(/\s+/g, " ").slice(0, 120)}`;
    dire(`  roomQuantity=${String(q).padStart(2)} -> ${msg} (${r.ms} ms)`);
    paliers.push({ roomQuantity: q, ok: r.ok, statut: r.statut, hotels: n, ms: r.ms });
    await new Promise((s) => setTimeout(s, 350));
  }
  dire("");
  return { joue: true, hotels: hotels.length, paliers };
}

/* ------------------------------------------------------------------- principal */

async function main() {
  dire(`Banc de sonde des API hotelieres — escale ${STATION}, nuit du ${CHECKIN} au ${CHECKOUT}`);
  dire(`Besoin de reference : ${BESOIN} chambres (liste SB800)`);
  dire("INV-1 : aucun appel de reservation n'est emis par ce banc.");
  dire("");

  const escale = ESCALES[STATION];
  if (!escale) { console.error(`Escale inconnue : ${STATION}. Connues : ${Object.keys(ESCALES).join(", ")}`); process.exit(2); }

  const rapport = { station: STATION, checkin: CHECKIN, checkout: CHECKOUT, besoin: BESOIN, at: new Date().toISOString() };

  if (has("--preflight") || argv.length === 0) rapport.preflight = await preflight();

  if (has("--liteapi")) {
    if (!cleLite()) { dire("LITEAPI_KEY absente — tests LiteAPI non joues."); dire(""); }
    else {
      rapport.t1 = await t1Couverture(escale);
      if (!has("--escales-minces")) rapport.t2 = await t2Echelle(escale, opt("--hotel") ? [opt("--hotel")] : null);
      if (has("--escales-minces")) rapport.t4 = await t4EscalesMinces();
    }
  }
  if (has("--amadeus")) rapport.t5 = await t5Amadeus(escale);

  rapport.trace = trace;
  const dir = path.join(process.cwd(), "out");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `sonde-api-${STATION}-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(rapport, null, 2));
  dire(`Rapport ecrit : ${path.relative(process.cwd(), f)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
