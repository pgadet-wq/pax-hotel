/**
 * Ingestion de la liste passagers d'une compagnie — format PAXLIST v1
 * (spécification : `docs/format-liste-passagers.md`).
 *
 * `lib/csv.mjs` reste le lecteur du format interne (générateur, aller-retour
 * verrouillé par test) : ce module est la porte d'entrée des fichiers VENANT DE
 * LA COMPAGNIE. Il applique la règle du CDC §5 et de CLAUDE.md — « toute entrée
 * externe passe par un schéma zod, erreur explicite, jamais de défaut
 * silencieux » — que le lecteur historique n'appliquait pas aux VALEURS.
 *
 * Trois étages :
 *   1. `readPaxCsv`       octets → lignes brutes (encodage, séparateur, RFC 4180, alias d'en-têtes)
 *   2. `normalizePaxRows` lignes brutes → lignes canoniques + rapport d'ingestion
 *   3. `splitPaxRows`     lignes canoniques → { pax, equipage, exclus }
 *
 * `ingestPassagers` enchaîne les trois. Une valeur absente donne un défaut
 * EXPLICITE tracé au rapport ; une valeur présente et non résoluble sur une
 * colonne qui commande le tier ou une exclusion fait ÉCHOUER l'ingestion
 * (`IngestError`, qui porte le rapport).
 *
 * INV-5 : rien de ce fichier ne part dans un prompt ou un événement d'agent.
 */
import { z } from "zod";

/* ------------------------------------------------------------ vocabulaire */

/** Colonnes canoniques du format (l'ordre du fichier est libre). */
export const PAXLIST_COLS = [
  "pnr", "nom", "prenom", "type_pax", "cabine", "categorie", "statut_pax", "assistance",
  "droit_entree", "destination_finale", "chambres_demandees", "flying_blue", "groupe",
  "age", "email", "telephone", "vol", "remarque", "classe_reservation",
];

/** Colonnes dont l'absence fait échouer l'ingestion (socle §3.1). */
export const PAXLIST_REQUIRED = ["pnr", "nom", "type_pax", "cabine"];

/** Colonnes recommandées : absence tolérée, défaut explicite + avertissement (§3.2). */
const RECOMMENDED = ["prenom", "assistance", "statut_pax", "categorie", "droit_entree"];

const HEADER_ALIASES = {
  pnr: ["pnr", "pnrno", "recordlocator", "rloc", "locator", "dossier", "nodossier", "bookingreference", "bookingref", "confirmationnumber", "reservation"],
  nom: ["nom", "lastname", "surname", "familyname", "nompassager", "paxname", "name"],
  prenom: ["prenom", "firstname", "givenname", "forename"],
  type_pax: ["typepax", "ptc", "passengertype", "paxtype", "type", "typepassager"],
  cabine: ["cabine", "cabin", "cabinclass", "compartment", "classecabine", "cabinereelle", "class", "classe", "cos", "serviceclass"],
  categorie: ["categorie", "category", "crew", "crewindicator", "paxorcrew", "typepersonne", "role"],
  statut_pax: ["statutpax", "statut", "boardingstatus", "boarded", "paxstatus", "status", "embarquement", "priseencharge"],
  assistance: ["assistance", "ssr", "ssrcodes", "specialservice", "specialrequests", "prm", "servicecodes", "besoins"],
  droit_entree: ["droitentree", "entryright", "immigration", "visa", "visaok", "entryok", "admissible", "transitonly"],
  destination_finale: ["destinationfinale", "finaldestination", "destination", "dest", "arrivalstation", "finaldest"],
  chambres_demandees: ["chambresdemandees", "chambres", "rooms", "rooming", "nbchambres"],
  flying_blue: ["flyingblue", "fqtv", "ffstatus", "frequentflyer", "tierstatus", "statutff", "loyaltytier"],
  groupe: ["groupe", "group", "groupname", "groupid", "nomgroupe", "tourcode"],
  age: ["age", "dob", "dateofbirth", "datenaissance", "birthdate"],
  email: ["email", "mail", "courriel", "contactemail", "emailaddress"],
  telephone: ["telephone", "tel", "phone", "mobile", "msisdn", "contactphone", "numero"],
  vol: ["vol", "flight", "flightnumber", "flightno", "numvol", "flt", "segment"],
  remarque: ["remarque", "remarques", "comment", "comments", "note", "notes", "observation", "freetext"],
  classe_reservation: ["classereservation", "rbd", "bookingclass", "fareclass", "rbdcode"],
};

/** Alias de VALEURS. Les titres de civilité (MR/MRS/MS) sont volontairement
 * absents de `type_pax` : ils fabriqueraient des adultes à partir d'une civilité. */
