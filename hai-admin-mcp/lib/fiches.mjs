/**
 * Fiches d'enregistrement hôtelier — une par PERSONNE à loger (condition client C3).
 *
 * « L'outil doit être en mesure de préparer les formulaires de saisie des informations
 * pour chaque passager selon le format de chambre sélectionné : famille, PMR, business,
 * éco, ou tout autre critère sélectionné. » Le plan et la liste d'appel s'arrêtent au
 * DOSSIER ; un registre d'hôtel se remplit par PERSONNE. Ce module fait la jonction :
 * il croise les lignes du plan (hôtel, chambres, règlement) avec les lignes de la liste
 * passagers (identité, assistance, contact) et produit deux livrables :
 *
 *   - `fiches-<runId>.csv`  — une ligne par personne, colonnes documentées (FICHE_COLS),
 *     pour l'archivage, le tableur du desk et un éventuel publipostage compagnie ;
 *   - `fiches-<runId>.html` — le rendu IMPRIMABLE, une fiche par page, regroupées par
 *     hôtel puis par dossier (= par bloc de chambres).
 *
 * POURQUOI HTML ET PAS MARKDOWN. Le livrable est fait pour être imprimé et posé sur un
 * comptoir à 2 h du matin. Markdown n'a aucun moyen de garantir « une fiche par page » :
 * il faudrait un convertisseur (pandoc, wkhtmltopdf) que l'escale n'a pas. Un fichier
 * HTML autonome — aucun script, aucune ressource externe, `@page` + `break-after` dans
 * une balise `<style>` — s'ouvre d'un double-clic, s'imprime avec Ctrl+P, et donne des
 * blancs à remplir réellement rectangulaires, au stylo. Le CSV couvre le reste.
 *
 * CE QUE CE MODULE NE FAIT PAS, ET NE DOIT PAS FAIRE : aucune saisie en ligne par un
 * agent sur le site d'un hôtel. INV-5 interdit qu'une donnée passager entre dans un
 * prompt ou un événement d'agent ; les agents relèvent des chambres publiques, ils ne
 * voient aucun nom. Et remplir un formulaire d'enregistrement au nom d'un passager est
 * un arbitrage client qui n'a pas été rendu. La sortie de ce module est un DOCUMENT
 * PRÉ-REMPLI remis au comptoir, signé par le passager, saisi par l'hôtel.
 *
 * Deux marqueurs, jamais une valeur inventée :
 *   `[à remplir]`   — champ qui se remplit au comptoir ou par l'hôtel (n° de chambre) ;
 *   `[non fourni]`  — champ que la compagnie n'a pas transmis dans la liste passagers.
 * La distinction est le sujet : le premier est normal, le second est un manque à
 * réclamer à la compagnie (il est chiffré par le rapport d'ingestion, `fiches_incompletes`).
 *
 * Fonctions PURES : aucune écriture disque, aucun accès réseau, aucune date implicite
 * hors `now`. L'appelant (rapport.mjs / run-manager.mjs / tools/rebooking-v2.mjs) décide
 * où écrire et quand purger (`policy.retention.nominative_hours`).
 */
import { toCsvBom } from "./csv.mjs";
import { effectiveCaps } from "./policy.mjs";
import { PAXLIST_IDENTITE, PAXLIST_IDENTITE_ESSENTIELLE, parseSsr, PMR_SSR, ESCALADE_SSR } from "./paxlist.mjs";

/** Champ à compléter au comptoir, par l'hôtel ou par le passager. */
export const A_REMPLIR = "[à remplir]";
/** Champ que la liste passagers de la compagnie ne portait pas (PAXLIST v2, §3.3bis). */
export const NON_FOURNI = "[non fourni]";

/**
 * Libellés des codes SSR qui changent la prise en charge hôtelière. Un code brut
 * (« WCHC ») ne veut rien dire pour un réceptionniste : la fiche porte la phrase.
 */
const SSR_LIBELLES = {
  WCHR: "fauteuil roulant jusqu'à la chambre (le passager monte quelques marches)",
  WCHS: "fauteuil roulant, ne monte pas les escaliers : ascenseur obligatoire",
  WCHC: "passager non ambulant : chambre PMR réelle et transfert adapté",
  WCBD: "fauteuil personnel à batterie : prise de recharge en chambre",
  WCBW: "fauteuil pliant personnel : rangement en chambre",
  WCMP: "fauteuil manuel personnel",
  BLND: "déficience visuelle : accompagnement jusqu'à la chambre",
  DEAF: "déficience auditive : alarme incendie visuelle requise",
  DPNA: "assistance à l'orientation : accompagnement desk → chambre",
  BSCT: "berceau demandé",
  MAAS: "accueil et accompagnement en escale",
  STCR: "civière : transport sanitaire, hors hébergement hôtelier ordinaire",
  MEDA: "cas médical : validation médicale avant hébergement",
  UMNR: "mineur non accompagné : prise en charge nominative par la compagnie",
  UNN: "mineur non accompagné : prise en charge nominative par la compagnie",
};

/** Libellé de cabine tel qu'il doit apparaître sur un document remis à un hôtelier. */
const CABINE_LIBELLE = { J: "business", W: "premium éco", Y: "éco" };

/** Colonnes du CSV `fiches-<runId>.csv` — ordre stable, documenté §3 de la notice. */
export const FICHE_COLS = [
  "fiche_ref", "run_id", "vol", "statut_fiche",
  "hotel", "hotel_url", "hotel_adresse", "nuit_du", "nuit_au", "nuits",
  "chambre_no", "room_type", "format_chambre", "chambres_dossier",
  "pnr", "nom", "prenom", "sexe", "date_naissance", "age", "nationalite",
  "passeport_num", "passeport_exp", "passeport_pays", "adresse_domicile",
  "type_pax", "cabine", "bareme_eur_nuit",
  "occupants_chambre", "adulte_referent", "berceau",
  "pmr_assistance", "pmr_chambre_accessible", "pmr_transfert", "contact_a_prevenir",
  "contact_telephone", "contact_email",
  "mode_reglement", "montant_carte_eur", "devise", "conformite",
  // GÉOGRAPHIE ET TEMPS — la couronne retenue, le temps de trajet DÉCLARÉ (jamais mesuré),
  // le vol suivant et les deux heures qui décident de la soirée du passager : à quelle
  // heure il doit être revenu à l'aéroport, et donc à quelle heure le bus repart de l'hôtel.
  "couronne", "transfert", "trajet_min_declare",
  "vol_correspondance", "heure_vol_suivant",
  "retour_aeroport_au_plus_tard", "depart_hotel_au_plus_tard",
  "escalade_motif", "identite_a_verifier", "notes", "signature",
];

