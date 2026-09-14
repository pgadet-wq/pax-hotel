#!/usr/bin/env node
/**
 * POC « vol bloqué à BKK » — proposition d'affectation passagers → hôtels.
 *
 *   node hai-admin-mcp/tools/rebooking.mjs [options]
 *
 *   --in <csv>        liste passagers (défaut data/passagers-test.csv)
 *   --checkin <date>  YYYY-MM-DD (défaut : demain)
 *   --nights <n>      nombre de nuits (défaut 1)
 *   --dry-run         calcule les besoins en chambres et s'arrête (aucun appel H)
 *   --probe           ne lance qu'une session (Novotel) pour valider la chaîne
 *   --offline <json>  réutilise un relevé out/releves-*.json au lieu de lancer des sessions
 *
 * Chaîne : CSV → besoins par dossier (PNR) → une session Holo par hôtel cible
 * (relevé Booking.com, lecture seule, answerSchema) → allocation selon la matrice
 * (docs/matrice-affectation.md) → out/plan-hebergement.csv + out/rapport.md.
 *
 * Aucune réservation : les agents s'arrêtent à la page de sélection des chambres.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { HaiAgentsClient, HaiAgentsEnvironment } from "hai-agents";

/* ------------------------------------------------------------------ config */

const CONFIG = {
  agentName: "hotel-scout-bkk",
  model: undefined, // défaut plateforme (holo3-122b-a10b)
  maxSteps: 70,
  maxTimeS: 1000,
  sessionTimeoutMs: 45 * 60 * 1000, // absorbe la mise en file (3 sessions concurrentes)
  hotels: [
    {
      key: "novotel",
      name: "Novotel Bangkok Suvarnabhumi Airport",
      zone: "connecté au terminal BKK",
      // le probe du 31/08 a montré le Novotel délisté de Booking à ces dates
      alternates: ["Hyatt Regency Bangkok Suvarnabhumi Airport", "Courtyard by Marriott Bangkok Suvarnabhumi Airport"],
    },
    {
      key: "meridien",
      name: "Le Méridien Suvarnabhumi Golf Resort & Spa",
      zone: "Bang Phli, 15-20 min de BKK",
      alternates: ["Eastin Thana City Golf Resort Bangkok"],
    },
    {
      key: "amaranth",
      name: "Amaranth Suvarnabhumi Hotel",
      zone: "Lat Krabang, navette BKK",
      alternates: ["Canalis Suvarnabhumi Airport Hotel"],
    },
    {
      key: "divalux",
      name: "Divalux Resort & Spa Bangkok",
      zone: "Lat Krabang, navette BKK",
      alternates: ["Amaranth Suvarnabhumi Hotel", "Canalis Suvarnabhumi Airport Hotel"],
    },
  ],
  // priorité d'hôtels par catégorie de dossier ; "asc" = moins cher d'abord
  allocation: {
    pmr: { hotels: ["novotel"], sort: "asc", note: "chambre accessible + transfert sans voirie" },
    famille: { hotels: ["novotel", "meridien"], sort: "asc", note: "enfants — hôtel connecté ou navette directe" },
    premium: { hotels: ["novotel", "meridien"], sort: "desc", note: "J / Flying Blue Gold+" },
    confort: { hotels: ["meridien", "novotel"], sort: "asc", note: "W / Flying Blue Silver" },
    standard: { hotels: ["amaranth", "divalux", "meridien"], sort: "asc", note: "Y" },
  },
};

/* -------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const IN = opt("in", path.join("data", "passagers-test.csv"));
const NIGHTS = Number(opt("nights", "1"));
const CHECKIN =
  opt("checkin", null) ??
  (() => {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  })();
const CHECKOUT = (() => {
  const d = new Date(`${CHECKIN}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + NIGHTS);
  return d.toISOString().slice(0, 10);
})();

/* ------------------------------------------- phase 1 : besoins en chambres */

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(";");
  return lines.map((l) => Object.fromEntries(l.split(";").map((v, i) => [cols[i], v])));
}

const FB_RANK = { PLATINUM: 3, GOLD: 2, SILVER: 1, NONE: 0 };
const CABIN_RANK = { J: 2, W: 1, Y: 0 };