const CABIN_ALIASES = {
  J: ["J", "BUSINESS", "AFFAIRES", "BUSINESSCLASS", "HIBISCUSBUSINESS", "CLASSEAFFAIRES"],
  W: ["W", "PREMIUM", "PREMIUMECO", "PREMIUMECONOMY", "PREMIEREECO", "ECOPREMIUM"],
  Y: ["Y", "ECO", "ECONOMY", "ECONOMIQUE", "COACH", "MAINCABIN", "CLASSEECONOMIQUE"],
};
const TYPE_ALIASES = {
  ADT: ["ADT", "ADULT", "ADULTE", "A", "SRC", "YTH", "STU", "MIL"],
  CHD: ["CHD", "CNN", "CHILD", "ENFANT", "CH", "UNN", "UMNR", "UM"],
  INF: ["INF", "INFT", "INS", "IN", "BABY", "BEBE", "NOURRISSON"],
};
const CAT_ALIASES = {
  PAX: ["PAX", "PASSENGER", "PASSAGER", "CUSTOMER", "P"],
  PNT: ["PNT", "COCKPIT", "FLIGHTCREW", "FLTCREW", "TECHCREW", "PILOTE", "FD"],
  PNC: ["PNC", "CABINCREW", "CC", "HOTESSE", "STEWARD", "CA"],
  DEADHEAD: ["DEADHEAD", "DH", "DHD", "ACM", "POSITIONING", "REPOSITIONNEMENT", "MEP"],
};
const STATUT_ALIASES = {
  A_LOGER: ["A_LOGER", "ALOGER", "EMBARQUE", "BOARDED", "FLOWN", "ONBOARD", "B", "GOSHOW"],
  NON_EMBARQUE: ["NON_EMBARQUE", "NONEMBARQUE", "NOSHOW", "OFFLOAD", "OFFLOADED", "ABSENT"],
  AUTONOME: ["AUTONOME", "SELF", "OWNARRANGEMENT", "SEDEBROUILLE"],
  DEJA_LOGE: ["DEJA_LOGE", "DEJALOGE", "ALREADYACCOMMODATED", "HOTELOK"],
  REFUSE: ["REFUSE", "DECLINE", "DECLINED", "REFUS"],
};
const DROIT_ALIASES = {
  OUI: ["OUI", "Y", "YES", "TRUE", "1", "OK", "VISAOK", "EXEMPT", "ADMIS"],
  NON: ["NON", "N", "NO", "FALSE", "0", "TWOV", "TRANSITONLY", "TRANSIT"],
  INCONNU: ["INCONNU", "UNKNOWN", "?", "NC", "AVERIFIER"],
};
const FB_ALIASES = {
  PLATINUM: ["PLATINUM", "PLT", "PL", "ULTIMATE", "ELITEPLUS"],
  GOLD: ["GOLD", "GLD", "GO", "ELITE"],
  SILVER: ["SILVER", "SLV", "SIL"],
  NONE: ["NONE", "EXPLORER", "BASIC", "AUCUN", "0", "-"],
};

/** SSR déclenchant l'overlay PMR (chambre accessible exigée). */
export const PMR_SSR = new Set(["WCHR", "WCHS", "WCHC", "WCBD", "WCBW", "WCMP", "BLND", "DEAF", "DPNA"]);
/** SSR sortant le dossier du plan hôtel : traitement nominatif au desk. */
export const ESCALADE_SSR = { STCR: "civière", MEDA: "médical", UMNR: "mineur non accompagné", UNN: "mineur non accompagné" };
/** SSR « animal » : note au plan, aucun filtre dur (aucun critère animalier dans l'inventaire). */
export const ANIMAL_SSR = new Set(["PETC", "AVIH", "ESAN", "SVAN"]);
/** SSR reconnus et sans effet sur la chambre : ignorés explicitement, jamais un refus. */
const SSR_SANS_EFFET = new Set(["MAAS", "BSCT", "NSST", "NSSA", "NSSW", "SEAT", "BULK", "SPEQ", "EXST", "FQTV", "DOCS", "TWOV", "CKIN", "INFT", "CHLD"]);
/** Notes de chambre spécifiques, par code SSR (le desk lit la colonne `notes`). */
const SSR_NOTES = {
  WCHS: "WCHS : ascenseur obligatoire (pas d'escalier jusqu'à la chambre)",
  WCHC: "WCHC : chambre PMR réelle + transfert adapté (passager non ambulant)",
  WCBD: "fauteuil à batterie : prise de recharge en chambre",
  WCBW: "fauteuil pliant : rangement en chambre",
  BLND: "déficience visuelle : accompagnement jusqu'à la chambre",
  DEAF: "déficience auditive : alarme incendie visuelle requise",
  DPNA: "assistance à l'orientation : accompagnement desk → chambre",
};

const norm = (s) => String(s ?? "").trim();
const slugHeader = (s) =>
  norm(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const slugValue = (s) =>
  norm(s).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z0-9?]/g, "");

