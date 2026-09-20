/**
 * Regroupement des passagers par dossier (PNR), files de service et budget de trajet.
 *
 * La CABINE reste le tier de la politique (J/W/Y) ; PMR et famille restent des overlays
 * cumulables qui ajoutent des contraintes sans changer le tier (EX-POL-2).
 *
 * Ce que ce module fait DEPUIS le 21/09/2026, et qu'il ne faisait pas avant :
 *
 *  1. LA FILE DE SERVICE VIENT DES CASES A COCHER. Jusqu'ici, trois files seulement
 *     existaient (`pmr`, `famille`, cabine) et `policy.global.priorities` ne faisait que
 *     les reordonner : saisir « correspondance » dans le champ de l'interface n'avait
 *     AUCUN effet. La file d'un dossier est desormais le critere ACTIF de plus petit
 *     `rang` qu'il satisfait, parmi `policy.global.prise_en_charge.criteres`. Un critere
 *     `departage: true` (Flying Blue) ne cree jamais de file : il ne joue qu'a l'interieur
 *     d'une file, comme aujourd'hui.
 *
 *  2. LE BUDGET DE TRAJET (`dossier.trajet_max_min`) EST UNE CONTRAINTE DURE. Un rang
 *     seul ne protege personne : si les PMR sont servis d'abord et epuisent le vivier
 *     proche, le passager qui repart a 05h40 finit a 40 km et manque son vol. Le budget
 *     se calcule sur l'heure du vol suivant ; aucun rang ne permet de l'outrepasser.
 *
 * REGLE DU PROJET : rien n'est estime. Un dossier sans heure de correspondance n'a PAS de
 * budget par defaut (`trajet_max_min = null`, aucune contrainte) ; une heure illisible
 * produit un avertissement nomme, jamais un chiffre de remplacement. Les temps de trajet
 * des couronnes, eux, sont DECLARES par l'exploitation (voir `couronnesDe` dans
 * `lib/stations.mjs`) : ce module ne convertit jamais une distance en duree.
 *
 * INV-5 : rien de ce module ne part vers un agent.
 */

import { paxIsPmr, paxEscalade, paxAnimal, parseSsr, ssrNotes, CORRESPONDANCE_MAX_H } from "./paxlist.mjs";
import { CRITERE_KEYS, CRITERE_LABELS } from "./policy.mjs";

const FB_RANK = { PLATINUM: 3, GOLD: 2, SILVER: 1, NONE: 0 };
const CABIN_RANK = { J: 2, W: 1, Y: 0 };
const DROIT_RANK = { NON: 2, INCONNU: 1, OUI: 0 };

/** File de repli : le dossier ne satisfait AUCUN critere actif — il est servi en dernier,
 * mais il est servi. Une file nommee vaut mieux qu'un dossier qui disparait du compte. */
export const FILE_REPLI = "sans_critere";
export const FILE_REPLI_LABEL = "aucun critère coché ne s'applique";
/** Rang de la file de repli : au-dela du rang maximal d'un critere (99). */
const RANG_REPLI = 100;

/** Motif d'escalade nominative pour un dossier dont l'hotel n'a plus de sens. */
export const ESCALADE_CORRESPONDANCE = "correspondance trop serrée";

/** SSR qui declenchent le critere `medical` (le meme couple que l'escalade nominative). */
const MEDICAL_SSR = new Set(["STCR", "MEDA"]);
/** SSR de mineur non accompagne. */
const MINEUR_SSR = new Set(["UMNR", "UNN"]);

/* ------------------------------------------------------- horodatage (fuseaux) */

const MS_MIN = 60000;
/** « 2026-09-22T05:40 » ou « 2026-09-22 05:40:00 » — horodatage SANS fuseau. */
const NAIF_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
/** « 05:40 » ou « 5h40 » — heure seule, le jour n'est pas dit. */
const HEURE_SEULE_RE = /^(\d{1,2})[:hH](\d{2})$/;
/**
 * Horodatage ABSOLU : date ISO + heure + decalage explicite (« Z », « +07:00 »). Seule
 * cette forme est confiee a `Date.parse`.
 *
 * Sans ce garde-fou, `Date.parse` accepte en silence des chaines qui ne sont pas des
 * horaires : « 0540 » — precisement la forme que `lib/paxlist.mjs` REFUSE a dessein,
 * parce que rien ne la distingue d'une annee — devenait le 1er janvier de l'an 540, et
 * « 9999 » le 1er janvier 9999, soit un budget de trajet de deux milliards de minutes
 * rendu SANS le moindre avertissement : une cellule fautive se transformait en « aucune
 * contrainte de distance ». Les deux modules refusent desormais les memes formes.
 */
const ABSOLU_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Lit un horodatage sous les formes que la liste compagnie peut porter.
 *
 * Deux cadres coexistent et ne se melangent pas : un horodatage AVEC fuseau (« Z »,
 * « +07:00 ») est un instant absolu ; un horodatage SANS fuseau est une heure murale,
 * comparable seulement a une autre heure murale de la meme escale. L'escale n'etant pas
 * dans le fuseau du serveur, confondre les deux fabrique des heures d'ecart silencieuses.
 *
 * @param {Date|number|string|null} value
 * @returns {{ms?: number, heureSeule?: {h: number, mi: number}, naif: boolean, forme: string}|{invalide: string}|null}
 */