const norm = (v) => String(v ?? "").trim();
const TYPE_ORDRE = { ADT: 0, CHD: 1, INF: 2 };

/**
 * Format de chambre de la ligne, au sens de C3 : les surcouches d'abord (ce qui
 * contraint la chambre), la cabine ensuite (ce qui fixe le barème).
 * @param {object} planRow ligne du plan (allocate.mjs)
 * @returns {string} ex. « PMR + FAMILLE + business (J) »
 */
export function formatChambre(planRow) {
  const overlays = norm(planRow?.overlays).split("+").filter(Boolean);
  const cabine = norm(planRow?.cabine);
  const libelle = CABINE_LIBELLE[cabine] ?? "cabine non renseignée";
  return [...overlays, `${libelle}${cabine ? ` (${cabine})` : ""}`].join(" + ");
}

/** Libellé du bloc « aucun hôtel affecté » dans le résumé par hôtel. */
const COMPTOIR = "(sans hôtel — comptoir)";

/** Horloge murale `AAAA-MM-JJTHH:MM` (ou avec une espace) — la forme de `heure_correspondance`. */
const HORLOGE_FICHE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * Les deux heures qui décident de la soirée d'un passager en correspondance :
 *
 *   - **retour à l'aéroport au plus tard** = heure du vol suivant − `avance_avant_vol_min`.
 *     C'est l'heure à laquelle il doit être REVENU, présentation à l'enregistrement comprise.
 *   - **départ de l'hôtel au plus tard** = ce retour − le temps de trajet DÉCLARÉ de la
 *     couronne − `marge_min` (bus, file d'attente, bagages). C'est l'heure à laquelle le
 *     bus repart : l'information la plus utile de toute la fiche.
 *
 * Les paramètres sont EXACTEMENT ceux du budget de trajet (`policy.global.correspondance`,
 * lus par `calculerBudgetTrajet`) : la fiche ne peut donc pas contredire le plan.
 *
 * RIEN N'EST ESTIMÉ. Sans heure de vol suivant, ou sans temps de trajet déclaré pour la
 * couronne retenue, la valeur correspondante vaut `null` et l'appelant imprime un blanc
 * MARQUÉ — jamais un horaire plausible. Le temps de trajet est déclaré par l'exploitation,
 * il n'a été mesuré par personne : ces heures ne sont pas des horaires garantis.
 *
 * @param {object} args
 * @param {string} args.heure heure murale du vol suivant, `AAAA-MM-JJTHH:MM` (escale)
 * @param {number|string|null} [args.trajetMinDeclare] temps de trajet DÉCLARÉ de la couronne
 * @param {object|null} [args.correspondance] `policy.global.correspondance`
 * @returns {{retour: string|null, departHotel: string|null, avance: number, marge: number,
 *            trajet: number|null, motif: string}} heures en `AAAA-MM-JJ HH:MM`
 */
export function heuresRetour({ heure, trajetMinDeclare = null, correspondance = null }) {
  const avance = Number(correspondance?.avance_avant_vol_min);
  const marge = Number(correspondance?.marge_min);
  const av = Number.isFinite(avance) ? avance : 0;
  const mg = Number.isFinite(marge) ? marge : 0;
  // `Number(null)` vaut 0 : sans ce test, un dossier SANS temps de trajet déclaré (une
  // ligne escaladée, qui n'a même pas d'hôtel) se verrait calculer une heure de départ
  // d'hôtel à « retour − marge », c'est-à-dire un horaire de bus pour un bus qui n'existe pas.
  const trajet =
    trajetMinDeclare === null || trajetMinDeclare === undefined || trajetMinDeclare === ""
      ? null
      : (() => {
        const n = Number(trajetMinDeclare);
        return Number.isFinite(n) && n >= 0 ? n : null;
      })();

  const m = HORLOGE_FICHE.exec(norm(heure));
  if (!m) return { retour: null, departHotel: null, avance: av, marge: mg, trajet, motif: "aucune heure de vol suivant exploitable" };

  // arithmétique sur une horloge MURALE : Date.UTC sert de calendrier, jamais de fuseau.
  // Le résultat est relu en UTC, il reste donc l'heure murale de l'escale, décalée.
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const fmt = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const retourMs = base - av * 60_000;
  return {
    retour: fmt(retourMs),
    // sans temps de trajet déclaré, l'heure de départ de l'hôtel n'existe pas : la
    // déduire d'une distance serait exactement la conversion que l'outil s'interdit
    departHotel: trajet === null ? null : fmt(retourMs - (trajet + mg) * 60_000),
    avance: av,
    marge: mg,
    trajet,
    motif: trajet === null ? "temps de trajet de la couronne non déclaré" : "",
  };
}

/** Nom d'affichage d'une personne : « Prénom NOM », le nom en capitales comme sur le document de voyage. */
const nomAffiche = (p) => [norm(p.prenom), norm(p.nom).toUpperCase()].filter(Boolean).join(" ") || A_REMPLIR;

/**
 * Repli sur le contact du DOSSIER quand la personne n'a donné ni téléphone ni e-mail.
 * La valeur est imprimée — c'est le seul moyen de joindre la chambre — mais sa
 * provenance est dite : une fiche ne prête pas à un passager le numéro d'un autre.
 */
const contactDuDossier = (v) => (v ? `${v} (contact du dossier)` : A_REMPLIR);

/** Noms des livrables du run — un seul endroit pour la vague 2. */
export function fichesFileNames(runId) {
  return { csv: `fiches-${runId}.csv`, html: `fiches-${runId}.html` };
}

/**
 * Personnes d'un dossier, dans l'ordre où elles doivent apparaître sur les fiches :
 * adultes d'abord (l'un d'eux est le référent des mineurs), puis enfants, puis bébés.
 */
function personnesDuDossier(rows) {
  return [...rows].sort(
    (a, b) => (TYPE_ORDRE[a.type_pax] ?? 0) - (TYPE_ORDRE[b.type_pax] ?? 0) ||
      norm(a.nom).localeCompare(norm(b.nom), "fr") || norm(a.prenom).localeCompare(norm(b.prenom), "fr"),
  );
}

/** Codes SSR d'une personne qui méritent une phrase sur la fiche. */
function assistanceDe(personne) {
  const codes = personne.ssr ?? parseSsr(personne.assistance);
  return codes
    .filter((c) => PMR_SSR.has(c) || ESCALADE_SSR[c] || SSR_LIBELLES[c])
    .map((c) => `${c} : ${SSR_LIBELLES[c] ?? "assistance déclarée"}`);
}

/**
 * Construit les fiches du run. Une fiche par PERSONNE d'une ligne du plan — y compris
 * les dossiers NON LOGÉS et les escalades : c'est justement au comptoir qu'ils sont
 * traités, et une prise en charge nominative sans document à la main ne se trace pas.
 *
 * @param {object} args
 * @param {Array<object>} args.plan lignes du plan (`allocate().plan`), logées ET escaladées
 * @param {Array<object>|null} [args.rows] lignes passagers canoniques À LOGER
 *   (`splitPaxRows().pax`) ; sans elles, une fiche par dossier au lieu d'une par personne,
 *   et un avertissement le dit
 * @param {Array<object>|null} [args.dossiers] sortie de `buildDossiers` (notes SSR, chambrage)
 * @param {object|null} [args.policy] politique validée (barème, carte prépayée, mineur seul)
 * @param {object|null} [args.station] fiche escale (transfert, facteur de plafond, adresse)
 * @param {string} [args.checkin] AAAA-MM-JJ
 * @param {string} [args.checkout] AAAA-MM-JJ
 * @param {number} [args.nights]
 * @param {string} [args.runId]
 * @param {string} [args.vol] indicatif du vol (colonne `vol` de la liste si absent)
 * @param {(planRow: object, personne: object|null) => (number|string|null)} [args.montantCartePar]
 *   montant à charger sur la carte prépayée du passager (C7). Sans cette fonction, le
 *   champ `carte_montant_eur` de la ligne de plan est lu s'il existe, sinon la fiche
 *   porte `[à remplir]` quand le règlement est une carte — jamais un montant deviné.
 * @returns {{fiches: Array<object>, resume: object, avertissements: string[]}}
 */
export function buildFiches({
  plan = [], rows = null, dossiers = null, policy = null, station = null,
  checkin = "", checkout = "", nights = 1, runId = "", vol = "", montantCartePar = null,
}) {
  const avertissements = [];
  const caps = policy ? effectiveCaps(policy, station) : null;
  if (!policy) avertissements.push("politique absente : le barème par nuit n'apparaît pas sur les fiches");
  const carte = policy?.payment?.prepaid_card ?? null;
  const exigeAccessible = policy?.global?.overlays?.pmr?.require_accessible !== false;
  const mineurSeulEscalade = policy?.global?.rooming?.minor_alone_escalates !== false;
  // Repli SEULEMENT : le transfert imprimé sur une fiche vient de la ligne de plan (donc
  // de la couronne réellement retenue). La fiche escale ne connaît qu'un maximum global,
  // elle ne sait pas si ce passager va à 4 ou à 40 km.
  const transfertFiche = station
    ? `${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min (fiche escale — couronne non renseignée sur la ligne)`
    : A_REMPLIR;
  /** Paramètres du budget de trajet : la fiche calcule les heures de retour avec EUX. */
  const correspondanceCfg = policy?.global?.correspondance ?? null;
  if (policy && !correspondanceCfg) {
    avertissements.push(
      "politique sans « global.correspondance » : aucune heure limite de retour à l'aéroport n'est calculée sur les fiches",
    );
  }
  /** Dossiers en correspondance dont une heure imprimable manque — chiffré plus bas. */
  let retoursIncalculables = 0;

  // index des personnes par dossier. Les lignes hors plan passagers (équipage,
  // non-embarqués) n'ont pas de ligne de plan : elles ne reçoivent pas de fiche ici,
  // et le résumé les compte pour que le rapport puisse le dire.
  const parPnr = new Map();
  for (const r of rows ?? []) {
    const categorie = r.categorie ?? "PAX";
    const statut = r.statut_pax ?? "A_LOGER";
    if (categorie !== "PAX" || statut !== "A_LOGER") continue;
    if (!parPnr.has(r.pnr)) parPnr.set(r.pnr, []);
    parPnr.get(r.pnr).push(r);
  }
  const dossierParPnr = new Map((dossiers ?? []).map((d) => [d.pnr, d]));
  if (!rows) {
    avertissements.push(
      "liste nominative non transmise à buildFiches : une fiche par DOSSIER au lieu d'une par personne — " +
        "l'identité et l'assistance individuelles resteront en blanc",
    );
  }

  const fiches = [];
  const manques = Object.fromEntries(PAXLIST_IDENTITE.map((c) => [c, 0]));
  let incompletes = 0;
  const formats = {};

  for (const planRow of plan) {
    const dossier = dossierParPnr.get(planRow.pnr) ?? null;
    const personnes = personnesDuDossier(parPnr.get(planRow.pnr) ?? []);
    if (rows && personnes.length === 0) {
      avertissements.push(`dossier ${planRow.pnr} : aucune ligne passager retrouvée — fiche établie sur la seule colonne « occupants » du plan`);
    }
    const loge = planRow.statut === "OK";
    const format = formatChambre(planRow);
    // ATTENTION à l'unité : `resume.formats` compte les DOSSIERS (une ligne de plan =
    // un bloc de chambres d'un même format), pas les fiches. Les deux totaux diffèrent
    // — 10 dossiers pour 23 fiches sur le fichier d'exemple — et un bandeau d'UI qui
    // les afficherait côte à côte doit le dire.
    formats[format] = (formats[format] ?? 0) + 1;

    const referent = personnes.find((p) => p.type_pax === "ADT") ?? null;
    const dossierPmr = norm(planRow.overlays).includes("PMR");
    /** La personne porte-t-elle elle-même un code d'assistance à effet chambre ? */
    const estPmr = (p) => p.pmr === true || (p.ssr ?? parseSsr(p.assistance)).some((c) => PMR_SSR.has(c));
    // l'accompagnant d'un passager PMR dort dans la chambre accessible sans être assisté :
    // sa fiche doit le dire, sinon l'hôtel lui attribue une assistance qu'il n'a pas demandée
    const assistes = personnes.filter(estPmr).map(nomAffiche);
    const occupantsChambre = personnes.length
      ? personnes.map(nomAffiche).join(", ")
      : norm(planRow.occupants) || A_REMPLIR;

    // contact du dossier : le premier renseigné fait foi pour toute la chambre
    const telDossier = personnes.map((p) => norm(p.telephone)).find(Boolean) ?? "";
    const mailDossier = personnes.map((p) => norm(p.email)).find(Boolean) ?? "";

    const montantBrut = montantCartePar
      ? montantCartePar(planRow, null)
      : planRow.carte_montant_eur ?? "";
    const carteMode = norm(planRow.mode_reglement) === "carte_prepayee";

    /* ---- géographie et temps : couronne retenue, vol suivant, heures de retour ---- */
    // `transfert` de la ligne de plan = couronne RÉELLEMENT retenue, temps DÉCLARÉ.
    const transfertLigne = norm(planRow.transfert) || transfertFiche;
    const couronneCle = norm(planRow.couronne_cle);
    const trajetBrut = Number(planRow.couronne_trajet_min_declare);
    const trajetDeclare = Number.isFinite(trajetBrut) ? trajetBrut : null;
    const couronneLibelle = !loge || !couronneCle
      ? ""
      : couronneCle === "hors_couronnes"
        ? "hors couronnes — aucun temps de trajet déclaré"
        : `couronne ${couronneCle}${planRow.couronne_source === "inconnue" ? " (À CONFIRMER : couronne non déterminée, prudence)" : ""}`;
    // correspondance : elle vient du DOSSIER (buildDossiers), jamais du plan — aucune
    // ligne de plan ne porte l'heure du vol suivant.
    const corr = dossier?.correspondance ?? null;
    const heureVolSuivant = norm(corr?.heure);
    const volSuivant = norm(corr?.vol);
    const enCorrespondance = Boolean(heureVolSuivant || volSuivant);
    const heures = heureVolSuivant
      ? heuresRetour({ heure: heureVolSuivant, trajetMinDeclare: loge ? trajetDeclare : null, correspondance: correspondanceCfg })
      : null;
    // blanc MARQUÉ, jamais un horaire plausible : la distinction est le sujet du document.
    const manquant = enCorrespondance ? A_REMPLIR : "";
    if (enCorrespondance && (!heures?.retour || (loge && !heures?.departHotel))) retoursIncalculables += 1;

    const cibles = personnes.length ? personnes : [null];
    for (const [i, personne] of cibles.entries()) {
      const p = personne ?? {};
      const type = norm(p.type_pax);
      const estMineur = type === "CHD" || type === "INF";
      const assistance = personne ? assistanceDe(p) : [];
      const pmrPersonne = personne ? estPmr(p) : false;
      const pmr = dossierPmr || pmrPersonne;

      // identité : ce qui manque est NOMMÉ, jamais comblé
      const identite = {};
      let identiteComplete = true;
      for (const col of PAXLIST_IDENTITE) {
        const v = norm(p[col]);
        if (v) { identite[col] = v; continue; }
        identite[col] = NON_FOURNI;
        if (personne) manques[col] += 1;
        if (PAXLIST_IDENTITE_ESSENTIELLE.includes(col)) identiteComplete = false;
      }
      if (!identiteComplete) incompletes += 1;

      const montantPersonne = montantCartePar && personne ? montantCartePar(planRow, personne) : montantBrut;
      const montantCarte = carteMode
        ? (montantPersonne === null || montantPersonne === undefined || montantPersonne === "" ? A_REMPLIR : montantPersonne)
        : "";

      const notes = [];
      if (pmr && !pmrPersonne && assistes.length) {
        notes.push(`chambre accessible au titre du dossier — le passager assisté est ${assistes.join(", ")}, pas le titulaire de cette fiche`);
      }
      if (dossier?.ssrNotes?.length) notes.push(...dossier.ssrNotes);
      if (norm(planRow.sous_reserve)) notes.push(`SOUS RÉSERVE : ${planRow.sous_reserve}`);
      if (norm(planRow.hors_plan)) notes.push(`hors plan hôtel : ${planRow.hors_plan} — prise en charge nominative au comptoir`);
      if (estMineur && !referent) {
        notes.push(
          mineurSeulEscalade
            ? "MINEUR SANS ADULTE au dossier : ne part pas seul à l'hôtel, escalade comptoir"
            : "mineur sans adulte identifié au dossier",
        );
      }
      if (carteMode && montantCarte === A_REMPLIR) {
        notes.push("règlement par carte prépayée : montant à charger non calculé par le run, à porter au comptoir");
      }
      // CORRESPONDANCE — ce qui n'a pas pu être calculé est dit, jamais comblé
      if (enCorrespondance && !heures?.retour) {
        notes.push(
          "CORRESPONDANCE : heure du vol suivant non exploitable — l'heure limite de retour à l'aéroport n'a PAS été " +
            "calculée, elle est à établir au comptoir sur l'horaire réel du vol",
        );
      } else if (enCorrespondance && loge && !heures?.departHotel) {
        notes.push(`CORRESPONDANCE : ${heures.motif} — heure de départ de l'hôtel à établir au comptoir`);
      }
      if (corr?.escalade) {
        notes.push(
          `CORRESPONDANCE TROP SERRÉE : ${corr.escalade}${corr.explication?.texte ? ` (${corr.explication.texte})` : ""} — ` +
            "repos côté piste à organiser, pas d'hôtel",
        );
      }
      if ((p.identite_hors_format ?? []).length) {
        notes.push(`identité à vérifier : ${p.identite_hors_format.join(", ")} hors format ISO 3166-1`);
      }
      if (norm(p.remarque)) notes.push(`remarque compagnie : ${norm(p.remarque).slice(0, 120)}`);

      fiches.push({
        fiche_ref: `${runId || "run"}-${planRow.pnr}-${String(i + 1).padStart(2, "0")}`,
        run_id: runId,
        vol: norm(vol) || norm(p.vol),
        statut_fiche: loge ? "LOGÉ" : "NON LOGÉ — COMPTOIR",
        hotel: loge ? norm(planRow.hotel) : "— aucun hôtel affecté —",
        hotel_url: loge ? norm(planRow.hotel_url) : "",
        // L'adresse n'est pas relevée par les agents (prix publics uniquement, INV-3) :
        // c'est un blanc assumé, pas un oubli — le comptoir l'écrit avec le bon de transfert.
        hotel_adresse: loge ? A_REMPLIR : "",
        nuit_du: checkin,
        nuit_au: checkout,
        nuits: nights,
        chambre_no: loge ? A_REMPLIR : "",
        room_type: loge ? norm(planRow.room_type) : "",
        format_chambre: format,
        chambres_dossier: planRow.chambres ?? "",
        pnr: planRow.pnr,
        nom: personne ? norm(p.nom).toUpperCase() : A_REMPLIR,
        prenom: personne ? norm(p.prenom) : A_REMPLIR,
        sexe: identite.sexe,
        date_naissance: identite.date_naissance,
        age: personne ? (norm(p.age) || NON_FOURNI) : NON_FOURNI,
        nationalite: identite.nationalite,
        passeport_num: identite.passeport_num,
        passeport_exp: identite.passeport_exp,
        passeport_pays: identite.passeport_pays,
        adresse_domicile: identite.adresse_domicile,
        type_pax: type || NON_FOURNI,
        cabine: norm(planRow.cabine),
        bareme_eur_nuit: caps ? `${caps[planRow.cabine] ?? "?"} EUR/nuit` : NON_FOURNI,
        occupants_chambre: occupantsChambre,
        adulte_referent: estMineur ? (referent ? nomAffiche(referent) : A_REMPLIR) : "",
        berceau: type === "INF" || (dossier?.infants ?? 0) > 0 ? "berceau à demander" : "",
        pmr_assistance: assistance.join(" ; "),
        pmr_chambre_accessible: pmr ? (exigeAccessible ? "EXIGÉE" : "souhaitée") : "",
        // Un dossier NON LOGÉ n'a ni chambre ni transfert. Imprimer « taxi, max 45 min »
        // sur un document que le passager lit et signe est exactement la promesse que
        // `messages.mjs` s'interdit pour un dossier hors plan (civière, médical, mineur
        // non accompagné) : le transfert n'apparaît que quand une chambre existe. La
        // contrainte « chambre accessible », elle, reste imprimée sur une fiche non logée —
        // ce n'est pas une promesse, c'est ce qu'il faudra exiger de la solution trouvée.
        pmr_transfert: loge ? (pmr ? `${transfertLigne} — véhicule adapté à confirmer` : transfertLigne) : "",
        contact_a_prevenir: pmr ? (telDossier || mailDossier || A_REMPLIR) : "",
        contact_telephone: personne ? (norm(p.telephone) || contactDuDossier(telDossier)) : A_REMPLIR,
        contact_email: personne ? (norm(p.email) || contactDuDossier(mailDossier)) : A_REMPLIR,
        mode_reglement: norm(planRow.mode_reglement),
        montant_carte_eur: montantCarte,
        devise: norm(planRow.devise),
        conformite: norm(planRow.conformite),
        // couronne retenue et transfert de la LIGNE (temps DÉCLARÉ par l'exploitation).
        // Une fiche NON LOGÉE ne porte aucun transfert : rien n'est promis sans chambre.
        couronne: couronneLibelle,
        transfert: loge ? transfertLigne : "",
        trajet_min_declare: !loge ? "" : trajetDeclare === null ? NON_FOURNI : `${trajetDeclare} min déclarées (non mesurées)`,
        // vol suivant : vide quand le dossier n'est pas en correspondance (sans objet),
        // marqué quand il l'est mais que la compagnie n'a pas transmis l'horaire.
        vol_correspondance: volSuivant || (enCorrespondance ? NON_FOURNI : ""),
        heure_vol_suivant: heureVolSuivant ? heureVolSuivant.replace("T", " ") : (enCorrespondance ? NON_FOURNI : ""),
        retour_aeroport_au_plus_tard: heures?.retour ?? manquant,
        depart_hotel_au_plus_tard: loge ? (heures?.departHotel ?? manquant) : "",
        escalade_motif: loge ? "" : (norm(planRow.escalade) || "escalade comptoir"),
        identite_a_verifier: (p.identite_hors_format ?? []).join(" "),
        notes: notes.join(" ; "),
        signature: A_REMPLIR,
      });
    }
  }

  // regroupement final : par hôtel (le plus gros bloc d'abord, c'est l'ordre d'appel),
  // puis par dossier, puis par personne. Les non logés ferment la liasse.
  const parHotel = new Map();
  for (const f of fiches) {
    const cle = f.statut_fiche === "LOGÉ" ? f.hotel : "";
    if (!parHotel.has(cle)) parHotel.set(cle, { hotel: cle, fiches: 0, dossiers: new Set(), chambres: 0 });
    const e = parHotel.get(cle);
    e.fiches += 1;
    if (!e.dossiers.has(f.pnr)) { e.dossiers.add(f.pnr); e.chambres += Number(f.chambres_dossier) || 0; }
  }
  const rang = new Map([...parHotel.values()]
    .sort((a, b) => (a.hotel === "" ? 1 : 0) - (b.hotel === "" ? 1 : 0) || b.chambres - a.chambres || a.hotel.localeCompare(b.hotel, "fr"))
    .map((e, i) => [e.hotel, i]));
  fiches.sort((a, b) => {
    const ca = a.statut_fiche === "LOGÉ" ? a.hotel : "";
    const cb = b.statut_fiche === "LOGÉ" ? b.hotel : "";
    return rang.get(ca) - rang.get(cb) || a.pnr.localeCompare(b.pnr) || a.fiche_ref.localeCompare(b.fiche_ref);
  });

  const horsFiche = (rows ?? []).filter((r) => (r.categorie ?? "PAX") !== "PAX" || (r.statut_pax ?? "A_LOGER") !== "A_LOGER").length;
  if (horsFiche) {
    avertissements.push(
      `${horsFiche} ligne(s) de la liste hors plan passagers (équipage, non embarqués, autonomes) : aucune fiche produite — ` +
        "l'hébergement équipage est hors périmètre de l'outil",
    );
  }
  if (retoursIncalculables) {
    avertissements.push(
      `${retoursIncalculables} dossier(s) en correspondance dont l'heure limite de retour à l'aéroport n'a PAS pu être ` +
        "calculée (horaire du vol suivant non transmis, ou temps de trajet de la couronne non déclaré) : ces fiches partent " +
        "avec un blanc marqué, à remplir au comptoir — aucune heure n'a été devinée",
    );
  }
  if (incompletes) {
    avertissements.push(
      `${incompletes} fiche(s) sur ${fiches.length} partent avec une identité incomplète (${PAXLIST_IDENTITE_ESSENTIELLE.join(", ")}) : ` +
        "blancs à remplir passeport en main au comptoir",
    );
  }

  const resume = {
    fiches: fiches.length,
    logees: fiches.filter((f) => f.statut_fiche === "LOGÉ").length,
    non_logees: fiches.filter((f) => f.statut_fiche !== "LOGÉ").length,
    incompletes,
    manques,
    formats,
    /** Fiches dont le dossier est en correspondance (au moins un vol ou un horaire suivant). */
    correspondances: fiches.filter((f) => norm(f.vol_correspondance) || norm(f.heure_vol_suivant)).length,
    /** Dossiers en correspondance dont une heure de retour n'a pas pu être calculée. */
    retours_incalculables: retoursIncalculables,
    hotels: [...parHotel.values()]
      // `loge: false` sur le bloc comptoir : ses `chambres` sont des chambres À TROUVER,
      // pas des chambres retenues. Sans ce drapeau, un tableau de synthèse additionne
      // les deux colonnes et annonce des chambres qui n'existent pas.
      .map((e) => ({ hotel: e.hotel || COMPTOIR, loge: e.hotel !== "", fiches: e.fiches, dossiers: e.dossiers.size, chambres: e.chambres }))
      .sort((a, b) => rang.get(a.loge ? a.hotel : "") - rang.get(b.loge ? b.hotel : "")),
  };
  return { fiches, resume, avertissements };
}

/** CSV `fiches-<runId>.csv` : une ligne par personne, UTF-8 avec BOM (Excel). */
export function buildFichesCsv(fiches) {
  return toCsvBom(FICHE_COLS, fiches);
}

/* ------------------------------------------------------------ rendu imprimable */

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * L'URL d'hôtel vient d'un relevé d'agent : elle est imprimée, jamais interprétée.
 * Une adresse non http(s) reste affichée telle quelle — la faire disparaître serait
 * un défaut silencieux — mais précédée de la mention qui dit de ne pas la suivre.
 */
const urlAffichable = (url) => {
  const u = norm(url);
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `${u} (adresse inattendue, à vérifier)`;
};

/**
 * Cellule de fiche. Trois cas, et la distinction est tout l'intérêt du document :
 *   - valeur          → imprimée sur un filet ;
 *   - `[à remplir]` ou `[non fourni]` → rectangle à remplir, marqué de son motif ;
 *   - chaîne vide     → SANS OBJET pour cette fiche (pas de carte prépayée, pas de
 *     mineur à rattacher) : le champ n'apparaît pas. Imprimer un blanc là où il n'y a
 *     rien à écrire ferait chercher une donnée qui n'existe pas.
 */
function champ(label, valeur, { large = false } = {}) {
  const v = norm(valeur);
  if (v === "") return "";
  const vide = v === A_REMPLIR || v === NON_FOURNI;
  const classe = `champ${large ? " champ-large" : ""}${vide ? " champ-vide" : ""}`;
  const contenu = vide
    ? `<span class="blanc"></span><span class="marque">${esc(v)}</span>`
    : `<span class="valeur">${esc(v)}</span>`;
  return `<div class="${classe}"><span class="label">${esc(label)}</span>${contenu}</div>`;
}

/** Bloc de fiche : un titre, des champs, affiché seulement s'il a du contenu. */
const bloc = (titre, champs) =>
  champs.filter(Boolean).length ? `<section class="bloc"><h3>${esc(titre)}</h3><div class="grille">${champs.filter(Boolean).join("")}</div></section>` : "";

/** Une fiche = une page A4. */
function ficheHtml(f) {
  const url = urlAffichable(f.hotel_url);
  const entete = `
    <header class="entete">
      <div class="entete-hotel">
        <div class="hotel">${esc(f.hotel || "— aucun hôtel affecté —")}</div>
        ${url ? `<div class="url">${esc(url)}</div>` : ""}
      </div>
      <div class="entete-ref">
        <div class="ref">${esc(f.fiche_ref)}</div>
        <div class="statut ${f.statut_fiche === "LOGÉ" ? "ok" : "escalade"}">${esc(f.statut_fiche)}</div>
      </div>
    </header>`;

  const famille = norm(f.format_chambre).includes("FAMILLE") || norm(f.adulte_referent) !== "" || norm(f.berceau) !== "";
  const assiste = norm(f.pmr_chambre_accessible) !== "" || norm(f.pmr_assistance) !== "";
  const loge = f.statut_fiche === "LOGÉ";
  // bloc « où, et pour combien de temps » : affiché dès qu'une couronne, un transfert ou
  // un vol suivant existe. Le bas de casse compte : ces heures sont des LIMITES, pas des
  // horaires de bus — l'horaire réel se confirme au comptoir.
  const geo = [norm(f.couronne), norm(f.transfert), norm(f.trajet_min_declare), norm(f.vol_correspondance),
    norm(f.heure_vol_suivant), norm(f.retour_aeroport_au_plus_tard), norm(f.depart_hotel_au_plus_tard)].some(Boolean);
  const correspondance = Boolean(norm(f.vol_correspondance) || norm(f.heure_vol_suivant) || norm(f.retour_aeroport_au_plus_tard));

  return `
  <article class="fiche">
    ${entete}
    <h2>${loge ? "Fiche d'enregistrement — à remettre à l'hôtel" : "Fiche de prise en charge — à traiter au comptoir"}</h2>
    <p class="chapeau">
      ${loge
        ? "Document pré-rempli par l'escale. Le passager vérifie et signe ; l'hôtel complète le numéro de chambre."
        : "Aucune chambre n'a pu être affectée à ce dossier : prise en charge nominative par l'agent d'escale. La fiche sert de trace et de base de saisie dès qu'une solution est trouvée."}
      Aucune réservation n'a été faite en ligne par l'outil.
    </p>

    ${bloc("Passager", [
      champ("Nom", f.nom),
      champ("Prénom", f.prenom),
      champ("Sexe", f.sexe),
      champ("Date de naissance", f.date_naissance),
      champ("Âge", f.age),
      champ("Nationalité", f.nationalite),
      champ("N° de passeport", f.passeport_num),
      champ("Expiration", f.passeport_exp),
      champ("Pays d'émission", f.passeport_pays),
      champ("Adresse du domicile", f.adresse_domicile, { large: true }),
    ])}

    ${bloc("Vol et nuit", [
      champ("Vol", f.vol),
      champ("Dossier (PNR)", f.pnr),
      champ("Cabine", f.cabine),
      champ("Nuit du", f.nuit_du),
      champ("au", f.nuit_au),
      champ("Nuits", f.nuits),
    ])}

    ${bloc("Chambre", [
      champ("Format retenu", f.format_chambre, { large: true }),
      champ("Type de chambre relevé", f.room_type),
      champ("Chambres du dossier", f.chambres_dossier),
      champ("N° de chambre (réservé à l'hôtel)", f.chambre_no),
      champ("Barème applicable", f.bareme_eur_nuit),
      champ("Conformité", f.conformite),
      champ("Adresse de l'hôtel", f.hotel_adresse, { large: true }),
    ])}

    ${geo ? bloc("Transfert et retour à l'aéroport", [
      champ("Couronne retenue", f.couronne),
      champ("Transfert", f.transfert, { large: true }),
      champ("Temps de trajet déclaré", f.trajet_min_declare),
      champ("Vol suivant", f.vol_correspondance),
      champ("Départ du vol suivant", f.heure_vol_suivant),
      champ("RETOUR À L'AÉROPORT au plus tard", f.retour_aeroport_au_plus_tard, { large: true }),
      champ("DÉPART DE L'HÔTEL au plus tard", f.depart_hotel_au_plus_tard, { large: true }),
    ]) : ""}
    ${geo ? `<p class="chapeau">Le temps de trajet est <strong>déclaré par l'exploitation</strong>, il n'a été mesuré par personne :
      ce n'est pas un horaire garanti.${correspondance ? " Les deux heures ci-dessus sont des LIMITES à ne pas dépasser, pas l'horaire du bus : l'horaire exact du transfert retour est confirmé au comptoir." : ""}</p>` : ""}

    ${famille ? bloc("Chambre famille — qui dort où", [
      champ("Occupants de la chambre", f.occupants_chambre, { large: true }),
      champ("Adulte responsable du mineur", f.adulte_referent),
      champ("Berceau", f.berceau),
      champ("Répartition des couchages", A_REMPLIR, { large: true }),
    ]) : ""}

    ${assiste ? bloc("Assistance et prise en charge", [
      champ("Nature de l'assistance", f.pmr_assistance, { large: true }),
      champ("Chambre accessible", f.pmr_chambre_accessible),
      champ("Transfert", f.pmr_transfert, { large: true }),
      champ("Contact à prévenir", f.contact_a_prevenir),
    ]) : ""}

    ${bloc("Règlement", [
      champ("Mode de règlement", f.mode_reglement),
      champ("Montant chargé sur la carte prépayée (EUR)", f.montant_carte_eur),
      champ("Devise de l'hôtel", f.devise),
      champ("Téléphone", f.contact_telephone),
      champ("E-mail", f.contact_email),
    ])}

    ${norm(f.escalade_motif) || norm(f.notes) ? `
    <section class="bloc notes">
      <h3>À signaler au comptoir</h3>
      ${norm(f.escalade_motif) ? `<p class="alerte">${esc(f.escalade_motif)}</p>` : ""}
      ${norm(f.notes) ? `<p>${esc(f.notes)}</p>` : ""}
    </section>` : ""}

    <section class="bloc signature">
      <div class="sign">
        <span class="label">Signature du passager</span>
        <span class="cadre"></span>
      </div>
      <div class="sign">
        <span class="label">Date et heure</span>
        <span class="cadre"></span>
      </div>
      <div class="sign">
        <span class="label">Visa de l'agent d'escale</span>
        <span class="cadre"></span>
      </div>
    </section>
  </article>`;
}

const STYLE = `
  :root { --trait: #111; --gris: #666; --fond-vide: #f4f4f4; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.35 "Segoe UI", Arial, Helvetica, sans-serif; color: var(--trait); margin: 0; padding: 12mm; }
  h1 { font-size: 16pt; margin: 0 0 4mm; }
  h2 { font-size: 12pt; margin: 3mm 0 1mm; }
  h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: .05em; color: var(--gris);
       margin: 0 0 1.5mm; border-bottom: .3mm solid var(--trait); padding-bottom: .6mm; }
  .garde { page-break-after: always; }
  .garde table { border-collapse: collapse; width: 100%; margin: 3mm 0; }
  .garde th, .garde td { border: .2mm solid var(--gris); padding: 1.5mm 2mm; text-align: left; font-size: 10pt; }
  .garde th { background: var(--fond-vide); }
  .rappel { border: .3mm solid var(--trait); padding: 3mm; margin-top: 4mm; font-size: 9.5pt; }
  .fiche { page-break-after: always; break-after: page; padding-bottom: 2mm; }
  .fiche:last-of-type { page-break-after: auto; break-after: auto; }
  .entete { display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: .6mm solid var(--trait); padding-bottom: 2mm; }
  .hotel { font-size: 14pt; font-weight: 700; }
  .url { font-size: 8pt; color: var(--gris); word-break: break-all; max-width: 110mm; }
  .entete-ref { text-align: right; }
  .ref { font-family: "Consolas", monospace; font-size: 9pt; }
  .statut { font-size: 9pt; font-weight: 700; margin-top: 1mm; }
  .statut.escalade { border: .4mm solid var(--trait); padding: .5mm 1.5mm; }
  .chapeau { font-size: 9pt; color: var(--gris); margin: 0 0 3mm; }
  .bloc { margin-bottom: 3.5mm; }
  .grille { display: flex; flex-wrap: wrap; gap: 2mm 3mm; }
  .champ { flex: 1 1 42mm; min-width: 42mm; }
  .champ-large { flex: 1 1 100%; }
  .label { display: block; font-size: 8pt; color: var(--gris); }
  .valeur { display: block; font-size: 11pt; border-bottom: .2mm solid var(--trait); min-height: 6mm; padding-top: .8mm; }
  .champ-vide .blanc { display: block; min-height: 6mm; border-bottom: .3mm solid var(--trait); background: var(--fond-vide); }
  .marque { font-size: 7.5pt; color: var(--gris); }
  .notes .alerte { font-weight: 700; margin: 0 0 1mm; }
  .notes p { margin: 0; font-size: 10pt; }
  .signature { display: flex; gap: 4mm; margin-top: 5mm; }
  .sign { flex: 1; }
  .cadre { display: block; height: 16mm; border: .3mm solid var(--trait); }
  @page { size: A4; margin: 10mm; }
  @media print { body { padding: 0; } .garde { page-break-after: always; } }
`;

/**
 * Rendu imprimable autonome : une page de garde (ce qu'il faut demander à chaque
 * hôtel) puis une fiche par page, dans l'ordre d'appel des hôtels.
 *
 * @param {Array<object>} fiches sortie de buildFiches().fiches
 * @param {object} ctx {runId, vol, station?, checkin, checkout, nights, resume?, avertissements?}
 * @returns {string} document HTML complet, sans script ni ressource externe
 */
export function buildFichesHtml(fiches, ctx = {}) {
  const { runId = "", vol = "", station = null, checkin = "", checkout = "", nights = 1, resume = null, avertissements = [] } = ctx;
  const titre = `Fiches d'enregistrement — ${vol || "vol"} — ${station?.code ?? ""} ${checkin}`.trim();

  // la colonne « chambres » du bloc comptoir compte des chambres À TROUVER : l'écrire,
  // sinon la page de garde annonce des chambres retenues qui n'ont jamais été prises
  const lignesHotels = (resume?.hotels ?? []).map(
    (h) => `<tr><td>${esc(h.hotel)}</td><td>${h.dossiers}</td><td>${esc(h.loge === false ? `${h.chambres} à trouver` : h.chambres)}</td><td>${h.fiches}</td></tr>`,
  ).join("");

  const garde = `
  <section class="garde">
    <h1>${esc(titre)}</h1>
    <p>
      Run <code>${esc(runId)}</code> · hébergement du <strong>${esc(checkin)}</strong> au <strong>${esc(checkout)}</strong>
      (${esc(nights)} nuit${Number(nights) > 1 ? "s" : ""})${station ? ` · escale ${esc(station.code)}` : ""}.
      <strong>${fiches.length}</strong> fiche(s) : une par personne à loger.
    </p>
    ${lignesHotels ? `<table>
      <thead><tr><th>Hôtel</th><th>Dossiers</th><th>Chambres</th><th>Fiches</th></tr></thead>
      <tbody>${lignesHotels}</tbody>
    </table>` : ""}
    ${resume?.incompletes ? `<p><strong>${resume.incompletes} fiche(s) à identité incomplète</strong> : les champs marqués « ${esc(NON_FOURNI)} » n'ont pas été transmis par la compagnie et se remplissent passeport en main.</p>` : ""}
    ${avertissements.length ? `<ul>${avertissements.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
    <div class="rappel">
      <strong>Mode d'emploi.</strong> Imprimer recto seul, une fiche par page, dans l'ordre des hôtels.
      Le passager vérifie son identité, complète les blancs et signe ; l'hôtel inscrit le numéro de chambre.
      <br><strong>Ce que l'outil n'a pas fait :</strong> aucune réservation en ligne, aucune saisie sur le site
      d'un hôtel, aucune donnée passager transmise à un tiers — les fiches sont des documents papier remis au comptoir.
      <br><strong>Données nominatives :</strong> ce document est à détruire après la séance.
    </div>
  </section>`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titre)}</title>
<style>${STYLE}</style>
</head>
<body>
${garde}
${fiches.map(ficheHtml).join("\n")}
</body>
</html>
`;
}