const HEADER_LOOKUP = new Map();
for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const a of aliases) HEADER_LOOKUP.set(a, canon);
}
const valueLookup = (table) => {
  const m = new Map();
  for (const [canon, aliases] of Object.entries(table)) for (const a of aliases) m.set(slugValue(a), canon);
  return m;
};
const CABIN_LOOKUP = valueLookup(CABIN_ALIASES);
const TYPE_LOOKUP = valueLookup(TYPE_ALIASES);
const CAT_LOOKUP = valueLookup(CAT_ALIASES);
const STATUT_LOOKUP = valueLookup(STATUT_ALIASES);
const DROIT_LOOKUP = valueLookup(DROIT_ALIASES);
const FB_LOOKUP = valueLookup(FB_ALIASES);

/** Erreur d'ingestion : porte le rapport pour que l'appelant l'affiche tel quel. */
export class IngestError extends Error {
  constructor(message, rapport) {
    super(message);
    this.name = "IngestError";
    this.rapport = rapport;
  }
}

/* ------------------------------------------------------- étage 1 : lecture */

/** Décodage : BOM UTF-8/UTF-16, UTF-8 strict, repli windows-1252 TRACÉ. */
function decode(input) {
  const warnings = [];
  if (typeof input === "string") return { text: input.replace(/^﻿/, ""), encodage: "utf-8 (texte déjà décodé)", warnings };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    const le = buf[0] === 0xff;
    const text = new TextDecoder(le ? "utf-16le" : "utf-16be").decode(buf);
    warnings.push({ code: "encodage", message: `fichier en UTF-16 ${le ? "LE" : "BE"} : décodé, mais ré-exportez en CSV UTF-8 pour éviter toute perte` });
    return { text: text.replace(/^﻿/, ""), encodage: `utf-16${le ? "le" : "be"}`, warnings };
  }
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.subarray(3) : buf;
  const strict = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if (!strict.includes("�")) return { text: strict, encodage: hasBom ? "utf-8 avec BOM" : "utf-8", warnings };
  const cp1252 = new TextDecoder("windows-1252").decode(body);
  if (cp1252.includes("�")) {
    throw new IngestError(
      "Encodage illisible : le fichier n'est ni UTF-8 ni windows-1252 — il est déjà corrompu, ré-exportez-le depuis la source en CSV UTF-8.",
      null,
    );
  }
  warnings.push({
    code: "encodage",
    message: "fichier non UTF-8 : décodé en windows-1252 (export Excel FR) — vérifiez les noms accentués dans le rapport ci-dessous",
  });
  return { text: cp1252, encodage: "windows-1252 (repli)", warnings };
}

/**
 * Parseur RFC 4180 : guillemets, guillemets doublés, sauts de ligne dans les champs.
 *
 * Garde-fou indispensable sur un fichier réel : un guillemet ouvrant JAMAIS refermé
 * (faute de frappe, export bancal) avalerait sans cela tout le reste du fichier dans
 * un seul champ — des centaines de passagers disparaîtraient derrière « 1 ligne
 * écartée ». Quand `expected` est connu, un saut de ligne qui complète exactement le
 * nombre de colonnes attendu referme implicitement le champ, et l'anomalie est
 * NOMMÉE (ligne, colonne) au lieu d'être silencieuse.
 *
 * @returns {{rows: Array<Array<string>>, lignes: number[], anomalies: object[]}}
 *   `lignes[i]` = numéro de ligne physique où commence la ligne logique `rows[i]`.
 */
function parseRfc4180(text, sep, expected = 0) {
  const rows = [];
  const lignes = [];
  const anomalies = [];
  let row = [];
  let cur = "";
  let quoted = false;
  let started = false;
  let phys = 1;
  let rowStart = 1;
  const pushField = () => { row.push(cur); cur = ""; };
  const pushRow = () => {
    pushField();
    rows.push(row);
    lignes.push(rowStart);
    row = [];
    started = false;
    rowStart = phys + 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") phys += 1;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
        continue;
      }
      if (c === "\n" && expected) {
        // Un champ d'une liste passagers ne contient JAMAIS de saut de ligne : un guillemet
        // ouvert qui atteint la fin de ligne est une faute de frappe ou un export bancal.
        // On referme ici — la ligne fautive sera écartée et NOMMÉE — au lieu d'avaler le
        // reste du fichier dans un seul champ (mesuré : 111 passagers perdus en silence).
        anomalies.push({ ligne: rowStart, motif: "guillemet ouvert non refermé en fin de ligne — ligne écartée" });
        quoted = false;
        pushRow();
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' && cur === "") { quoted = true; started = true; continue; }
    if (c === sep) { pushField(); started = true; continue; }
    if (c === "\n") { pushRow(); continue; }
    if (c === "\r") continue;
    cur += c;
    started = true;
  }
  if (quoted) anomalies.push({ ligne: rowStart, motif: "guillemet ouvert non refermé en fin de fichier" });
  if (started || cur !== "" || row.length) pushRow();
  return { rows, lignes, anomalies };
}

/** Séparateur retenu : celui qui fait reconnaître le plus de colonnes canoniques. */
function detectSeparator(headerLine) {
  const candidates = [";", ",", "\t", "|"];
  let best = { sep: ";", known: -1, cols: 0 };
  for (const sep of candidates) {
    const cols = parseRfc4180(headerLine + "\n", sep).rows[0] ?? [];
    const known = cols.filter((c) => HEADER_LOOKUP.has(slugHeader(c))).length;
    if (known > best.known || (known === best.known && cols.length > best.cols)) best = { sep, known, cols: cols.length };
  }
  return best;
}