function lireHorodatage(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? { ms: value.getTime(), naif: false, forme: "Date" } : { invalide: "Date invalide" };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ms: value, naif: false, forme: "horodatage epoch" } : { invalide: String(value) };
  }
  const s = String(value).trim();
  if (!s) return null;
  const naif = NAIF_RE.exec(s);
  if (naif) {
    const [, y, mo, d, h, mi, sec] = naif;
    // Date.UTC sert de REPERE ARITHMETIQUE, pas de declaration de fuseau : deux heures
    // murales lues de la meme façon se soustraient correctement.
    return { ms: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0)), naif: true, forme: "date-heure sans fuseau" };
  }
  const heure = HEURE_SEULE_RE.exec(s);
  if (heure) {
    const h = Number(heure[1]);
    const mi = Number(heure[2]);
    if (h > 23 || mi > 59) return { invalide: s };
    return { heureSeule: { h, mi }, naif: true, forme: "heure seule" };
  }
  // `Date.parse` n'est appele que sur une forme VERIFIEE : tout le reste est illisible,
  // jamais interprete au juge (voir ABSOLU_RE).
  if (ABSOLU_RE.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return { ms: t, naif: false, forme: "date-heure avec fuseau" };
  }
  return { invalide: s };
}

/**
 * Cadre de reference du « maintenant » injecte — les DEUX frames a la fois quand
 * l'appelant les connait.
 *
 * `maintenantLocal` (« AAAA-MM-JJTHH:MM ») est l'heure MURALE de l'escale : c'est ce que
 * rend `stationClock()` de `lib/scenario.mjs` (`${date}T${heure}`), et c'est le cadre de
 * `row.heure_correspondance`, qui est une horloge murale d'escale (paxlist v3).
 * `maintenant` (une `Date`) est l'instant absolu : c'est le cadre de
 * `row.correspondance_utc`, qui n'existe que si la compagnie a DECLARE un decalage.
 * Passer les deux evite tout repli. A defaut, l'heure murale du SERVEUR sert de dernier
 * recours, et cela se signale (`correspondance_fuseau`).
 */
function cadreMaintenant(maintenant, maintenantLocal) {
  const lu = lireHorodatage(maintenant);
  const luLocal = lireHorodatage(maintenantLocal);
  const utilisable = (x) => x && !x.invalide && !x.heureSeule;
  const absolu = utilisable(lu) && !lu.naif ? lu.ms : null;
  let naif = null;
  let serveur = false;
  if (utilisable(luLocal) && luLocal.naif) naif = luLocal.ms;
  else if (utilisable(lu) && lu.naif) naif = lu.ms;
  else if (absolu !== null) {
    // heure murale du SERVEUR : repli explicite, signale des qu'il sert
    const d = new Date(absolu);
    naif = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    serveur = true;
  }
  if (naif === null && absolu === null) return null;
  return { naifMs: naif, absoluMs: absolu, serveur };
}

/**
 * Minutes entre `maintenant` et l'horodatage cible, ou null si les deux cadres ne sont
 * pas comparables honnetement.
 * @returns {{minutes: number|null, avertissement: {code: string, message: string}|null, heureSeule: boolean}}
 */
function minutesJusqua(cible, cadre, { pnr = "" } = {}) {
  const ref = pnr ? `dossier ${pnr} : ` : "";
  if (cible.heureSeule) {
    if (cadre.naifMs === null) return { minutes: null, avertissement: null, heureSeule: true };
    const base = new Date(cadre.naifMs);
    let visee = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), cible.heureSeule.h, cible.heureSeule.mi, 0);
    if (visee <= cadre.naifMs) visee += 24 * 60 * MS_MIN; // prochaine occurrence
    return {
      minutes: Math.floor((visee - cadre.naifMs) / MS_MIN),
      avertissement: {
        code: "correspondance_heure_seule",
        message: `${ref}heure de correspondance « ${String(cible.heureSeule.h).padStart(2, "0")}:${String(cible.heureSeule.mi).padStart(2, "0")} » sans date — PROCHAINE OCCURRENCE retenue ; faites porter la date par la liste`,
      },
      heureSeule: true,
    };
  }
  if (cible.naif) {
    if (cadre.naifMs === null) return { minutes: null, avertissement: null, heureSeule: false };
    const av = cadre.serveur
      ? {
          code: "correspondance_fuseau",
          message: `${ref}heure de correspondance sans fuseau comparée à l'horloge du SERVEUR — passez « maintenant » en heure murale de l'escale (stationClock) pour un budget juste`,
        }
      : null;
    return { minutes: Math.floor((cible.ms - cadre.naifMs) / MS_MIN), avertissement: av, heureSeule: false };
  }
  if (cadre.absoluMs === null) {
    return {
      minutes: null,
      avertissement: {
        code: "correspondance_fuseau_incomparable",
        message: `${ref}heure de correspondance datée d'un fuseau alors que « maintenant » est une heure murale sans fuseau — aucun budget de trajet calculé (rien n'est estimé)`,
      },
      heureSeule: false,
    };
  }
  return { minutes: Math.floor((cible.ms - cadre.absoluMs) / MS_MIN), avertissement: null, heureSeule: false };
}

/* -------------------------------------------------------- budget de trajet */

