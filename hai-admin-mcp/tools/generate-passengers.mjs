#!/usr/bin/env node
/**
 * Génère le jeu de test passagers — wrapper mince autour de lib/passagers.mjs.
 *
 *   node hai-admin-mcp/tools/generate-passengers.mjs [--out data/passagers-test.csv] [--seed 42]
 *
 * Défauts CLI inchangés depuis le POC v1 : A330 rempli à ~95 % (22 J / 20 W / 236 Y,
 * mode « legacy » — même séquence de tirages que la v1), seed 42, 4 passagers WCHR.
 * L'UI de démo utilise, elle, un A350-900 plein exact via lib/scenario.mjs.
 * Sortie : CSV UTF-8 avec BOM (ouvrable dans Excel), une ligne par passager.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePassengers, LEGACY_A330_SEATS } from "../lib/passagers.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SEED = Number(args.seed ?? 42);
if (!Number.isInteger(SEED) || SEED < 0) throw new Error(`--seed doit être un entier positif (reçu : ${args.seed})`);

// défaut résolu depuis la racine du dépôt (jamais process.cwd()) ; --out explicite : chemin de l'appelant
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = args.out ? path.resolve(args.out) : path.join(ROOT, "data", "passagers-test.csv");

const { csv, stats } = generatePassengers({ seats: LEGACY_A330_SEATS, seed: SEED, fill: "legacy" });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, csv, "utf8");

console.log(`Écrit ${OUT} — ${stats.passagers} passagers, ${stats.dossiers} dossiers (seed ${stats.seed})`);
console.log(
  `  J=${stats.parCabine.J}  W=${stats.parCabine.W}  Y=${stats.parCabine.Y}` +
    `  ADT=${stats.parType.ADT}  CHD=${stats.parType.CHD}  INF=${stats.parType.INF}  PMR=${stats.pmr}`,
);