/**
 * Octets ou texte → lignes brutes (objets à clés canoniques) + rapport de fichier.
 * Les lignes dont le nombre de champs diffère de l'en-tête sont ÉCARTÉES et comptées
 * (une ligne bancale ne doit jamais coûter le fichier) ; l'en-tête, lui, est bloquant.
 */
export function readPaxCsv(input) {
  const { text, encodage, warnings } = decode(input);
  const firstBreak = text.indexOf("\n");
  const headerLine = (firstBreak === -1 ? text : text.slice(0, firstBreak)).replace(/\r$/, "");
  if (!headerLine.trim()) throw new IngestError("CSV vide : il faut une ligne d'en-tête et au moins un passager.", null);
  const { sep, known } = detectSeparator(headerLine);
  if (known === 0) {
    throw new IngestError(
      `Séparateur introuvable : aucune colonne connue n'est reconnue avec « ; » « , » tabulation ou « | ». En-tête lu : ${headerLine.slice(0, 200)}`,
      null,
    );
  }

  // deux passes : la première donne le nombre de colonnes attendu, la seconde s'en sert
  // pour refermer un guillemet non refermé au lieu d'avaler la suite du fichier
  const attendu = (parseRfc4180(headerLine + "\n", sep).rows[0] ?? []).length;
  const parsed = parseRfc4180(text, sep, attendu);
  const grid = [];
  const lignesDe = [];
  parsed.rows.forEach((r, i) => {
    if (r.length > 1 || norm(r[0]) !== "") { grid.push(r); lignesDe.push(parsed.lignes[i]); }
  });
  const rawHeader = grid.shift().map(norm);
  lignesDe.shift();
  const mapping = [];
  const ignored = [];
  const aliases = [];
  const seen = new Map();
  rawHeader.forEach((h, i) => {
    const canon = HEADER_LOOKUP.get(slugHeader(h));
    if (!canon) { ignored.push(h); mapping.push(null); return; }
    if (seen.has(canon)) {
      throw new IngestError(
        `En-tête en double après normalisation : « ${rawHeader[seen.get(canon)]} » et « ${h} » désignent tous deux la colonne ${canon}.`,
        null,
      );
    }
    seen.set(canon, i);
    mapping.push(canon);
    if (slugHeader(h) !== canon.replace(/_/g, "")) aliases.push(`${h} → ${canon}`);
  });

  const manquantes = PAXLIST_REQUIRED.filter((c) => !seen.has(c));
  if (manquantes.length) {
    throw new IngestError(
      `Colonne manquante dans le CSV : ${manquantes.join(", ")} — colonnes lues : ${rawHeader.join(", ")}`,
      null,
    );
  }

  const rows = [];
  const lignesIgnorees = [...parsed.anomalies];
  grid.forEach((vals, idx) => {
    const ligne = lignesDe[idx] ?? idx + 2;
    if (vals.every((v) => norm(v) === "")) { lignesIgnorees.push({ ligne, motif: "ligne vide" }); return; }
    if (vals.length !== rawHeader.length) {
      lignesIgnorees.push({ ligne, motif: `${vals.length} champs pour ${rawHeader.length} colonnes (guillemets ou séparateur incohérents)` });
      return;
    }
    const row = { _ligne: ligne };
    mapping.forEach((canon, i) => { if (canon) row[canon] = norm(vals[i]); });
    rows.push(row);
  });

  if (!rows.length) throw new IngestError("CSV vide : il faut une ligne d'en-tête et au moins un passager.", null);

  return {
    rows,
    colonnesPresentes: [...seen.keys()],
    fichier: {
      encodage,
      separateur: sep === "\t" ? "tabulation" : sep,
      colonnes_lues: rawHeader,
      colonnes_ignorees: ignored,
      alias_appliques: aliases,
      lignes_ignorees: lignesIgnorees,
    },
    warnings,
  };
}

/* -------------------------------------------------- étage 2 : normalisation */

const PaxRowSchema = z.object({
  pnr: z.string().min(1).max(20),
  nom: z.string().min(1).max(60),
  prenom: z.string().max(60).default(""),
  type_pax: z.enum(["ADT", "CHD", "INF"]),
  cabine: z.enum(["J", "W", "Y"]),
  categorie: z.enum(["PAX", "PNT", "PNC", "DEADHEAD"]),
  statut_pax: z.enum(["A_LOGER", "NON_EMBARQUE", "AUTONOME", "DEJA_LOGE", "REFUSE"]),
  flying_blue: z.enum(["PLATINUM", "GOLD", "SILVER", "NONE"]),
  droit_entree: z.enum(["OUI", "NON", "INCONNU"]),
});

