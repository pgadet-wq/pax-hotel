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
import { loadInventaire, mergeInventaire, normalizeInventaire, isStale, slugify, reconcileIds, INVENTAIRE_DIR } from "../lib/inventaire.mjs";
import { buildNflt, buildSearchUrl, buildHotelUrl } from "../lib/hai-urls.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { newRunId } from "../lib/scenario.mjs";
import { mkEmitter } from "../lib/events.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Étage 0 par agents (--refresh, --max) : PAYANT — garde INV-8, réservé aux phases 5-6.
const wantsRefresh = flag("refresh") || opt("max", null) !== null;
if (wantsRefresh && process.env.DEMO_ALLOW_PAID !== "1") {
  console.error("refusé (INV-8) : --refresh/--max lancent des sessions d'agents PAYANTES (Étage 0).");
  console.error("Réservé aux phases 5-6, sur demande explicite : exporter DEMO_ALLOW_PAID=1 pour l'autoriser.");
  console.error("Modes gratuits : --dry-run, --offline <fixtures.json>.");
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

/* --------------------------------------- Étage 0 par agents (EX-INV-5, payant) */

if (!wantsRefresh) {
  console.error("préciser un mode : --dry-run, --offline <fixtures.json>, ou --refresh [--max n] (payant, DEMO_ALLOW_PAID=1).");
  process.exit(1);
}

const MAX = Number(opt("max", "10"));
if (!Number.isInteger(MAX) || MAX < 1 || MAX > 15) throw new Error(`--max doit être un entier de 1 à 15 (reçu : ${opt("max", "10")})`);

const { createClient, apiOrigin, readApiKey, ensureAgentV2, agentNameV2, inventaireHotelSchema, promptInventaireHotel, toInventaireEntry, pumpToCompletion } =
  await import("../lib/hai.mjs");
const { runDiscovery } = await import("../lib/discovery.mjs");
const { discoverySchema } = await import("../lib/hai.mjs");

const OUT_DIR = path.join(ROOT, "out");
const runId = newRunId();
const groupId = `inv-${station.code.toLowerCase()}-${runId}`; // EX-INV-7
const t0 = Date.now();
const captures = []; // {hotel_key, seq, source, imageType, mediaType}
const metricsByKey = new Map(); // hotel_key → dernier {steps, cost_usd, tokens}
let queue429 = 0;
let inFlight = 0;
let maxInFlight = 0; // concurrence réellement obtenue (mesure §13)

const emit = mkEmitter({ run_id: runId }, (ev) => {
  const d = ev.data;
  const key = ev.hotel_key ?? "?";
  if (ev.type === "warning") {
    console.log(`[warn ] ${d.message}`);
    if (/429|rate.?limit|file d'attente|queue/i.test(d.message)) queue429 += 1;
  } else if (ev.type === "error") console.log(`[erreur] ${key} : ${d.message}`);
  else if (ev.type === "phase") console.log(`[phase] ${d.phase}${d.done ? ` terminé (${d.count ?? ""})` : ""}`);
  else if (ev.type === "agent_status" && d.status) console.log(`[agent] ${key} : ${d.status}${d.live_view_url ? ` — vue live : ${d.live_view_url}` : ""}`);
  else if (ev.type === "agent_thought") console.log(`[pensée] ${key} : ${d.text}`);
  else if (ev.type === "candidate") console.log(`[cand ] ${d.name} (${d.stars ?? "?"}★, ${d.review_score ?? "?"}/10)`);
  else if (ev.type === "metrics" && ev.hotel_key) metricsByKey.set(key, d);
  else if (ev.type === "screenshot") {
    const seq = captures.filter((c) => c.hotel_key === key).length;
    captures.push({ hotel_key: key, seq, source: d.source, imageType: d.imageType ?? null, mediaType: d.mediaType ?? "image/png" });
  }
});

console.log(`Étage 0 — inventaire ${station.code} par agents (groupe ${groupId}, max ${MAX} hôtels, référence ${CHECKIN} → ${CHECKOUT})`);
const client = createClient();

/* 1. découverte (logique Étage A : 1 session, 2 passes) */
const disc = await runDiscovery({ client, policy, station, checkin: CHECKIN, checkout: CHECKOUT, groupId, emit });
const discSchemaOk = disc.flat ? discoverySchema.safeParse(disc.flat).success : false;
const candidats = disc.candidates.slice(0, MAX);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, `candidats-${runId}.json`),
  JSON.stringify({
    runId, kind: "inventaire-discovery", station: station.code, checkin: CHECKIN, checkout: CHECKOUT, groupId,
    sessionId: disc.sessionId, status: disc.status, outcome: disc.outcome, currency: disc.currency,
    notes: disc.notes, schema_valid: discSchemaOk, answer: disc.flat, candidates: disc.candidates,
  }, null, 2) + "\n",
  "utf8",
);
console.log(`écrit out/candidats-${runId}.json (${disc.candidates.length} candidats, devise ${disc.currency}, schéma ${discSchemaOk ? "valide" : "NON valide"})`);
if (!candidats.length) {
  console.error("découverte sans candidat : inventaire inchangé (replis de la fiche escale disponibles au run).");
  process.exit(1);
}

