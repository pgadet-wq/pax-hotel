/**
 * Livrables du run (CDC §8) : plan CSV (colonnes §5.7), liste d'appel par hôtel,
 * FICHES d'enregistrement par passager (C3), rapport Markdown, messages CSV.
 * Retourne des chaînes, l'appelant (CLI ou serveur) décide où écrire.
 *
 * Ce module est le dernier avant l'humain : tout ce qu'il n'écrit pas, personne ne le
 * verra. Trois règles y sont donc absolues.
 *
 *  1. AUCUN MONTANT INVENTÉ À L'AFFICHAGE. Le moteur met `null` à un total qu'il refuse
 *     de calculer (devises mélangées, poste non renseigné) ; `Number(null).toLocaleString()`
 *     rendait « 0 », c'est-à-dire « rien à payer » là où le moteur dit « indéterminé ».
 *     Tout montant passe par `fmtMontant`, qui écrit « indéterminé » quand il l'est.
 *  2. CE QUI EST RÉSERVÉ SE DIT EN TOUTES LETTRES. Un plan dont 99 chambres reposent sur
 *     un stock jamais mesuré, un dossier logé sans couchage suffisant, une ligne écartée
 *     d'un relevé : le validateur humain signe la répartition (C6), il doit lire ces
 *     réserves avant de signer, pas les déduire d'une colonne de CSV.
 *  3. L'ÉCART AVEC UNE ÉQUIPE D'ESCALE EST CHIFFRÉ (C4). L'outil s'arrête au plan (INV-1) :
 *     le bloc « Travail humain restant » dit combien d'appels, de confirmations et de
 *     dossiers nominatifs restent à la charge de l'escale. Sans ce bloc, le client
 *     dimensionne son équipe résiduelle à zéro.
 */
import { toCsvBom } from "./csv.mjs";
import { effectiveCaps } from "./policy.mjs";
import { buildFiches, buildFichesCsv, buildFichesHtml, fichesFileNames } from "./fiches.mjs";

/** Donnée que rien n'a relevée : jamais remplacée par un blanc ni par une valeur plausible. */
export const NON_RELEVE = "[non relevé]";

/** Colonnes §5.7 : colonnes v1 + `conformite` + ajouts v2 + réserves C2/C3/C6/C7. */
export const PLAN_COLS = [
  "pnr", "occupants", "pax", "cabine", "overlays", "categorie",
  "hotel", "hotel_url", "room_type", "chambres", "prix_total", "devise",
  "conformite", "mode_reglement", "hotel_source", "provisoire",
  "session_ref", "transfert",
  // COURONNES — la géographie de la ligne. `couronne_trajet_min_declare` est un temps
  // DÉCLARÉ par l'exploitation, jamais mesuré : c'est lui qui dit quel transport commander
  // (un bus pour 60 min ne se commande pas comme un taxi pour 15 min), et c'est à lui que
  // `trajet_max_min` (budget du dossier, contrainte DURE) a été opposé.
  "couronne", "couronne_cle", "couronne_source", "couronne_trajet_min_declare", "couronne_mode",
  "trajet_max_min", "proximite",
  "escalade", "hors_plan", "sous_reserve", "statut",
  // C2/C3 — la qualité de ce qui est engagé, ligne par ligne, et le stock à DEUX NIVEAUX
  "stock_mesure", "chambres_fermes", "chambres_a_confirmer",
  "couchages_insuffisants", "couchages_manquants", "format_cabine",
  // C6 — convocation au comptoir et justification du mode de règlement
  "creneau_presentation", "reglement_source", "reglement_paiement_compagnie",
  // C7 — la carte prépayée de la ligne (renseignée si `cost` ou `row.carte_prepayee` est fourni)
  "carte_montant", "carte_devise", "carte_nb", "carte_incomplet",
  "notes",
];

/** Liste d'appel PAR HÔTEL (§8) : ce que l'escale lit au téléphone, hôtel par hôtel. */
export const ROOMING_COLS = [
  "hotel", "hotel_url", "chambres_hotel", "personnes_hotel", "mode_reglement",
  // « À appeler » sans numéro ni adresse n'est pas une liste d'appel : la donnée est
  // portée quand elle existe, et marquée `[non relevé]` quand elle n'existe pas.
  "hotel_adresse", "hotel_telephone",
  // C2 — le chiffre que l'agent d'escale annonce au téléphone, hôtel par hôtel :
  // tant de chambres fermes, tant à confirmer. Le total seul ferait croire à un bloc acquis.
  "chambres_hotel_fermes", "chambres_hotel_a_confirmer",
  // COURONNE de l'établissement : c'est ELLE qui détermine le transport à commander.
  // `couronne_hotel` est la couronne du bloc (une par hôtel, sauf relevés contradictoires),
  // `transfert_hotel` le libellé de transfert repris de la ligne de plan — temps DÉCLARÉ.
  "couronne_hotel", "couronne_trajet_min_declare", "couronne_mode", "transfert_hotel",
  "pnr", "titulaire", "occupants", "pax", "cabine", "overlays", "room_type", "chambres",
  "prix_total", "devise", "conformite",
  // la contrainte de la LIGNE : budget de trajet du dossier et réglage de proximité de sa
  // file. Couronne retenue ≤ budget, toujours : la ligne se conteste au comptoir.
  "couronne", "couronne_source", "trajet_max_min", "proximite",
  "stock_mesure", "chambres_fermes", "chambres_a_confirmer",
  "couchages_insuffisants", "creneau_presentation", "carte_montant",
  "notes",
];

export const MESSAGES_COLS = ["pnr", "lang", "subject", "body"];

/* ------------------------------------------------------------ mise en forme */

const oui = (v) => (v === true ? "oui" : v === false ? "non" : "");
const ouiVide = (v) => (v === true ? "oui" : "");

/**
 * Créneau de présentation (C6) en texte court pour un tableur : « 02:10–02:25 ».
 * Une forme inattendue n'est pas devinée : la cellule reste vide (la ligne de plan
 * porte déjà l'avertissement émis par l'allocation).
 */
export function creneauTexte(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.debut === "string") {
    return typeof v.fin === "string" && v.fin ? `${v.debut}–${v.fin}` : `à partir de ${v.debut}`;
  }
  return "";
}

/**
 * Couronne d'une ligne de plan, en texte court : « 2 — taxi, 35 min déclarées ».
 *
 * Le mot « déclarées » n'est pas une précaution de style : l'outil n'a aucun service de
 * routage et ne convertit JAMAIS une distance en durée. Ce temps vient de la fiche escale
 * (`search.couronnes[].trajet_min`), il a été posé par l'exploitation.
 *
 * Trois cas se lisent différemment et ne doivent pas se confondre :
 *  - `hors_couronnes` : hôtel mesuré au-delà de la dernière couronne déclarée — AUCUN temps
 *    de trajet ne le couvre, il n'y a donc rien à annoncer, pas même une borne ;
 *  - `couronne_source: "inconnue"` : couronne non déterminée, rattachée PAR PRUDENCE à la
 *    plus lointaine — le chiffre est une borne haute de prudence, pas un relevé ;
 *  - ligne sans hôtel : chaîne vide, aucun transfert n'est promis à un dossier sans chambre.
 *
 * @param {object} row ligne de plan (allocate.mjs)
 * @returns {string}
 */
export function couronneTexte(row) {
  const cle = String(row?.couronne_cle ?? "").trim();
  if (!cle) return "";
  const mode = String(row?.couronne_mode ?? "").trim();
  if (cle === "hors_couronnes") {
    return `hors couronnes${mode ? ` — ${mode}` : ""}, aucun temps de trajet déclaré`;
  }
  const trajet = Number(row?.couronne_trajet_min_declare);
  const base =
    `couronne ${cle}` +
    (mode ? ` — ${mode}` : "") +
    (Number.isFinite(trajet) ? `, ${trajet} min déclarées` : ", temps de trajet non déclaré");
  return row?.couronne_source === "inconnue" ? `${base} (couronne À CONFIRMER, prudence)` : base;
}

/**
 * Montant destiné à un humain. `null`/`undefined`/NaN ne valent PAS zéro : ils valent
 * « indéterminé ». C'est la garde qui empêche le rapport de contredire le moteur.
 * @param {number|null} v
 * @param {string|null} [devise] libellé accolé au nombre ; jamais « ? »
 */
export function fmtMontant(v, devise = null) {
  if (v === null || v === undefined || v === "") return "indéterminé";
  const n = Number(v);
  if (!Number.isFinite(n)) return "indéterminé";
  const nombre = n.toLocaleString("fr-FR");
  const d = devise === null || devise === undefined ? "" : String(devise).trim();
  return d && d !== "?" ? `${nombre} ${d}` : nombre;
}

const fmtDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "?";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/** Index PNR → ligne de carte prépayée, depuis `cost` ou depuis les lignes de plan. */
function indexCartes(plan, cost) {
  const parPnr = new Map();
  for (const l of cost?.cartes_prepayees?.lignes ?? []) if (l?.pnr) parPnr.set(l.pnr, l);
  for (const row of plan ?? []) {
    // le pipeline peut greffer le résultat de carteLigne sur la ligne elle-même
    if (row?.carte_prepayee && row.pnr && !parPnr.has(row.pnr)) parPnr.set(row.pnr, row.carte_prepayee);
  }
  return parPnr;
}