/** Codes SSR d'une cellule `assistance` (séparateurs : espace, virgule, /). */
export function parseSsr(value) {
  return norm(value).split(/[\s,/]+/).map(slugValue).filter(Boolean);
}
/** La ligne déclenche-t-elle l'overlay PMR ? (tolère une ligne non normalisée) */
export function paxIsPmr(row) {
  if (row?.pmr === true) return true;
  return parseSsr(row?.assistance).some((c) => PMR_SSR.has(c));
}
/** Motif d'escalade nominative porté par la ligne, ou null. */
export function paxEscalade(row) {
  if (row?.escalade_ssr) return row.escalade_ssr;
  for (const c of parseSsr(row?.assistance)) if (ESCALADE_SSR[c]) return ESCALADE_SSR[c];
  return null;
}
/** La ligne porte-t-elle un animal (PETC/AVIH) ? */
export function paxAnimal(row) {
  if (row?.animal === true) return true;
  return parseSsr(row?.assistance).some((c) => ANIMAL_SSR.has(c));
}
/** Notes de chambre dérivées des codes SSR de la ligne. */
export function ssrNotes(codes) {
  return [...new Set(codes.map((c) => SSR_NOTES[c]).filter(Boolean))];
}

/**
 * Lignes brutes → lignes canoniques + rapport. Idempotent : une ligne déjà
 * canonique (générateur interne) traverse sans changement de sens.
 * @param {Array<object>} rows
 * @param {object} [opts] `colonnesPresentes` pilote les avertissements « colonne absente »
 */
