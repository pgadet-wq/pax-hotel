#!/usr/bin/env node
/**
 * CLI v2 (CDC §12.1) — prise en charge hébergement multi-escale.
 *
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run [--station BKK]
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json
 *
 *   --station BKK|CDG|NOU     escale (défaut BKK)
 *   --checkin YYYY-MM-DD      arrivée (défaut : aujourd'hui)
 *   --nights <n>              nuits (défaut 1)   --seed <n> (défaut 42)
 *   --in <csv>                liste passagers (défaut : A350 plein généré, seed)
 *   --dry-run                 besoins, inventaire, décision découverte, URLs, plan d'extension — AUCUN agent
 *   --offline <fixtures>      rejoue des relevés de fixtures → plan, rapport, messages, coût ; 0 €
 *
 * Options PAYANTES (INV-8) — exigent DEMO_ALLOW_PAID=1, réservées aux phases 5-6 :
 *   --probe-discovery                    1 session de découverte (~0,21 $) → out/candidats-{runId}.json
 *   --probe-releve <n>                   n sessions de relevé (~0,30 $/session) → out/releves-{runId}.json
 *   --probe-capacity <url> --rooms <n>   1 sonde de capacité (~0,15 $, H-3) → out/probe-{runId}.json
 *   --probe-inventaire --max <n>         Étage 0 limité (délégué à tools/inventaire.mjs --refresh)
 *   (sans option)                        run complet (phase 6)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadStation } from "../lib/stations.mjs";
import { loadInventaire, isStale, candidatesFrom, slugify, capaciteIndicative } from "../lib/inventaire.mjs";
import { DEFAULT_POLICY, effectiveCaps } from "../lib/policy.mjs";
import { mergeConfig, resolveDates, DEFAULT_AVION, newRunId, stationClock } from "../lib/scenario.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { ingestPassagers, formatRapport, IngestError } from "../lib/paxlist.mjs";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { discoveryNeeded, runDiscovery } from "../lib/discovery.mjs";
import { planExtension, runProbe } from "../lib/capacite.mjs";
import { runReleves } from "../lib/releve.mjs";
import { buildHotelUrl, buildProbeUrl } from "../lib/hai-urls.mjs";
import { runPipeline, fixturesCollect } from "../lib/pipeline.mjs";
import { mkEmitter } from "../lib/events.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "out");

/* ---------------------------------------------------- garde INV-8 (payant) */

const PAID_FLAGS = ["probe-discovery", "probe-releve", "probe-capacity", "probe-inventaire"];
const wantsPaid = PAID_FLAGS.some((f) => flag(f)) || (!flag("dry-run") && !opt("offline", null));
if (wantsPaid && process.env.DEMO_ALLOW_PAID !== "1") {
  console.error("refusé (INV-8) : cette commande lancerait des sessions d'agents PAYANTES.");
  console.error("Elle est réservée aux phases 5-6, sur demande explicite : exporter DEMO_ALLOW_PAID=1 pour l'autoriser.");
  console.error("Modes gratuits : --dry-run, --offline <fixtures.json>.");
  process.exit(1);
}

/* ------------------------------------------------------------ paramètres */

const station = loadStation(opt("station", "BKK"));
const { policy, avion, scenario } = mergeConfig({
  scenario: {
    station: station.code,
    ...(opt("checkin", null) ? { checkin: opt("checkin", null) } : {}),
    nights: Number(opt("nights", "1")),
    seed: Number(opt("seed", "42")),
  },
});
const { checkin, checkout } = resolveDates(scenario, new Date(), station.timezone);

/* Liste passagers : fichier compagnie (ingestion PAXLIST v1, rapport imprimé et
   BLOQUANT sur valeur illisible) ou liste générée (avion plein, seed du scénario). */