/**
 * Budget de trajet d'un dossier, en minutes, depuis l'heure du vol suivant.
 *
 *     fenetre = heure_correspondance − maintenant
 *     utile   = fenetre − avance_avant_vol_min − marge_min − repos_minimal_min
 *     trajet_max_min = floor(utile / 2)        // aller ET retour
 *
 * `trajet_max_min <= 0` : l'hotel n'a pas de sens, le dossier sort en escalade
 * « correspondance trop serrée » (repos cote piste a organiser). Pas d'horaire :
 * `trajet_max_min = null`, AUCUNE contrainte, et le dossier n'est pas « serré » —
 * jamais de budget par defaut.
 *
 * @param {object} args
 * @param {Date|number|string|null} args.heure heure du vol suivant (brute, telle que lue)
 * @param {object|null} args.cadre cadre de `maintenant` (voir `cadreMaintenant`)
 * @param {object} args.correspondance `policy.global.correspondance`
 * @param {string} [args.pnr] pour nommer les avertissements
 * @returns {{trajet_max_min: number|null, fenetre_min: number|null, serree: boolean,
 *   escalade: string|null, explication: object|null, avertissements: Array<{code: string, message: string}>}}
 */
export function calculerBudgetTrajet({ heure, cadre, correspondance, pnr = "" }) {
  const vide = { trajet_max_min: null, fenetre_min: null, serree: false, escalade: null, explication: null, avertissements: [] };
  const lu = lireHorodatage(heure);
  if (!lu) return vide;
  const ref = pnr ? `dossier ${pnr} : ` : "";
  if (lu.invalide) {
    return { ...vide, avertissements: [{ code: "correspondance_illisible", message: `${ref}heure de correspondance « ${lu.invalide} » illisible — aucun budget de trajet calculé (formats admis : AAAA-MM-JJTHH:MM, horodatage avec fuseau, HH:MM)` }] };
  }
  if (!cadre) {
    return {
      ...vide,
      avertissements: [{ code: "correspondance_sans_horloge", message: `${ref}heure de correspondance présente mais l'heure de l'escale n'a pas été fournie à buildDossiers({maintenant}) — AUCUN budget de trajet n'est calculé, les correspondances ne sont pas protégées` }],
    };
  }

  const { minutes: fenetre, avertissement } = minutesJusqua(lu, cadre, { pnr });
  const avertissements = avertissement ? [avertissement] : [];
  if (fenetre === null) return { ...vide, avertissements };

  // FENETRE ABERRANTE. `lib/paxlist.mjs` ecarte deja un horaire qui tombe au-dela de
  // CORRESPONDANCE_MAX_H, mais ce controle ne tourne QUE si l'appelant lui a fourni
  // `opts.escale.arrivee_locale` — ce que ne fait aucun appelant aujourd'hui. Sans ce
  // garde-fou ici, une annee fautive (« 2029 » pour « 2026 ») produisait un budget de
  // 790 105 minutes AFFICHE TEL QUEL par le dry-run et le rapport : un chiffre rassurant
  // qui n'est pas merite, et surtout un dossier tenu pour NON CONTRAINT alors que son vol
  // part peut-etre dans six heures. On refuse le budget et on nomme la faute, au lieu de
  // publier un nombre absurde.
  if (fenetre > CORRESPONDANCE_MAX_H * 60) {
    return {
      ...vide,
      avertissements: [
        ...avertissements,
        {
          code: "correspondance_lointaine",
          message: `${ref}heure de correspondance à ${Math.round(fenetre / 60)} h de « maintenant », au-delà de ${CORRESPONDANCE_MAX_H} h — horaire écarté comme aberrant (année ou date de saisie erronée) ; AUCUN budget de trajet, le dossier n'est PAS réputé libre de s'éloigner, l'horaire est à corriger`,
        },
      ],
    };
  }

  const avance = correspondance?.avance_avant_vol_min ?? 0;
  const marge = correspondance?.marge_min ?? 0;
  const repos = correspondance?.repos_minimal_min ?? 0;
  const seuil = correspondance?.seuil_serree_min ?? 0;
  const utile = fenetre - avance - marge - repos;
  const trajet = Math.floor(utile / 2);
  const serree = fenetre <= seuil;
  const escalade = trajet <= 0 ? ESCALADE_CORRESPONDANCE : null;

  if (fenetre <= 0) {
    avertissements.push({ code: "correspondance_passee", message: `${ref}heure de correspondance déjà passée au regard de « maintenant » (${fenetre} min) — dossier en escalade, l'heure ou l'horloge de l'escale est à vérifier` });
  }

  const texte =
    `fenêtre ${fenetre} min jusqu'au vol suivant − ${avance} min de présentation − ${marge} min de marge − ${repos} min de repos = ${utile} min utiles` +
    (trajet > 0 ? ` ; aller ET retour → ${trajet} min de trajet au maximum` : ` ; aucun trajet possible → ${ESCALADE_CORRESPONDANCE}`);

  return {
    trajet_max_min: trajet,
    fenetre_min: fenetre,
    serree,
    escalade,
    /** De quoi contester le chiffre au comptoir : chaque terme retranché est nommé. */
    explication: {
      fenetre_min: fenetre,
      avance_avant_vol_min: avance,
      marge_min: marge,
      repos_minimal_min: repos,
      utile_min: utile,
      trajet_max_min: trajet,
      seuil_serree_min: seuil,
      texte,
    },
    avertissements,
  };
}

/* ------------------------------------------------------------- les criteres */

/**
 * Predicats des 13 criteres cochables. Chacun repond sur le dossier DEJA construit.
 *
 * `bebe` : un INF le declenche toujours ; un CHD le declenche seulement si son age est
 * DECLARE et inferieur ou egal a `age_bas_max`. Un CHD sans age declare n'est PAS presume
 * en bas age — presumer ferait passer devant des dossiers qui n'y ont peut-etre pas droit,
 * et surtout, sous une proximite « preferee », ferait consommer le vivier proche par des
 * dossiers qui ne sont pas contraints. Le choix est chiffre : voir l'avertissement
 * `bebe_age_absent`, qui dit combien de dossiers changeraient de file dans l'autre sens.
 *
 * `sans_droit_entree` : « NON » seulement. « INCONNU » n'est pas un refus (c'est la regle
 * de `allocate.mjs`, ou le dossier reste dans le plan sous reserve).
 */