/** Colonnes C7 d'une ligne de plan (vides quand aucune carte n'a été calculée). */
function colonnesCarte(row, cartes) {
  const c = cartes.get(row.pnr);
  if (!c) return { carte_montant: "", carte_devise: "", carte_nb: "", carte_incomplet: "" };
  return {
    // `null` = montant non calculable : la cellule le DIT, elle ne reste pas vide et ne
    // vaut surtout pas 0 (une carte à 0 € est une carte inutilisable au comptoir)
    carte_montant: c.montant_par_carte === null ? "non calculable" : c.montant_par_carte,
    carte_devise: c.devise ?? "",
    carte_nb: c.cartes ?? "",
    carte_incomplet: ouiVide(c.incomplet),
  };
}

/**
 * Coordonnées d'appel d'un hôtel. L'adresse et le téléphone ne sont relevés par aucun
 * agent (prix publics uniquement, INV-3) et les producteurs d'inventaire écrivent
 * `contact.phone: null` en dur : dans ce cas la cellule porte `[non relevé]`, jamais un
 * blanc qui se lirait « pas besoin d'appeler » ni un numéro deviné.
 * @param {Array} inventories relevés du run
 * @param {Array} [entrees] entrées d'inventaire (data/inventaire/<escale>.json)
 */
export function indexContactsHotels(inventories = [], entrees = []) {
  const parNom = new Map();
  const poser = (nom, adresse, tel) => {
    const cle = String(nom ?? "").trim().toLowerCase();
    if (!cle) return;
    const e = parNom.get(cle) ?? { adresse: "", telephone: "" };
    if (!e.adresse && adresse) e.adresse = String(adresse).trim();
    if (!e.telephone && tel) e.telephone = String(tel).trim();
    parNom.set(cle, e);
  };
  for (const inv of inventories ?? []) {
    const a = inv?.answer ?? {};
    const adresse = a.address ?? a.adresse ?? inv?.address ?? inv?.candidate?.address ?? "";
    const tel = a.contact?.phone ?? a.phone ?? inv?.contact?.phone ?? inv?.candidate?.contact?.phone ?? "";
    for (const nom of [a.hotel, inv?.name, inv?.hotelKey, inv?.hotel]) poser(nom, adresse, tel);
  }
  // le schema d'inventaire porte `adresse` (francais) ; `address` reste accepte pour les
  // fiches ecrites avant le 21/09 — un contact perdu, c'est un hotel qu'on n'appelle pas
  for (const h of entrees ?? []) poser(h?.name, h?.adresse || h?.address || "", h?.contact?.phone ?? "");
  return {
    /** @returns {{adresse: string, telephone: string}} valeurs prêtes à imprimer */
    de(nom) {
      const e = parNom.get(String(nom ?? "").trim().toLowerCase());
      return { adresse: e?.adresse || NON_RELEVE, telephone: e?.telephone || NON_RELEVE };
    },
    /** true si au moins une coordonnée a été trouvée (le rapport le dit au validateur) */
    get vide() {
      return [...parNom.values()].every((e) => !e.adresse && !e.telephone);
    },
  };
}

/**
 * Ventilation du stock engagé en DEUX NIVEAUX (C2) : chambres FERMES (adossées à une
 * mesure sûre — sélecteur ou sonde non plafonnés) et chambres À CONFIRMER (adossées à
 * un sélecteur plafonné, donc à une borne basse).
 *
 * Le résumé d'allocation fait foi. Un plan restitué d'une version antérieure ne porte
 * pas ces compteurs : ils sont alors RECALCULÉS sur les lignes (`chambres_fermes` /
 * `chambres_a_confirmer`, à défaut `stock_mesure`), jamais devinés. Quand rien ne
 * permet de trancher, `connu` vaut false et l'appelant écrit « indéterminé » plutôt
 * qu'un zéro qui se lirait « tout est mesuré ».
 *
 * @param {Array} plan lignes du plan
 * @param {object|null} summary résumé d'allocation
 * @returns {{fermes: number, aConfirmer: number, total: number, part: number, connu: boolean}}
 */
export function niveauxPlan(plan = [], summary = null) {
  const f = Number(summary?.chambresFermes);
  const a = Number(summary?.chambresAConfirmer);
  if (Number.isFinite(f) && Number.isFinite(a)) {
    const total = f + a;
    return { fermes: f, aConfirmer: a, total, part: total ? a / total : 0, connu: true };
  }
  let fermes = 0;
  let aConfirmer = 0;
  let connu = false;
  for (const row of plan ?? []) {
    if (row?.statut !== "OK") continue;
    const ch = Number(row.chambres) || 0;
    const nf = Number(row.chambres_fermes);
    const na = Number(row.chambres_a_confirmer);
    if (Number.isFinite(nf) || Number.isFinite(na)) {
      fermes += Number.isFinite(nf) ? nf : 0;
      aConfirmer += Number.isFinite(na) ? na : 0;
      connu = true;
    } else if (row.stock_mesure === true || row.stock_mesure === false) {
      if (row.stock_mesure === true) fermes += ch;
      else aConfirmer += ch;
      connu = true;
    }
  }
  const total = fermes + aConfirmer;
  return { fermes, aConfirmer, total, part: total ? aConfirmer / total : 0, connu };
}

/* ------------------------------------------------------------------- plan CSV */

/**
 * @param {Array} plan lignes du plan (sortie d'allocate)
 * @param {object} [opts] `{cost}` (sortie de computeCost) pour renseigner les colonnes de
 *   carte prépayée ; sans lui elles restent vides, sauf si le pipeline a greffé
 *   `row.carte_prepayee` sur les lignes. Comportement historique inchangé.
 */
export function buildPlanCsv(plan, { cost = null } = {}) {
  const cartes = indexCartes(plan, cost);
  const rows = plan.map((row) => ({
    ...row,
    stock_mesure: oui(row.stock_mesure),
    couchages_insuffisants: ouiVide(row.couchages_insuffisants),
    couchages_manquants: row.couchages_manquants || "",
    creneau_presentation: creneauTexte(row.creneau_presentation),
    ...colonnesCarte(row, cartes),
  }));
  return toCsvBom(PLAN_COLS, rows);
}

/**
 * Le plan est trié par dossier : inexploitable pour appeler un hôtel. Cette sortie
 * le regroupe par établissement, avec le total de chambres et de personnes en tête
 * de chaque bloc — c'est la forme dont le comptoir a besoin pour négocier et pour
 * appeler les passagers à la porte du bus.
 *
 * @param {Array} plan lignes du plan
 * @param {object} [opts] `{inventories, entrees, cost}` — additifs. `inventories`/`entrees`
 *   alimentent adresse et téléphone ; `cost` alimente le montant de carte par ligne.
 */