export function normalizePaxRows(rows, opts = {}) {
  const presentes = new Set(opts.colonnesPresentes ?? Object.keys(rows[0] ?? {}));
  const refus = [];
  const avert = [];
  const compteurs = {
    parCabine: { J: 0, W: 0, Y: 0 },
    parType: { ADT: 0, CHD: 0, INF: 0 },
    pmr: 0, animaux: 0, groupes: new Set(), equipage: 0,
    escalades: { nominative: 0, droit_entree: 0 },
    exclus: {},
  };
  const alias = new Map();
  const ssrInconnus = new Map();
  const ssrSansEffet = new Map();
  const noteAlias = (k) => alias.set(k, (alias.get(k) ?? 0) + 1);
  const add = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);
  const refuse = (row, colonne, valeur, aide) =>
    refus.push({ ligne: row._ligne ?? null, colonne, valeur, message: `ligne ${row._ligne ?? "?"}, colonne ${colonne} : « ${valeur} » non reconnue — ${aide}` });

  // défauts explicites pour les colonnes absentes : tracés une fois, jamais silencieux
  for (const col of RECOMMENDED) {
    if (presentes.has(col)) continue;
    const consequence = {
      prenom: "la liste d'appel n'affichera que le nom",
      assistance: "AUCUN passager à mobilité réduite ne sera reconnu",
      statut_pax: "toutes les lignes sont planifiées comme à loger — un PNL de réservation contient des no-shows",
      categorie: "tout est traité comme passager — l'équipage serait logé comme des passagers",
      droit_entree: "tous les dossiers sont planifiés comme entrants sur le territoire",
    }[col];
    avert.push({ code: `colonne_absente:${col}`, message: `colonne « ${col} » absente : ${consequence}` });
  }
  if (!presentes.has("chambres_demandees")) {
    avert.push({ code: "colonne_absente:chambres_demandees", message: "colonne « chambres_demandees » absente : le chambrage est calculé automatiquement (unité familiale, sinon 2 chambres ; adultes appariés par deux)" });
  }

  const out = [];
  for (const row of rows) {
    const pnr = slugValue(row.pnr).replace(/-/g, "");
    if (!pnr) { refuse(row, "pnr", row.pnr ?? "", "le regroupement en dossiers est impossible sans clé"); continue; }
    if (!/^[A-Z0-9]{4,20}$/.test(pnr)) noteAlias(`pnr hors gabarit : ${pnr}`);

    // type_pax : alias, puis codes à âge C00–C17
    const rawType = slugValue(row.type_pax);
    let type = TYPE_LOOKUP.get(rawType) ?? null;
    let ageFromCode = null;
    if (!type) {
      const m = /^C(\d{2})$/.exec(rawType);
      if (m) { type = "CHD"; ageFromCode = Number(m[1]); }
    }
    if (!type) {
      refuse(row, "type_pax", row.type_pax ?? "", "codes acceptés : ADT, CHD, INF, CNN, INFT, INS, UNN, C00 à C17");
      continue;
    }
    if (rawType !== type) noteAlias(`${rawType} → ${type}`);

    const rawCabine = slugValue(row.cabine);
    const cabine = CABIN_LOOKUP.get(rawCabine) ?? null;
    if (!cabine) {
      refuse(row, "cabine", row.cabine ?? "",
        "valeurs acceptées : J, W, Y (ou BUSINESS / PREMIUM / ECO). Une classe de réservation (C, D, S, M, K…) n'est pas une cabine : fournissez la cabine normalisée");
      continue;
    }
    if (rawCabine !== cabine) noteAlias(`${rawCabine} → ${cabine}`);

    const resolve = (col, lookup, defaut, aide) => {
      const raw = slugValue(row[col]);
      if (!raw) return { value: presentes.has(col) && col === "droit_entree" ? "INCONNU" : defaut, defaulted: true };
      const v = lookup.get(raw);
      if (!v) { refuse(row, col, row[col], aide); return { value: null, defaulted: false }; }
      if (raw !== v) noteAlias(`${raw} → ${v}`);
      return { value: v, defaulted: false };
    };
    const cat = resolve("categorie", CAT_LOOKUP, "PAX", "valeurs acceptées : PAX, PNT, PNC, DEADHEAD");
    const statut = resolve("statut_pax", STATUT_LOOKUP, "A_LOGER", "valeurs acceptées : A_LOGER (EMBARQUE), NON_EMBARQUE, AUTONOME, DEJA_LOGE, REFUSE — « OK » signifie réservation confirmée, pas embarqué");
    const droit = resolve("droit_entree", DROIT_LOOKUP, "OUI", "valeurs acceptées : OUI, NON, INCONNU");
    const fb = resolve("flying_blue", FB_LOOKUP, "NONE", "valeurs acceptées : PLATINUM, GOLD, SILVER, NONE");
    if (cat.value === null || statut.value === null || droit.value === null) continue;
    if (fb.value === null) continue;

    const codes = parseSsr(row.assistance);
    for (const c of codes) {
      if (PMR_SSR.has(c) || ESCALADE_SSR[c] || ANIMAL_SSR.has(c)) continue;
      if (SSR_SANS_EFFET.has(c) || /ML$/.test(c)) add(ssrSansEffet, c);
      else add(ssrInconnus, c);
    }

    let age = null;
    if (norm(row.age) !== "") {
      const brut = norm(row.age);
      const n = /^\d{1,3}$/.test(brut) ? Number(brut) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 120) avert.push({ code: "age", message: `ligne ${row._ligne ?? "?"} : âge « ${row.age} » ignoré (entier 0–120 attendu)` });
      else age = n;
    }
    if (age === null && ageFromCode !== null) age = ageFromCode;
    if (age !== null) {
      if (type === "ADT" && age < 12) avert.push({ code: "age_type", message: `ligne ${row._ligne ?? "?"} : ADT de ${age} ans — type ou âge incohérent` });
      if (type === "CHD" && age >= 18) avert.push({ code: "age_type", message: `ligne ${row._ligne ?? "?"} : CHD de ${age} ans — type ou âge incohérent` });
      if (type === "INF" && age >= 2) avert.push({ code: "age_type", message: `ligne ${row._ligne ?? "?"} : INF de ${age} ans — type ou âge incohérent` });
    }

    let chambres = null;
    if (norm(row.chambres_demandees) !== "") {
      const brut = norm(row.chambres_demandees);
      const n = /^\d{1,2}$/.test(brut) ? Number(brut) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 50) avert.push({ code: "chambres", message: `ligne ${row._ligne ?? "?"} : chambres_demandees « ${row.chambres_demandees} » ignorée (entier ≥ 1 attendu)` });
      else chambres = n;
    }

    const email = norm(row.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) avert.push({ code: "email", message: `ligne ${row._ligne ?? "?"} : e-mail de forme invalide, ignoré` });

    const destination = slugValue(row.destination_finale);
    if (destination && !/^[A-Z]{3}$/.test(destination)) avert.push({ code: "destination", message: `ligne ${row._ligne ?? "?"} : destination_finale « ${row.destination_finale} » hors format IATA (3 lettres)` });

    const pmr = codes.some((c) => PMR_SSR.has(c));
    const escalade = codes.map((c) => ESCALADE_SSR[c]).find(Boolean) ?? null;
    const animal = codes.some((c) => ANIMAL_SSR.has(c));

    // format PNL « NOM/PRENOM TITRE » en un seul champ : découpé, titre retiré
    let nomBrut = norm(row.nom);
    let prenomBrut = norm(row.prenom);
    if (nomBrut.includes("/") && !prenomBrut) {
      const [n, reste = ""] = nomBrut.split("/");
      nomBrut = n.trim();
      prenomBrut = reste.trim().replace(/\s+(MR|MRS|MS|MSTR|MISS|DR|PROF)\.?$/i, "").trim();
      noteAlias("nom PNL « NOM/PRENOM » découpé");
    }

    const out_row = {
      pnr,
      nom: nomBrut,
      prenom: prenomBrut,
      type_pax: type,
      cabine,
      categorie: cat.value,
      statut_pax: statut.value,
      assistance: codes.join(" "),
      ssr: codes,
      pmr,
      escalade_ssr: escalade,
      animal,
      droit_entree: droit.value,
      destination_finale: destination,
      chambres_demandees: chambres,
      flying_blue: fb.value,
      groupe: norm(row.groupe),
      age: age === null ? "" : String(age),
      email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "",
      telephone: norm(row.telephone),
      vol: norm(row.vol),
      remarque: norm(row.remarque),
      _ligne: row._ligne ?? null,
    };
    if (!out_row.nom) { refuse(row, "nom", "", "le nom est obligatoire (liste d'appel au comptoir)"); continue; }

    const check = PaxRowSchema.safeParse(out_row);
    if (!check.success) {
      const issue = check.error.issues[0];
      refuse(row, issue.path.join("."), String(out_row[issue.path[0]] ?? ""), issue.message);
      continue;
    }

    if (out_row.categorie !== "PAX") compteurs.equipage += 1;
    else if (out_row.statut_pax !== "A_LOGER") compteurs.exclus[out_row.statut_pax] = (compteurs.exclus[out_row.statut_pax] ?? 0) + 1;
    else {
      compteurs.parCabine[out_row.cabine] += 1;
      compteurs.parType[out_row.type_pax] += 1;
      if (pmr) compteurs.pmr += 1;
      if (animal) compteurs.animaux += 1;
      if (escalade) compteurs.escalades.nominative += 1;
      if (out_row.droit_entree !== "OUI") compteurs.escalades.droit_entree += 1;
      if (out_row.groupe) compteurs.groupes.add(out_row.groupe);
    }
    out.push(out_row);
  }

  // contrôles inter-lignes
  const byPnr = new Map();
  for (const r of out) {
    if (!byPnr.has(r.pnr)) byPnr.set(r.pnr, []);
    byPnr.get(r.pnr).push(r);
  }
  for (const [pnr, pax] of byPnr) {
    const cabines = new Set(pax.map((p) => p.cabine));
    if (cabines.size > 1) {
      const max = ["J", "W", "Y"].find((t) => cabines.has(t));
      avert.push({ code: "pnr_cabines", message: `dossier ${pnr} : cabines ${[...cabines].join(" et ")} — tier retenu ${max} (maximum du dossier)` });
    }
    const noms = new Set(pax.map((p) => p.nom));
    if (noms.size > 2 && !pax.some((p) => p.groupe)) {
      avert.push({ code: "pnr_partage", message: `dossier ${pnr} : ${noms.size} noms de famille distincts sans valeur « groupe » — la colonne PNR est-elle la bonne ?` });
    }
    if (pax.length > 9 && !pax.some((p) => p.chambres_demandees)) {
      avert.push({ code: "pnr_volumineux", message: `dossier ${pnr} : ${pax.length} personnes sans « chambres_demandees » — chambrage deviné, à vérifier` });
    }
    const demandes = [...new Set(pax.map((p) => p.chambres_demandees).filter((n) => Number.isInteger(n) && n > 0))];
    if (demandes.length > 1) {
      avert.push({ code: "chambres_contradictoires", message: `dossier ${pnr} : chambres_demandees contradictoires (${demandes.join(", ")}) — le MAXIMUM est retenu (${Math.max(...demandes)}), jamais sous-loger` });
    }
    const mixte = new Set(pax.map((p) => (p.categorie === "PAX" ? "PAX" : "EQUIPAGE")));
    if (mixte.size > 1) avert.push({ code: "pnr_mixte", message: `dossier ${pnr} : passagers et équipage sous le même PNR — l'équipage doit porter une clé propre` });
    const cats = new Set(pax.filter((p) => p.categorie !== "PAX").map((p) => p.pnr));
    if (cats.size && pax.length > 1 && mixte.size === 1) {
      avert.push({ code: "equipage_partage", message: `dossier ${pnr} : ${pax.length} membres d'équipage sous la même clé — une chambre individuelle par personne est attendue` });
    }
  }
  const ratio = byPnr.size ? out.length / byPnr.size : 0;
  if (ratio > 6) avert.push({ code: "ratio", message: `${out.length} passagers pour ${byPnr.size} dossiers (ratio ${ratio.toFixed(1)}) — la colonne PNR est-elle la bonne ?` });

  if (ssrSansEffet.size) avert.push({ code: "ssr_sans_effet", message: `SSR reconnus sans effet sur la chambre : ${[...ssrSansEffet].map(([c, n]) => `${c} ×${n}`).join(", ")}` });
  if (ssrInconnus.size) avert.push({ code: "ssr_inconnu", message: `SSR inconnus, conservés sans effet : ${[...ssrInconnus].map(([c, n]) => `${c} ×${n}`).join(", ")}` });
  if (compteurs.animaux) avert.push({ code: "animaux", message: `${compteurs.animaux} dossier(s) avec animal (PETC/AVIH) : aucun critère « animaux acceptés » n'existe dans l'inventaire — à confirmer hôtel par hôtel` });
  if (compteurs.equipage === 0 && presentes.has("categorie")) {
    avert.push({ code: "equipage_absent", message: "aucune ligne d'équipage dans le fichier : l'hébergement équipage reste hors périmètre de l'outil (chambres à déduire du stock)" });
  }

  const rapport = {
    lignes: { lues: rows.length, retenues: out.length, refusees: refus.length },
    refus,
    avertissements: avert,
    alias_valeurs: [...alias].map(([k, n]) => `${k} : ${n} ligne(s)`),
    compteurs: {
      ...compteurs,
      groupes: [...compteurs.groupes],
      dossiers: byPnr.size,
      a_loger: out.filter((r) => r.categorie === "PAX" && r.statut_pax === "A_LOGER").length,
    },
  };
  return { rows: out, rapport };
}