export const CRITERE_PREDICATS = Object.freeze({
  correspondance_serree: (d) => d.correspondance?.serree === true,
  medical: (d) => (d.ssr ?? []).some((c) => MEDICAL_SSR.has(c)),
  pmr: (d) => d.overlays.pmr === true,
  mineur_seul: (d) => d.mineurSeul === true || (d.ssr ?? []).some((c) => MINEUR_SSR.has(c)),
  bebe: (d, ctx) => d.infants > 0 || (d.agesEnfants ?? []).some((a) => a <= (ctx?.ageBasMax ?? 6)),
  famille: (d) => d.overlays.famille === true,
  equipage: (d) => d.equipage === true,
  J: (d) => d.cabin === "J",
  W: (d) => d.cabin === "W",
  Y: (d) => d.cabin === "Y",
  groupe: (d) => d.overlays.groupe === true,
  sans_droit_entree: (d) => d.droitEntree === "NON",
  flying_blue: (d) => FB_RANK[d.fb] > 0,
});

/**
 * Le dossier satisfait-il ce critere ?
 * @param {string} cle une des `CRITERE_KEYS`
 * @param {object} dossier dossier construit
 * @param {{ageBasMax?: number}} [ctx]
 * @returns {boolean} false pour une cle inconnue (jamais une exception)
 */
export function satisfaitCritere(cle, dossier, ctx = {}) {
  const p = CRITERE_PREDICATS[cle];
  return p ? Boolean(p(dossier, ctx)) : false;
}

/** Valeur de departage : graduee pour Flying Blue (PLATINUM > GOLD > SILVER), binaire sinon. */
function scoreDepartage(cle, d, ctx) {
  if (cle === "flying_blue") return FB_RANK[d.fb] ?? 0;
  return satisfaitCritere(cle, d, ctx) ? 1 : 0;
}

/** Criteres actifs, tries par rang croissant (puis ordre de `CRITERE_KEYS`, a rang egal). */
function criteresActifs(criteres) {
  const ordreCle = new Map(CRITERE_KEYS.map((k, i) => [k, i]));
  return criteres
    .filter((c) => c && c.actif !== false && ordreCle.has(c.cle))
    .map((c) => ({ cle: c.cle, rang: Number(c.rang) || 99, proximite: c.proximite ?? "aucune", departage: c.departage === true }))
    .sort((a, b) => a.rang - b.rang || ordreCle.get(a.cle) - ordreCle.get(b.cle));
}

/* ---------------------------------------------------------------- dossiers */

/**
 * @param {Array<object>} rows lignes CSV passagers (forme canonique de `lib/paxlist.mjs`)
 * @param {object} policy politique validée (rooming, prise_en_charge, correspondance)
 * @param {object} [opts]
 * @param {Date|string|number|null} [opts.maintenant] HEURE DE L'ESCALE, injectée par
 *   l'appelant — jamais lue sur l'horloge globale. Une chaîne « AAAA-MM-JJTHH:MM » est
 *   l'heure murale de l'escale (`stationClock()` de `lib/scenario.mjs` rend `date` et
 *   `heure` : les concaténer) ; une `Date` est un instant absolu. Absente, aucun budget
 *   de trajet n'est calculé et un avertissement le dit.
 * @param {string} [opts.maintenantLocal] heure murale de l'escale « AAAA-MM-JJTHH:MM »,
 *   à passer EN PLUS d'une `Date` : les deux cadres sont alors connus, celui de
 *   `heure_correspondance` (horloge murale) comme celui de `correspondance_utc` (instant).
 * @returns {Array<object>} dossiers triés dans l'ordre de service ; la propriété NON
 *   ÉNUMÉRABLE `avertissements` (voir `avertissementsDe`) porte ce qui doit être dit.
 */