/* 2. un relevé d'inventaire court par candidat — concurrence 3, décalage 25 s (EX-INV-5) */
await ensureAgentV2(client, station, policy);
const queue = [...candidats];
const entries = [];
const sessions = []; // bilan par session (mesures §13)
let started = 0;
async function worker() {
  for (;;) {
    const cand = queue.shift();
    if (!cand) return;
    const delay = started * 25000;
    started += 1;
    if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 25000)));
    const hotelKey = slugify(cand.name);
    const url = cand.url ? buildHotelUrl(cand.url, { checkin: CHECKIN, checkout: CHECKOUT }) : null;
    try {
      const handle = await client.startSession({
        agent: agentNameV2(station),
        messages: promptInventaireHotel({ hotelName: cand.name, hasStartUrl: Boolean(url), checkin: CHECKIN, checkout: CHECKOUT }),
        maxSteps: 30,
        maxTimeS: 600,
        groupId,
        answerSchema: inventaireHotelSchema,
        ...(url ? { overrides: { "agent.environments[kind=web].start_url": url } } : {}),
      });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let result;
      try {
        result = await pumpToCompletion(handle, (type, data) => emit(type, data, { hotel_key: hotelKey, session_id: handle.id }));
      } finally {
        inFlight -= 1;
      }
      let flat = result.answer;
      if (typeof flat === "string") {
        try { flat = JSON.parse(flat); } catch { flat = null; }
      }
      const m = metricsByKey.get(hotelKey) ?? {};
      sessions.push({ hotel: hotelKey, name: cand.name, sessionId: handle.id, status: result.status, outcome: result.outcome ?? null, found: flat?.found ?? false, steps: m.steps ?? 0, cost_usd: m.cost_usd ?? 0, schema_valid: inventaireHotelSchema.safeParse(flat).success, answer: flat });
      const entry = toInventaireEntry(flat, { id: hotelKey });
      if (entry) entries.push(entry);
      else emit("warning", { message: `« ${cand.name} » : relevé d'inventaire sans résultat (${result.error ?? flat?.notes ?? "found=false"})` });
    } catch (err) {
      emit("warning", { message: `« ${cand.name} » : session d'inventaire en échec (${err?.message ?? err})` });
      sessions.push({ hotel: hotelKey, name: cand.name, sessionId: null, status: "error", outcome: null, found: false, steps: 0, cost_usd: 0, schema_valid: false, answer: null, error: String(err?.message ?? err) });
    }
  }
}
await Promise.all(Array.from({ length: 3 }, () => worker()));

