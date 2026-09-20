/**
 * Messages passagers FR/EN (CDC §8.2) — génération déterministe par gabarit,
 * AUCUN appel de LLM (EX-MSG-3). Un message par dossier (PNR), en FR et en EN,
 * quatre variantes : affecté, provisoire, escalade, hors_plan (EX-MSG-1).
 *
 * `hors_plan` couvre les dossiers que le desk prend en charge nominativement
 * (civière, médical, mineur non accompagné, droit d'entrée refusé) : ni convocation
 * au comptoir, ni promesse d'hôtel ou de transfert — un passager allongé sur civière
 * ne « se présente » pas, un passager retenu en zone de transit ne prend pas de taxi.
 *
 * C6 — un message n'annonce jamais une réservation faite : l'outil ne réserve pas (INV-1)
 * et, à l'instant où le message est produit, la répartition n'a pas encore été validée par
 * un humain. La variante `affecte` énonce donc une chambre attribuée et en cours de
 * confirmation, jamais un hébergement « organisé ».
 *
 * C6 — convocation étalée : `{{creneau_presentation}}` porte le créneau de passage au
 * comptoir, pour ne pas renvoyer tous les dossiers escaladés à la même minute. Le créneau
 * est calculé par l'allocation (champ `creneau_presentation` de la ligne de plan) ; ici on se
 * contente de le mettre en phrase. Son absence laisse un message correct : le paragraphe
 * disparaît, jamais un « créneau : undefined ».
 *
 * COURONNES — un passager logé loin doit lire son temps de transfert et son heure de
 * retour. `{{transfert_texte}}` porte le transport et le temps de trajet DÉCLARÉ de la
 * couronne réellement retenue ; `{{retour_texte}}` porte le vol suivant, l'heure limite de
 * retour à l'aéroport et l'heure limite de départ de l'hôtel.
 *
 * Ces deux textes ne promettent RIEN qui n'existe : aucune réservation n'est faite (INV-1),
 * un temps de trajet déclaré n'est pas un horaire garanti, et les heures annoncées sont des
 * LIMITES, pas l'horaire du bus — l'horaire réel se confirme au comptoir. `{{retour_texte}}`
 * est facultatif comme `{{creneau_presentation}}` : sans horaire de correspondance
 * exploitable il rend une chaîne vide, le paragraphe disparaît, et jamais un « undefined »
 * ni une accolade orpheline. Les deux langues disent la même chose.
 *
 * Les gabarits vivent dans `data/messages/fr.md` et `en.md` (éditables). Un
 * placeholder inconnu dans un gabarit, une variante manquante ou un placeholder
 * non résolu produisent une erreur explicite — jamais un `{{` résiduel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// le calcul des heures de retour est celui des FICHES, importé et non recopié : une
// fiche papier et un message qui donneraient deux heures différentes au même passager
// seraient pires que pas d'heure du tout.
import { heuresRetour } from "./fiches.mjs";

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "messages");

export const VARIANTS = ["affecte", "provisoire", "escalade", "hors_plan"];
export const PLACEHOLDERS = [
  "pnr", "hotel_name", "hotel_address", "hotel_url", "transfer_mode", "max_transfer_min",
  "mode_reglement_texte", "repas_texte", "next_update_time", "station_name", "contact_channel",
  "creneau_presentation",
  // GÉOGRAPHIE ET TEMPS. `transfert_texte` dit le transport et le temps de trajet DÉCLARÉ
  // de la couronne réellement retenue (là où `transfer_mode`/`max_transfer_min` ne
  // connaissent que le maximum global de la fiche escale, identique à 4 km et à 40 km).
  // `retour_texte` porte le vol suivant et l'heure limite de retour à l'aéroport.
  "transfert_texte", "retour_texte",
];

/** Seuls placeholders dont la valeur vide est légitime : leur paragraphe disparaît alors du corps. */
export const PLACEHOLDERS_OPTIONNELS = ["creneau_presentation", "retour_texte"];
const OPTIONNELS = new Set(PLACEHOLDERS_OPTIONNELS);

/**
 * Parse un gabarit Markdown : sections `## affecte|provisoire|escalade`, première
 * ligne utile `sujet:`/`subject:`, reste = corps. Le préambule (avant la première
 * section) est ignoré.
 */