export function buildDossiers(rows, policy, opts = {}) {
  const rooming = policy.global.rooming;
  const priseEnCharge = policy.global.prise_en_charge ?? null;
  const correspondanceCfg = policy.global.correspondance ?? null;
  const ageBasMax = priseEnCharge?.age_bas_max ?? 6;
  const ctx = { ageBasMax };
  const avert = [];
  const cadre = cadreMaintenant(opts.maintenant ?? null, opts.maintenantLocal ?? null);
  const fourni = (v) => v !== undefined && v !== null && v !== "";
  if ((fourni(opts.maintenant) || fourni(opts.maintenantLocal)) && !cadre) {
    avert.push({ code: "maintenant_illisible", message: `« maintenant » illisible (${String(opts.maintenant ?? opts.maintenantLocal)}) — aucun budget de trajet calculé` });
  }

  const byPnr = new Map();
  for (const r of rows) {
    if (!byPnr.has(r.pnr)) byPnr.set(r.pnr, []);
    byPnr.get(r.pnr).push(r);
  }

  const dossiers = [];
  const vus = new Map(); // code d'avertissement -> nombre de dossiers concernés
  const compteAvert = (code) => vus.set(code, (vus.get(code) ?? 0) + 1);

  for (const [pnr, pax] of byPnr) {
    const adults = pax.filter((p) => p.type_pax === "ADT").length;
    const children = pax.filter((p) => p.type_pax === "CHD").length;
    const infants = pax.filter((p) => p.type_pax === "INF").length;
    // PMR : tout code SSR d'assistance déclencheur (WCHR/WCHS/WCHC/WCBD/WCBW/WCMP/BLND/DEAF/DPNA),
    // pas le seul littéral « WCHR » — voir lib/paxlist.mjs
    const pmr = pax.some(paxIsPmr);
    const cabin = pax.reduce((m, p) => (CABIN_RANK[p.cabine] > CABIN_RANK[m] ? p.cabine : m), "Y");
    const fb = pax.reduce((m, p) => (FB_RANK[p.flying_blue] > FB_RANK[m] ? p.flying_blue : m), "NONE");
    const famille = children + infants > 0;
    const animal = pax.some(paxAnimal);
    const groupe = pax.map((p) => p.groupe).find(Boolean) ?? "";
    // équipage : la catégorie vient de la liste compagnie (PNT/PNC/DEADHEAD). Les lignes
    // d'équipage sont normalement séparées en amont (`splitPaxRows`) ; le critère existe
    // pour l'escale qui loge son équipage dans le même plan.
    const equipage = pax.some((p) => p.categorie && p.categorie !== "PAX");
    // hors plan hôtel : traitement nominatif au desk (civière, médical, mineur non accompagné)
    const ssrEscalade = pax.map(paxEscalade).find(Boolean) ?? null;
    // C3 : un dossier sans aucun adulte n'est pas un dossier d'hôtel, même sans code
    // UMNR sur la liste — il partait jusqu'ici en chambre double, statut OK, sans note.
    // Il suit le MÊME chemin nominatif que STCR/MEDA/UMNR (`escaladeNominative`).
    // Option absente d'une politique incomplète : on protège, on ne suppose pas.
    const mineurSeul = adults === 0 && children + infants > 0;
    const escaladeBase = ssrEscalade ?? (mineurSeul && rooming.minor_alone_escalates !== false ? "mineur sans adulte" : null);
    // droit d'entrée sur le territoire de l'escale : le plus contraignant du dossier
    const droitEntree = pax.reduce((m, p) => (DROIT_RANK[p.droit_entree] > DROIT_RANK[m] ? p.droit_entree : m), "OUI");
    const ssr = [...new Set(pax.flatMap((p) => p.ssr ?? parseSsr(p.assistance)))];

    // âges DÉCLARÉS des enfants (jamais devinés) + combien n'en portent pas : le critère
    // `bebe` se joue là, et le silence de la liste doit rester visible.
    const agesEnfants = [];
    let enfantsSansAge = 0;
    for (const p of pax) {
      if (p.type_pax !== "CHD") continue;
      const brut = p.age;
      const n = brut === "" || brut === null || brut === undefined ? NaN : Number(brut);
      if (Number.isFinite(n)) agesEnfants.push(n);
      else enfantsSansAge += 1;
    }

    // chambrage : `chambres_demandees` de la liste fait foi (familles nombreuses, groupes,
    // PMR à chambre individuelle) ; sinon unité familiale jusqu'à family_unit_max, sinon
    // 2 chambres même hôtel. Les nourrissons ne consomment pas de capacité.
    // plusieurs valeurs sous un même PNR : on retient le MAXIMUM (ne jamais sous-loger) ;
    // la contradiction est signalée par le rapport d'ingestion
    const demandesPnr = pax.map((p) => Number(p.chambres_demandees)).filter((n) => Number.isInteger(n) && n > 0);
    const demandees = demandesPnr.length ? Math.max(...demandesPnr) : null;
    let rooms;
    let familyUnit = false;
    if (demandees) {
      rooms = demandees;
      familyUnit = demandees === 1 && children > 0;
    } else if (children > 0) {
      const max = rooming.family_unit_max;
      if (adults <= max.adults && children <= max.children) {
        rooms = 1;
        familyUnit = true;
      } else rooms = 2;
    } else rooms = Math.max(1, Math.ceil(adults / 2));

    // correspondance : champs ajoutés à la liste passagers (`vol_correspondance` /
    // `heure_correspondance`). Absents d'une liste qui ne les porte pas — le dossier n'a
    // alors aucun budget, et ce n'est pas une anomalie.
    const volsCorr = [...new Set(pax.map((p) => String(p.vol_correspondance ?? "").trim()).filter(Boolean))];
    const candidats = new Map(); // valeur horaire lue -> libellé affiché
    for (const p of pax) {
      const local = String(p.heure_correspondance ?? "").trim();
      // l'INSTANT déclaré par la compagnie prime sur l'horloge murale : c'est le seul cas
      // où le fuseau du vol suivant est connu (paxlist v3, `correspondance_offset`)
      const utc = String(p.correspondance_utc ?? "").trim();
      const valeur = utc || local;
      if (valeur) {
        candidats.set(valeur, local || utc);
        continue;
      }
      if (p.correspondance_rejet) compteAvert("correspondance_rejetee_ingestion");
      else if (p.correspondance_date_source === "indeterminee") {
        // l'ingestion a refusé de DATER un « HH:MM » seul faute de référence ; ici, la
        // référence existe (« maintenant » de l'escale), donc on la date — et on le dit.
        const brute = String(p.heure_correspondance_brute ?? "").trim();
        const lu = lireHorodatage(brute);
        if (lu?.heureSeule) candidats.set(brute, brute);
        else compteAvert("correspondance_date_indeterminee");
      }
    }

    // plusieurs correspondances sous un même PNR : la PLUS CONTRAIGNANTE s'applique à tout
    // le dossier (il voyage ensemble) — jamais la plus confortable. Comparer des budgets
    // plutôt que des horaires évite de mélanger un instant absolu et une horloge murale.
    let heureRetenue = null;
    let budget = { trajet_max_min: null, fenetre_min: null, serree: false, escalade: null, explication: null, avertissements: [] };
    if (candidats.size) {
      const calcules = [...candidats.entries()].map(([valeur, affiche]) => ({ affiche, b: calculerBudgetTrajet({ heure: valeur, cadre, correspondance: correspondanceCfg, pnr }) }));
      const chiffres = calcules.filter((x) => x.b.trajet_max_min !== null);
      const retenu = chiffres.length ? chiffres.reduce((m, x) => (x.b.trajet_max_min < m.b.trajet_max_min ? x : m)) : calcules[0];
      heureRetenue = retenu.affiche;
      budget = retenu.b;
      // les avertissements des autres candidats (illisible, fuseau) ne se perdent pas
      for (const x of calcules) if (x !== retenu) budget.avertissements.push(...x.b.avertissements);
      if (candidats.size > 1) {
        avert.push({
          code: "correspondance_contradictoire",
          message: `dossier ${pnr} : heures de correspondance différentes (${[...candidats.values()].join(", ")}) — la plus contraignante est retenue (${heureRetenue}), le dossier voyage ensemble`,
        });
      }
    }
    for (const a of budget.avertissements) {
      // un avertissement de cadre (fuseau, horloge absente) se répète à chaque dossier :
      // on le dit UNE fois, avec le nombre de dossiers concernés à la fin.
      if (a.code === "correspondance_sans_horloge" || a.code === "correspondance_fuseau" || a.code === "correspondance_fuseau_incomparable" || a.code === "correspondance_heure_seule") compteAvert(a.code);
      else avert.push(a);
    }
    const escaladeNominative = escaladeBase ?? budget.escalade;

    dossiers.push({
      pnr,
      occupants: pax.map((p) => `${p.prenom} ${p.nom}${p.type_pax !== "ADT" ? ` (${p.type_pax})` : ""}`).join(", "),
      adults,
      children,
      infants,
      cabin,
      fb,
      overlays: { pmr, famille, groupe: Boolean(groupe), animal },
      familyUnit,
      rooms,
      roomsSource: demandees ? "liste" : "calcul",
      groupe,
      escaladeNominative,
      mineurSeul,
      droitEntree,
      ssrNotes: ssrNotes(ssr),
      /** Codes SSR du dossier (additif) : les prédicats `medical` et `mineur_seul` les lisent. */
      ssr,
      /** Équipage (catégorie PNT/PNC/DEADHEAD sur au moins une ligne). */
      equipage,
      /** Âges DÉCLARÉS des enfants, et combien n'en portent aucun (critère `bebe`). */
      agesEnfants,
      enfantsSansAge,
      /** Vol suivant et budget de trajet — `trajet_max_min` est une CONTRAINTE DURE. */
      volCorrespondance: volsCorr[0] ?? "",
      heureCorrespondance: heureRetenue ?? "",
      trajet_max_min: budget.trajet_max_min,
      correspondanceSerree: budget.serree,
      correspondance: {
        vol: volsCorr[0] ?? "",
        heure: heureRetenue ?? "",
        fenetre_min: budget.fenetre_min,
        trajet_max_min: budget.trajet_max_min,
        serree: budget.serree,
        escalade: budget.escalade,
        explication: budget.explication,
      },
    });
  }

  for (const [code, n] of vus) {
    const texte = {
      correspondance_sans_horloge: `${n} dossier(s) portent une heure de correspondance mais « maintenant » n'a pas été fourni à buildDossiers — AUCUN budget de trajet n'est calculé, les correspondances ne sont PAS protégées`,
      correspondance_fuseau: `${n} dossier(s) : heure de correspondance sans fuseau comparée à l'horloge du SERVEUR — passez « maintenant » en heure murale de l'escale (stationClock)`,
      correspondance_fuseau_incomparable: `${n} dossier(s) : heure de correspondance datée d'un fuseau alors que « maintenant » est une heure murale — aucun budget calculé (rien n'est estimé)`,
      correspondance_heure_seule: `${n} dossier(s) : heure de correspondance sans date — PROCHAINE OCCURRENCE retenue, à confirmer`,
      correspondance_rejetee_ingestion: `${n} ligne(s) portent une heure de correspondance ÉCARTÉE à l'ingestion (voir le rapport d'ingestion) — aucun budget de trajet, aucune contrainte de distance pour ces dossiers`,
      correspondance_date_indeterminee: `${n} ligne(s) : heure de correspondance dont la date reste indéterminée et illisible en l'état — aucun budget de trajet calculé`,
    }[code];
    if (texte) avert.push({ code, message: texte });
  }

  /* ------------------------------------------------ files et ordre de service */

  const criteresBruts = Array.isArray(priseEnCharge?.criteres) ? priseEnCharge.criteres : [];
  const modeCriteres = criteresBruts.length > 0;
  const actifs = modeCriteres ? criteresActifs(criteresBruts) : [];
  const filesCriteres = actifs.filter((c) => !c.departage);
  const departages = actifs.filter((c) => c.departage);

  // `priorities` est DÉPRÉCIÉ : une valeur qui ne correspond à aucun critère ne pilotait
  // déjà rien (les trois seules files étaient pmr/famille/cabine). On le DIT.
  const priorities = Array.isArray(policy.global.priorities) ? policy.global.priorities : [];
  const inconnues = priorities.filter((p) => !CRITERE_KEYS.includes(p));
  if (inconnues.length) {
    avert.push({
      code: "priorities_sans_critere",
      message: `politique enregistrée : « ${inconnues.join(", ")} » dans global.priorities ne correspond à aucun critère de prise en charge — sans effet${modeCriteres ? " (la file vient désormais des cases à cocher)" : " (les seules files de l'ancien mécanisme sont pmr, famille, J, W, Y)"} ; cochez le critère correspondant`,
    });
  }

  if (modeCriteres && !filesCriteres.length) {
    avert.push({
      code: "criteres_tous_inactifs",
      message: `aucun critère de file actif dans la politique de prise en charge — tous les dossiers partent en file « ${FILE_REPLI} » (${FILE_REPLI_LABEL}), l'ordre se joue sur les seuls départages`,
    });
  }
  if (!modeCriteres) {
    avert.push({
      code: "criteres_absents",
      message: "politique sans « prise_en_charge.criteres » (enregistrée avant le 21/09/2026) — ancien comportement conservé : files pmr → famille → cabine, aucune protection de correspondance",
    });
  }

  if (modeCriteres) {
    const rangDe = new Map(filesCriteres.map((c, i) => [c.cle, { rang: c.rang, ordre: i, proximite: c.proximite }]));
    for (const d of dossiers) {
      const satisfaits = actifs.filter((c) => satisfaitCritere(c.cle, d, ctx)).map((c) => c.cle);
      const file = filesCriteres.find((c) => satisfaits.includes(c.cle)) ?? null;
      d.criteres = satisfaits;
      d.file = file ? file.cle : FILE_REPLI;
      d.fileLabel = file ? CRITERE_LABELS[file.cle] ?? file.cle : FILE_REPLI_LABEL;
      d.fileRang = file ? rangDe.get(file.cle).rang : RANG_REPLI;
      d._ordreFile = file ? rangDe.get(file.cle).ordre : RANG_REPLI;
      /** Droit aux couronnes proches, hérité du critère de file (`stricte`/`preferee`/`aucune`). */
      d.proximite = file ? file.proximite : "aucune";
    }
    dossiers.sort((a, b) => {
      if (a._ordreFile !== b._ordreFile) return a._ordreFile - b._ordreFile;
      for (const c of departages) {
        const sa = scoreDepartage(c.cle, a, ctx);
        const sb = scoreDepartage(c.cle, b, ctx);
        if (sa !== sb) return sb - sa;
      }
      return b.adults + b.children - (a.adults + a.children);
    });
    for (const d of dossiers) delete d._ordreFile;
  } else {
    // ANCIEN COMPORTEMENT, à l'identique : file pmr → famille → J → W → Y (ordre de
    // policy.global.priorities) ; intra-file : Flying Blue décroissant puis taille du
    // dossier décroissante.
    const fileOf = (d) => (d.overlays.pmr ? "pmr" : d.overlays.famille ? "famille" : d.cabin);
    dossiers.sort((a, b) => {
      const fa = priorities.indexOf(fileOf(a));
      const fb2 = priorities.indexOf(fileOf(b));
      if (fa !== fb2) return fa - fb2;
      if (FB_RANK[b.fb] !== FB_RANK[a.fb]) return FB_RANK[b.fb] - FB_RANK[a.fb];
      return b.adults + b.children - (a.adults + a.children);
    });
    for (const d of dossiers) {
      d.file = fileOf(d);
      d.fileLabel = CRITERE_LABELS[d.file] ?? d.file;
      d.fileRang = Math.max(0, priorities.indexOf(d.file)) + 1;
      // INFORMATIF seulement : aucune case n'est cochée, donc aucun critère ne pilote
      // l'ordre. On relève quand même ce que le dossier satisfait pour que `parCritere`
      // reste lisible (un PMR reste un PMR, même sous une politique de 2026-09-20).
      d.criteres = CRITERE_KEYS.filter((cle) => satisfaitCritere(cle, d, ctx));
      d.proximite = "aucune";
    }
  }

  // effet CHIFFRÉ du choix « un CHD sans âge déclaré n'est pas présumé en bas âge »
  const bebeActif = filesCriteres.find((c) => c.cle === "bebe") ?? null;
  if (bebeActif) {
    const bascules = dossiers.filter((d) => d.enfantsSansAge > 0 && !satisfaitCritere("bebe", d, ctx) && d.fileRang > bebeActif.rang).length;
    if (bascules) {
      avert.push({
        code: "bebe_age_absent",
        message: `${bascules} dossier(s) avec enfant SANS âge déclaré passeraient en file « bebe » si l'âge était présumé — il ne l'est pas (rien n'est estimé) ; faites porter la colonne « age » ou « date_naissance » par la liste`,
      });
    }
  }

  const escaladesCorr = dossiers.filter((d) => d.correspondance.escalade).length;
  if (escaladesCorr) {
    avert.push({
      code: "correspondance_escalade",
      message: `${escaladesCorr} dossier(s) en « ${ESCALADE_CORRESPONDANCE} » : le temps utile à l'hôtel est nul ou négatif — repos côté piste à organiser au desk`,
    });
  }

  // avertissements portés par le tableau, sans le polluer (JSON, longueur, itérations)
  Object.defineProperty(dossiers, "avertissements", { value: avert, enumerable: false, configurable: true, writable: true });
  return dossiers;
}