let rows;
let ingestion = null;
if (opt("in", null)) {
  const fichier = path.resolve(opt("in", null));
  try {
    const ing = ingestPassagers(fs.readFileSync(fichier));
    console.log(`Liste passagers : ${fichier}`);
    console.log(formatRapport(ing.rapport));
    if (ing.equipage.length) console.log(`  (${ing.equipage.length} ligne(s) d'équipage hors plan passagers)`);
    if (ing.exclus.length) console.log(`  (${ing.exclus.length} ligne(s) non à loger)`);
    console.log("");
    rows = ing.pax;
    ingestion = ing.rapport;
  } catch (err) {
    if (!(err instanceof IngestError)) throw err;
    console.error(`\nListe passagers REFUSÉE — ${fichier}\n`);
    console.error(err.message);
    if (err.rapport) console.error(`\n${formatRapport(err.rapport)}`);
    process.exit(2);
  }
} else {
  rows = generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
}

/* ---------------------------------------------------------------- dry-run */

if (flag("dry-run")) {
  const dossiers = buildDossiers(rows, policy);
  const needs = computeNeeds(dossiers);
  const caps = effectiveCaps(policy, station);
  const horloge = stationClock(new Date(), station.timezone);
  console.log(`Escale ${station.code} — ${station.name} · séjour du ${checkin} au ${checkout} (${scenario.nights} nuit${scenario.nights > 1 ? "s" : ""})`);
  console.log(`  heure locale escale : ${horloge.date} ${horloge.heure} (${station.timezone}) — c'est CETTE nuit qui sera relevée`);
  console.log(`${rows.length} passagers, ${dossiers.length} dossiers — plafonds effectifs J ${caps.J} / W ${caps.W} / Y ${caps.Y} EUR/nuit`);
  console.log("\nBesoins par tier :");
  for (const tier of ["J", "W", "Y"]) {
    const n = needs.parTier[tier] ?? { dossiers: 0, chambres: 0 };
    console.log(`  ${tier} : ${n.dossiers} dossiers, ${n.chambres} chambres`);
  }
  console.log("Files de priorité :", Object.entries(needs.parFile).map(([f, v]) => `${f} ${v.dossiers}d/${v.chambres}ch`).join(" · "));

  const inv = loadInventaire(station.code);
  const stale = isStale(inv, policy);
  console.log(`\nInventaire ${station.code} : ${inv ? `${inv.hotels.length} hôtel(s), mis à jour le ${inv.updated_at ?? "jamais"}` : "absent"} · périmé : ${stale ? "oui" : "non"}`);

  const decision = discoveryNeeded({ inv, policy, station, needs: needs.parTier, force: scenario.force_discovery });
  console.log(`Découverte : ${decision.run ? "EXÉCUTÉE" : "SAUTÉE"} — ${decision.reason}`);

  const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });
  const maxB = policy.global.discovery.max_hotels_stage_b;
  const besoinTotal = ["J", "W", "Y"].reduce((n, t) => n + (needs.parTier[t]?.chambres ?? 0), 0);
  const cap = capaciteIndicative(candidates);
  console.log(`\nVivier : ${cap.hotels} candidat(s) — capacité indicative ~${cap.total} chambre(s) pour un besoin de ${besoinTotal}`);
  if (cap.total < besoinTotal) {
    console.log("  ATTENTION : le vivier ne peut PAS couvrir le besoin — le run s'arrêtera « épuisé » et escaladera.");
    console.log(`  Avant le run : DEMO_ALLOW_PAID=1 node hai-admin-mcp/tools/inventaire.mjs --station ${station.code} --refresh --max 20`);
    console.log("  ou cocher « Forcer la découverte » pour chercher des hôtels au-delà de l'inventaire.");
  }
  console.log(`\nRelevés étage B (${Math.min(maxB, candidates.length)} premiers sur ${candidates.length} candidats) :`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  - ${c.name}${c.fallback ? " [repli]" : ""} (tiers ${c.tiers.join("/")})`);
    console.log(`    ${c.url ? buildHotelUrl(c.url, { checkin, checkout }) : "(pas d'URL : recherche par nom)"}`);
  }

  // plan d'extension théorique : tout manque (aucun relevé encore fait)
  const gaps = { chambresManquantes: Object.fromEntries(["J", "W", "Y"].map((t) => [t, needs.parTier[t]?.chambres ?? 0])) };
  const surveyed = new Set(candidates.slice(0, maxB).map((c) => c.id));
  const theorique = planExtension({
    gaps, inventories: [], candidates, surveyedKeys: surveyed, probedKeys: new Set(),
    policy, station, wave: 1, sessionsUsed: 0, costUsd: 0,
  });
  console.log(`\nPlan d'extension théorique (vague 1, si tout manquait après l'étage B) :`);
  console.log(`  bornes : ${theorique.limits.sessions_max} sessions · ${theorique.limits.max_waves} vagues · ${theorique.limits.cost_max} $ · sonde d'abord : ${policy.extension.probe_same_hotel_first ? "oui (H-3)" : "non"}`);
  if (theorique.stop) console.log(`  → ${theorique.reason}`);
  else console.log(`  → sondes : ${theorique.probes.length} (aucun relevé encore fait) · relevés supplémentaires : ${theorique.surveys.map((s) => s.name).join(", ") || "aucun"}`);
  console.log("\nDry-run : aucun agent, aucun réseau, aucune écriture.");
  process.exit(0);
}