export function parseTemplates(mdText, sourceName = "gabarit") {
  const sections = {};
  let current = null;
  for (const line of String(mdText).split(/\r?\n/)) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) {
      current = m[1];
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  const out = {};
  for (const variant of VARIANTS) {
    const lines = sections[variant];
    if (!lines) throw new Error(`${sourceName} : variante « ${variant} » absente (sections trouvées : ${Object.keys(sections).join(", ") || "aucune"})`);
    const idx = lines.findIndex((l) => /^(sujet|subject)\s*:/i.test(l.trim()));
    if (idx === -1) throw new Error(`${sourceName} : la variante « ${variant} » n'a pas de ligne sujet:/subject:`);
    const subject = lines[idx].trim().replace(/^(sujet|subject)\s*:\s*/i, "");
    const body = lines.slice(idx + 1).join("\n").trim() + "\n";
    out[variant] = { subject, body };
  }
  return out;
}

/** Charge et parse les gabarits FR et EN depuis `data/messages/`. */
export function loadTemplates(dir = TEMPLATES_DIR) {
  const read = (lang) => {
    const file = path.join(dir, `${lang}.md`);
    return parseTemplates(fs.readFileSync(file, "utf8"), `data/messages/${lang}.md`);
  };
  return { fr: read("fr"), en: read("en") };
}

const MODE_TEXTES = {
  fr: {
    compagnie: "la chambre est réglée directement par la compagnie, vous n'avez rien à avancer.",
    compagnie_a_confirmer:
      "la chambre est prise en charge par la compagnie (mode de règlement en cours de confirmation avec l'hôtel) ; ne réglez rien sans instruction du comptoir.",
    carte_prepayee: "une carte prépayée vous sera remise au comptoir pour régler la chambre à l'hôtel.",
    "": "pris en charge par la compagnie, modalités communiquées au comptoir.",
  },
  en: {
    compagnie: "the room is paid directly by the airline; you have nothing to pay.",
    compagnie_a_confirmer:
      "the room is covered by the airline (payment method being confirmed with the hotel); please do not pay anything unless instructed at the desk.",
    carte_prepayee: "a prepaid card will be handed to you at the desk to pay the hotel room.",
    "": "covered by the airline; details provided at the desk.",
  },
};

const CONTACT_DEFAUT = { fr: "notre comptoir compagnie de l'aéroport", en: "our airline desk at the airport" };
const ADRESSE_DEFAUT = { fr: "voir la fiche de l'hôtel (lien ci-dessous)", en: "see the hotel page (link below)" };

function repasTexte(policy, lang) {
  const rate = policy.allowances.meal_eur_per_pax_per_day;
  if (rate === null) {
    return lang === "fr"
      ? "pris en charge selon la réglementation en vigueur (montant non renseigné à ce stade, précisé au comptoir)."
      : "covered as per applicable regulations (amount not specified at this stage; details at the desk).";
  }
  return lang === "fr"
    ? `pris en charge à hauteur de ${rate} EUR par personne et par jour.`
    : `covered up to ${rate} EUR per person per day.`;
}

/**
 * Met le créneau de présentation en phrase, ou rend une chaîne vide s'il n'y en a pas.
 * Formes acceptées : `{debut, fin}` (forme canonique posée par l'allocation), `{debut}` seul,
 * ou une chaîne déjà formatée (« 02:10–02:25 »). Toute autre forme est signalée et traitée
 * comme absente : aucun horaire n'est inventé.
 */
function creneauTexte(valeur, lang, avertir) {
  if (valeur === null || valeur === undefined || valeur === "") return "";
  if (typeof valeur === "string") {
    const s = valeur.trim();
    if (!s) return "";
    return lang === "fr"
      ? `Créneau de présentation au comptoir : ${s}. Merci de respecter cet horaire.`
      : `Desk time slot: ${s}. Please keep to this time.`;
  }
  if (typeof valeur === "object") {
    const debut = typeof valeur.debut === "string" ? valeur.debut.trim() : "";
    const fin = typeof valeur.fin === "string" ? valeur.fin.trim() : "";
    if (debut && fin) {
      return lang === "fr"
        ? `Présentez-vous au comptoir entre ${debut} et ${fin} : ce créneau vous est réservé.`
        : `Please come to the desk between ${debut} and ${fin}: this slot is reserved for you.`;
    }
    if (debut) {
      return lang === "fr"
        ? `Présentez-vous au comptoir à partir de ${debut} : ce créneau vous est réservé.`
        : `Please come to the desk from ${debut}: this slot is reserved for you.`;
    }
  }
  avertir("creneau_illisible", "créneau de présentation illisible : message produit sans créneau");
  return "";
}