export function buildRoomingCsv(plan, { inventories = [], entrees = [], cost = null } = {}) {
  const contacts = indexContactsHotels(inventories, entrees);
  const cartes = indexCartes(plan, cost);
  const parHotel = new Map();
  for (const row of plan) {
    if (row.statut !== "OK" || !row.hotel) continue;
    if (!parHotel.has(row.hotel)) parHotel.set(row.hotel, []);
    parHotel.get(row.hotel).push(row);
  }
  const rows = [];
  for (const [hotel, lignes] of [...parHotel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const chambres = lignes.reduce((s2, r) => s2 + (Number(r.chambres) || 0), 0);
    const personnes = lignes.reduce((s2, r) => s2 + (Number(r.pax) || 0), 0);
    // C2 — ventilation du bloc à demander : fermes / à confirmer. Une ligne d'un plan
    // antérieur qui ne porte pas ces champs n'est pas devinée : elle est comptée sur
    // `stock_mesure`, seule information dont on dispose alors.
    const niveau = (r, ferme) => {
      const n = Number(ferme ? r.chambres_fermes : r.chambres_a_confirmer);
      if (Number.isFinite(n)) return n;
      return (r.stock_mesure === true) === ferme ? Number(r.chambres) || 0 : 0;
    };
    const chambresFermes = lignes.reduce((s2, r) => s2 + niveau(r, true), 0);
    const chambresAConfirmer = lignes.reduce((s2, r) => s2 + niveau(r, false), 0);
    // COURONNE DU BLOC : c'est elle qui décide du TRANSPORT à commander. Un hôtel a
    // normalement une seule couronne ; si deux relevés du même nom n'ont pas été rangés
    // au même endroit, les deux sont écrites plutôt qu'une seule choisie au hasard.
    const couronnesBloc = [...new Set(lignes.map((r) => couronneTexte(r)).filter(Boolean))];
    const couronneHotel = couronnesBloc.join(" / ");
    const trajetsBloc = [...new Set(lignes.map((r) => r.couronne_trajet_min_declare).filter((v) => v !== "" && v !== null && v !== undefined))];
    const modesBloc = [...new Set(lignes.map((r) => String(r.couronne_mode ?? "").trim()).filter(Boolean))];
    const transfertsBloc = [...new Set(lignes.map((r) => String(r.transfert ?? "").trim()).filter(Boolean))];
    const coord = contacts.de(hotel);
    for (const r of lignes) {
      rows.push({
        hotel,
        hotel_url: r.hotel_url ?? "",
        chambres_hotel: chambres,
        personnes_hotel: personnes,
        chambres_hotel_fermes: chambresFermes,
        chambres_hotel_a_confirmer: chambresAConfirmer,
        mode_reglement: r.mode_reglement ?? "",
        hotel_adresse: coord.adresse,
        hotel_telephone: coord.telephone,
        couronne_hotel: couronneHotel,
        couronne_trajet_min_declare: trajetsBloc.join(" / "),
        couronne_mode: modesBloc.join(" / "),
        transfert_hotel: transfertsBloc.join(" / "),
        pnr: r.pnr,
        titulaire: String(r.occupants ?? "").split(",")[0].trim(),
        occupants: r.occupants ?? "",
        pax: r.pax ?? "",
        cabine: r.cabine ?? "",
        overlays: r.overlays ?? "",
        room_type: r.room_type ?? "",
        chambres: r.chambres ?? "",
        prix_total: r.prix_total ?? "",
        devise: r.devise ?? "",
        conformite: r.conformite ?? "",
        couronne: r.couronne_cle ?? "",
        couronne_source: r.couronne_source ?? "",
        // budget de trajet du dossier, tel qu'il a été OPPOSÉ à l'hôtel. Vide = aucune
        // contrainte (horaire du vol suivant inconnu), jamais « zéro minute ».
        trajet_max_min: r.trajet_max_min ?? "",
        proximite: r.proximite ?? "",
        stock_mesure: oui(r.stock_mesure),
        chambres_fermes: niveau(r, true),
        chambres_a_confirmer: niveau(r, false),
        couchages_insuffisants: ouiVide(r.couchages_insuffisants),
        creneau_presentation: creneauTexte(r.creneau_presentation),
        ...colonnesCarte(r, cartes),
        notes: r.notes ?? "",
      });
    }
  }
  return toCsvBom(ROOMING_COLS, rows);
}

export function buildMessagesCsv(messages) {
  return toCsvBom(MESSAGES_COLS, messages);
}

/* --------------------------------------------------------------- fiches (C3) */

/**
 * 8e livrable : les FICHES d'enregistrement, un formulaire de saisie par passager selon
 * le format de chambre retenu (C3). `fiches.mjs` les construit ; cette fonction est le
 * point d'accroche du run — le CSV et le rendu imprimable deviennent des livrables au
 * même titre que le plan, la liste d'appel et les messages.
 *
 * Le montant de carte prépayée (C7) est repris de `cost` quand il est fourni : la fiche
 * porte alors le montant réellement calculé par `carteLigne`, et `[à remplir]` sinon —
 * jamais un montant deviné. Une carte incomplète est dite incomplète sur la fiche.
 *
 * @param {{plan: Array, summary: object}} alloc sortie d'allocate
 * @param {object} ctx {rows?, dossiers?, policy, station?, checkin, checkout, nights?, runId?, vol?, cost?}
 *   `rows` = `splitPaxRows().pax` (lignes passagers canoniques) : sans elles, une fiche
 *   par dossier au lieu d'une par personne, et l'avertissement le dit.
 * @returns {{csv: string, html: string, fichiers: {csv: string, html: string},
 *            fiches: Array, resume: object, avertissements: string[]}}
 */
export function buildFichesOutputs(alloc, ctx = {}) {
  const { rows = null, dossiers = null, policy = null, station = null, checkin = "", checkout = "", runId = "", vol = "", cost = null } = ctx;
  const nights = ctx.nights ?? 1;
  const cartes = indexCartes(alloc?.plan ?? [], cost);

  /**
   * Montant à porter sur la fiche : celui de la carte du dossier, avec sa devise et TOUTES
   * ses réserves. La colonne s'appelle `montant_carte_eur` et s'imprime « (EUR) » : livrer
   * le nombre nu d'une carte libellée en THB ferait lire 3 500 THB comme 3 500 EUR au
   * comptoir. Aucune conversion n'est faite — il n'y a pas de taux dans l'outil, et en
   * inventer un serait pire que de dire la devise.
   */
  const montantCartePar = (planRow) => {
    const c = cartes.get(planRow?.pnr);
    if (!c || c.montant_par_carte === null) return null; // → « [à remplir] », jamais un chiffre supposé
    const reference = policy?.global?.currency ?? "EUR";
    const devise = c.devise && c.devise !== "?" ? c.devise : "";
    const reserves = [];
    if (devise && devise !== reference) reserves.push(`carte libellée en ${devise}, NON convertie`);
    if ((c.motifs ?? []).includes("devise_non_affichee")) reserves.push(`devise du relevé non affichée, montant SUPPOSÉ en ${reference}`);
    // `incomplet` : au moins un poste n'a pas pu être chiffré. Le montant existe mais ne
    // couvre pas tout ; le taire chargerait une carte insuffisante sans jamais le dire.
    const manquants = [...(c.postes_non_renseignes ?? []), ...(c.postes_non_convertibles ?? [])];
    if (manquants.length) reserves.push(`PARTIEL — poste(s) non chiffré(s) : ${manquants.join(", ")}`);
    else if (c.incomplet) reserves.push("PARTIEL — montant incomplet, voir le fichier coût du run");
    if (c.plafond_depasse) reserves.push(`au-dessus du plafond de carte (${c.plafond_eur} ${reference})`);
    if (c.per === "dossier" && c.cartes === 1 && Number(planRow?.pax) > 1) reserves.push("carte unique du dossier");
    const valeur = !devise || devise === reference ? c.montant_par_carte : `${c.montant_par_carte} ${devise}`;
    return reserves.length ? `${valeur} (${reserves.join(" ; ")})` : valeur;
  };

  const { fiches, resume, avertissements } = buildFiches({
    plan: alloc?.plan ?? [], rows, dossiers, policy, station,
    checkin, checkout, nights, runId, vol, montantCartePar,
  });
  return {
    csv: buildFichesCsv(fiches),
    html: buildFichesHtml(fiches, { runId, vol, station, checkin, checkout, nights, resume, avertissements }),
    fichiers: fichesFileNames(runId || "run"),
    fiches, resume, avertissements,
  };
}

/* ------------------------------------------------------------ rapport Markdown */

/**
 * Section « Répartition par couronne » du rapport.
 *
 * C'est la lecture que le client a demandée : combien de dossiers, de chambres et de
 * personnes dans chaque couronne, et à quel temps de trajet DÉCLARÉ. Elle sert deux
 * décisions distinctes, et c'est pourquoi elle est isolée du reste :
 *
 *  1. le TRANSPORT à commander — un bus pour 60 min ne se commande pas comme un taxi
 *     pour 15 min, et le chiffre par couronne est le nombre de sièges à affréter ;
 *  2. la CAUSE d'une escalade — « temps de trajet » n'est pas « capacité ». Relever
 *     des hôtels plus lointains ne logera jamais un dossier dont le vol suivant part
 *     dans 6 h ; l'écrire évite de dépenser des sessions d'agents contre rien.
 *
 * Aucun temps de trajet n'est mesuré ici : ils sont tous DÉCLARÉS par l'exploitation
 * dans la fiche escale. Une couronne DÉRIVÉE du rayon n'est pas une déclaration et la
 * section le dit en toutes lettres — sans quoi un repli passerait pour un engagement.
 *
 * @param {object} summary `allocate().summary`
 * @param {object|null} [station] fiche escale (pour nommer l'escale)
 * @returns {string[]} lignes Markdown (vide si le résumé ne porte pas les couronnes)
 */
export function sectionCouronnes(summary, station = null) {
  const couronnes = summary?.couronnes;
  const parCouronne = summary?.parCouronne ?? {};
  // un résumé d'une version antérieure ne porte pas ces champs : on n'invente pas une
  // section vide qui se lirait « aucun hôtel lointain », on ne l'écrit simplement pas
  if (!couronnes || !Array.isArray(couronnes.liste) || couronnes.liste.length === 0) return [];

  const lines = [];
  const declaree = couronnes.source === "declaree";
  lines.push(`## Répartition par couronne — la géographie du plan`);
  lines.push("");
  lines.push(
    declaree
      ? `Couronnes **déclarées par l'exploitation** dans la fiche escale${station?.code ? ` ${station.code}` : ""} : ` +
        `${couronnes.liste.map((c) => `**${c.rang}** ≤ ${Math.round(c.rayon_m / 1000)} km, ${c.trajet_min_declare} min en ${c.mode}`).join(" · ")}.`
      : `**Aucune couronne n'est déclarée** dans la fiche escale${station?.code ? ` ${station.code}` : ""} : une couronne unique a été ` +
        `DÉRIVÉE du rayon (${Math.round((couronnes.liste[0]?.rayon_m ?? 0) / 1000)} km, ${couronnes.liste[0]?.trajet_min_declare} min). ` +
        `Une couronne dérivée **n'est pas une déclaration d'exploitation** : tous les hôtels y partagent le même temps de ` +
        `trajet, et les budgets de trajet des dossiers ne départagent donc rien.`,
  );
  lines.push("");
  lines.push(
    declaree
      ? `Les temps de trajet ci-dessous sont **DÉCLARÉS**, jamais mesurés : l'outil n'a aucun service de routage et ne ` +
        `convertit pas une distance en durée. Ils se vérifient auprès de l'exploitation avant d'engager un transport.`
      : `Le temps de trajet ci-dessous est repris de \`transfer.max_transfer_min\` de la fiche escale : c'est un MAXIMUM ` +
        `déclaré pour l'escale entière, ni une mesure ni une couronne. L'outil n'a aucun service de routage et ne convertit ` +
        `pas une distance en durée — déclarer de vraies couronnes dans la fiche escale est ce qui rendrait ce tableau utile.`,
  );
  lines.push("");

  // ordre de lecture : couronnes déclarées par rang, puis hors couronnes, puis l'inconnu
  const cles = Object.keys(parCouronne).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return Number.isFinite(na) ? -1 : Number.isFinite(nb) ? 1 : a.localeCompare(b);
  });
  if (cles.length) {
    lines.push(`| Couronne | Trajet déclaré | Transport | Dossiers | Chambres | dont FERMES | dont À CONFIRMER | Personnes |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const cle of cles) {
      const c = parCouronne[cle];
      const nom = cle === "hors_couronnes" ? "**hors couronnes**" : cle === "inconnue" ? "**indéterminée**" : `**${cle}**`;
      const trajet = c.trajet_min_declare === null || c.trajet_min_declare === undefined || c.trajet_min_declare === ""
        ? "**non déclaré**"
        : `${c.trajet_min_declare} min`;
      lines.push(
        `| ${nom} | ${trajet} | ${c.mode || NON_RELEVE} | ${c.dossiers} | **${c.chambres}** | ${c.chambres_fermes} | ` +
          `${c.chambres_a_confirmer} | ${c.pax} |`,
      );
    }
    lines.push("");
    lines.push(
      `**Ce tableau commande le transport** : chaque ligne est un groupe à acheminer au même temps de trajet déclaré. ` +
        `La colonne « Personnes » donne le nombre de sièges, pas le nombre de chambres.`,
    );
    lines.push("");
  } else {
    lines.push(`Aucun dossier logé : il n'y a rien à ventiler par couronne.`);
    lines.push("");
  }

  const horsCouronnes = parCouronne.hors_couronnes;
  if (horsCouronnes) {
    lines.push(
      `- **${horsCouronnes.dossiers} dossier(s) logés HORS COURONNES** (${horsCouronnes.pax} personne(s)) : l'hôtel est ` +
        `mesuré au-delà de la dernière couronne déclarée et **aucun temps de trajet ne le couvre** — le transfert est à ` +
        `établir par l'exploitation avant toute annonce au passager.`,
    );
  }
  if (summary.dossiersCouronneIndeterminee) {
    lines.push(
      `- **${summary.dossiersCouronneIndeterminee} dossier(s) logés dans un hôtel de couronne NON DÉTERMINÉE** : aucune ` +
        `distance mesurée, hôtel rattaché PAR PRUDENCE à la couronne la plus lointaine. Le temps affiché pour eux est une ` +
        `borne de prudence, pas un relevé — distance à relever avant diffusion.`,
    );
  }
  // le budget de trajet : combien de dossiers en ont réellement un. Zéro n'est PAS
  // « tout le monde peut aller loin » : c'est « aucun horaire de vol suivant n'est connu ».
  const avecBudget = Number(summary.dossiersAvecBudget) || 0;
  lines.push(
    avecBudget
      ? `- **${avecBudget} dossier(s) sous budget de trajet** : leur couronne est une CONTRAINTE DURE, opposée à l'hôtel ` +
        `(colonne \`trajet_max_min\` du plan). Aucun rang de la politique de prise en charge ne permet de l'outrepasser.`
      : `- **Aucun dossier n'a de budget de trajet** : la liste ne portait aucun horaire de vol suivant exploitable, ou ` +
        `l'heure de l'escale n'a pas été fournie au moteur. Les couronnes ci-dessus décrivent donc la géographie du plan, ` +
        `**elles n'ont protégé aucune correspondance**.`,
  );
  if (summary.escaladesTempsTrajet) {
    lines.push(
      `- **${summary.escaladesTempsTrajet} dossier(s) escaladés faute de TEMPS DE TRAJET** — à ne pas confondre avec un ` +
        `manque de chambres : il faut des chambres PLUS PROCHES, ou un repos côté piste. Des relevés supplémentaires en ` +
        `couronne lointaine ne changeraient rien à leur sort.`,
    );
  }
  if (summary.escaladesProximite) {
    lines.push(
      `- **${summary.escaladesProximite} dossier(s) escaladés par PROXIMITÉ STRICTE** : des chambres existaient plus loin, ` +
        `la politique de prise en charge a refusé de les y envoyer. C'est un ARBITRAGE, réversible en passant leur critère ` +
        `de « stricte » à « préférée ».`,
    );
  }
  lines.push("");
  return lines;
}

