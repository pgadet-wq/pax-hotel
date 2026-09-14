/**
 * CSV passagers et sorties — parsing et sérialisation.
 * Format : séparateur `;`, UTF-8 avec BOM (compatibilité Excel), une ligne par enregistrement.
 */

export const PAX_COLS = ["pnr", "nom", "prenom", "type_pax", "age", "cabine", "flying_blue", "assistance", "remarque"];

/**
 * Parse le texte d'un CSV passagers. Valide la présence des colonnes obligatoires.
 * @param {string} text contenu du fichier (BOM toléré)
 * @returns {Array<object>} une ligne par passager
 */
export function parsePassagersCsv(text) {
  const lines = String(text).replace(/^﻿/, "").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV vide : il faut une ligne d'en-tête et au moins un passager.");
  const cols = lines[0].split(";").map((c) => c.trim());
  for (const required of PAX_COLS.slice(0, 8)) {
    if (!cols.includes(required)) throw new Error(`Colonne manquante dans le CSV : ${required}`);
  }
  return lines.slice(1).filter((l) => l.trim()).map((l) => {
    const vals = l.split(";");
    return Object.fromEntries(cols.map((c, i) => [c, (vals[i] ?? "").trim()]));
  });
}

/**
 * Un champ contenant `;`, `"` ou un saut de ligne est mis entre guillemets
 * (guillemets internes doublés) — nécessaire pour les corps de messages multilignes.
 */
function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * Sérialise des lignes en CSV `;` avec BOM.
 * @param {string[]} cols ordre des colonnes
 * @param {Array<object>} rows
 */
export function toCsvBom(cols, rows) {
  return (
    "﻿" + cols.join(";") + "\n" +
    rows.map((r) => cols.map((c) => csvField(r[c])).join(";")).join("\n") + "\n"
  );
}
