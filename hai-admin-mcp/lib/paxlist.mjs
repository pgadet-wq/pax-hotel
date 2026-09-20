/**
 * Ingestion de la liste passagers d'une compagnie — format PAXLIST v3
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

/**
 * Colonnes d'IDENTITÉ (PAXLIST v2, §3.3bis) — toutes OPTIONNELLES.
 *
 * Elles n'ont aucun effet sur le plan : elles ne changent ni le tier, ni le chambrage,
 * ni le coût. Elles n'existent que pour remplir les formulaires d'enregistrement
 * hôtelier (`lib/fiches.mjs`, condition C3) : sans elles, la fiche part au comptoir
 * avec des blancs que l'agent d'escale remplit à la main, passeport en main.
 * Une liste v1 qui ne les porte pas reste donc parfaitement valable — l'ingestion
 * chiffre seulement ce qui manquera sur les fiches.
 *
 * INV-5 — DONNÉES PERSONNELLES SENSIBLES : numéro de passeport, date de naissance,
 * nationalité et adresse ne sortent JAMAIS de ce processus. Aucune de ces valeurs
 * n'entre dans un prompt ni dans un événement d'agent (les agents relèvent des hôtels,
 * ils ne voient aucun passager) ; elles ne vont que dans les livrables locaux, soumis
 * à `policy.retention.nominative_hours`.
 */
export const PAXLIST_IDENTITE = [
  "date_naissance", "nationalite", "passeport_num", "passeport_exp", "passeport_pays",
  "sexe", "adresse_domicile",
];

/** Les trois champs qu'un registre d'hôtel exige partout : sans eux, la fiche est
 * incomplète et l'agent d'escale devra ouvrir le passeport au comptoir. Les quatre
 * autres colonnes sont du confort de saisie. */
export const PAXLIST_IDENTITE_ESSENTIELLE = ["date_naissance", "nationalite", "passeport_num"];

/**
 * Colonnes de CORRESPONDANCE (PAXLIST v3, §3.3ter) — toutes OPTIONNELLES.
 *
 * Elles portent le vol SUIVANT du passager, et elles seules permettent de calculer le
 * « budget de trajet » d'un dossier (`dossier.trajet_max_min`) : sans horaire de vol
 * suivant, aucune contrainte de distance ne s'applique, et un passager qui repart à
 * 05h40 peut être logé à 40 km de l'aéroport sans que rien ne le signale.
 *
 * Ce module ne calcule AUCUN budget et ne convertit aucune distance en durée : il lit
 * l'horaire, le date quand il le peut, et dit toujours d'où vient la date qu'il rend.
 *
 * INV-5 — comme toute donnée passager : rien de ce bloc n'entre dans un prompt ni dans
 * un événement d'agent. Les agents relèvent des hôtels, ils ne voient aucun passager,
 * donc aucun horaire de correspondance.
 */
export const PAXLIST_CORRESPONDANCE = ["vol_correspondance", "heure_correspondance"];

/**
 * Champs DÉRIVÉS posés sur la ligne canonique à partir des deux colonnes ci-dessus.
 * Ils ne sont jamais lus dans le fichier de la compagnie : ils sont le contrat de
 * sortie de l'ingestion vers le module qui calculera le budget de trajet.
 *
 *  - `heure_correspondance`        horloge MURALE canonique `AAAA-MM-JJTHH:MM`, ou "" ;
 *  - `heure_correspondance_brute`  la cellule telle que la compagnie l'a écrite ;
 *  - `correspondance_fuseau`       "declare" (le fichier porte un décalage UTC) ou
 *                                  "escale" (à lire dans `station.timezone`, JAMAIS sur
 *                                  l'horloge du serveur) ;
 *  - `correspondance_offset`       le décalage déclaré (`+07:00`), "" sinon ;
 *  - `correspondance_utc`          instant absolu `AAAA-MM-JJTHH:MMZ`, rempli SEULEMENT
 *                                  quand le fichier déclarait un décalage ;
 *  - `correspondance_date_source`  "declaree" | "inferee" | "indeterminee" | "" ;
 *  - `correspondance_rejet`        "" | "format" | "anterieure_arrivee" | "au_dela_72h".
 */
export const PAXLIST_CORRESPONDANCE_DERIVEES = [
  "heure_correspondance_brute", "correspondance_fuseau", "correspondance_offset",
  "correspondance_utc", "correspondance_date_source", "correspondance_rejet",
];

/** Colonnes canoniques du format (l'ordre du fichier est libre). */
export const PAXLIST_COLS = [
  "pnr", "nom", "prenom", "type_pax", "cabine", "categorie", "statut_pax", "assistance",
  "droit_entree", "destination_finale", "chambres_demandees", "flying_blue", "groupe",
  "age", "email", "telephone", "vol", "remarque", "classe_reservation",
  ...PAXLIST_IDENTITE,
  ...PAXLIST_CORRESPONDANCE,
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
  // `dob` / `date of birth` DÉSIGNENT UNE DATE : les rabattre sur `age` (v1) faisait
  // rejeter « 1982-03-14 » comme « âge hors 0–120 » et perdait la seule donnée que le
  // DCS exporte vraiment. Ils partent désormais sur `date_naissance`, d'où l'âge est déduit.
  age: ["age", "agepax", "agepassager", "paxage"],
  date_naissance: ["datenaissance", "dob", "dateofbirth", "birthdate", "birthday", "datedenaissance", "naissance", "dtnaissance", "dateofbirthdob"],
  nationalite: ["nationalite", "nationality", "nationalité", "natio", "citizenship", "paysnationalite", "nationalitycode"],
  passeport_num: ["passeportnum", "passeport", "passport", "passportnumber", "passportno", "docnumber", "documentnumber", "numpasseport", "numerodepasseport", "docid", "traveldocnumber"],
  passeport_exp: ["passeportexp", "passportexpiry", "passportexpiration", "expiry", "expirydate", "expirationdate", "docexpiry", "dateexpiration", "validitepasseport", "passportvalidity"],
  passeport_pays: ["passeportpays", "passportcountry", "issuingcountry", "countryofissue", "docissuecountry", "paysemission", "paysdelivrance"],
  // `civilite` est volontairement absent : MR/MRS est un titre, pas un sexe, et le
  // déduire fabriquerait une donnée d'état civil à partir d'une formule de politesse.
  sexe: ["sexe", "gender", "sex", "genre"],
  adresse_domicile: ["adressedomicile", "adresse", "address", "homeaddress", "residentialaddress", "streetaddress", "domicile", "adressepostale"],
  email: ["email", "mail", "courriel", "contactemail", "emailaddress"],
  telephone: ["telephone", "tel", "phone", "mobile", "msisdn", "contactphone", "numero"],
  vol: ["vol", "flight", "flightnumber", "flightno", "numvol", "flt", "segment"],
  remarque: ["remarque", "remarques", "comment", "comments", "note", "notes", "observation", "freetext"],
  classe_reservation: ["classereservation", "rbd", "bookingclass", "fareclass", "rbdcode"],
  // v3 — correspondance. `flight` / `segment` restent des alias de `vol` (le vol dérouté) :
  // les alias ci-dessous nomment tous EXPLICITEMENT le vol SUIVANT, jamais « flight » seul.
  vol_correspondance: [
    "volcorrespondance", "volsuivant", "prochainvol", "onwardflight", "onwardflightnumber",
    "onwardflightno", "connectingflight", "connectingflightnumber", "connectingflightno",
    "connectionflight", "nextflight", "nextflightnumber", "nextflightno", "flightonward",
    "vol2", "segment2", "voldecorrespondance", "numvolcorrespondance",
  ],
  heure_correspondance: [
    "heurecorrespondance", "horairecorrespondance", "heurevolsuivant", "heureprochainvol",
    "heuredecorrespondance", "heurevolcorrespondance", "std", "stdcorrespondance",
    "stdonward", "etd", "departuretime", "onwarddeparture", "onwarddeparturetime",
    "onwardstd", "onwardtime", "onwardflighttime", "connectingflighttime",
    "connectingdeparture", "connectiontime", "nextflighttime", "nextflightdeparture",
    "nextdeparture", "departcorrespondance", "heuredepartcorrespondance",
    "departvolsuivant", "heuredepartvolsuivant",
  ],
};