/** Regroupe par PNR et dérive catégorie + chambres nécessaires. */
function buildDossiers(rows) {
  const byPnr = new Map();
  for (const r of rows) {
    if (!byPnr.has(r.pnr)) byPnr.set(r.pnr, []);
    byPnr.get(r.pnr).push(r);
  }
  const dossiers = [];
  for (const [pnr, pax] of byPnr) {
    const adults = pax.filter((p) => p.type_pax === "ADT").length;
    const children = pax.filter((p) => p.type_pax === "CHD").length;
    const infants = pax.filter((p) => p.type_pax === "INF").length;
    const pmr = pax.some((p) => p.assistance === "WCHR");
    const cabin = pax.reduce((m, p) => (CABIN_RANK[p.cabine] > CABIN_RANK[m] ? p.cabine : m), "Y");
    const fb = pax.reduce((m, p) => (FB_RANK[p.flying_blue] > FB_RANK[m] ? p.flying_blue : m), "NONE");

    let category;
    if (pmr) category = "pmr";
    else if (children + infants > 0) category = "famille";
    else if (cabin === "J" || FB_RANK[fb] >= 2) category = "premium";
    else if (cabin === "W" || fb === "SILVER") category = "confort";
    else category = "standard";

    // chambrage (matrice) : familiale jusqu'à 2A+2C, communicantes (2 ch.) au-delà
    let rooms;
    let familyUnit = false;
    if (children > 0) {
      if (adults <= 2 && children <= 2) {
        rooms = 1;
        familyUnit = true;
      } else rooms = 2;
    } else rooms = Math.max(1, Math.ceil(adults / 2));

    dossiers.push({
      pnr,
      occupants: pax.map((p) => `${p.prenom} ${p.nom}${p.type_pax !== "ADT" ? ` (${p.type_pax})` : ""}`).join(", "),
      adults,
      children,
      infants,
      pmr,
      cabin,
      fb,
      category,
      rooms,
      familyUnit,
    });
  }
  const order = ["pmr", "famille", "premium", "confort", "standard"];
  dossiers.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.adults - a.adults);
  return dossiers;
}

/* --------------------------------------------- phase 2 : relevés par agent */

const answerSchema = z.object({
  hotel: z.string(),
  found: z.boolean().describe("false si hôtel introuvable ou complet"),
  checkin: z.string(),
  checkout: z.string(),
  currency: z.string().describe("devise des prix affichés, ex THB"),
  rooms: z
    .array(
      z.object({
        room_type: z.string(),
        occupancy_adults: z.number().int(),
        occupancy_children: z.number().int().describe("0 si non précisé"),
        quantity_available: z.number().int().describe("nombre max de chambres sélectionnables affiché"),
        price_per_night: z.number().describe("prix par nuit toutes taxes comprises"),
        free_cancellation: z.boolean(),
        breakfast_included: z.boolean(),
      }),
    )
    .describe("tous les types de chambres visibles"),
  notes: z.string().describe("blocages, CAPTCHA, particularités ; vide sinon"),
});

function readApiKey() {
  if (process.env.HAI_API_KEY) return process.env.HAI_API_KEY;
  const file = path.join(os.homedir(), ".config", "hai", ".env");
  const m = /HAI_API_KEY\s*=\s*(\S+)/.exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`HAI_API_KEY introuvable dans ${file}`);
  return m[1];
}

async function ensureAgent(client) {
  try {
    await client.agents.getAgent({ agentName: CONFIG.agentName });
    return;
  } catch {
    /* absent : on le crée */
  }
  await client.agents.createAgent({
    name: CONFIG.agentName,
    description:
      "Relevé d'inventaire hôtelier en lecture seule sur les sites de réservation, pour la prise en charge " +
      "de passagers en aléa d'exploitation près de l'aéroport de Bangkok. Ne réserve jamais.",
    model: CONFIG.model,
    environments: [
      {
        id: "booking-visual",
        kind: "web",
        startUrl: "https://www.booking.com",
        mode: { type: "visual", width: 1280, height: 900, markdown: true },
      },
    ],
    skills: ["h/answering", "h/planning"],
    instructions:
      "Tu relèves des inventaires hôteliers : types de chambres, capacités, quantités disponibles affichées, " +
      "prix par nuit toutes taxes comprises, conditions d'annulation et petit-déjeuner. " +
      "Tu ne réserves JAMAIS : aucun clic sur un bouton de réservation finale, aucune création de compte, " +
      "aucune saisie de données personnelles ou de paiement. Tu t'arrêtes à la page de sélection des chambres. " +
      "Tu n'inventes aucun chiffre : chaque valeur vient de l'écran. Si une information est absente, mets 0 ou " +
      "false et signale-le dans notes. Face à un CAPTCHA ou un blocage anti-robot, tu ne tentes pas de le " +
      "contourner : tu le décris dans notes et tu conclus avec outcome blocked.",
  });
  console.log(`Agent ${CONFIG.agentName} créé.`);
}