/**
 * Avertissements attachés par `buildDossiers` (jamais une exception, jamais null).
 * @param {Array<object>} dossiers
 * @returns {Array<{code: string, message: string}>}
 */
export function avertissementsDe(dossiers) {
  return dossiers?.avertissements ?? [];
}

/* ------------------------------------------------------------------ besoins */

const seau = () => ({ dossiers: 0, chambres: 0, personnes: 0, pax: 0 });
const ajoute = (b, d, personnes, pax) => {
  b.dossiers += 1;
  b.chambres += d.rooms;
  b.personnes += personnes;
  b.pax += pax;
};

/**
 * Besoins agrégés en chambres, par file de service, par tier, par critère et par
 * CONTRAINTE DE TRAJET.
 *
 * C2 : le besoin se compte aussi en PERSONNES (`personnes` hors nourrissons, `pax`
 * tout compris) — le nombre de dossiers ne dit pas combien de passagers dorment.
 *
 * `parTrajet` est ce qui permet à la découverte de savoir QUELLE couronne ouvrir et POUR
 * COMBIEN DE MONDE : `contraint` compte les chambres qui doivent tenir dans un budget,
 * `libre` celles qu'aucun horaire ne contraint, `impossible` celles qui n'ont plus rien à
 * faire à l'hôtel. `paliers` donne, pour chaque budget distinct croissant, le cumul des
 * chambres dont le budget lui est inférieur ou égal.
 *
 * `parCritere` compte chaque critère SATISFAIT (pas seulement celui qui a donné la file) :
 * un PMR servi en file « correspondance_serree » reste un PMR, et l'inventaire doit
 * toujours lui trouver une chambre accessible.
 *
 * @returns {{parFile: object, parTier: object, parCritere: object, parTrajet: object, total: object}}
 */