/* Un même slug d'en-tête ne peut désigner qu'UNE colonne canonique : sinon le fichier
 * est refusé en bloc sur « En-tête en double ». Le dictionnaire remis à la compagnie
 * annonçait `class` et `cos` comme alias de `classe_reservation` alors qu'ils sont ici
 * des alias de `cabine` : un export DCS qui suivait le dictionnaire à la lettre était
 * refusé, zéro ligne ingérée. La collision est désormais interdite à l'écriture. */
{
  const vus = new Map();
  for (const [colonne, alias] of Object.entries(HEADER_ALIASES)) {
    for (const a of alias) {
      const precedent = vus.get(a);
      if (precedent && precedent !== colonne) {
        throw new Error(
          `paxlist : l'alias d'en-tête « ${a} » est déclaré sur DEUX colonnes canoniques ` +
            `(${precedent} et ${colonne}) — tout fichier portant les deux serait refusé.`,
        );
      }
      vus.set(a, colonne);
    }
  }
}

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
/** Sexe (v2) : valeurs du document de voyage, `X` = non spécifié (OACI 9303). */
const SEXE_ALIASES = {
  M: ["M", "MALE", "HOMME", "H", "MASCULIN"],
  F: ["F", "FEMALE", "FEMME", "FEMININ"],
  X: ["X", "U", "UNSPECIFIED", "NONSPECIFIE", "AUTRE", "OTHER", "NB"],
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
const SEXE_LOOKUP = valueLookup(SEXE_ALIASES);
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
        `En-tête en double après normalisation : « ${rawHeader[seen.get(canon)]} » et « ${h} » désignent tous deux la colonne ${canon}. ` +
          `Remède : renommez l'une des deux dans le fichier avec le nom canonique qui lui convient ` +
          `(la classe de réservation — lettre RBD — se nomme « classe_reservation », la cabine J/W/Y se nomme « cabine »), ` +
          `ou supprimez la colonne en trop. Aucune ligne n'est ingérée tant que l'en-tête est ambigu.`,
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

/* ---------------------------------------------- v2 : colonnes d'identité (C3) */

/** Mois à trois lettres des dates de format PNR/DCS (`14MAR1982`), FR et EN. */
const MOIS3 = {
  JAN: 1, FEB: 2, FEV: 2, MAR: 3, APR: 4, AVR: 4, MAY: 5, MAI: 5, JUN: 6, JUIN: 6,
  JUL: 7, JUIL: 7, AUG: 8, AOU: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** Codes pays ISO 3166-1 alpha-2 ou alpha-3 (la table des codes n'est PAS embarquée :
 * on vérifie le gabarit, pas l'existence — une liste de 249 pays périmée ferait refuser
 * un code valide). */
export const ISO_PAYS_RE = /^[A-Z]{2,3}$/;

/**
 * Date d'une colonne v2 → ISO 8601, ou motif de rejet nommé.
 *
 * Trois formes acceptées, toutes NON AMBIGUËS : `AAAA-MM-JJ` (ISO, la forme demandée),
 * `AAAAMMJJ` (export DCS) et `JJMMMAAAA` (PNR, mois en trois lettres). `03/04/1982` est
 * refusé exprès : selon le pays d'export c'est le 3 avril ou le 4 mars, et une date de
 * naissance devinée sur un formulaire d'enregistrement hôtelier est pire qu'un blanc.
 * Une année à deux chiffres l'est pour la même raison (1982 ou 2082 ?).
 *
 * @param {string} value valeur brute de la cellule
 * @returns {{iso: string, forme: string, motif: string|null}} `iso` vide si non résolue
 */
export function parsePaxDate(value) {
  const brut = norm(value);
  if (!brut) return { iso: "", forme: "", motif: null };
  let y;
  let m;
  let d;
  let forme;
  let mm;
  if ((mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(brut))) { [, y, m, d] = mm; forme = "ISO 8601"; }
  else if ((mm = /^(\d{4})(\d{2})(\d{2})$/.exec(brut))) { [, y, m, d] = mm; forme = "AAAAMMJJ"; }
  else if ((mm = /^(\d{2})[ -]?([A-Za-zÀ-ÿ]{3})[ -]?(\d{4})$/.exec(brut))) {
    const mois = MOIS3[slugValue(mm[2])];
    if (!mois) return { iso: "", forme: "", motif: `mois « ${mm[2]} » non reconnu` };
    [, d, , y] = mm;
    m = String(mois).padStart(2, "0");
    forme = "JJMMMAAAA";
  } else {
    return {
      iso: "", forme: "",
      motif: "format attendu AAAA-MM-JJ (ISO 8601) ; AAAAMMJJ et JJMMMAAAA acceptés — une date en JJ/MM/AAAA ou à deux chiffres d'année est ambiguë et n'est jamais devinée",
    };
  }
  const iso = `${y}-${m}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  const reel = !Number.isNaN(dt.getTime()) && dt.getUTCFullYear() === Number(y) &&
    dt.getUTCMonth() + 1 === Number(m) && dt.getUTCDate() === Number(d);
  if (!reel) return { iso: "", forme, motif: "date inexistante au calendrier" };
  return { iso, forme, motif: null };
}

/**
 * Âge révolu à une date de référence.
 * @param {string} isoNaissance date ISO
 * @param {Date} [ref] date de référence (défaut : maintenant)
 * @returns {number|null} null si la date est vide ou postérieure à la référence
 */
export function ageAt(isoNaissance, ref = new Date()) {
  if (!isoNaissance) return null;
  const n = new Date(`${isoNaissance}T00:00:00Z`);
  if (Number.isNaN(n.getTime())) return null;
  const r = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  if (n > r) return null;
  let a = r.getUTCFullYear() - n.getUTCFullYear();
  const avant = r.getUTCMonth() < n.getUTCMonth() ||
    (r.getUTCMonth() === n.getUTCMonth() && r.getUTCDate() < n.getUTCDate());
  if (avant) a -= 1;
  return a;
}

/* -------------------------------------- v3 : horaire du vol de correspondance */

/**
 * Gabarit d'un indicatif de vol IATA : 2 (parfois 3) caractères de compagnie dont AU
 * MOINS UNE LETTRE, puis 1 à 4 chiffres, suffixe de lettre toléré (`TG920`, `SB800`,
 * `3U8633`, `AF1234A`). La lettre exigée écarte les valeurs purement numériques, qu'une
 * colonne d'horaire déversée dans la mauvaise case produirait (« 0540 »).
 * Hors gabarit, la valeur est CONSERVÉE et signalée — jamais corrigée au jugé.
 */
export const VOL_IATA_RE = /^(?=.*[A-Z])[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

/** Au-delà de cette fenêtre, un horaire de correspondance est jugé absurde (§3.3ter). */
export const CORRESPONDANCE_MAX_H = 72;

/**
 * En-têtes d'horaire AMBIGUS, acceptés mais SIGNALÉS.
 *
 * `STD`, `ETD` et `departure time` sont ce qu'un DCS exporte pour l'horaire d'un vol —
 * mais rien dans le mot ne dit DUQUEL. Sur une liste de déroutement, une colonne `STD`
 * a autant de chances de porter le départ du vol DÉROUTÉ que celui du vol SUIVANT, et se
 * tromper de vol fabrique un budget de trajet faux sans que rien ne le montre. Ils restent
 * des alias — un export réel les porte — mais leur usage déclenche `correspondance_entete_ambigue`.
 */
export const ENTETES_HORAIRE_AMBIGUS = new Set(["std", "etd", "departuretime", "nextdeparture", "connectiontime", "onwardtime"]);

/** Forme canonique d'une horloge murale : `AAAA-MM-JJTHH:MM`. */
export const HORLOGE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const RE_HEURE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** Date et heure séparées par `T` ou une espace, l'heure ANCRÉE en fin de chaîne :
 * un mois en trois lettres qui contient un « T » (`21OCT2026 05:40`) resterait entier. */
const RE_DATE_HEURE = /^(.+?)[T ](\d{1,2}:\d{2}(?::\d{2})?)$/i;

/** Lendemain d'une date ISO, en arithmétique UTC pure (aucun fuseau consulté). */
const lendemain = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Instant absolu d'une horloge murale assortie d'un décalage déclaré. */
const instantUtc = (local, offset) => {
  const signe = offset[0] === "-" ? -1 : 1;
  const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6));
  return `${new Date(Date.parse(`${local}:00Z`) - signe * minutes * 60000).toISOString().slice(0, 16)}Z`;
};

/** Minutes séparant deux horloges murales LUES DANS LE MÊME FUSEAU. */
const minutesEntre = (a, b) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000;

/**
 * Horaire du vol de correspondance → horloge murale canonique + provenance de la date.
 *
 * FORMES ACCEPTÉES (ce qu'un DCS exporte réellement) :
 *  - ISO 8601 complet avec fuseau   `2026-09-21T05:40:00+07:00`, `…Z` ;
 *  - ISO 8601 sans fuseau           `2026-09-21T05:40`, `2026-09-21T05:40:00` ;
 *  - date + heure séparées d'une espace `2026-09-21 05:40` — la partie DATE accepte les
 *    trois formes non ambiguës de `parsePaxDate` (`AAAA-MM-JJ`, `AAAAMMJJ`, `21SEP2026`) ;
 *  - `HH:MM` seul (et `HH:MM:SS`).
 *
 * FORME REFUSÉE À DESSEIN : l'horaire à quatre chiffres collés (`0540`). Rien ne le
 * distingue d'une année : « 2026 » se lirait 20:26. La compagnie écrit `05:40`.
 *
 * LA RÈGLE DE DATAGE DE `HH:MM` SEUL, TRANCHÉE ICI. Un vol à 05:40 est presque toujours
 * le LENDEMAIN d'un déroutement de nuit. La règle retenue est donc : **la première
 * occurrence de cette heure STRICTEMENT POSTÉRIEURE à l'arrivée du vol dérouté à
 * l'escale** (`reference`, horloge murale de l'escale). 05:40 après une arrivée à 23h15
 * tombe le lendemain ; 23h50 après la même arrivée tombe le soir même. La date ainsi
 * obtenue est marquée `date_source: "inferee"` — l'appelant DOIT en avertir l'opérateur,
 * elle n'est jamais devinée en silence.
 *
 * SANS `reference`, AUCUNE DATE N'EST INVENTÉE : la fonction rend `local: ""`,
 * `heure: "HH:MM"` et `date_source: "indeterminee"`. L'appelant, qui connaît la fiche
 * escale et l'heure d'arrivée, tranche.
 *
 * LE FUSEAU. Une heure sans décalage explicite est l'heure LOCALE DE L'ESCALE
 * (`station.timezone`), jamais l'horloge du serveur : la fonction ne convertit donc
 * rien et rend l'horloge murale telle quelle. Quand le fichier déclare un décalage,
 * l'instant absolu est calculé et rendu dans `utc` — c'est la seule valeur de ce module
 * qui soit un instant, et elle n'existe que si la compagnie l'a déclarée.
 *
 * @param {string} value cellule brute `heure_correspondance`
 * @param {object} [opts] `reference` : horloge murale d'escale `AAAA-MM-JJTHH:MM` de
 *   l'arrivée du vol dérouté (sert UNIQUEMENT à dater un `HH:MM` seul)
 * @returns {{local: string, heure: string, offset: string, utc: string,
 *   date_source: ""|"declaree"|"inferee"|"indeterminee", motif: string|null}}
 */
export function parseHeureCorrespondance(value, { reference = "" } = {}) {
  const vide = { local: "", heure: "", offset: "", utc: "", date_source: "", motif: null };
  const brut = norm(value);
  if (!brut) return { ...vide };

  let reste = brut.replace(/\s+/g, " ").trim();
  let offset = "";
  const mz = /(Z|[+-]\d{2}:?\d{2})$/i.exec(reste);
  if (mz) {
    const z = mz[1].toUpperCase();
    offset = z === "Z" ? "+00:00" : `${z.slice(0, 3)}:${z.slice(-2)}`;
    reste = reste.slice(0, mz.index).trim();
    if (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4, 6)) > 59) {
      return { ...vide, motif: `décalage horaire « ${mz[1]} » impossible` };
    }
  }

  let datePart = "";
  let heurePart = "";
  const md = RE_DATE_HEURE.exec(reste);
  if (md) { datePart = md[1].trim(); heurePart = md[2]; }
  else if (RE_HEURE.test(reste)) heurePart = reste;
  else if (/^\d{3,4}$/.test(reste)) {
    return {
      ...vide,
      motif: `un horaire en chiffres collés (« ${reste} ») n'est pas accepté : rien ne le distingue d'une année, « 2026 » se lirait 20:26 — écrivez l'heure avec deux points, « 05:40 »`,
    };
  } else {
    return {
      ...vide,
      motif: "format attendu AAAA-MM-JJTHH:MM (ISO 8601, fuseau facultatif), AAAA-MM-JJ HH:MM, ou HH:MM seul",
    };
  }

  const mh = RE_HEURE.exec(heurePart);
  const H = Number(mh[1]);
  const M = Number(mh[2]);
  if (H > 23 || M > 59) return { ...vide, motif: `heure « ${heurePart} » hors 00:00–23:59` };
  const hhmm = `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`;

  let jour = "";
  let dateSource = "";
  if (datePart) {
    const d = parsePaxDate(datePart);
    if (!d.iso) return { ...vide, heure: hhmm, offset, motif: d.motif ?? "date illisible" };
    jour = d.iso;
    dateSource = "declaree";
  } else if (HORLOGE_RE.test(reference)) {
    const jourRef = reference.slice(0, 10);
    jour = `${jourRef}T${hhmm}` > reference ? jourRef : lendemain(jourRef);
    dateSource = "inferee";
  } else {
    // pas de référence : on ne devine pas une date, on rend de quoi la trancher
    return { local: "", heure: hhmm, offset, utc: "", date_source: "indeterminee", motif: null };
  }

  const local = `${jour}T${hhmm}`;
  return { local, heure: hhmm, offset, utc: offset ? instantUtc(local, offset) : "", date_source: dateSource, motif: null };
}