const taskFor = (hotel) =>
  `Sur Booking.com, relève l'inventaire visible de l'hôtel « ${hotel.name} » (${hotel.zone}) pour un séjour du ` +
  `${CHECKIN} au ${CHECKOUT}, base 2 adultes par chambre. Cherche l'hôtel par son nom exact, ouvre sa fiche, ` +
  `règle les dates, puis liste TOUS les types de chambres proposés avec leur capacité, le nombre maximal de ` +
  `chambres sélectionnables affiché, le prix par nuit toutes taxes comprises, l'annulation gratuite et le ` +
  `petit-déjeuner. Si cet hôtel est introuvable ou complet à ces dates, relève À LA PLACE le premier disponible ` +
  `parmi : ${(hotel.alternates ?? []).map((a) => `« ${a} »`).join(", ")} — et mets dans le champ hotel le nom de ` +
  `l'établissement réellement relevé. Si aucun n'est disponible, réponds found=false en l'expliquant dans notes.`;

async function collectInventories(client, hotels, groupId) {
  await ensureAgent(client);
  console.log(`Lancement de ${hotels.length} session(s) — groupe ${groupId} (concurrence plateforme : 3, file au-delà)…`);
  const results = await Promise.all(
    hotels.map(async (hotel) => {
      const started = Date.now();
      try {
        const r = await client.runSession({
          agent: CONFIG.agentName,
          messages: taskFor(hotel),
          maxSteps: CONFIG.maxSteps,
          maxTimeS: CONFIG.maxTimeS,
          idleTimeoutS: null, // la session se ferme dès la réponse (sinon elle reste idle et occupe un slot)
          groupId,
          answerSchema,
          timeoutMs: CONFIG.sessionTimeoutMs,
          waitForSeconds: 25, // plafond imposé par l'API

        });
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        console.log(`  [${hotel.key}] ${r.status} outcome=${r.outcome ?? "-"} en ${mins} min (session ${r.id})`);
        return { hotel: hotel.key, sessionId: r.id, status: r.status, outcome: r.outcome, error: r.error, answer: r.answer };
      } catch (err) {
        // Attention : un échec ici peut être un échec de SUIVI alors que la session a bien
        // été créée côté H (elle continue de tourner). Vérifier avec hai_list_sessions
        // avant de relancer, sous peine de doublon.
        console.log(`  [${hotel.key}] ÉCHEC : ${err?.message ?? err}`);
        return { hotel: hotel.key, sessionId: null, status: "error", outcome: null, error: String(err?.message ?? err), answer: null };
      }
    }),
  );
  return results;
}

/* ------------------------------------------------- phase 3 : allocation */