export function computeNeeds(dossiers) {
  const parFile = {};
  const parTier = {};
  const parCritere = {};
  const parTrajet = { contraint: seau(), libre: seau(), impossible: seau(), paliers: [] };
  const paliersMap = new Map();
  const total = {
    dossiers: 0, chambres: 0, personnes: 0, pax: 0, mineursSeuls: 0,
    /** additifs : ce que la correspondance change au plan */
    avecCorrespondance: 0, serrees: 0, contraints: 0, escaladesCorrespondance: 0,
    trajetMinContraint: null,
  };
  for (const d of dossiers) {
    const personnes = d.adults + d.children; // les nourrissons ne consomment pas de capacité
    const pax = personnes + d.infants;
    for (const bucket of [(parFile[d.file] ??= seau()), (parTier[d.cabin] ??= seau())]) ajoute(bucket, d, personnes, pax);
    for (const cle of d.criteres ?? []) ajoute((parCritere[cle] ??= seau()), d, personnes, pax);

    const budget = d.trajet_max_min;
    if (budget === null || budget === undefined) ajoute(parTrajet.libre, d, personnes, pax);
    else if (budget <= 0) ajoute(parTrajet.impossible, d, personnes, pax);
    else {
      ajoute(parTrajet.contraint, d, personnes, pax);
      ajoute((paliersMap.get(budget) ?? paliersMap.set(budget, seau()).get(budget)), d, personnes, pax);
      total.trajetMinContraint = total.trajetMinContraint === null ? budget : Math.min(total.trajetMinContraint, budget);
    }

    total.dossiers += 1;
    total.chambres += d.rooms;
    total.personnes += personnes;
    total.pax += pax;
    if (d.mineurSeul) total.mineursSeuls += 1;
    if (d.correspondance?.heure) total.avecCorrespondance += 1;
    if (d.correspondanceSerree) total.serrees += 1;
    if (typeof budget === "number" && budget > 0) total.contraints += 1;
    if (d.correspondance?.escalade) total.escaladesCorrespondance += 1;
  }

  // paliers croissants + cumul : « combien de chambres doivent tenir sous X minutes »
  const cumul = seau();
  for (const trajet of [...paliersMap.keys()].sort((a, b) => a - b)) {
    const b = paliersMap.get(trajet);
    cumul.dossiers += b.dossiers;
    cumul.chambres += b.chambres;
    cumul.personnes += b.personnes;
    cumul.pax += b.pax;
    parTrajet.paliers.push({ trajet_max_min: trajet, ...b, cumul: { ...cumul } });
  }
  return { parFile, parTier, parCritere, parTrajet, total };
}

/**
 * Chambres qui ne peuvent PAS aller dans une couronne dont le temps de trajet DÉCLARÉ est
 * `trajetMin` : celles des dossiers dont le budget est strictement inférieur.
 *
 * Le temps de trajet d'une couronne est déclaré par l'exploitation, jamais mesuré (voir
 * `couronnesDe` dans `lib/stations.mjs`) : ce nombre compare un budget à une DÉCLARATION,
 * il ne mesure rien.
 *
 * @param {object} needs sortie de `computeNeeds`
 * @param {number} trajetMin temps de trajet déclaré de la couronne, en minutes
 * @returns {{dossiers: number, chambres: number, personnes: number, pax: number}}
 */
export function chambresHorsPortee(needs, trajetMin) {
  const out = seau();
  for (const p of needs?.parTrajet?.paliers ?? []) {
    if (p.trajet_max_min >= trajetMin) break;
    out.dossiers += p.dossiers;
    out.chambres += p.chambres;
    out.personnes += p.personnes;
    out.pax += p.pax;
  }
  return out;
}