/**
 * Transfert annoncé au passager : la couronne RÉELLEMENT retenue pour sa ligne, et son
 * temps de trajet DÉCLARÉ par l'exploitation.
 *
 * Ce que ce texte ne fait jamais : promettre une durée. L'outil n'a aucun service de
 * routage, il ne mesure aucun trajet, et un temps déclaré n'est pas un horaire garanti —
 * la phrase le dit au passager plutôt que de le laisser croire à un engagement.
 *
 * Repli sur la fiche escale (`transfer.default_mode` / `max_transfer_min`) quand la ligne
 * ne porte pas de couronne : c'est le comportement d'avant les couronnes, conservé tel quel.
 *
 * @param {object} row ligne de plan
 * @param {object} station fiche escale
 * @param {"fr"|"en"} lang
 * @returns {string} jamais vide
 */
function transfertTexte(row, station, lang) {
  const cle = String(row?.couronne_cle ?? "").trim();
  const mode = String(row?.couronne_mode ?? "").trim() || station.transfer.default_mode;
  const trajet = Number(row?.couronne_trajet_min_declare);
  if (cle && cle !== "hors_couronnes" && Number.isFinite(trajet)) {
    return lang === "fr"
      ? `${mode}, environ ${trajet} min de trajet annoncées par l'exploitation (durée déclarée, non garantie), organisé et pris en charge par la compagnie.`
      : `${mode}, approximately ${trajet} min of travel as declared by ground operations (declared duration, not guaranteed), arranged and paid for by the airline.`;
  }
  if (cle === "hors_couronnes") {
    return lang === "fr"
      ? `${mode}, organisé et pris en charge par la compagnie — l'hôtel retenu est au-delà de la zone dont les temps de trajet sont établis, la durée vous sera précisée au comptoir.`
      : `${mode}, arranged and paid for by the airline — the hotel is beyond the area for which travel times are established; the duration will be given to you at the desk.`;
  }
  return lang === "fr"
    ? `${station.transfer.default_mode} (durée maximale prévue : ${station.transfer.max_transfer_min} min), organisé et pris en charge par la compagnie.`
    : `${station.transfer.default_mode} (maximum expected duration: ${station.transfer.max_transfer_min} min), arranged and paid for by the airline.`;
}

/**
 * Vol suivant et heure LIMITE de retour à l'aéroport, quand le dossier est en
 * correspondance et que l'horaire a pu être exploité. Chaîne vide sinon : le paragraphe
 * disparaît, et surtout aucune heure n'est inventée (un passager qui lirait une heure
 * fausse manquerait son vol en croyant bien faire).
 *
 * Les deux heures sont des LIMITES, pas l'horaire du bus : la phrase le dit, et renvoie
 * au comptoir pour l'horaire réel du transfert retour.
 *
 * @param {object|null} dossier dossier de `buildDossiers` (porte `correspondance`)
 * @param {object} row ligne de plan (pour le temps de trajet déclaré de la couronne)
 * @param {object} policy politique validée (`global.correspondance`)
 * @param {string} stationName nom de l'escale (le fuseau de lecture de ces heures)
 * @param {"fr"|"en"} lang
 * @returns {string}
 */