/**
 * Schéma zod de la FORME CANONIQUE de chaque colonne d'identité — ce qui est stocké
 * sur la ligne, jamais la cellule brute. Une valeur qui ne passe pas est ÉCARTÉE avec
 * un avertissement nommé : ces colonnes ne commandent ni le tier ni une exclusion,
 * elles ne peuvent donc pas faire échouer l'ingestion (règle d'or n° 2 du format).
 * La chaîne vide est la valeur « non fourni » et traverse partout.
 */
export const IDENTITE_SCHEMAS = {
  // messages en français : ils sont recopiés tels quels dans l'avertissement lu par
  // l'agent d'escale, et le défaut zod est anglais.
  date_naissance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date attendue au format AAAA-MM-JJ"),
  // gabarit délibérément large : le code pays hors ISO est conservé tel quel et
  // signalé (voir `identite_hors_format`), pas jeté — le comptoir sait le lire.
  nationalite: z.string().min(1).max(40, "40 caractères maximum"),
  passeport_num: z.string()
    .min(4, "4 caractères au minimum")
    .max(20, "20 caractères au maximum")
    .regex(/^[A-Z0-9]+$/, "chiffres et lettres uniquement (les espaces et tirets sont retirés automatiquement)"),
  passeport_exp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date attendue au format AAAA-MM-JJ"),
  passeport_pays: z.string().min(1).max(40, "40 caractères maximum"),
  sexe: z.enum(["M", "F", "X"]),
  adresse_domicile: z.string().min(1).max(200, "200 caractères maximum"),
};

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
 *
 * v2 : les sept colonnes d'identité (§3.3bis) sont lues si elles sont présentes,
 * comptées si elles manquent, et JAMAIS inventées.
 *
 * v3 : les deux colonnes de correspondance (§3.3ter) suivent la même règle. `opts.escale`
 * est le SEUL ajout qui change quoi que ce soit, et il est facultatif : sans lui, un
 * `HH:MM` seul reste `indeterminee` au lieu d'être daté, et les contrôles de plausibilité
 * ne tournent pas. Une liste v1 ou v2 traverse donc exactement comme aujourd'hui.
 *
 * @param {Array<object>} rows
 * @param {object} [opts] `colonnesPresentes` pilote les avertissements « colonne absente » ;
 *   `now` est la date de référence des âges déduits et de la péremption des passeports
 *   (défaut : maintenant — le passer rend la fonction reproductible en test) ;
 *   `escale` = `{code, timezone, arrivee_locale, offset_min}` — `arrivee_locale` est
 *   l'horloge murale d'escale `AAAA-MM-JJTHH:MM` de l'arrivée du vol dérouté (elle seule
 *   permet de dater un `HH:MM` seul et de juger un horaire aberrant) ; `offset_min` est
 *   le décalage UTC DÉCLARÉ de l'escale, nécessaire seulement pour comparer un horaire
 *   qui porte lui-même un fuseau ; `timezone` et `code` ne servent qu'aux messages et au
 *   croisement avec `destination_finale`.
 */