/* ------------------------------------------------------- étage 3 : tri */

/**
 * Sépare ce qui entre dans le plan hôtel passagers du reste.
 * L'équipage sort du plan (une chambre individuelle par personne, hors barème
 * passager) ; les non-embarqués, autonomes, déjà logés et refus ne sont jamais logés.
 */
export function splitPaxRows(rows) {
  const pax = [];
  const equipage = [];
  const exclus = [];
  for (const r of rows) {
    const categorie = r.categorie ?? "PAX";
    const statut = r.statut_pax ?? "A_LOGER";
    if (categorie !== "PAX") equipage.push(r);
    else if (statut !== "A_LOGER") exclus.push(r);
    else pax.push(r);
  }
  return { pax, equipage, exclus };
}

/* ------------------------------------------------------------ enchaînement */

/**
 * Octets/texte/lignes → { rows, rapport, pax, equipage, exclus }.
 * Lève `IngestError` (portant le rapport) si une valeur décisive est illisible.
 */
export function ingestPassagers(input, opts = {}) {
  let rows;
  let fichier = null;
  let colonnesPresentes = opts.colonnesPresentes;
  let warnings = [];
  if (Array.isArray(input)) {
    rows = input;
  } else {
    const read = readPaxCsv(input);
    rows = read.rows;
    fichier = read.fichier;
    colonnesPresentes = read.colonnesPresentes;
    warnings = read.warnings;
  }
  const { rows: normalized, rapport } = normalizePaxRows(rows, { colonnesPresentes });
  rapport.fichier = fichier;
  rapport.avertissements = [...warnings, ...rapport.avertissements];
  if (fichier?.lignes_ignorees?.length) {
    rapport.avertissements.unshift({
      code: "lignes_ignorees",
      message: `${fichier.lignes_ignorees.length} ligne(s) écartée(s) à la lecture : ${fichier.lignes_ignorees.slice(0, 5).map((l) => `ligne ${l.ligne} (${l.motif})`).join(" ; ")}`,
    });
  }
  if (rapport.refus.length) {
    const apercu = rapport.refus.slice(0, 10).map((r) => r.message).join("\n");
    throw new IngestError(
      `Liste passagers refusée : ${rapport.refus.length} ligne(s) dont une valeur n'est pas interprétable.\n${apercu}` +
        (rapport.refus.length > 10 ? `\n… et ${rapport.refus.length - 10} autre(s).` : ""),
      rapport,
    );
  }
  const split = splitPaxRows(normalized);
  return { rows: normalized, rapport, ...split };
}