function retourTexte(dossier, row, policy, stationName, lang) {
  const corr = dossier?.correspondance ?? null;
  const heure = String(corr?.heure ?? "").trim();
  if (!heure) return "";
  const loge = row?.statut === "OK";
  const h = heuresRetour({
    heure,
    // pas d'hôtel = pas de temps de trajet à opposer : on ne donne alors QUE l'heure de
    // retour à l'aéroport. Annoncer une heure de départ d'hôtel à un dossier escaladé
    // serait promettre un bus qui n'existe pas.
    trajetMinDeclare: loge ? row?.couronne_trajet_min_declare : null,
    correspondance: policy?.global?.correspondance ?? null,
  });
  if (!h.retour) return "";
  const vol = String(corr?.vol ?? "").trim();
  const depart = heure.replace("T", " ");
  // la raison du blanc est écrite DANS LA LANGUE DU MESSAGE : `h.motif` est un libellé
  // interne français, il n'a rien à faire dans un message anglais remis à un passager.
  if (lang === "fr") {
    const manque = loge
      ? " L'heure de départ de l'hôtel n'a pas pu être calculée, le temps de trajet de cet hôtel n'étant pas déclaré : elle vous sera indiquée au comptoir."
      : " Aucun hôtel ne vous est encore affecté : l'heure de départ du transfert retour vous sera indiquée au comptoir.";
    return (
      `Votre vol suivant${vol ? ` ${vol}` : ""} est annoncé le ${depart} (heure locale de ${stationName}). ` +
      `Vous devez être REVENU à l'aéroport au plus tard le ${h.retour}` +
      (h.departHotel ? `, et donc quitter l'hôtel au plus tard le ${h.departHotel}. Ces heures sont des limites` : `. Cette heure est une limite`) +
      ` à ne pas dépasser, calculée${h.departHotel ? "s" : ""} sur un temps de trajet DÉCLARÉ : ce n'est pas l'horaire du ` +
      `transfert, qui vous sera confirmé au comptoir.` +
      (h.departHotel ? "" : manque)
    );
  }
  const missing = loge
    ? " The hotel departure time could not be computed, as no travel time is declared for this hotel: it will be given to you at the desk."
    : " No hotel has been allocated to you yet: the departure time of the return transfer will be given to you at the desk.";
  return (
    `Your onward flight${vol ? ` ${vol}` : ""} is scheduled for ${depart} (local time at ${stationName}). ` +
    `You must be BACK at the airport by ${h.retour} at the latest` +
    (h.departHotel ? `, and therefore leave the hotel by ${h.departHotel} at the latest. These are deadlines` : `. This is a deadline`) +
    `, computed from a DECLARED travel time: ${h.departHotel ? "they are" : "it is"} not the transfer schedule, which will ` +
    `be confirmed at the desk.` +
    (h.departHotel ? "" : missing)
  );
}

/** HH:MM locale de `now + next_update_minutes`. */
function nextUpdateTime(scenario, now) {
  const minutes = scenario?.next_update_minutes ?? 30;
  if (!Number.isFinite(minutes)) {
    throw new Error(`buildMessages : next_update_minutes illisible (${String(scenario?.next_update_minutes)}) — aucune heure inventée`);
  }
  const d = new Date(now.getTime() + minutes * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Dernier verrou avant substitution : aucune valeur ne doit pouvoir s'imprimer en
 * « undefined », « null » ou vide dans un message remis à un passager. Seuls les
 * placeholders optionnels (le créneau) admettent la chaîne vide.
 */
function verifieValeurs(values, sourceName) {
  for (const [key, v] of Object.entries(values)) {
    if (OPTIONNELS.has(key)) continue;
    const ok = (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));
    if (!ok) throw new Error(`${sourceName} : valeur manquante ou illisible pour {{${key}}} (${String(v)}) — message non produit`);
  }
}

function render(tpl, values, sourceName) {
  const sub = (text) =>
    text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`${sourceName} : placeholder inconnu {{${key}}}`);
      return String(values[key]);
    });
  const subject = sub(tpl.subject);
  // Un placeholder optionnel vide laisse un paragraphe vide : on le referme. Seule
  // normalisation appliquée au corps, elle ne retire rien d'autre qu'une ligne blanche.
  const body = sub(tpl.body).replace(/\n{3,}/g, "\n\n");
  if (subject.includes("{{") || body.includes("{{")) {
    throw new Error(`${sourceName} : placeholder non résolu après substitution`);
  }
  return { subject, body };
}

/**
 * Construit les messages FR et EN de chaque dossier du plan.
 * @param {Array} plan lignes du plan (sortie d'allocate) ; `creneau_presentation` (optionnel,
 *   `{debut, fin}` ou chaîne déjà formatée) porte le créneau de passage au comptoir
 * @param {object} station fiche escale (name, transfer)
 * @param {object} scenario scénario validé (next_update_minutes)
 * @param {object} policy politique validée (allowances)
 * @param {object} [opts] {templates: sortie de loadTemplates(), now: Date de génération,
 *   contact: {fr, en}, warnings: tableau où empiler les avertissements {code, message},
 *   dossiers: sortie de `buildDossiers` — ADDITIF ET FACULTATIF, seule source de l'heure du
 *   vol suivant (aucune ligne de plan ne la porte). Sans lui, `{{retour_texte}}` est vide et
 *   son paragraphe disparaît : le message reste correct, il ne dit simplement pas l'heure
 *   limite de retour à l'aéroport}
 * @returns {Array<{pnr, lang, variante, subject, body}>}
 */