/* ---------------------------------------------------------------- offline */

const offline = opt("offline", null);
if (offline) {
  const file = path.resolve(offline);
  if (!fs.existsSync(file)) throw new Error(`Fixtures introuvables : ${file}`);
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(records)) throw new Error(`${offline} : un tableau de relevés est attendu`);

  const emit = mkEmitter({ run_id: null }, (ev) => {
    if (["phase", "warning", "inventory_status", "extension", "done"].includes(ev.type)) {
      const d = ev.data;
      if (ev.type === "phase") console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.wave ? ` vague ${d.wave}` : ""}`);
      else if (ev.type === "warning") console.log(`[warn ] ${d.message}`);
      else if (ev.type === "inventory_status") console.log(`[inv  ] ${d.station} : ${d.hotels_count} hôtel(s), périmé ${d.stale ? "oui" : "non"}, utilisé ${d.used ? "oui" : "non"}`);
      else if (ev.type === "extension") console.log(`[ext  ] vague ${d.wave} : ${d.reason} — sondes ${d.planned.probes}, relevés ${d.planned.surveys} (sessions ${d.limits.sessions_used}/${d.limits.sessions_max})`);
      else if (ev.type === "done") console.log(`[done ] OK ${d.ok} · escalade ${d.escalade} · sessions ${d.sessions_used ?? 0} · coût ${d.cost_usd ?? 0} $`);
    }
  });

  const result = await runPipeline({
    policy, station, scenario, avion, rows, ingestion,
    emit, collect: fixturesCollect(records),
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const w = (name, content) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, content, "utf8");
    console.log(`écrit ${path.relative(ROOT, p)}`);
  };
  w(`plan-${result.runId}.csv`, result.outputs.planCsv);
  w(`rapport-${result.runId}.md`, result.outputs.rapportMd);
  w(`messages-${result.runId}.csv`, result.outputs.messagesCsv);
  w(`rooming-${result.runId}.csv`, result.outputs.roomingCsv);
  w(`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n");
  w(`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n");

  console.log(`\nRejeu hors ligne terminé : ${result.alloc.summary.ok} dossiers logés, ${result.alloc.summary.escalade} en escalade — coût agents : 0 € (aucune session).`);
  process.exit(0);
}

/* ------------------------------------- modes payants (derrière DEMO_ALLOW_PAID) */
/* Probes phase 5 (CDC §12.1) : chaque probe archive un fichier out/*-{runId}.json
 * VALIDÉ contre son schéma, imprime le flux pensées/captures et un bilan mesuré
 * (durée, steps, coût, files/429) pour ETAT.md et CDC §13. */

if (PAID_FLAGS.some((f) => flag(f))) {
  const { createClient, apiOrigin, readApiKey, discoverySchema, releveSchema, probeSchema } = await import("../lib/hai.mjs");

  /* --probe-inventaire : Étage 0 limité, délégué à l'outil dédié (même code que la fiche) */
  if (flag("probe-inventaire")) {
    const args = [
      path.join(ROOT, "hai-admin-mcp", "tools", "inventaire.mjs"),
      "--station", station.code, "--refresh", "--max", opt("max", "10"),
      "--nights", String(scenario.nights),
      ...(opt("checkin", null) ? ["--checkin", opt("checkin", null)] : []),
    ];
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }

  const runId = newRunId();
  const groupId = `${station.code.toLowerCase()}-v2-${checkin}-${runId}`;
  const t0 = Date.now();
  const captures = []; // {hotel_key, seq, source, imageType, mediaType} — téléchargées en fin de probe
  const metricsByKey = new Map(); // hotel_key → dernier {steps, cost_usd, tokens}
  let queue429 = 0;

  const emit = mkEmitter({ run_id: runId }, (ev) => {
    const d = ev.data;
    const key = ev.hotel_key ?? "?";
    switch (ev.type) {
      case "phase":
        console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.done ? ` — terminé (${d.count} candidats)` : ""}`);
        break;
      case "agent_status":
        if (d.status) console.log(`[agent] ${key} : ${d.status}${d.live_view_url ? ` — vue live : ${d.live_view_url}` : ""}`);
        else if (d.live_view_url) console.log(`[agent] ${key} — vue live : ${d.live_view_url}`);
        break;
      case "agent_thought":
        console.log(`[pensée] ${key} : ${d.text}`);
        break;
      case "screenshot": {
        const seq = captures.filter((c) => c.hotel_key === key).length;
        captures.push({ hotel_key: key, seq, source: d.source, imageType: d.imageType ?? null, mediaType: d.mediaType ?? "image/png" });
        console.log(`[capture] ${key} #${seq} (${d.imageType ?? "url"})`);
        break;
      }
      case "candidate":
        console.log(`[cand ] ${d.name} (${d.stars ?? "?"}★, ${d.review_score ?? "?"}/10, à partir de ${d.price_from_per_night ?? "?"} EUR)`);
        break;
      case "metrics":
        if (ev.hotel_key) metricsByKey.set(key, d);
        break;
      case "probe":
        console.log(`[sonde] ${d.hotel} : ${d.status}${d.result ? ` — max sélectionnable ${d.result.rooms_available_max}, plafonné ${d.result.cap_reached}` : ""}`);
        break;
      case "warning":
        console.log(`[warn ] ${d.message}`);
        if (/429|rate.?limit|file d'attente|queue/i.test(d.message)) queue429 += 1;
        break;
      case "error":
        console.log(`[erreur] ${d.message}`);
        break;
      default:
        break;
    }
  });

  /** Bilan mesuré du probe (ETAT.md / CDC §13). */
  function bilan(label) {
    const duration_s = Math.round((Date.now() - t0) / 1000);
    let cost_usd = 0, steps = 0, tokens = 0;
    for (const m of metricsByKey.values()) {
      cost_usd += m.cost_usd ?? 0;
      steps += m.steps ?? 0;
      tokens += m.tokens ?? 0;
    }
    cost_usd = Math.round(cost_usd * 10000) / 10000;
    console.log(`\n${label} — durée ${duration_s} s · ${metricsByKey.size} session(s) · ${steps} steps · ${cost_usd} $ · files/429 : ${queue429}`);
    return { duration_s, sessions: metricsByKey.size, steps, tokens, cost_usd, queue_or_429: queue429 };
  }

  /** Télécharge les captures relevées (bearer vers l'origine API H uniquement, INV-4). */
  async function saveCaptures(dir) {
    if (!captures.length) return 0;
    fs.mkdirSync(dir, { recursive: true });
    const origin = new URL(apiOrigin()).origin;
    let saved = 0;
    for (const c of captures) {
      try {
        const src = String(c.source ?? "");
        let buf = null;
        let ext = String(c.mediaType ?? "").includes("jpeg") ? ".jpg" : ".png";
        if (c.imageType === "base64" && !src.startsWith("data:")) {
          buf = Buffer.from(src, "base64");
        } else if (src.startsWith("data:")) {
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
          if (!m) continue;
          buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
        } else if (/^https:\/\//.test(src)) {
          const r = await fetch(src, new URL(src).origin === origin ? { headers: { Authorization: `Bearer ${readApiKey()}` } } : undefined);
          if (!r.ok) continue;
          buf = Buffer.from(await r.arrayBuffer());
          if ((r.headers.get("content-type") ?? "").includes("jpeg")) ext = ".jpg";
        } else {
          continue;
        }
        fs.writeFileSync(path.join(dir, `${c.hotel_key.replace(/[^a-z0-9_-]/gi, "_")}-${String(c.seq).padStart(2, "0")}${ext}`), buf);
        saved += 1;
      } catch {
        /* capture manquée : sans gravité, le flux a déjà été journalisé */
      }
    }
    if (saved) console.log(`captures enregistrées : ${saved} → ${path.relative(ROOT, dir)}/`);
    return saved;
  }

  const writeOut = (name, obj) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
    console.log(`écrit ${path.relative(ROOT, p)}`);
  };

  /* ---------------------------------------------------------- --probe-discovery */
  if (flag("probe-discovery")) {
    console.log(`Probe découverte — ${station.code}, séjour ${checkin} → ${checkout}, runId ${runId} (~0,21 $ attendu)`);
    const client = createClient();
    const disc = await runDiscovery({ client, policy, station, checkin, checkout, groupId, emit });
    const mesures = bilan("Découverte");
    const v = disc.flat ? discoverySchema.safeParse(disc.flat) : { success: false, error: { issues: [{ path: [], message: "réponse absente" }] } };
    if (!v.success) console.log(`⚠ réponse plate NON conforme au discoverySchema : ${v.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ")}`);
    writeOut(`candidats-${runId}.json`, {
      runId, kind: "probe-discovery", station: station.code, checkin, checkout, groupId,
      sessionId: disc.sessionId, status: disc.status, outcome: disc.outcome,
      currency: disc.currency, notes: disc.notes, schema_valid: v.success,
      answer: disc.flat, candidates: disc.candidates, mesures,
    });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    console.log(`\n${disc.candidates.length} candidat(s), devise ${disc.currency}, schéma ${v.success ? "valide" : "NON valide"}.`);
    process.exit(disc.candidates.length && v.success ? 0 : 1);
  }

  /* ------------------------------------------------------------- --probe-releve n */
  if (flag("probe-releve")) {
    const n = Number(opt("probe-releve", "1"));
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      console.error(`--probe-releve attend un entier de 1 à 5 (reçu : ${opt("probe-releve", "1")})`);
      process.exit(1);
    }
    const inv = loadInventaire(station.code);
    const dossiers = buildDossiers(rows, policy);
    const needs = computeNeeds(dossiers);
    const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier }).filter((c) => c.url); // navigation directe
    const selection = candidates.slice(0, n).map((c) => ({ candidate: c, tiers: c.tiers }));
    if (!selection.length) {
      console.error("aucun candidat avec URL dans l'inventaire — lancer d'abord la découverte ou l'inventaire Étage 0");
      process.exit(1);
    }
    console.log(`Probe relevés — ${selection.length} session(s) sur : ${selection.map((s) => s.candidate.name).join(", ")} (~0,30 $/session attendu)`);
    const client = createClient();
    const records = await runReleves({ client, policy, station, selection, substitutes: {}, checkin, checkout, groupId, emit });
    const mesures = bilan("Relevés");
    let allValid = records.length > 0;
    for (const r of records) {
      const v = r.flat ? releveSchema.safeParse(r.flat) : { success: false };
      if (!v.success) {
        allValid = false;
        console.log(`⚠ ${r.name} : réponse absente ou non conforme au releveSchema`);
      }
      console.log(
        `- ${r.name} : ${r.status}` +
          (r.answer?.found
            ? ` — ${r.answer.rooms.length} type(s) de chambre, prépaiement ${r.answer.payment?.prepayment_online ?? "?"}`
            : " — found=false") +
          ` (${r.steps ?? 0} steps, ${r.costUsd ?? 0} $)`,
      );
    }
    writeOut(`releves-${runId}.json`, records); // format fixtures : rejouable par --offline
    writeOut(`releves-${runId}.mesures.json`, { runId, kind: "probe-releve", n: records.length, groupId, mesures });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    process.exit(allValid ? 0 : 1);
  }

  /* -------------------------------------------- --probe-capacity <url> --rooms n */
  if (flag("probe-capacity")) {
    const capUrl = opt("probe-capacity", null);
    const roomsN = Number(opt("rooms", "12"));
    if (!capUrl || !/^https:\/\/www\.booking\.com\/hotel\//.test(capUrl)) {
      console.error("--probe-capacity attend une URL de fiche Booking (https://www.booking.com/hotel/...)");
      process.exit(1);
    }
    if (!Number.isInteger(roomsN) || roomsN < 2 || roomsN > 50) {
      console.error(`--rooms attend un entier de 2 à 50 (reçu : ${opt("rooms", "12")})`);
      process.exit(1);
    }
    const hotelKey = slugify(new URL(capUrl).pathname.split("/").pop().replace(/\.[a-z.]+$/i, "")) || "sonde";
    const probe = { hotelKey, name: hotelKey, url: capUrl, requested_rooms: roomsN };
    console.log(`Sonde de capacité (H-3) — ${roomsN} chambres (${2 * roomsN} adultes), runId ${runId} (~0,15 $ attendu)`);
    console.log(`URL sonde : ${buildProbeUrl(capUrl, { checkin, checkout, noRooms: roomsN })}`);
    const client = createClient();
    const answer = await runProbe({ client, policy, station, probe, checkin, checkout, groupId, emit });
    const mesures = bilan("Sonde");
    const v = answer ? probeSchema.safeParse(answer) : { success: false };
    // H-3 : concluante si la page a affiché une disponibilité LISIBLE pour ce volume
    const conclusive = Boolean(answer?.found && answer.rooms_selectable_max >= 0);
    const h3 = {
      conclusive,
      verdict: !conclusive
        ? "non concluant : disponibilité illisible à ce volume → probe_same_hotel_first = false (extension par candidats suivants seulement)"
        : answer.rooms_selectable_max > 9
          ? `concluant : ${answer.rooms_selectable_max} chambres lisibles au-delà du plafond d'affichage (9) → sonde conservée`
          : `lisible mais borné à ${answer.rooms_selectable_max} (≤ 9) : la sonde n'apporte rien au-delà du relevé → à trancher avec notes`,
    };
    writeOut(`probe-${runId}.json`, {
      runId, kind: "probe-capacity", station: station.code, checkin, checkout, groupId,
      url: capUrl, probe_url: buildProbeUrl(capUrl, { checkin, checkout, noRooms: roomsN }),
      requested_rooms: roomsN, schema_valid: v.success, answer, h3, mesures,
    });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    console.log(`\nH-3 : ${h3.verdict}`);
    process.exit(answer && v.success ? 0 : 1);
  }
}