/* 3. fusion et écriture (EX-INV-6) — ids réconciliés avec l'existant (pas de doublon d'hôtel) */
const reconciled = reconcileIds(existing, entries, {
  onDrop: (e, id) => emit("warning", { message: `« ${e.name} » écarté : hôtel déjà relevé dans ce lot (${id})` }),
});
const fresh = normalizeInventaire({
  station: station.code,
  updated_at: new Date().toISOString(),
  reference: { checkin: CHECKIN, nights: NIGHTS },
  hotels: reconciled,
}, "inventaire Étage 0");
const merged = mergeInventaire(existing, fresh);
const dest = path.join(INVENTAIRE_DIR, `${station.code}.json`);
fs.mkdirSync(INVENTAIRE_DIR, { recursive: true });
fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n", "utf8");
console.log(`Écrit ${dest} — ${merged.hotels.length} hôtel(s), ${reconciled.length} relevé(s) frais (groupe ${groupId}).`);

/* 4. mesures (§13, H-9) + archives + captures */
const duration_s = Math.round((Date.now() - t0) / 1000);
let cost_usd = 0, steps = 0;
for (const m of metricsByKey.values()) {
  cost_usd += m.cost_usd ?? 0;
  steps += m.steps ?? 0;
}
cost_usd = Math.round(cost_usd * 10000) / 10000;
const mesures = {
  duration_s, sessions: metricsByKey.size, steps, cost_usd, queue_or_429: queue429,
  concurrency_config: 3, stagger_ms: 25000, max_in_flight_observed: maxInFlight,
  discovery: { sessionId: disc.sessionId, status: disc.status, steps: disc.steps ?? 0, cost_usd: disc.costUsd ?? 0 },
};
fs.writeFileSync(
  path.join(OUT_DIR, `inventaire-${runId}.json`),
  JSON.stringify({ runId, kind: "inventaire-releves", station: station.code, checkin: CHECKIN, checkout: CHECKOUT, groupId, entries: reconciled, sessions, mesures }, null, 2) + "\n",
  "utf8",
);
console.log(`écrit out/inventaire-${runId}.json (${reconciled.length} entrées, ${sessions.length} sessions)`);

if (captures.length) {
  const dir = path.join(OUT_DIR, `captures-${runId}`);
  fs.mkdirSync(dir, { recursive: true });
  const origin = new URL(apiOrigin()).origin;
  let saved = 0;
  for (const c of captures) {
    try {
      const src = String(c.source ?? "");
      let buf = null;
      let ext = String(c.mediaType ?? "").includes("jpeg") ? ".jpg" : ".png";
      if (c.imageType === "base64" && !src.startsWith("data:")) buf = Buffer.from(src, "base64");
      else if (src.startsWith("data:")) {
        const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
        if (!m) continue;
        buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
      } else if (/^https:\/\//.test(src)) {
        const r = await fetch(src, new URL(src).origin === origin ? { headers: { Authorization: `Bearer ${readApiKey()}` } } : undefined);
        if (!r.ok) continue;
        buf = Buffer.from(await r.arrayBuffer());
        if ((r.headers.get("content-type") ?? "").includes("jpeg")) ext = ".jpg";
      } else continue;
      fs.writeFileSync(path.join(dir, `${c.hotel_key.replace(/[^a-z0-9_-]/gi, "_")}-${String(c.seq).padStart(2, "0")}${ext}`), buf);
      saved += 1;
    } catch {
      /* capture manquée : sans gravité */
    }
  }
  console.log(`captures enregistrées : ${saved}/${captures.length} → out/captures-${runId}/`);
}

console.log(
  `\nBilan Étage 0 — durée ${duration_s} s · découverte ${Math.round((disc.costUsd ?? 0) * 10000) / 10000} $ + ` +
    `${metricsByKey.size - (metricsByKey.has("_discovery") ? 1 : 0)} relevés · total ${cost_usd} $ · ` +
    `concurrence observée ${maxInFlight}/3 · files/429 : ${queue429}`,
);