function allocate(dossiers, inventories) {
  // stock mutable : par hôtel, offres triées, quantités décrémentées
  const stock = new Map();
  const realNames = new Map();
  for (const inv of inventories) {
    const rooms = inv.answer?.found ? (inv.answer.rooms ?? []) : [];
    if (inv.answer?.found && inv.answer.hotel) realNames.set(inv.hotel, inv.answer.hotel);
    // Les variantes tarifaires d'un même type (non-remboursable / annulable / avec pdj)
    // partagent le même stock physique : garder une ligne par type — annulation
    // gratuite prioritaire (contexte disruption), la moins chère à conditions égales.
    const byType = new Map();
    for (const r of rooms) {
      const prev = byType.get(r.room_type);
      const better =
        !prev ||
        (r.free_cancellation && !prev.free_cancellation) ||
        (r.free_cancellation === prev.free_cancellation && r.price_per_night < prev.price_per_night);
      if (better) byType.set(r.room_type, r);
    }
    stock.set(
      inv.hotel,
      [...byType.values()].map((r) => ({ ...r, left: Math.max(0, r.quantity_available), currency: inv.answer?.currency || "?" })),
    );
  }
  const takeRooms = (hotelKey, dossier, sort) => {
    const offers = stock.get(hotelKey) ?? [];
    const sorted = [...offers].sort((a, b) =>
      sort === "desc" ? b.price_per_night - a.price_per_night : a.price_per_night - b.price_per_night,
    );
    // 1 unité familiale : une chambre dont la capacité couvre tout le monde
    if (dossier.familyUnit) {
      const fit = sorted.find(
        (o) => o.left >= 1 && o.occupancy_adults + (o.occupancy_children ?? 0) >= dossier.adults + dossier.children,
      );
      if (fit) {
        fit.left -= 1;
        return [{ room_type: fit.room_type, count: 1, price: fit.price_per_night, currency: fit.currency }];
      }
      // repli : 2 chambres standard (communicantes non garanties — signalé en note)
    }
    const needed = dossier.familyUnit ? 2 : dossier.rooms;
    const fit = sorted.find((o) => o.left >= needed && o.occupancy_adults >= Math.min(2, dossier.adults));
    if (fit) {
      fit.left -= needed;
      return [{ room_type: fit.room_type, count: needed, price: fit.price_per_night, currency: fit.currency }];
    }
    return null;
  };

  const plan = [];
  for (const d of dossiers) {
    const rule = CONFIG.allocation[d.category];
    let placed = null;
    let hotelKey = null;
    for (const key of rule.hotels) {
      placed = takeRooms(key, d, rule.sort);
      if (placed) {
        hotelKey = key;
        break;
      }
    }
    // nom de l'établissement réellement relevé (substitution possible), pas celui de la config
    const hotelName = realNames.get(hotelKey) ?? CONFIG.hotels.find((h) => h.key === hotelKey)?.name ?? "";
    const roomsCount = placed ? placed.reduce((s, p) => s + p.count, 0) : d.familyUnit ? 1 : d.rooms;
    const price = placed ? placed.reduce((s, p) => s + p.count * p.price, 0) * NIGHTS : null;
    const notes = [];
    if (d.pmr) notes.push("PMR : chambre accessible + transfert adapté à confirmer par l'hôtel");
    if (d.familyUnit && placed && placed[0].count === 2) notes.push("communicantes à confirmer");
    if (d.infants) notes.push("berceau à demander");
    plan.push({
      pnr: d.pnr,
      occupants: d.occupants,
      categorie: d.category,
      hotel: placed ? hotelName : "",
      room_type: placed ? placed[0].room_type : "",
      chambres: roomsCount,
      prix_total: price ?? "",
      devise: placed ? placed[0].currency : "",
      statut: placed ? "OK" : "ESCALADE DESK",
      notes: notes.join(" ; "),
    });
  }
  return plan;
}

/* --------------------------------------------------------------- sorties */

function writeOutputs(plan, inventories, groupId) {
  fs.mkdirSync("out", { recursive: true });

  const cols = ["pnr", "occupants", "categorie", "hotel", "room_type", "chambres", "prix_total", "devise", "statut", "notes"];
  const csv = "﻿" + cols.join(";") + "\n" + plan.map((p) => cols.map((c) => p[c]).join(";")).join("\n") + "\n";
  fs.writeFileSync(path.join("out", "plan-hebergement.csv"), csv, "utf8");

  const ok = plan.filter((p) => p.statut === "OK");
  const ko = plan.filter((p) => p.statut !== "OK");
  const totals = {};
  for (const p of ok) totals[p.devise] = (totals[p.devise] ?? 0) + (Number(p.prix_total) || 0);
  const totalStr = Object.entries(totals)
    .map(([cur, v]) => `${v.toLocaleString("fr-FR")} ${cur}`)
    .join(" + ") || "0";
  const byCat = {};
  for (const p of plan) {
    byCat[p.categorie] ??= { ok: 0, ko: 0 };
    byCat[p.categorie][p.statut === "OK" ? "ok" : "ko"] += 1;
  }

  const lines = [];
  lines.push(`# Plan d'hébergement — vol bloqué à BKK`);
  lines.push("");
  lines.push(`Nuit(s) du ${CHECKIN} au ${CHECKOUT} · groupe de sessions \`${groupId}\``);
  lines.push("");
  lines.push(`## Synthèse`);
  lines.push("");
  lines.push(`- Dossiers hébergés en ligne : **${ok.length}** (${ok.reduce((s, p) => s + p.chambres, 0)} chambres)`);
  lines.push(`- Dossiers à escalader au desk : **${ko.length}** (${ko.reduce((s, p) => s + p.chambres, 0)} chambres)`);
  lines.push(`- Coût total relevé : **${totalStr}**`);
  lines.push("");
  lines.push(`| Catégorie | OK | Escalade |`);
  lines.push(`|---|---|---|`);
  for (const [cat, v] of Object.entries(byCat)) lines.push(`| ${cat} | ${v.ok} | ${v.ko} |`);
  lines.push("");
  lines.push(`## Relevés par hôtel`);
  lines.push("");
  for (const inv of inventories) {
    const name = CONFIG.hotels.find((h) => h.key === inv.hotel)?.name ?? inv.hotel;
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(`- session : \`${inv.sessionId ?? "-"}\` · statut ${inv.status} · outcome ${inv.outcome ?? "-"}`);
    if (inv.error) lines.push(`- erreur : ${inv.error}`);
    const a = inv.answer;
    if (a?.found) {
      lines.push(`- devise : ${a.currency}`);
      if (a.notes) lines.push(`- notes agent : ${a.notes}`);
      lines.push("");
      lines.push(`| Type de chambre | Capacité | Dispo affichée | Prix/nuit | Annul. gratuite | Petit-déj |`);
      lines.push(`|---|---|---|---|---|---|`);
      for (const r of a.rooms)
        lines.push(
          `| ${r.room_type} | ${r.occupancy_adults}A+${r.occupancy_children ?? 0}C | ${r.quantity_available} | ` +
            `${r.price_per_night.toLocaleString("fr-FR")} | ${r.free_cancellation ? "oui" : "non"} | ${r.breakfast_included ? "oui" : "non"} |`,
        );
    } else if (a) {
      lines.push(`- found=false : ${a.notes || "sans détail"}`);
    }
    lines.push("");
  }
  lines.push(`## Limites`);
  lines.push("");
  lines.push(
    `Les quantités sont celles **affichées en ligne** (borne basse de la capacité réelle). ` +
      `Les dossiers en escalade relèvent du desk groupe de l'hôtel — un volume de cette taille y serait de ` +
      `toute façon renvoyé par les plateformes. Aucune réservation n'a été effectuée.`,
  );
  fs.writeFileSync(path.join("out", "rapport.md"), lines.join("\n") + "\n", "utf8");

  console.log(`\nÉcrit : out/plan-hebergement.csv (${plan.length} dossiers) et out/rapport.md`);
  console.log(`  hébergés en ligne : ${ok.length} · escalade desk : ${ko.length} · total relevé : ${totalStr}`);
}

