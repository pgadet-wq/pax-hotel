#!/usr/bin/env node
/**
 * Génère le jeu de test passagers du POC « vol bloqué à BKK ».
 *
 *   node hai-admin-mcp/tools/generate-passengers.mjs [--out data/passagers-test.csv] [--seed 42]
 *
 * Sortie : CSV UTF-8 avec BOM (ouvrable dans Excel), une ligne par passager.
 * Déterministe à seed égal, pour des runs reproductibles.
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SEED = Number(args.seed ?? 42);
const OUT = args.out ?? path.join("data", "passagers-test.csv");

/* PRNG déterministe (mulberry32) */
let s = SEED >>> 0;
const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (Math.imul(s ^ (s >>> 15), 1 | s) >>> 16) / 65536 % 1);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

const NOMS = [
  "MARTIN","BERNARD","DUBOIS","THOMAS","ROBERT","PETIT","DURAND","LEROY","MOREAU","SIMON",
  "LAURENT","LEFEBVRE","MICHEL","GARCIA","DAVID","BERTRAND","ROUX","VINCENT","FOURNIER","MOREL",
  "GIRARD","ANDRE","MERCIER","BLANC","GUERIN","BOYER","GARNIER","CHEVALIER","FRANCOIS","LEGRAND",
  "WAMYTAN","TJIBAOU","GOPE","POADJA","NAISSELINE","WASHETINE","KASARHEROU","POUYE","HNAWIA","WAHEO",
  "NGUYEN","TRAN","LE","PHAM","HOANG","CHANE","AH-SCHA","LOUEckHOTE".toUpperCase(),
];
const PRENOMS_A = [
  "Jean","Marie","Pierre","Sophie","Luc","Claire","Paul","Julie","Marc","Anne","Nicolas","Laure",
  "Thomas","Emma","Hugo","Camille","Louis","Lea","Antoine","Chloe","Waia","Dewe","Kaloi","Marama",
  "Teiva","Moana","Hina","Manu","Linh","Thi","Duc","Mai",
];
const PRENOMS_C = ["Lucas","Lina","Noah","Jade","Gabriel","Louise","Raphaël","Alice","Nathan","Rose","Timo","Maeva"];

let pnrSeq = 0;
const newPnr = () => {
  pnrSeq += 1;
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let tag = "";
  for (let i = 0; i < 3; i += 1) tag += letters[Math.floor(rnd() * letters.length)];
  return `SB${String(pnrSeq).padStart(3, "0")}${tag}`;
};

const rows = [];
const addPax = (pnr, cabine, type, age, fb, assistance, remarque) =>
  rows.push({
    pnr,
    nom: pick(NOMS),
    prenom: type === "CHD" || type === "INF" ? pick(PRENOMS_C) : pick(PRENOMS_A),
    type_pax: type,
    age,
    cabine,
    flying_blue: fb,
    assistance,
    remarque,
  });

const fbAdult = (premium) => {
  const r = rnd();
  if (premium) return r < 0.25 ? "PLATINUM" : r < 0.55 ? "GOLD" : r < 0.8 ? "SILVER" : "NONE";
  return r < 0.02 ? "PLATINUM" : r < 0.07 ? "GOLD" : r < 0.2 ? "SILVER" : "NONE";
};
const adultAge = () => 20 + Math.floor(rnd() * 55);

/** Un dossier (PNR) : solo, couple, ou famille. Retourne le nombre de sièges consommés. */
function makeBooking(cabine, kind) {
  const pnr = newPnr();
  const premium = cabine !== "Y";
  if (kind === "solo") {
    addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
    return 1;
  }
  if (kind === "couple") {
    addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
    addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
    return 2;
  }
  // famille : 1 ou 2 adultes + 1..3 enfants, parfois un bébé
  const adults = chance(0.8) ? 2 : 1;
  const children = 1 + Math.floor(rnd() * 3);
  const infant = chance(0.2) ? 1 : 0;
  for (let i = 0; i < adults; i += 1) addPax(pnr, cabine, "ADT", adultAge(), fbAdult(premium), "", "");
  for (let i = 0; i < children; i += 1) addPax(pnr, cabine, "CHD", 2 + Math.floor(rnd() * 10), "NONE", "", "");
  if (infant) addPax(pnr, cabine, "INF", chance(0.5) ? 0 : 1, "NONE", "", "bébé - berceau");
  return adults + children + infant;
}

/* Remplit une cabine jusqu'à sa capacité. mix = proportions {solo, couple, famille}. */
function fillCabin(cabine, seats, mix) {
  let used = 0;
  while (used < seats - 4) {
    const r = rnd();
    const kind = r < mix.solo ? "solo" : r < mix.solo + mix.couple ? "couple" : "famille";
    used += makeBooking(cabine, kind);
  }
  while (used < seats) used += makeBooking(cabine, "solo");
}

/* A330-900 type : 24 J, 21 W, 246 Y — rempli à ~95 % */
fillCabin("J", 22, { solo: 0.65, couple: 0.35, famille: 0 });
fillCabin("W", 20, { solo: 0.45, couple: 0.4, famille: 0.15 });
fillCabin("Y", 236, { solo: 0.38, couple: 0.32, famille: 0.3 });

/* PMR : ~4 passagers adultes marqués WCHR, répartis sur des dossiers existants */
const adults = rows.filter((r) => r.type_pax === "ADT");
const marked = new Set();
while (marked.size < 4) {
  const r = pick(adults);
  if (marked.has(r.pnr)) continue;
  marked.add(r.pnr);
  r.assistance = "WCHR";
  r.remarque = [r.remarque, "fauteuil roulant - chambre accessible requise"].filter(Boolean).join(" ; ");
}

const header = "pnr;nom;prenom;type_pax;age;cabine;flying_blue;assistance;remarque";
const csv =
  "﻿" +
  header +
  "\n" +
  rows
    .map((r) => [r.pnr, r.nom, r.prenom, r.type_pax, r.age, r.cabine, r.flying_blue, r.assistance, r.remarque].join(";"))
    .join("\n") +
  "\n";

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, csv, "utf8");

const count = (fn) => rows.filter(fn).length;
console.log(`Écrit ${OUT} — ${rows.length} passagers, ${new Set(rows.map((r) => r.pnr)).size} dossiers (seed ${SEED})`);
console.log(
  `  J=${count((r) => r.cabine === "J")}  W=${count((r) => r.cabine === "W")}  Y=${count((r) => r.cabine === "Y")}` +
    `  ADT=${count((r) => r.type_pax === "ADT")}  CHD=${count((r) => r.type_pax === "CHD")}  INF=${count((r) => r.type_pax === "INF")}` +
    `  PMR=${count((r) => r.assistance === "WCHR")}`,
);
