/**
 * Messages passagers FR/EN (CDC §8.2) — génération déterministe par gabarit,
 * AUCUN appel de LLM (EX-MSG-3). Un message par dossier (PNR), en FR et en EN,
 * trois variantes : affecté, provisoire, escalade (EX-MSG-1).
 *
 * Les gabarits vivent dans `data/messages/fr.md` et `en.md` (éditables). Un
 * placeholder inconnu dans un gabarit, une variante manquante ou un placeholder
 * non résolu produisent une erreur explicite — jamais un `{{` résiduel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "messages");

export const VARIANTS = ["affecte", "provisoire", "escalade"];
export const PLACEHOLDERS = [
  "pnr", "hotel_name", "hotel_address", "hotel_url", "transfer_mode", "max_transfer_min",
  "mode_reglement_texte", "repas_texte", "next_update_time", "station_name", "contact_channel",
];

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

/** HH:MM locale de `now + next_update_minutes`. */
function nextUpdateTime(scenario, now) {
  const d = new Date(now.getTime() + (scenario.next_update_minutes ?? 30) * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function render(tpl, values, sourceName) {
  const sub = (text) =>
    text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) => {
      if (!(key in values)) throw new Error(`${sourceName} : placeholder inconnu {{${key}}}`);
      return String(values[key]);
    });
  const subject = sub(tpl.subject);
  const body = sub(tpl.body);
  if (subject.includes("{{") || body.includes("{{")) {
    throw new Error(`${sourceName} : placeholder non résolu après substitution`);
  }
  return { subject, body };
}

/**
 * Construit les messages FR et EN de chaque dossier du plan.
 * @param {Array} plan lignes du plan (sortie d'allocate)
 * @param {object} station fiche escale (name, transfer)
 * @param {object} scenario scénario validé (next_update_minutes)
 * @param {object} policy politique validée (allowances)
 * @param {object} [opts] {templates: sortie de loadTemplates(), now: Date de génération, contact: {fr, en}}
 * @returns {Array<{pnr, lang, variante, subject, body}>}
 */
export function buildMessages(plan, station, scenario, policy, opts = {}) {
  const templates = opts.templates ?? loadTemplates();
  const now = opts.now ?? new Date();
  const contact = opts.contact ?? CONTACT_DEFAUT;
  const updateTime = nextUpdateTime(scenario, now);

  const out = [];
  for (const row of plan) {
    const variante =
      row.statut !== "OK" ? "escalade" : row.provisoire === true || row.provisoire === "true" ? "provisoire" : "affecte";
    for (const lang of ["fr", "en"]) {
      const values = {
        pnr: row.pnr,
        hotel_name: row.hotel || (lang === "fr" ? "communiqué au comptoir" : "provided at the desk"),
        hotel_address: row.hotel_address || ADRESSE_DEFAUT[lang],
        hotel_url: row.hotel_url || "—",
        transfer_mode: station.transfer.default_mode,
        max_transfer_min: station.transfer.max_transfer_min,
        mode_reglement_texte: MODE_TEXTES[lang][row.mode_reglement ?? ""] ?? MODE_TEXTES[lang][""],
        repas_texte: repasTexte(policy, lang),
        next_update_time: updateTime,
        station_name: station.name,
        contact_channel: contact[lang],
      };
      const { subject, body } = render(templates[lang][variante], values, `data/messages/${lang}.md · ${variante}`);
      out.push({ pnr: row.pnr, lang, variante, subject, body });
    }
  }
  return out;
}