/** Rapport d'ingestion en texte (CLI et journal de run). */
export function formatRapport(rapport) {
  const c = rapport.compteurs;
  const out = [];
  if (rapport.fichier) {
    out.push(`Fichier : ${rapport.fichier.encodage}, séparateur « ${rapport.fichier.separateur} », ${rapport.fichier.colonnes_lues.length} colonnes lues`);
    if (rapport.fichier.alias_appliques.length) out.push(`  en-têtes traduits : ${rapport.fichier.alias_appliques.join(", ")}`);
    if (rapport.fichier.colonnes_ignorees.length) out.push(`  colonnes ignorées : ${rapport.fichier.colonnes_ignorees.join(", ")}`);
  }
  out.push(`Lignes : ${rapport.lignes.lues} lues, ${rapport.lignes.retenues} retenues, ${rapport.lignes.refusees} refusées`);
  out.push(`À loger : ${c.a_loger} passagers · ${c.dossiers} dossiers — J ${c.parCabine.J} / W ${c.parCabine.W} / Y ${c.parCabine.Y}`);
  out.push(`  types : ${c.parType.ADT} ADT, ${c.parType.CHD} CHD, ${c.parType.INF} INF · PMR ${c.pmr} · animaux ${c.animaux} · groupes ${c.groupes.length}`);
  out.push(`  escalades nominatives : ${c.escalades.nominative} · droit d'entrée : ${c.escalades.droit_entree} · équipage hors plan : ${c.equipage}`);
  const exclus = Object.entries(c.exclus).map(([k, n]) => `${k} ${n}`).join(", ");
  if (exclus) out.push(`  exclus (non logés) : ${exclus}`);
  if (rapport.alias_valeurs.length) out.push(`Valeurs traduites : ${rapport.alias_valeurs.join(" · ")}`);
  if (rapport.avertissements.length) {
    out.push(`Avertissements (${rapport.avertissements.length}) :`);
    for (const a of rapport.avertissements) out.push(`  - ${a.message}`);
  }
  return out.join("\n");
}