export function normalizePaxRows(rows, opts = {}) {
  const presentes = new Set(opts.colonnesPresentes ?? Object.keys(rows[0] ?? {}));
  const now = opts.now ?? new Date();
  const isoDuJour = new Date(now).toISOString().slice(0, 10);
  const refus = [];
  const avert = [];
  const compteurs = {
    parCabine: { J: 0, W: 0, Y: 0 },
    parType: { ADT: 0, CHD: 0, INF: 0 },
    pmr: 0, animaux: 0, groupes: new Set(), equipage: 0,
    escalades: { nominative: 0, droit_entree: 0 },
    exclus: {},
    // C3 — ce que les fiches d'enregistrement pourront ou non porter. Compté sur les
    // personnes À LOGER, qui sont exactement celles qui recevront une fiche.
    fiches: { attendues: 0, completes: 0, manques: Object.fromEntries(PAXLIST_IDENTITE.map((c) => [c, 0])) },
    // v3 — de quoi dire, en chiffres, sur combien de dossiers un budget de trajet est
    // calculable. Compté sur les personnes À LOGER, comme les fiches.
    correspondance: {
      renseignees: 0, dates_declarees: 0, dates_inferees: 0, dates_indeterminees: 0,
      ecartees: 0, dossiers: 0, dossiers_sans_horaire: 0,
    },
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

  // ---- v3 : contexte d'escale, facultatif. Sans lui, rien n'est deviné (voir §3.3ter).
  const escale = opts.escale ?? {};
  const escaleTz = norm(escale.timezone);
  const escaleCode = slugValue(escale.code ?? "");
  const arriveeBrute = norm(escale.arrivee_locale);
  const refEscale = HORLOGE_RE.test(arriveeBrute) ? arriveeBrute : "";
  if (arriveeBrute && !refEscale) {
    avert.push({
      code: "correspondance_reference",
      message: `heure d'arrivée à l'escale « ${arriveeBrute} » illisible (AAAA-MM-JJTHH:MM attendu, heure LOCALE de l'escale) : les horaires donnés en HH:MM seul ne seront pas datés`,
    });
  }
  const escaleOffsetMin = Number.isInteger(escale.offset_min) ? escale.offset_min : null;
  let corrInferees = 0;
  let corrIndeterminees = 0;
  let corrNonComparables = 0;
  let corrSansFuseau = 0;

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

    // ---- colonnes d'identité v2 (C3) : lues si la compagnie les fournit, JAMAIS devinées.
    // INV-5 : rien de ce bloc ne part vers un agent — il ne sert qu'aux fiches remises au comptoir.
    const identite = Object.fromEntries(PAXLIST_IDENTITE.map((c) => [c, ""]));
    const horsFormat = [];
    const ecarte = (col, aide) =>
      avert.push({
        code: `identite:${col}`,
        message: `ligne ${row._ligne ?? "?"} : ${col} « ${norm(row[col])} » écartée — ${aide} ; la fiche portera un blanc à remplir au comptoir`,
      });
    /** Passe la valeur canonique au schéma zod de la colonne ; échec = champ vide + avertissement. */
    const poseIdentite = (col, valeur) => {
      if (valeur === "") return;
      const check = IDENTITE_SCHEMAS[col].safeParse(valeur);
      if (!check.success) { ecarte(col, check.error.issues[0].message); return; }
      identite[col] = check.data;
    };
    for (const col of ["date_naissance", "passeport_exp"]) {
      const { iso, motif } = parsePaxDate(row[col]);
      if (motif) { ecarte(col, motif); continue; }
      poseIdentite(col, iso);
    }
    for (const col of ["nationalite", "passeport_pays"]) {
      const brut = norm(row[col]);
      // un CODE se lit sans ponctuation, un NOM DE PAYS EN CLAIR se lit avec : passer
      // « Côte d'Ivoire » à la moulinette des codes donnerait « COTEDIVOIRE » sur un
      // registre d'hôtel, et l'avertissement en dessous promet justement l'inverse.
      const slug = slugValue(brut);
      poseIdentite(col, ISO_PAYS_RE.test(slug) ? slug : brut.toUpperCase());
      // un nom de pays en clair (« FRANCE », « THAÏLANDE ») reste lisible par un hôtelier :
      // on le garde et on le signale, au lieu de le jeter ou de le convertir au jugé
      if (identite[col] && !ISO_PAYS_RE.test(identite[col])) horsFormat.push(col);
    }
    const passeport = slugValue(row.passeport_num);
    poseIdentite("passeport_num", passeport);
    // « ab-12-345 » → « AB12345 » : la mise en forme change, jamais les caractères
    // signifiants — on le trace pour que personne ne découvre l'écart au comptoir
    if (passeport && passeport !== norm(row.passeport_num).toUpperCase()) noteAlias("passeport_num : espaces et séparateurs retirés");
    if (norm(row.sexe) !== "") {
      const s = SEXE_LOOKUP.get(slugValue(row.sexe));
      if (!s) ecarte("sexe", "valeurs acceptées : M, F, X (alias MALE/HOMME, FEMALE/FEMME, UNSPECIFIED)");
      else { poseIdentite("sexe", s); if (slugValue(row.sexe) !== s) noteAlias(`${slugValue(row.sexe)} → sexe ${s}`); }
    }
    poseIdentite("adresse_domicile", norm(row.adresse_domicile));
    if (identite.date_naissance) {
      const a = ageAt(identite.date_naissance, now);
      if (a === null) { ecarte("date_naissance", "date postérieure à la date du run"); identite.date_naissance = ""; }
      else if (a > 120) { ecarte("date_naissance", `${a} ans — date manifestement erronée`); identite.date_naissance = ""; }
    }
    if (identite.passeport_exp && identite.passeport_exp < isoDuJour) {
      avert.push({
        code: "passeport_expire",
        message: `ligne ${row._ligne ?? "?"} : passeport expiré le ${identite.passeport_exp} — l'hôtel et l'immigration le refuseront, à traiter au comptoir`,
      });
    }
    if (horsFormat.length) {
      avert.push({
        code: "identite_hors_format",
        message: `ligne ${row._ligne ?? "?"} : ${horsFormat.join(" et ")} hors format ISO 3166-1 (${horsFormat.map((c) => `« ${identite[c]} »`).join(", ")}) — valeur conservée telle quelle sur la fiche, à vérifier`,
      });
    }

    let age = null;
    let ageSource = "";
    if (norm(row.age) !== "") {
      const brut = norm(row.age);
      const n = /^\d{1,3}$/.test(brut) ? Number(brut) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 120) avert.push({ code: "age", message: `ligne ${row._ligne ?? "?"} : âge « ${row.age} » ignoré (entier 0–120 attendu)` });
      else { age = n; ageSource = "age"; }
    }
    // la date de naissance prime sur le code à âge `C05` : elle est datée, lui est figé au jour de l'émission
    if (age === null && identite.date_naissance) {
      age = ageAt(identite.date_naissance, now);
      ageSource = "date_naissance";
      noteAlias("âge déduit de date_naissance");
    }
    if (age === null && ageFromCode !== null) { age = ageFromCode; ageSource = "type_pax"; }
    // les deux colonnes fournies et incohérentes : c'est un mauvais appariement de lignes
    // à la source, et ce sont deux passagers qui échangent leur identité sur les fiches
    if (ageSource === "age" && identite.date_naissance) {
      const calcule = ageAt(identite.date_naissance, now);
      if (calcule !== null && Math.abs(calcule - age) > 1) {
        avert.push({
          code: "age_date_naissance",
          message: `ligne ${row._ligne ?? "?"} : âge ${age} déclaré mais ${calcule} ans au vu de date_naissance ${identite.date_naissance} — colonne « age » retenue, les deux valeurs sont à vérifier`,
        });
      }
    }
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

    // ---- colonnes de correspondance v3 (§3.3ter) : lues si la compagnie les fournit.
    // INV-5 : rien de ce bloc ne part vers un agent — un agent relève des hôtels, il n'a
    // jamais à connaître ni le vol suivant ni l'horaire d'un passager.
    // « AF 165 » → « AF165 » : la mise en forme change, jamais les caractères signifiants.
    // Hors gabarit, on garde la cellule TELLE QUELLE (« Thai Airways 930 » reste lisible
    // par un agent de comptoir ; le tasser en « THAIAIRWAYS930 » n'aiderait personne).
    const volBrut = norm(row.vol_correspondance);
    const volSlug = slugValue(volBrut);
    const volGabarit = VOL_IATA_RE.test(volSlug);
    const volCorr = volGabarit ? volSlug : volBrut.toUpperCase();
    if (volGabarit && volSlug !== volBrut.toUpperCase()) noteAlias("vol_correspondance : espaces et séparateurs retirés");
    if (volCorr && !volGabarit) {
      avert.push({
        code: "correspondance_vol",
        message: `ligne ${row._ligne ?? "?"} : vol_correspondance « ${volBrut} » hors gabarit IATA (2 ou 3 caractères de compagnie + 1 à 4 chiffres) — valeur conservée telle quelle, à vérifier`,
      });
    }
    // Une ligne DÉJÀ CANONIQUE qui repasse ici (générateur interne, pipeline) ne doit rien
    // perdre : quand `heure_correspondance` est vide parce que l'horaire a été écarté ou
    // laissé indéterminé, c'est `heure_correspondance_brute` qui porte encore la cellule
    // d'origine. La relire évite qu'un second passage efface la seule trace de ce que la
    // compagnie avait écrit.
    // L'horloge canonique, quand elle existe, fait foi pour l'analyse (elle porte la date
    // déjà résolue) ; la cellule d'origine, elle, n'est jamais réécrite par-dessus.
    // Le fuseau déclaré voyage à part de l'horloge murale : on le recolle avant de relire,
    // faute de quoi un second passage transformerait un horaire « declare » en horaire
    // « escale » et perdrait l'instant absolu que la compagnie avait pourtant fourni.
    const heureBrute = norm(row.heure_correspondance)
      ? norm(row.heure_correspondance) + norm(row.correspondance_offset)
      : norm(row.heure_correspondance_brute);
    const heureOrigine = norm(row.heure_correspondance_brute) || heureBrute;
    let corr = { local: "", heure: "", offset: "", utc: "", date_source: "", motif: null };
    let corrRejet = "";
    if (heureBrute) {
      corr = parseHeureCorrespondance(heureBrute, { reference: refEscale });
      // La DATE INFÉRÉE reste inférée : une horloge canonique se relit comme « declaree »,
      // ce qui ferait disparaître au second passage le fait qu'elle n'a jamais été fournie.
      if (corr.local && corr.local === norm(row.heure_correspondance) && norm(row.correspondance_date_source) === "inferee") {
        corr = { ...corr, date_source: "inferee" };
      }
      if (corr.motif) {
        corrRejet = "format";
        avert.push({
          code: "correspondance_horaire",
          message: `ligne ${row._ligne ?? "?"} : heure_correspondance « ${heureBrute} » écartée — ${corr.motif} ; aucun budget de trajet ne sera calculé pour ce dossier, aucune contrainte de distance ne s'y appliquera`,
        });
      } else {
        if (corr.date_source === "inferee") corrInferees += 1;
        if (corr.date_source === "indeterminee") corrIndeterminees += 1;
        if (!corr.offset) corrSansFuseau += 1;
      }
    }
    // plausibilité : antériorité et fenêtre de 72 h, mesurées SUR LE MÊME AXE seulement.
    // Une heure sans fuseau est une horloge d'escale, comparable à l'arrivée ; une heure
    // qui porte son propre fuseau ne l'est qu'avec le décalage déclaré de l'escale.
    if (!corrRejet && corr.local && refEscale) {
      let delta = null;
      if (!corr.offset) delta = minutesEntre(refEscale, corr.local);
      else if (escaleOffsetMin !== null) {
        delta = (Date.parse(corr.utc) - (Date.parse(`${refEscale}:00Z`) - escaleOffsetMin * 60000)) / 60000;
      } else corrNonComparables += 1;
      if (delta !== null && delta < 0) {
        corrRejet = "anterieure_arrivee";
        avert.push({
          code: "correspondance_anterieure",
          message: `ligne ${row._ligne ?? "?"} : heure_correspondance « ${heureBrute} » est ANTÉRIEURE à l'arrivée à l'escale (${refEscale}) — horaire écarté, un budget de trajet négatif escaladerait tout le dossier ; valeur brute conservée dans heure_correspondance_brute, à corriger`,
        });
      } else if (delta !== null && delta > CORRESPONDANCE_MAX_H * 60) {
        corrRejet = "au_dela_72h";
        avert.push({
          code: "correspondance_lointaine",
          message: `ligne ${row._ligne ?? "?"} : heure_correspondance « ${heureBrute} » tombe ${Math.round(delta / 60)} h après l'arrivée (au-delà de ${CORRESPONDANCE_MAX_H} h) — horaire écarté comme aberrant (année ou date de saisie erronée) ; valeur brute conservée, à corriger`,
        });
      }
    }
    if (corrRejet) compteurs.correspondance.ecartees += 1;
    // les deux colonnes se combinent : destination ≠ escale + horaire = dossier en
    // correspondance. Les voir se contredire vaut mieux que de choisir en silence.
    if (escaleCode && destination && destination === escaleCode && heureBrute) {
      avert.push({
        code: "correspondance_destination",
        message: `ligne ${row._ligne ?? "?"} : destination_finale « ${destination} » est l'escale elle-même alors qu'un horaire de correspondance est fourni — l'un des deux est faux, à vérifier avant d'appliquer une contrainte de distance`,
      });
    }

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
      // trace d'audit : la lettre RBD est CONSERVEE telle quelle. Elle ne sert jamais de
      // source de tier - la cabine J/W/Y reste obligatoire (voir le dictionnaire de colonnes).
      classe_reservation: norm(row.classe_reservation).toUpperCase(),
      // v2 — identité (C3). Champs ADDITIFS : vides sur une liste v1, aucun module
      // existant ne les lit, seules les fiches du comptoir s'en servent.
      ...identite,
      // v3 — correspondance (§3.3ter). Champs ADDITIFS : vides sur une liste v1 ou v2.
      // `heure_correspondance` est une horloge MURALE, pas un instant : le fuseau dans
      // lequel la lire est dans `correspondance_fuseau`. Voir PAXLIST_CORRESPONDANCE_DERIVEES.
      vol_correspondance: volCorr,
      heure_correspondance: corrRejet ? "" : corr.local,
      heure_correspondance_brute: heureOrigine,
      correspondance_fuseau: corrRejet || !heureBrute ? "" : corr.offset ? "declare" : "escale",
      correspondance_offset: corrRejet ? "" : corr.offset,
      correspondance_utc: corrRejet ? "" : corr.utc,
      correspondance_date_source: corrRejet ? "" : corr.date_source,
      correspondance_rejet: corrRejet,
      /** `age` / `date_naissance` / `type_pax` : d'où vient l'âge retenu, ou "" s'il n'y en a pas. */
      age_source: ageSource,
      /** Colonnes d'identité conservées bien que hors gabarit ISO (pays en clair). */
      identite_hors_format: horsFormat,
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
      if (out_row.heure_correspondance || out_row.correspondance_date_source === "indeterminee") {
        compteurs.correspondance.renseignees += 1;
        if (out_row.correspondance_date_source === "declaree") compteurs.correspondance.dates_declarees += 1;
        if (out_row.correspondance_date_source === "inferee") compteurs.correspondance.dates_inferees += 1;
        if (out_row.correspondance_date_source === "indeterminee") compteurs.correspondance.dates_indeterminees += 1;
      }
      compteurs.fiches.attendues += 1;
      let complete = true;
      for (const col of PAXLIST_IDENTITE) {
        if (out_row[col]) continue;
        compteurs.fiches.manques[col] += 1;
        if (PAXLIST_IDENTITE_ESSENTIELLE.includes(col)) complete = false;
      }
      if (complete) compteurs.fiches.completes += 1;
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
  // Le chambrage PMR n'est PAS déduit : `buildDossiers` apparie les PMR comme des adultes
  // ordinaires. Un WCHC et son accompagnante partagent donc une chambre double tant que la
  // compagnie ne renseigne pas `chambres_demandees`. Ce n'est pas un chiffre faux, mais
  // c'est un chambrage DEVINÉ : il se dit, et il se compte, avant le run.
  const pmrSansChambrage = [...byPnr.values()].filter(
    (pax) => pax.some((p) => p.pmr) && !pax.some((p) => Number.isInteger(p.chambres_demandees) && p.chambres_demandees > 0),
  ).length;
  if (pmrSansChambrage) {
    avert.push({
      code: "pmr_chambrage_devine",
      message:
        `${pmrSansChambrage} dossier(s) PMR sans « chambres_demandees » — chambrage DEVINÉ : ` +
        `l'outil apparie les PMR comme des adultes ordinaires (pas de règle « 1 chambre par PMR »). ` +
        `Pour une chambre individuelle PMR, la compagnie doit renseigner « chambres_demandees ».`,
    });
  }

  // ---- v3 : le chiffre qui compte — sur combien de dossiers un budget de trajet est
  // calculable. Un dossier « sans horaire » n'est pas une anomalie de format : c'est un
  // dossier sur lequel AUCUNE contrainte de distance ne pourra s'appliquer.
  const dossiersPax = [...byPnr.values()].filter((pax) => pax.some((p) => p.categorie === "PAX" && p.statut_pax === "A_LOGER"));
  const aHoraire = (p) =>
    p.categorie === "PAX" && p.statut_pax === "A_LOGER" &&
    (p.heure_correspondance !== "" || p.correspondance_date_source === "indeterminee");
  const sansHoraire = dossiersPax.filter((pax) => !pax.some(aHoraire)).length;
  compteurs.correspondance.dossiers = dossiersPax.length;
  compteurs.correspondance.dossiers_sans_horaire = sansHoraire;
  if (sansHoraire) {
    const colonneAbsente = !presentes.has("heure_correspondance");
    avert.push({
      code: "correspondance_absente",
      message:
        `${sansHoraire} dossier(s) sur ${dossiersPax.length} sans horaire de correspondance` +
        (colonneAbsente ? " (colonne « heure_correspondance » absente du fichier)" : "") +
        " : leur budget de trajet ne peut pas être calculé, aucune contrainte de distance ne s'appliquera — " +
        "ces dossiers peuvent être logés dans n'importe quelle couronne, y compris la plus lointaine",
    });
  }
  if (corrInferees) {
    avert.push({
      code: "correspondance_date_inferee",
      message:
        `${corrInferees} horaire(s) de correspondance donné(s) en HH:MM seul : la DATE A ÉTÉ INFÉRÉE — ` +
        `première occurrence de cette heure strictement postérieure à l'arrivée à l'escale (${refEscale}` +
        `${escaleTz ? `, heure locale ${escaleTz}` : ""}). Un vol à 05:40 après un déroutement de nuit est daté du LENDEMAIN. ` +
        "À vérifier : une date inférée à tort décale le budget de trajet de 24 h",
    });
  }
  if (corrIndeterminees) {
    avert.push({
      code: "correspondance_date_indeterminee",
      message:
        `${corrIndeterminees} horaire(s) de correspondance donné(s) en HH:MM seul SANS heure d'arrivée à l'escale : ` +
        "la date n'a pas été devinée. L'heure brute est conservée (heure_correspondance_brute) et " +
        "correspondance_date_source vaut « indeterminee » — c'est à l'appelant de la dater sur l'arrivée du vol dérouté, " +
        "sans quoi aucun budget de trajet n'est calculable",
    });
  }
  if (corrSansFuseau && !escaleTz) {
    avert.push({
      code: "correspondance_fuseau",
      message:
        `${corrSansFuseau} horaire(s) de correspondance sans fuseau, et le fuseau de l'escale n'a pas été fourni à l'ingestion : ` +
        "ces heures sont des horloges MURALES D'ESCALE (correspondance_fuseau = « escale »), jamais l'horloge du serveur — " +
        "l'appelant doit les lire dans station.timezone",
    });
  }
  if (corrNonComparables) {
    avert.push({
      code: "correspondance_non_comparable",
      message:
        `${corrNonComparables} horaire(s) portent un fuseau explicite alors que le décalage UTC de l'escale n'a pas été fourni ` +
        `(opts.escale.offset_min) : les contrôles « antérieur à l'arrivée » et « au-delà de ${CORRESPONDANCE_MAX_H} h » ` +
        "n'ont PAS pu être faits sur ces lignes",
    });
  }

  const ratio = byPnr.size ? out.length / byPnr.size : 0;
  if (ratio > 6) avert.push({ code: "ratio", message: `${out.length} passagers pour ${byPnr.size} dossiers (ratio ${ratio.toFixed(1)}) — la colonne PNR est-elle la bonne ?` });

  if (ssrSansEffet.size) avert.push({ code: "ssr_sans_effet", message: `SSR reconnus sans effet sur la chambre : ${[...ssrSansEffet].map(([c, n]) => `${c} ×${n}`).join(", ")}` });
  if (ssrInconnus.size) avert.push({ code: "ssr_inconnu", message: `SSR inconnus, conservés sans effet : ${[...ssrInconnus].map(([c, n]) => `${c} ×${n}`).join(", ")}` });
  if (compteurs.animaux) avert.push({ code: "animaux", message: `${compteurs.animaux} dossier(s) avec animal (PETC/AVIH) : aucun critère « animaux acceptés » n'existe dans l'inventaire — à confirmer hôtel par hôtel` });
  // C3 — un chiffre, pas une impression : combien de fiches partiront au comptoir avec
  // des blancs, et lesquels. Une liste v1 tombe entièrement ici, c'est normal et dit.
  const f = compteurs.fiches;
  const incompletes = f.attendues - f.completes;
  if (incompletes > 0) {
    const detail = PAXLIST_IDENTITE_ESSENTIELLE
      .filter((c) => f.manques[c] > 0)
      .map((c) => `${c} absent sur ${f.manques[c]}`)
      .join(", ");
    avert.push({
      code: "fiches_incompletes",
      message:
        `${incompletes} fiche(s) sur ${f.attendues} seront incomplètes : ${detail} — ` +
        "les formulaires d'enregistrement partiront avec ces champs en blanc, à remplir passeport en main au comptoir. " +
        `Colonnes à demander à la compagnie : ${PAXLIST_IDENTITE_ESSENTIELLE.join(", ")} (optionnelles, mais c'est le temps d'escale qui les paie)`,
    });
  }
  const identiteFournies = PAXLIST_IDENTITE.filter((c) => presentes.has(c));
  if (identiteFournies.length && incompletes > 0) {
    avert.push({
      code: "identite_partielle",
      message: `colonnes d'identité fournies : ${identiteFournies.join(", ")} — mais toutes les lignes ne sont pas renseignées (voir le détail ci-dessus)`,
    });
  }
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
 * @param {Buffer|string|Array<object>} input
 * @param {object} [opts] `colonnesPresentes` (entrée déjà lue) ; `now` = date de
 *   référence des âges déduits et de la péremption des passeports ; `escale` =
 *   `{code, timezone, arrivee_locale, offset_min}` (v3, facultatif — voir
 *   `normalizePaxRows`). Sans `escale`, le comportement est celui d'avant la v3.
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
  const { rows: normalized, rapport } = normalizePaxRows(rows, { colonnesPresentes, now: opts.now, escale: opts.escale });
  rapport.fichier = fichier;
  rapport.avertissements = [...warnings, ...rapport.avertissements];
  // Une colonne que la compagnie a pris la peine de fournir et que l'outil ne connaît
  // pas ne doit plus disparaître dans une ligne de rapport : si elle porte une identité
  // ou un contact, c'est une fiche remplie de moins, et l'escale doit pouvoir le dire.
  if (fichier?.colonnes_ignorees?.length) {
    rapport.avertissements.push({
      code: "colonnes_ignorees",
      message: `${fichier.colonnes_ignorees.length} colonne(s) du fichier ne sont pas reconnues et n'ont servi à rien : ${fichier.colonnes_ignorees.join(", ")} — si l'une d'elles porte une donnée utile (identité, contact), signalez-la : le format sait l'absorber par alias`,
    });
  }
  // Un en-tête d'horaire ambigu (`STD`, `ETD`…) est accepté, jamais silencieux : l'opérateur
  // doit confirmer que la colonne porte bien le vol SUIVANT et non le vol dérouté.
  const ambigus = (fichier?.alias_appliques ?? [])
    .filter((a) => a.endsWith("→ heure_correspondance"))
    .map((a) => a.split("→")[0].trim())
    .filter((h) => ENTETES_HORAIRE_AMBIGUS.has(slugHeader(h)));
  if (ambigus.length) {
    rapport.avertissements.push({
      code: "correspondance_entete_ambigue",
      message:
        `en-tête « ${ambigus.join(" », « ")} » lu comme heure_correspondance : ce nom ne dit pas DE QUEL VOL ` +
        "il s'agit. CONFIRMEZ qu'il porte le départ du vol SUIVANT et non celui du vol dérouté — " +
        "se tromper de vol fabrique un budget de trajet faux sans que rien ne le montre",
    });
  }
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
  if (c.fiches) {
    out.push(`  fiches d'enregistrement : ${c.fiches.completes}/${c.fiches.attendues} complètes (identité fournie) — les autres partent avec des blancs à remplir au comptoir`);
  }
  if (c.correspondance) {
    const k = c.correspondance;
    out.push(
      `  correspondances : ${k.renseignees} ligne(s) à loger porteuses d'un horaire — dates déclarées ${k.dates_declarees}, inférées ${k.dates_inferees}, indéterminées ${k.dates_indeterminees}, écartées ${k.ecartees}`,
    );
    out.push(
      `  budget de trajet : ${k.dossiers - k.dossiers_sans_horaire}/${k.dossiers} dossier(s) À LOGER calculables — ${k.dossiers_sans_horaire} sans horaire, donc sans aucune contrainte de distance`,
    );
  }
  const exclus = Object.entries(c.exclus).map(([k, n]) => `${k} ${n}`).join(", ");
  if (exclus) out.push(`  exclus (non logés) : ${exclus}`);
  if (rapport.alias_valeurs.length) out.push(`Valeurs traduites : ${rapport.alias_valeurs.join(" · ")}`);
  if (rapport.avertissements.length) {
    out.push(`Avertissements (${rapport.avertissements.length}) :`);
    for (const a of rapport.avertissements) out.push(`  - ${a.message}`);
  }
  return out.join("\n");
}