export function buildMessages(plan, station, scenario, policy, opts = {}) {
  const templates = opts.templates ?? loadTemplates();
  const now = opts.now ?? new Date();
  const contact = opts.contact ?? CONTACT_DEFAUT;
  // index des dossiers par PNR : la correspondance vit là, pas sur la ligne de plan
  const dossierParPnr = new Map((opts.dossiers ?? []).map((d) => [d.pnr, d]));
  // Avertissements additifs : sans tableau fourni ils sont perdus, le comportement des
  // appelants actuels reste identique.
  const warnings = Array.isArray(opts.warnings) ? opts.warnings : [];
  const updateTime = nextUpdateTime(scenario, now);

  const out = [];
  for (const [i, row] of plan.entries()) {
    if (typeof row.pnr !== "string" || row.pnr.trim() === "") {
      throw new Error(`buildMessages : ligne de plan ${i} sans pnr — aucun message nominatif ne peut être produit`);
    }
    const avertir = (code, message) => warnings.push({ code, message: `dossier ${row.pnr} : ${message}` });
    // Variante choisie sur la CERTITUDE DE LA LIGNE, pas sur l'avancement du run.
    // `row.provisoire` est un drapeau de RUN (faux pour toutes les lignes en fin de run) :
    // s'y fier seul faisait partir la variante affirmative « une chambre vous est attribuée »
    // sur des lignes dont le stock n'a JAMAIS été mesuré. Une chambre à confirmer auprès de
    // l'hôtel, ou une chambre sans couchage suffisant, est une affectation PROVISOIRE —
    // c'est ce que le passager doit lire.
    const certaine =
      row.stock_mesure === true
      && !(Number(row.chambres_a_confirmer) > 0)
      && row.couchages_insuffisants !== true && row.couchages_insuffisants !== "oui";
    const variante =
      row.hors_plan ? "hors_plan"
        : row.statut !== "OK" ? "escalade"
          : row.provisoire === true || row.provisoire === "true" || !certaine ? "provisoire" : "affecte";
    const modeCle = row.mode_reglement ?? "";
    if (!(modeCle in MODE_TEXTES.fr)) {
      avertir("mode_reglement_inconnu", `mode de règlement « ${String(modeCle)} » inconnu : formulation générique utilisée`);
    }
    for (const lang of ["fr", "en"]) {
      const values = {
        pnr: row.pnr,
        hotel_name: row.hotel || (lang === "fr" ? "communiqué au comptoir" : "provided at the desk"),
        hotel_address: row.hotel_address || ADRESSE_DEFAUT[lang],
        hotel_url: row.hotel_url || "—",
        transfer_mode: station.transfer.default_mode,
        max_transfer_min: station.transfer.max_transfer_min,
        mode_reglement_texte: MODE_TEXTES[lang][modeCle] ?? MODE_TEXTES[lang][""],
        repas_texte: repasTexte(policy, lang),
        next_update_time: updateTime,
        station_name: station.name,
        contact_channel: contact[lang],
        // avertissement une seule fois par dossier, au passage FR
        creneau_presentation: creneauTexte(row.creneau_presentation, lang, lang === "fr" ? avertir : () => {}),
        // couronne réellement retenue et temps de trajet DÉCLARÉ ; jamais vide (repli fiche escale)
        transfert_texte: transfertTexte(row, station, lang),
        // vol suivant et heure LIMITE de retour ; vide quand l'horaire manque — le
        // paragraphe disparaît alors, plutôt qu'une heure inventée
        retour_texte: retourTexte(dossierParPnr.get(row.pnr) ?? null, row, policy, station.name, lang),
      };
      const sourceName = `data/messages/${lang}.md · ${variante}`;
      verifieValeurs(values, sourceName);
      const { subject, body } = render(templates[lang][variante], values, sourceName);
      out.push({ pnr: row.pnr, lang, variante, subject, body });
    }
  }
  return out;
}