// Run complet PAYANT (phases 5-6) : sessions réelles via realCollect.
const { createClient } = await import("../lib/hai.mjs");
const { realCollect } = await import("../lib/pipeline.mjs");
const emit = mkEmitter({ run_id: null }, (ev) => {
  const d = ev.data;
  if (ev.type === "phase") console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.wave ? ` vague ${d.wave}` : ""}`);
  else if (ev.type === "warning") console.log(`[warn ] ${d.message}`);
  else if (ev.type === "extension") console.log(`[ext  ] vague ${d.wave} : sondes ${d.planned.probes}, relevés ${d.planned.surveys} (sessions ${d.limits.sessions_used}/${d.limits.sessions_max}, coût ${d.limits.cost_usd}/${d.limits.cost_max} $)`);
  else if (ev.type === "agent_status" && d.status) console.log(`[agent] ${ev.hotel_key ?? "?"} : ${d.status}`);
  else if (ev.type === "done") console.log(`[done ] OK ${d.ok} · escalade ${d.escalade} · sessions ${d.sessions_used ?? 0} · coût ${d.cost_usd ?? 0} $`);
});
const client = createClient();
const result = await runPipeline({ client, policy, station, scenario, avion, rows, ingestion, emit });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of [
  [`plan-${result.runId}.csv`, result.outputs.planCsv],
  [`rapport-${result.runId}.md`, result.outputs.rapportMd],
  [`messages-${result.runId}.csv`, result.outputs.messagesCsv],
  [`rooming-${result.runId}.csv`, result.outputs.roomingCsv],
  [`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n"],
  [`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n"],
]) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, "utf8");
  console.log(`écrit out/${name}`);
}
