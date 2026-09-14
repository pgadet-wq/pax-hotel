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
 *   --probe-discovery · --probe-releve <n> · --probe-capacity <url> --rooms <n>
 *   --probe-inventaire --max <n> · (sans option) run complet
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStation } from "../lib/stations.mjs";
import { loadInventaire, isStale, candidatesFrom } from "../lib/inventaire.mjs";
import { DEFAULT_POLICY, effectiveCaps } from "../lib/policy.mjs";
import { mergeConfig, resolveDates, DEFAULT_AVION } from "../lib/scenario.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { parsePassagersCsv } from "../lib/csv.mjs";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { discoveryNeeded } from "../lib/discovery.mjs";
import { planExtension } from "../lib/capacite.mjs";
import { buildHotelUrl } from "../lib/hai-urls.mjs";
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
const { checkin, checkout } = resolveDates(scenario);

const rows = opt("in", null)
  ? parsePassagersCsv(fs.readFileSync(path.resolve(opt("in", null)), "utf8"))
  : generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;

/* ---------------------------------------------------------------- dry-run */

if (flag("dry-run")) {
  const dossiers = buildDossiers(rows, policy);
  const needs = computeNeeds(dossiers);
  const caps = effectiveCaps(policy, station);
  console.log(`Escale ${station.code} — ${station.name} · séjour du ${checkin} au ${checkout} (${scenario.nights} nuit${scenario.nights > 1 ? "s" : ""})`);
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
    policy, station, scenario, avion, rows,
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
  w(`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n");
  w(`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n");

  console.log(`\nRejeu hors ligne terminé : ${result.alloc.summary.ok} dossiers logés, ${result.alloc.summary.escalade} en escalade — coût agents : 0 € (aucune session).`);
  process.exit(0);
}

/* ------------------------------------- modes payants (derrière DEMO_ALLOW_PAID) */

if (PAID_FLAGS.some((f) => flag(f))) {
  // Les probes fins sont exercés et mesurés en phase 5 (H-3, H-9).
  console.error("probes payants : câblés en phase 5 (mesures H-3/H-9). Le run complet (sans option) est disponible.");
  process.exit(1);
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
const result = await runPipeline({ client, policy, station, scenario, avion, rows, emit });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of [
  [`plan-${result.runId}.csv`, result.outputs.planCsv],
  [`rapport-${result.runId}.md`, result.outputs.rapportMd],
  [`messages-${result.runId}.csv`, result.outputs.messagesCsv],
  [`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n"],
  [`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n"],
]) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, "utf8");
  console.log(`écrit out/${name}`);
}
