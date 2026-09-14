#!/usr/bin/env node
/**
 * Récupère les réponses des sessions d'un groupe et reconstruit le fichier de
 * relevés au format attendu par `rebooking.mjs --offline`.
 *
 *   node hai-admin-mcp/tools/collect-sessions.mjs --group poc-bkk-2026-09-01 [--wait]
 *
 * Filet de sécurité : si le process d'orchestration meurt (timeout client),
 * les sessions continuent côté H — ce script les rattrape. --wait sonde
 * jusqu'à ce que toutes les sessions du groupe soient terminées.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HaiAgentsClient, HaiAgentsEnvironment, isSettledSessionStatus } from "hai-agents";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const GROUP = opt("group", null);
const WAIT = argv.includes("--wait");
if (!GROUP) {
  console.error("usage: node collect-sessions.mjs --group <groupId> [--wait]");
  process.exit(2);
}

const key = /HAI_API_KEY=(\S+)/.exec(
  fs.readFileSync(path.join(os.homedir(), ".config", "hai", ".env"), "utf8"),
)[1];
const client = new HaiAgentsClient({ apiKey: key, environment: HaiAgentsEnvironment.Eu });

/** L'hôtel ciblé est déduit du message initial de la session. */
const HOTEL_KEYS = [
  ["novotel", ["novotel", "hyatt regency", "courtyard"]],
  ["meridien", ["méridien", "meridien", "eastin"]],
  ["amaranth", ["amaranth"]],
  ["divalux", ["divalux"]],
];
function keyFor(message) {
  // seule la partie avant la consigne de substitution identifie l'hôtel principal :
  // les alternates cités ensuite (« relève À LA PLACE… ») ne doivent pas matcher
  const m = (message ?? "").toLowerCase().split("à la place")[0];
  for (const [key2, needles] of HOTEL_KEYS) if (m.includes(`« ${needles[0]}`)) return key2;
  for (const [key2, needles] of HOTEL_KEYS) if (needles.some((n) => m.includes(n))) return key2;
  return "inconnu";
}

async function listGroup() {
  const page = await client.sessions.listSessions({ groupId: GROUP, size: 50 });
  return page.items ?? [];
}

let sessions = await listGroup();
if (!sessions.length) {
  console.error(`Aucune session dans le groupe ${GROUP}.`);
  process.exit(1);
}

if (WAIT) {
  let lastPending = -1;
  for (;;) {
    sessions = await listGroup();
    const pending = sessions.filter((s) => !isSettledSessionStatus(s.status) && s.status !== "idle");
    if (pending.length !== lastPending) {
      // n'imprimer que les changements d'état, pas chaque poll
      console.log(`${new Date().toISOString().slice(11, 19)} — ${pending.length} session(s) encore en cours`);
      lastPending = pending.length;
    }
    if (!pending.length) break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const collected = [];
for (const s of sessions) {
  const changes = await client.sessions.getSessionChanges({ id: s.id });
  let answer = changes.answer ?? null;
  if (typeof answer === "string") {
    try {
      answer = JSON.parse(answer);
    } catch {
      /* réponse libre : conservée telle quelle dans notes */
      answer = { hotel: "", found: false, checkin: "", checkout: "", currency: "", rooms: [], notes: answer };
    }
  }
  collected.push({
    hotel: keyFor(s.firstMessage?.message),
    sessionId: s.id,
    createdAt: s.createdAt,
    status: changes.status ?? s.status,
    outcome: changes.outcome ?? null,
    error: changes.error ?? null,
    answer,
  });
}

// Un groupe peut contenir plusieurs sessions pour le même hôtel (probes, relances) :
// garder la meilleure — réponse exploitable d'abord, puis la plus récente.
const score = (e) => (e.answer?.found ? 2 : e.answer ? 1 : 0);
const byHotel = new Map();
for (const e of collected) {
  const prev = byHotel.get(e.hotel);
  if (!prev || score(e) > score(prev) || (score(e) === score(prev) && e.createdAt > prev.createdAt)) byHotel.set(e.hotel, e);
}
const out = [...byHotel.values()];

fs.mkdirSync("out", { recursive: true });
const file = path.join("out", `releves-${GROUP}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
console.log(`Écrit ${file} — ${out.length} sessions :`);
for (const o of out) console.log(`  [${o.hotel}] ${o.status} found=${o.answer?.found ?? "-"} rooms=${o.answer?.rooms?.length ?? 0}`);