/* ------------------------------------------------------------------ main */

const rows = parseCsv(IN);
const dossiers = buildDossiers(rows);
const need = {};
for (const d of dossiers) {
  need[d.category] ??= { dossiers: 0, chambres: 0 };
  need[d.category].dossiers += 1;
  need[d.category].chambres += d.rooms;
}
console.log(`${rows.length} passagers, ${dossiers.length} dossiers — nuit(s) du ${CHECKIN} au ${CHECKOUT}`);
for (const [cat, v] of Object.entries(need)) console.log(`  ${cat.padEnd(9)} ${String(v.dossiers).padStart(3)} dossiers, ${String(v.chambres).padStart(3)} chambres`);

if (flag("dry-run")) process.exit(0);

const client = new HaiAgentsClient({ apiKey: readApiKey(), environment: HaiAgentsEnvironment.Eu });
const groupId = `poc-bkk-${CHECKIN}`;

let inventories;
const offline = opt("offline", null);
const relevePath = path.join("out", `releves-${groupId}.json`);
if (offline) {
  inventories = JSON.parse(fs.readFileSync(offline, "utf8"));
  console.log(`Relevés rechargés depuis ${offline} (aucune session lancée).`);
} else {
  // --hotels novotel,divalux : relance ciblée ; les relevés des autres hôtels sont conservés
  const only = opt("hotels", null);
  let targets = only ? CONFIG.hotels.filter((h) => only.split(",").includes(h.key)) : CONFIG.hotels;
  if (flag("probe")) targets = targets.slice(0, 1);
  if (!targets.length) throw new Error(`--hotels ne correspond à aucune clé (${CONFIG.hotels.map((h) => h.key).join(", ")})`);
  inventories = await collectInventories(client, targets, groupId);
  if (only && fs.existsSync(relevePath)) {
    const redone = new Set(inventories.map((i) => i.hotel));
    const kept = JSON.parse(fs.readFileSync(relevePath, "utf8")).filter((p) => !redone.has(p.hotel));
    inventories = [...kept, ...inventories];
    console.log(`Fusion avec les relevés conservés : ${kept.map((k) => k.hotel).join(", ") || "(aucun)"}`);
  }
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(relevePath, JSON.stringify(inventories, null, 2), "utf8");
  console.log(`Relevés bruts : ${relevePath}`);
}

if (flag("probe")) {
  console.log("\nMode probe : pas d'allocation. Relevé ci-dessus à inspecter.");
  process.exit(0);
}
writeOutputs(allocate(dossiers, inventories), inventories, groupId);