/** Somme des chambres OK d'un plan. */
const chambresOkDe = (plan) => plan.filter((p) => p.statut === "OK").reduce((s, p) => s + (Number(p.chambres) || 0), 0);

/**
 * Rapport Markdown : scénario, escale, politique, relevés horodatés (EX-REL-2),
 * qualité des relevés, plan par tier, liste d'appel, escalades, extension, coût,
 * cartes prépayées, fiches, travail humain restant, avertissements.
 * @param {{plan, summary, gaps}} alloc sortie d'allocate
 * @param {Array} inventories relevés
 * @param {object} ctx {station, scenario?, policy, checkin, checkout, nights?, runId?, cost?,
 *   extension?, warnings?, ingestion?, fiches? (sortie de buildFichesOutputs), entrees?}
 */
export function buildRapportMd(alloc, inventories, ctx) {
  const { plan, summary, gaps } = alloc;
  const { station, policy, checkin, checkout, runId, cost, extension, warnings, ingestion, fiches, entrees } = ctx;
  const nights = ctx.nights ?? Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
  const caps = effectiveCaps(policy, station);
  const contacts = indexContactsHotels(inventories ?? [], entrees ?? []);
  const lines = [];

  lines.push(`# Plan d'hébergement — ${station?.name ?? "escale"} (démo v2)`);
  lines.push("");
  lines.push(`**Arrivée du vol : ${checkin}** · hébergement du **${checkin}** au **${checkout}** (${nights} nuit${nights > 1 ? "s" : ""})`);
  if (runId) lines.push(`Run \`${runId}\``);
  if (station) {
    lines.push(
      `Escale ${station.code} · transfert par défaut : ${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min` +
        (station.pricing?.price_cap_factor && station.pricing.price_cap_factor !== 1
          ? ` · facteur de plafond ${station.pricing.price_cap_factor}`
          : ""),
    );
  }
  lines.push("");
  lines.push(`## Synthèse`);
  lines.push("");
  const chambresOk = chambresOkDe(plan);
  // dossiers escaladés QUI ATTENDENT ENCORE UNE CHAMBRE : les hors-plan (nominatifs) sont
  // escaladés mais ne sont pas en attente de chambre, les compter ensemble gonfle le manque
  const dossiersSansChambre = Math.max(0, (summary.escalade ?? 0) - (summary.horsPlan ?? 0));
  // dossiers qui se présenteront au comptoir sans horaire : le compteur de l'allocation
  // s'il existe, sinon tous les dossiers convocables (résumé construit à la main)
  const sansCreneau = Number.isFinite(summary.sansCreneau)
    ? summary.sansCreneau
    : Math.max(0, (summary.ok ?? 0) + (summary.escalade ?? 0) - (summary.horsPlan ?? 0));
  // Aucune devise chiffrée = AUCUN prix relevé, pas un plan gratuit. Écrire « 0 » ici
  // annoncerait une facture nulle sur des chambres qui seront bel et bien facturées.
  const couts =
    Object.entries(summary.coutParDevise).map(([d, v]) => `${fmtMontant(v, d)}`).join(" + ") ||
    "indéterminé — aucun prix relevé sur ce plan (ce n'est pas un coût nul)";
  // « personne » au sens du PLAN = personne À BORD, nourrissons compris. Le cadrage
  // (dry-run, `computeNeeds`) compte lui des personnes À COUCHER, hors nourrissons :
  // les deux chiffres diffèrent légitimement, chacun nomme donc son unité.
  lines.push(`- Dossiers hébergés en ligne : **${summary.ok}** (${chambresOk} chambres, ${summary.paxLoges ?? "?"} personnes à bord)`);
  // C2 — le stock engagé, à DEUX NIVEAUX. C'est la première chose que le validateur doit
  // lire : « tant de chambres fermes, tant à confirmer », et non un total qui se lirait
  // comme un bloc acquis.
  const niveaux = niveauxPlan(plan, summary);
  if (niveaux.connu) {
    lines.push(
      `- Stock engagé : **${niveaux.fermes} chambre(s) FERME(S)** (mesurées) · ` +
        `**${niveaux.aConfirmer} chambre(s) À CONFIRMER** auprès des hôtels (stock non mesuré, ` +
        `${Math.round(niveaux.part * 100)} % des chambres du plan)`,
    );
  } else {
    lines.push(
      `- Stock engagé : ventilation ferme / à confirmer **INDÉTERMINÉE** pour ce plan ` +
        `(ni le résumé d'allocation ni les lignes ne la portent) — ne pas lire ces ${chambresOk} chambres comme acquises`,
    );
  }
  lines.push(`- Dossiers à escalader au desk : **${summary.escalade}** — **${summary.paxNonLoges ?? "?"} personnes non logées**`);
  if (summary.motifs && Object.keys(summary.motifs).length) {
    lines.push(`  - motifs : ${Object.entries(summary.motifs).map(([m, n]) => `${m} ${n}`).join(" · ")}`);
    if (summary.horsPlan) lines.push(`  - dont **${summary.horsPlan} hors plan hôtel** (traitement nominatif au desk) : relever plus d'hôtels ne les logera pas`);
  }
  // COURONNES — la cause « temps de trajet » appelle une action DIFFÉRENTE de la cause
  // « capacité » : relever des hôtels de plus ne logera personne si les chambres relevées
  // sont hors d'atteinte. Tant que tout finissait en « DESK (capacité) », l'opérateur
  // dépensait des sessions d'agents contre un manque qui n'est pas un manque de chambres.
  if (summary.escaladesTempsTrajet) {
    lines.push(
      `  - dont **${summary.escaladesTempsTrajet} dossier(s) faute de TEMPS DE TRAJET** : aucune chambre dans le temps ` +
        `de trajet que leur vol suivant autorise. **Ce n'est PAS un manque de chambres** — relever d'autres hôtels ` +
        `plus loin ne les logera pas ; il faut des chambres PLUS PROCHES, ou un repos côté piste.`,
    );
  }
  if (summary.escaladesProximite) {
    lines.push(
      `  - dont **${summary.escaladesProximite} dossier(s) par PROXIMITÉ STRICTE** : la politique de prise en charge ` +
        `refuse de les éloigner de la couronne la plus proche (réglage \`proximite: "stricte"\` de leur critère).`,
    );
  }
  lines.push(`- Coût total relevé : **${couts}**`);
  // Ce total ne porte QUE les dossiers logés. Les escalades n'ont pas de chambre, donc pas
  // de prix : les laisser hors champ sans le dire ferait lire ce montant comme la facture
  // de l'escale, alors que les personnes non logées coûteront en plus — et probablement plus cher.
  if (summary.escalade > 0) {
    lines.push(
      `  - ce total ne couvre **que les ${summary.ok} dossier(s) logés** : les ${summary.escalade} dossier(s) ` +
        `en escalade (${summary.paxNonLoges ?? "?"} personne(s)) ne sont **pas chiffrés** — leur hébergement ` +
        `reste à trouver et à payer, hors de ce montant`,
    );
  }
  lines.push("");

  // C2 — un plan dont l'essentiel repose sur du non-mesuré le dit EN TÊTE, pas en note
  // de bas de page : c'est l'information qui change la nature de l'appel téléphonique.
  if (niveaux.connu && niveaux.total && niveaux.part > 0.5) {
    lines.push(
      `> **L'ESSENTIEL DE CE PLAN REPOSE SUR DU STOCK NON MESURÉ** : ${niveaux.aConfirmer} chambre(s) sur ` +
        `${niveaux.total} (${Math.round(niveaux.part * 100)} %) sont des chambres **à confirmer** — l'affichage du site ` +
        `plafonne le sélecteur, il donne une borne basse, pas un compte. Ces chambres se DEMANDENT à l'hôtel par ` +
        `téléphone ; tant qu'un établissement n'a pas confirmé, elles ne sont pas acquises.`,
    );
    lines.push("");
  }

  // C2/C6 — ce qui interdit de lire ce plan comme « couvert ». Écrit AVANT le tableau :
  // le validateur ne doit pas avoir à chercher les réserves sous les chiffres.
  if (summary.complet === false || (summary.reserves ?? []).length) {
    lines.push(`### Réserves sur ce plan — à lire avant validation`);
    lines.push("");
    lines.push(`Ce plan n'est **pas** un plan couvert : ${(summary.reserves ?? []).length} réserve(s).`);
    lines.push("");
    const paxSansChambre = Math.max(0, (summary.paxNonLoges ?? 0) - (summary.paxHorsPlan ?? 0));
    if (dossiersSansChambre) {
      lines.push(`- **${dossiersSansChambre} dossier(s) sans aucune chambre** (${paxSansChambre} personne(s)) : à traiter au comptoir`);
    }
    if (niveaux.connu && niveaux.aConfirmer) {
      lines.push(
        `- **${niveaux.aConfirmer} chambre(s) À CONFIRMER sur ${niveaux.total}** (${summary.stockNonMesure ?? "?"} dossier(s)) : ` +
          `quantité plafonnée par le sélecteur ou non affichée, donc BORNE BASSE et non mesure. ` +
          `Les ${niveaux.fermes} autres sont fermes. Ces chambres sont **planifiées** — elles figurent dans la liste d'appel — ` +
          `mais elles ne sont acquises qu'une fois confirmées par l'établissement, avant toute annonce aux passagers.`,
      );
    }
    if (summary.couchagesInsuffisants) {
      lines.push(
        `- **${summary.couchagesInsuffisants} dossier(s) logés sans couchage déclaré suffisant** ` +
          `(${summary.paxSansCouchage} personne(s) sans lit déclaré) : lit d'appoint ou chambre supplémentaire à obtenir de l'hôtel.`,
      );
    }
    if ((summary.avertissements ?? []).length) {
      lines.push(`- **${summary.avertissements.length} avertissement(s) de stock** — détail en fin de rapport, section « Avertissements »`);
    }
    // toute réserve d'une nature que cette section ne détaille pas encore est reprise
    // telle quelle : une réserve ajoutée par l'allocation ne doit jamais disparaître ici
    const detaillees = [/sans chambre/i, /couchage/i, /stock non mesur/i, /à confirmer/i, /avertissement/i];
    for (const r of summary.reserves ?? []) {
      if (!detaillees.some((re) => re.test(r))) lines.push(`- ${r}`);
    }
    lines.push("");
  } else if (summary.complet === true) {
    lines.push(`Aucune réserve : toutes les personnes de la liste ont une chambre, les ${niveaux.fermes} chambre(s) du plan reposent toutes sur un stock MESURÉ (niveau ferme) et les couchages déclarés suffisent.`);
    lines.push("");
  }

  if (summary.concentration && summary.concentration.hotels > 0) {
    const c = summary.concentration;
    lines.push(
      `Concentration : **${Math.round(c.part * 100)} %** des chambres chez « ${c.hotel} » ` +
        `(${c.chambres} chambres, ${c.dossiers} dossiers, ${c.pax} personnes) sur ${c.hotels} hôtel(s) engagé(s).`,
    );
    lines.push("");
  }

  // C6 — convocations étalées
  if (summary.creneaux) {
    const cr = summary.creneaux;
    lines.push(
      // `par_creneau` est un PLAFOND, pas une répartition : chaque bloc (un bus par hôtel)
      // commence sur un créneau neuf, le dernier créneau d'un bloc est partiel. L'occupation
      // réelle est ce qui dimensionne le comptoir ; elle est donnée quand le moteur la porte.
      `Convocations au comptoir : **${cr.dossiers} dossier(s)** répartis sur **${cr.creneaux} créneau(x)** de ${cr.pas_minutes} min ` +
        `(au plus ${cr.par_creneau} dossier(s) par créneau), de **${cr.debut}** à **${cr.fin}** heure locale (${cr.fuseau}).` +
        (Number.isFinite(cr.occupation_max)
          ? ` Occupation réelle : de **${cr.occupation_min}** à **${cr.occupation_max}** dossier(s) par créneau` +
            `${Array.isArray(cr.occupation) ? ` (${cr.occupation.join(" · ")})` : ""} — ` +
            `le flux n'est PAS constant, ne pas dimensionner le comptoir sur le plafond.`
          : ""),
    );
  } else {
    lines.push(
      `**Aucun créneau de présentation n'a été calculé** : les ${sansCreneau} dossier(s) concernés se présenteront ` +
        `au comptoir sans horaire réparti (option \`presentation\` non fournie au moteur).`,
    );
  }
  if (summary.creneaux && sansCreneau) lines.push(`Dossiers convoqués sans créneau : **${sansCreneau}**.`);
  lines.push("");

  lines.push(`| Cabine | OK | Escalade | Chambres | Plafond effectif |`);
  lines.push(`|---|---|---|---|---|`);
  for (const tier of ["J", "W", "Y"]) {
    const s = summary.parTier[tier] ?? { ok: 0, escalade: 0, chambres: 0 };
    lines.push(`| ${tier} | ${s.ok} | ${s.escalade} | ${s.chambres} | ${caps[tier]} EUR/nuit |`);
  }
  lines.push("");

  lines.push(...sectionCouronnes(summary, station));

  if (ingestion) {
    const c = ingestion.compteurs ?? {};
    lines.push(`## Liste passagers (ingestion)`);
    lines.push("");
    if (ingestion.fichier) {
      lines.push(`- fichier : ${ingestion.fichier.encodage}, séparateur « ${ingestion.fichier.separateur} », ${ingestion.fichier.colonnes_lues?.length ?? "?"} colonnes lues`);
      if (ingestion.fichier.alias_appliques?.length) lines.push(`- en-têtes traduits : ${ingestion.fichier.alias_appliques.join(", ")}`);
      if (ingestion.fichier.colonnes_ignorees?.length) lines.push(`- colonnes ignorées : ${ingestion.fichier.colonnes_ignorees.join(", ")}`);
      if (ingestion.fichier.lignes_ignorees?.length) {
        lines.push(`- **${ingestion.fichier.lignes_ignorees.length} ligne(s) écartée(s) à la lecture** : ${ingestion.fichier.lignes_ignorees.slice(0, 10).map((l) => `ligne ${l.ligne} (${l.motif})`).join(" ; ")}`);
      }
    }
    lines.push(`- lignes : ${ingestion.lignes?.lues ?? "?"} lues · ${ingestion.lignes?.retenues ?? "?"} retenues · ${ingestion.lignes?.refusees ?? 0} refusées`);
    lines.push(`- à loger : ${c.a_loger ?? "?"} passagers · ${c.dossiers ?? "?"} dossiers — J ${c.parCabine?.J ?? 0} / W ${c.parCabine?.W ?? 0} / Y ${c.parCabine?.Y ?? 0}`);
    lines.push(`- types : ${c.parType?.ADT ?? 0} ADT, ${c.parType?.CHD ?? 0} CHD, ${c.parType?.INF ?? 0} INF · PMR ${c.pmr ?? 0} · animaux ${c.animaux ?? 0} · groupes ${c.groupes?.length ?? 0}`);
    lines.push(`- hors plan hôtel : ${c.escalades?.nominative ?? 0} nominative(s) · ${c.escalades?.droit_entree ?? 0} sur droit d'entrée · équipage ${c.equipage ?? 0}`);
    const exclus = Object.entries(c.exclus ?? {}).map(([k, n]) => `${k} ${n}`).join(", ");
    if (exclus) lines.push(`- exclus du plan (non logés) : ${exclus}`);
    if (c.fiches) {
      lines.push(
        `- identité pour les fiches (C3) : ${c.fiches.completes ?? 0} complète(s) sur ${c.fiches.attendues ?? 0} — ` +
          `manques : ${Object.entries(c.fiches.manques ?? {}).filter(([, n]) => n > 0).map(([col, n]) => `${col} ${n}`).join(", ") || "aucun"}`,
      );
    }
    if (ingestion.alias_valeurs?.length) lines.push(`- valeurs traduites : ${ingestion.alias_valeurs.join(" · ")}`);
    lines.push("");
  }

  lines.push(`## Relevés par hôtel`);
  lines.push("");
  for (const inv of inventories) {
    const a = inv.answer;
    lines.push(`### ${a?.hotel || inv.name || inv.hotelKey || inv.hotel}`);
    lines.push("");
    lines.push(`- session : \`${inv.sessionId ?? "-"}\` · statut ${inv.status ?? "-"} · outcome ${inv.outcome ?? "-"}`);
    if (inv.error) lines.push(`- erreur : ${inv.error}`);
    if (a?.found) {
      if (a.observed_at) lines.push(`- **prix relevé le ${fmtDateTime(a.observed_at)}** — prix affiché, non garanti`);
      const am = a.amenities ?? {};
      const dist = a.distance_km ?? a.distance_to_airport_km;
      lines.push(
        `- ${a.stars || "?"}★ · note ${a.review_score ?? "?"}/10 (${a.review_count ?? "?"} avis) · ` +
          `${dist >= 0 ? `${dist} km (réf. ${a.distance_ref ?? "airport"})` : "distance non affichée"} · devise ${a.currency}`,
      );
      lines.push(
        `- équipements déclarés par la plateforme : wifi ${am.wifi_free ? "oui" : "non"} · room service ${am.room_service ?? "?"} · ` +
          `espace travail ${am.workspace === true || am.workspace === "oui" ? "oui" : am.workspace === "non_precise" ? "non précisé" : "non"} · ` +
          `navette ${am.airport_shuttle ?? "?"} · resto tardif ${am.restaurant_late ? "oui" : "non"} · PMR ${am.accessible ? "oui" : "non"}`,
      );
      if (a.payment) {
        lines.push(`- paiement : prépaiement en ligne ${a.payment.prepayment_online ?? "non précisé"} · paiement sur place uniquement ${a.payment.pay_at_property_only === true ? "oui" : a.payment.pay_at_property_only === false ? "non" : "non précisé"}`);
      }
      if (a.notes) lines.push(`- notes agent : ${a.notes}`);
      lines.push("");
      lines.push(`| Type de chambre | Capacité | Famille | Dispo affichée | Plafond atteint | Prix/nuit | Annul. gratuite | Petit-déj |`);
      lines.push(`|---|---|---|---|---|---|---|---|`);
      for (const r of a.rooms ?? []) {
        const displayed = r.quantity_available ?? r.quantity_displayed_max ?? "?";
        lines.push(
          `| ${r.room_type} | ${r.occupancy_adults}A+${r.occupancy_children ?? 0}C | ${r.family_capable ? "oui" : "-"} | ` +
            `${displayed} | ${r.cap_reached ? "oui (borne basse)" : "-"} | ${fmtMontant(r.price_per_night)} | ` +
            `${r.free_cancellation ? "oui" : "non"} | ${r.breakfast_included ? "oui" : "non"} |`,
        );
      }
    } else if (a) {
      lines.push(`- found=false : ${a.notes || "sans détail"}`);
    }
    lines.push("");
  }

  /* C2 — qualité des relevés : ce que le filtre de vraisemblance a écarté et pourquoi.
     Une ligne écartée est une chambre qui N'EXISTE PAS dans le plan : si le rapport ne la
     montre pas, l'écart entre « ce que le site affichait » et « ce que l'outil a retenu »
     est invisible, et le validateur croit à un relevé pauvre plutôt qu'à un filtrage. */
  const qualite = (inventories ?? []).map((inv) => ({
    nom: inv.answer?.hotel || inv.name || inv.hotelKey || inv.hotel,
    rejected: inv.answer?.rooms_rejected ?? inv.roomsRejected ?? [],
    all: inv.answer?.rooms_rejected_all === true,
    overCap: inv.answer?.rooms_over_cap ?? [],
    warns: inv.answer?.quality_warnings ?? [],
  })).filter((q) => q.rejected.length || q.warns.length || q.overCap.length);
  if (qualite.length) {
    lines.push(`## Qualité des relevés (lignes écartées, quantités invraisemblables)`);
    lines.push("");
    for (const q of qualite) {
      lines.push(`### ${q.nom}`);
      lines.push("");
      if (q.all) lines.push(`- **toutes les lignes de cet hôtel ont été écartées** : il n'apporte aucune chambre au plan`);
      for (const r of q.rejected) {
        lines.push(
          `- écartée : « ${r.room_type ?? "?"} » — ${r.reason ?? "motif non précisé"} ` +
            `(prix ${fmtMontant(r.price_per_night)}, quantité ${r.quantity_available ?? "?"})`,
        );
      }
      for (const r of q.overCap) {
        lines.push(`- conservée mais **quantité au-dessus du seuil de vraisemblance** : « ${r.room_type ?? "?"} » — ${r.quantity_available ?? "?"} chambres annoncées`);
      }
      for (const w of q.warns) lines.push(`- ${w}`);
      lines.push("");
    }
  }

  const parHotel = new Map();
  for (const row of plan) {
    if (row.statut !== "OK" || !row.hotel) continue;
    const e = parHotel.get(row.hotel) ?? { chambres: 0, fermes: 0, aConfirmer: 0, personnes: 0, dossiers: 0, url: row.hotel_url, reglement: row.mode_reglement, mesure: true, couronnes: new Set() };
    const ch = Number(row.chambres) || 0;
    e.chambres += ch;
    // la couronne de l'hôtel décide du TRANSPORT à commander pour ce bloc
    const ct = couronneTexte(row);
    if (ct) e.couronnes.add(ct);
    // ventilation par établissement — le chiffre exact que l'agent d'escale annonce au
    // téléphone. Ligne d'un plan antérieur sans les compteurs : repli sur `stock_mesure`.
    const nf = Number(row.chambres_fermes);
    const na = Number(row.chambres_a_confirmer);
    if (Number.isFinite(nf) || Number.isFinite(na)) {
      e.fermes += Number.isFinite(nf) ? nf : 0;
      e.aConfirmer += Number.isFinite(na) ? na : 0;
    } else if (row.stock_mesure === true) e.fermes += ch;
    else e.aConfirmer += ch;
    e.personnes += Number(row.pax) || 0;
    e.dossiers += 1;
    if (row.stock_mesure !== true) e.mesure = false;
    parHotel.set(row.hotel, e);
  }
  if (parHotel.size) {
    lines.push(`## À appeler — totaux par hôtel`);
    lines.push("");
    lines.push(`| Hôtel | Couronne (trajet DÉCLARÉ) | Téléphone | Adresse | Dossiers | Chambres | dont FERMES | dont À CONFIRMER | Personnes | Règlement |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const [hotel, e] of [...parHotel.entries()].sort((a, b) => b[1].chambres - a[1].chambres)) {
      const coord = contacts.de(hotel);
      lines.push(
        `| ${hotel} | ${[...e.couronnes].join(" / ") || NON_RELEVE} | ${coord.telephone} | ${coord.adresse} | ${e.dossiers} | **${e.chambres}** | ${e.fermes} | ` +
          `${e.aConfirmer ? `**${e.aConfirmer}**` : "0"} | ${e.personnes} | ${e.reglement || "?"} |`,
      );
    }
    lines.push("");
    lines.push(
      `Ce que l'agent d'escale annonce au téléphone, établissement par établissement : **le total de chambres**, ` +
        `dont la part **ferme** (quantité mesurée sur le site) et la part **à confirmer** (sélecteur plafonné : le site ` +
        `n'a donné qu'une borne basse). La part « à confirmer » est le vrai objet de l'appel — c'est elle qui peut manquer.`,
    );
    lines.push("");
    lines.push(
      `La colonne **Couronne** commande le TRANSPORT : c'est le nombre de personnes de la ligne qu'il faut acheminer au ` +
        `temps de trajet déclaré indiqué. Un bus groupé pour une couronne à 60 min ne se commande pas comme un taxi pour ` +
        `une couronne à 15 min — et ce temps est **déclaré par l'exploitation**, il n'a été mesuré par personne.`,
    );
    lines.push("");
    if (contacts.vide) {
      lines.push(
        `Aucun téléphone ni aucune adresse n'est relevé : les agents ne relèvent que des informations publiques de prix ` +
          `et de disponibilité (INV-3), et les fiches d'inventaire portent \`contact.phone: null\`. Les coordonnées sont à ` +
          `reprendre du contrat d'escale ou de la fiche de l'établissement — rien n'est deviné ici.`,
      );
      lines.push("");
    }
    lines.push(`Détail nominatif par établissement : \`rooming-<runId>.csv\`. Aucune réservation n'est faite par l'outil (INV-1) : ces totaux sont ce qu'il faut demander à chaque hôtel.`);
    lines.push("");
  }

  // un plan peut n'avoir AUCUN dossier sans chambre et manquer quand même de couchages
  // (tout le monde logé, mais des chambres trop petites) : sous l'ancienne condition, ce
  // manque-là disparaissait du rapport alors que c'est un appel hôtelier à passer.
  const couchagesGap = Object.entries(gaps.couchagesManquants ?? {});
  if (Object.keys(gaps.chambresManquantes).length || couchagesGap.length) {
    lines.push(`## Manques (escalade desk)`);
    lines.push("");
    for (const [tier, n] of Object.entries(gaps.chambresManquantes)) {
      lines.push(`- cabine ${tier} : ${n} chambre(s) non couvertes par l'inventaire en ligne`);
    }
    for (const [tier, n] of couchagesGap) {
      lines.push(`- cabine ${tier} : ${n} chambre(s) supplémentaires seraient nécessaires pour les couchages manquants (dossiers déjà logés)`);
    }
    lines.push("");
  }

  if (extension) {
    lines.push(`## Extension`);
    lines.push("");
    lines.push(`- vagues exécutées : ${extension.waves ?? 0} · sondes : ${extension.probes ?? 0} · relevés supplémentaires : ${extension.surveys ?? 0}`);
    if (extension.limits) {
      // un coût jamais rapporté par la plateforme se DIT ; il ne s'imprime pas « 0 »
      const coutBorne = extension.limits.cost_usd === null || extension.limits.cost_usd === undefined
        ? "NON MESURÉ" : extension.limits.cost_usd;
      lines.push(`- bornes : ${extension.limits.sessions_used ?? "?"}/${extension.limits.sessions_max ?? "?"} sessions · ${coutBorne}/${extension.limits.cost_max ?? "?"} USD`);
      if (extension.limits.minutes_max) {
        lines.push(`- horloge du run (C5) : ${extension.limits.minutes_used ?? "?"}/${extension.limits.minutes_max} minutes`);
      }
    }
    lines.push("");
  }

  if (cost) {
    lines.push(`## Coût`);
    lines.push("");
    // C7 — le moteur met `null` quand il refuse d'additionner des devises : on écrit
    // « indéterminé », jamais « 0 ». Le détail par devise reste la source de vérité.
    const dev = cost.devise_unique ?? null;
    const suffixe = cost.devise_unique_supposee ? " *(devise non affichée par les relevés, supposée)*" : "";
    if (cost.bloquant) {
      lines.push(
        `- **aucun total consolidé** : le plan mélange ${(cost.devises ?? []).filter((d) => d !== "?").join(", ")} ` +
          `et aucun taux de change n'est appliqué (INV-3). Les montants ci-dessous sont ventilés par devise.`,
      );
    } else {
      lines.push(
        `- par nuit : J ${fmtMontant(cost.per_night.J, dev)} + W ${fmtMontant(cost.per_night.W, dev)} + ` +
          `Y ${fmtMontant(cost.per_night.Y, dev)} = **${fmtMontant(cost.per_night.total, dev)}**${suffixe}`,
      );
      lines.push(`- projection ${cost.nights} nuit${cost.nights > 1 ? "s" : ""} : **${fmtMontant(cost.projection_total, dev)}**`);
    }
    if (cost.par_devise && Object.keys(cost.par_devise).length) {
      lines.push(`- par devise et par nuit :`);
      for (const [d, bloc] of Object.entries(cost.par_devise)) {
        const libelle = d === "?" ? `${cost.devise_reference ?? "EUR"} (devise non affichée)` : d;
        lines.push(`  - ${libelle} : J ${fmtMontant(bloc.J)} · W ${fmtMontant(bloc.W)} · Y ${fmtMontant(bloc.Y)} — total ${fmtMontant(bloc.total)}`);
      }
    }
    // Le périmètre du total, dit à l'endroit où on lit le total (C2/C7) : sans cette ligne,
    // « 22 846 EUR » se lit comme la facture de l'escale alors que des passagers n'ont pas de chambre.
    const escaladees = Object.entries(cost.escalated_rooms ?? {}).filter(([, n]) => Number(n) > 0);
    if (escaladees.length) {
      lines.push(
        `- **périmètre : les dossiers en escalade ne sont PAS dans ce total** — ` +
          `${escaladees.map(([t, n]) => `${t} ${n} chambre(s)`).join(" · ")} restent à loger et à payer en plus`,
      );
    }
    lines.push(`- borne haute aux plafonds (une chambre par passager) : ${fmtMontant(cost.upper_bound_at_caps, "EUR")}`);
    lines.push(`- repas : ${cost.allowances.meal === null ? "non renseigné" : fmtMontant(cost.allowances.meal, "EUR")} · transport : ${cost.allowances.transport === null ? "non renseigné" : fmtMontant(cost.allowances.transport, "EUR")}`);
    if (cost.not_determinable.length) lines.push(`- postes non déterminables : ${cost.not_determinable.join(", ")}`);
    if ((cost.prix_illisibles ?? []).length) {
      lines.push(`- **${cost.prix_illisibles.length} ligne(s) au prix illisible exclues du total** : ${cost.prix_illisibles.slice(0, 10).join(", ")}`);
    }
    lines.push("");

    /* C7 — la commande à passer à l'émetteur de cartes. Sans cette section, le montant à
       charger n'existe nulle part et le comptoir distribue des cartes vides. */
    const cp = cost.cartes_prepayees;
    if (cp && (cp.actives || cp.nombre_lignes)) {
      lines.push(`## Cartes prépayées (C7)`);
      lines.push("");
      lines.push(`- ${cp.nombre_cartes} carte(s) pour ${cp.nombre_lignes} dossier(s) — une carte par ${cp.per}`);
      lines.push(`- postes chargés : ${cp.load_includes.join(", ") || "**aucun** (politique à compléter)"} · marge ${fmtMontant(cp.marge_eur, "EUR")} · arrondi ${fmtMontant(cp.arrondi_eur, "EUR")}${cp.plafond_eur === null ? "" : ` · plafond ${fmtMontant(cp.plafond_eur, "EUR")}`}`);
      lines.push(`- **montant total à charger : ${fmtMontant(cp.montant_total_a_charger, cp.devises.length === 1 ? cp.devises[0] : null)}**`);
      for (const [d, v] of Object.entries(cp.montant_total_par_devise ?? {})) lines.push(`  - cartes complètes en ${d} : ${fmtMontant(v, d)}`);
      for (const [d, v] of Object.entries(cp.montant_partiel_par_devise ?? {})) {
        lines.push(`  - cartes INCOMPLÈTES en ${d} : ${fmtMontant(v, d)} — montant partiel, à compléter avant émission`);
      }
      lines.push(`- cartes complètes : ${cp.cartes_completes} · **incomplètes : ${cp.cartes_incompletes}**`);
      if (cp.escalades.length) lines.push(`- **${cp.escalades.length} escalade(s) « carte insuffisante »** : ${cp.escalades.slice(0, 10).map((e) => `${e.pnr} (${fmtMontant(e.montant_par_carte, e.devise)})`).join(", ")}`);
      for (const a of cp.avertissements) lines.push(`- ${a}`);
      lines.push("");
    }
  }

  /* C3 — les fiches. Le plan s'arrête au dossier ; un registre d'hôtel se remplit par
     personne. Cette section dit combien de formulaires sortent et ce qui y reste blanc. */
  if (fiches?.resume) {
    const r = fiches.resume;
    lines.push(`## Fiches d'enregistrement par passager (C3)`);
    lines.push("");
    lines.push(`Livrables : \`${fiches.fichiers?.csv ?? "fiches-<runId>.csv"}\` (tableur) et \`${fiches.fichiers?.html ?? "fiches-<runId>.html"}\` (imprimable, une fiche par page).`);
    lines.push("");
    lines.push(`- **${r.fiches} fiche(s)** — ${r.logees} avec hôtel affecté, ${r.non_logees} à traiter au comptoir`);
    lines.push(`- **${r.incompletes} fiche(s) à identité incomplète** : blancs à remplir passeport en main au comptoir`);
    // les heures de retour portées par les fiches : c'est l'information que le passager
    // cherche en premier, et un blanc marqué doit être compté comme du travail au comptoir
    if (r.correspondances) {
      lines.push(
        `- **${r.correspondances} fiche(s) en correspondance** portent le vol suivant et l'heure limite de retour à l'aéroport` +
          (r.retours_incalculables
            ? `, dont **${r.retours_incalculables} dossier(s) au blanc marqué** (horaire du vol suivant non transmis ou temps ` +
              `de trajet non déclaré) : heure à établir au comptoir, rien n'a été deviné`
            : ` — calculée sur les mêmes paramètres que le budget de trajet (\`policy.global.correspondance\`)`),
      );
    }
    const manques = Object.entries(r.manques ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    if (manques.length) lines.push(`- champs non transmis par la compagnie : ${manques.map(([col, n]) => `${col} (${n})`).join(", ")}`);
    const formats = Object.entries(r.formats ?? {}).sort((a, b) => b[1] - a[1]);
    if (formats.length) {
      lines.push(`- formats de chambre (en DOSSIERS, pas en fiches) : ${formats.map(([f, n]) => `${f} × ${n}`).join(" · ")}`);
    }
    // les avertissements des fiches sont rendus ICI, à côté du chiffre qu'ils expliquent,
    // et pas une seconde fois en fin de rapport ; celui qui ne fait que répéter le compte
    // d'identités incomplètes est omis (la ligne ci-dessus le dit déjà)
    for (const a of fiches.avertissements ?? []) if (!/identité incomplète/i.test(a)) lines.push(`- ${a}`);
    lines.push("");
  } else {
    lines.push(`## Fiches d'enregistrement par passager (C3)`);
    lines.push("");
    // Le rapport ne sait pas si les fiches ont été construites ailleurs : il sait
    // seulement qu'on ne les lui a pas transmises. Écrire « aucune fiche n'a été
    // produite » serait affirmer un fait invérifiable — et faux dès qu'un appelant
    // écrit `fiches-<runId>.csv` sans passer `ctx.fiches`. On dit ce qu'on sait.
    lines.push(
      `**Aucune fiche n'est jointe à ce rapport** : les fiches n'ont pas été transmises ici ` +
        `(\`ctx.fiches\`, sortie de \`buildFichesOutputs\`). Ce rapport ne peut donc ni les compter ni dire ce qui ` +
        `y reste en blanc.`,
    );
    lines.push("");
    lines.push(
      `Vérifiez la présence de \`fiches-<runId>.csv\` et \`fiches-<runId>.html\` parmi les livrables du run : ` +
        `si ces fichiers manquent, la totalité des formulaires de saisie est à établir à la main au comptoir.`,
    );
    lines.push("");
  }

  /* C4 — l'écart avec une équipe d'escale, chiffré. C'est la section qui permet au client
     de dimensionner l'équipe résiduelle au lieu de croire qu'il n'en a plus besoin. */
  // VIVIER DE REPLI (21/09) : les etablissements connus par annuaire seulement. Ils ne sont
  // PAS dans le plan — aucun prix public (INV-3) — mais ce sont des chambres joignables au
  // telephone, et c'est ce qui permet de depasser ce que les plateformes referencent.
  const leads = (ctx.entrees ?? []).filter((h) => h?.source === "lead" && !h?.excluded);
  if (leads.length) {
    lines.push(`## Vivier de repli à APPELER — hors plateforme de réservation`);
    lines.push("");
    lines.push(
      `**${leads.length} établissement(s)** trouvés par annuaire : ils ne figurent sur aucune plateforme de ` +
      `réservation exploitée par l'outil, donc **aucun prix public et aucune disponibilité** n'a pu être relevé ` +
      `(INV-3). Ils ne sont PAS dans le plan et ne sont pas chiffrés. Ce sont des chambres à obtenir **par ` +
      `téléphone** — c'est le levier quand le vivier en ligne ne suffit pas.`,
    );
    lines.push("");
    lines.push(`| Établissement | Téléphone | Adresse | Note | Source |`);
    lines.push(`|---|---|---|---|---|`);
    for (const h of leads) {
      lines.push(
        `| ${h.name} | **${h.contact?.phone || NON_RELEVE}** | ${h.adresse || h.address || NON_RELEVE} | ` +
        `${h.review_score ?? NON_RELEVE} | ${h.source_cle || "annuaire"} |`,
      );
    }
    const sansTel = leads.filter((h) => !h.contact?.phone).length;
    lines.push("");
    if (sansTel) {
      lines.push(
        `${sansTel} établissement(s) sans téléphone relevé : le nom et l'adresse sont là, le numéro reste à ` +
        `trouver. Aucun numéro n'a été deviné.`,
      );
      lines.push("");
    }
  }
  lines.push(`## Travail humain restant (C4) — ce que l'outil NE fait pas`);
  lines.push("");
  const dossiersDesk = dossiersSansChambre;
  const cartesAEmettre = cost?.cartes_prepayees?.nombre_cartes ?? null;
  const cartesIncompletes = cost?.cartes_prepayees?.cartes_incompletes ?? null;
  lines.push(`L'outil s'arrête au PLAN (INV-1 : aucune réservation n'est faite, aucun hôtel n'est appelé, aucune carte n'est commandée). Restent à faire, après validation :`);
  lines.push("");
  lines.push(`- **${parHotel.size} appel(s) hôtelier(s)** à passer pour confirmer les blocs de chambres`);
  lines.push(
    `- **${chambresOk} chambre(s) à demander** aux établissements` +
      (niveaux.connu
        ? ` : **${niveaux.fermes} ferme(s)** (stock mesuré, l'appel les confirme) et **${niveaux.aConfirmer} à confirmer** ` +
          `(stock non mesuré — à traiter EN PREMIER : ce sont celles qui peuvent manquer)`
        : ` — ventilation ferme / à confirmer indéterminée pour ce plan`),
  );
  lines.push(`- **${dossiersDesk} dossier(s) à traiter au comptoir** faute de chambre + **${summary.horsPlan ?? 0} dossier(s) en prise en charge nominative** (civière, médical, mineur non accompagné, droit d'entrée)`);
  // COURONNES — le transport n'est ni commandé ni réservé par l'outil : le dire avec le
  // chiffre par couronne, sinon personne ne sait combien de sièges affréter ni pour quand.
  const couronnesDuPlan = Object.entries(summary.parCouronne ?? {});
  if (couronnesDuPlan.length) {
    lines.push(
      `- **transport à commander, couronne par couronne** : ` +
        couronnesDuPlan
          .map(([cle, c]) => {
            const ou = cle === "hors_couronnes" ? "hors couronnes" : cle === "inconnue" ? "couronne indéterminée" : `couronne ${cle}`;
            const t = c.trajet_min_declare === null || c.trajet_min_declare === undefined || c.trajet_min_declare === ""
              ? "trajet NON DÉCLARÉ"
              : `${c.trajet_min_declare} min déclarées`;
            return `**${ou}** ${c.pax} personne(s) en ${c.mode || "mode non déclaré"} (${t})`;
          })
          .join(" · ") +
        ` — aucun véhicule n'est réservé par l'outil, et ces durées sont déclarées, pas mesurées`,
    );
  }
  if (summary.escaladesTempsTrajet) {
    lines.push(
      `- **${summary.escaladesTempsTrajet} dossier(s) sans solution d'hébergement dans leur temps de trajet** : repos côté ` +
        `piste, salon ou chambre plus proche à obtenir à la main — des relevés d'hôtels supplémentaires ne les logeront pas`,
    );
  }
  if (summary.couchagesInsuffisants) lines.push(`- **${summary.couchagesInsuffisants} dossier(s)** dont le couchage est à compléter avec l'hôtel (${summary.paxSansCouchage} personne(s))`);
  if (fiches?.resume) {
    lines.push(`- **${fiches.resume.incompletes} fiche(s) incomplète(s)** sur ${fiches.resume.fiches} à compléter au comptoir, document de voyage en main`);
  } else {
    lines.push(
      `- **fiches passagers : non transmises à ce rapport** — se reporter aux livrables \`fiches-<runId>.*\` du run ; ` +
        `à défaut, la totalité des formulaires reste à établir`,
    );
  }
  if (cartesAEmettre !== null) {
    lines.push(`- **${cartesAEmettre} carte(s) prépayée(s) à commander, charger et remettre**, dont ${cartesIncompletes} au montant incomplet`);
  }
  if (sansCreneau) lines.push(`- **${sansCreneau} dossier(s) sans créneau de présentation** : file d'attente à gérer à la main au comptoir`);
  const motifs = Object.entries(summary.motifs ?? {}).sort((a, b) => b[1] - a[1]);
  if (motifs.length) {
    lines.push(`- escalades par motif : ${motifs.map(([m, n]) => `**${m}** ${n}`).join(" · ")}`);
  }
  lines.push(
    `- non couvert par l'outil, de bout en bout : la négociation tarifaire, la réservation, le transport des passagers, ` +
      `la remise des cartes, l'enregistrement à l'hôtel, la gestion des litiges et le suivi du retour vol.`,
  );
  lines.push("");

  const avertIngestion = (ingestion?.avertissements ?? []).map((a) => `liste passagers : ${a.message ?? a}`);
  const avertAlloc = (summary.avertissements ?? []).map((a) => `allocation : ${a}`);
  const avertCout = (cost?.avertissements ?? []).map((a) => `coût : ${a.message ?? a}`);
  // les avertissements des fiches restent dans leur propre section (voir plus haut) :
  // les répéter ici les noierait dans les avertissements de liste passagers
  // dédoublonnage : le pipeline rediffuse une partie des avertissements d'allocation en
  // `warning`, ils arriveraient deux fois ici (préfixés et nus)
  const vus = new Set((warnings ?? []).map((w) => String(w).trim()));
  const tousAvert = [
    ...avertIngestion,
    ...avertAlloc.filter((a) => !vus.has(a.replace(/^allocation : /, "").trim())),
    ...avertCout,
    ...(warnings ?? []),
  ];
  if (tousAvert.length) {
    lines.push(`## Avertissements`);
    lines.push("");
    for (const w of tousAvert) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push(`## Limites`);
  lines.push("");
  lines.push(
    `Les quantités sont celles affichées en ligne (borne basse : le sélecteur plafonne à ~9 chambres par type). ` +
      `Les prix sont ceux relevés à l'horodatage indiqué — un prix relevé n'est pas un prix garanti. ` +
      `Les équipements sont **déclarés par la plateforme**, non audités ; les mentions « à confirmer » du plan pointent ` +
      `les exigences que la fiche ne précise pas. Les dossiers en escalade relèvent du desk groupe des hôtels. ` +
      `Aucune réservation n'a été effectuée ; prix publics uniquement, sans accord ni tarif négocié.`,
  );
  return lines.join("\n") + "\n";
}
