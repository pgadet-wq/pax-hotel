/**
 * Tests messages (CDC §8.2, §12.2) : FR et EN par dossier, 3 variantes,
 * placeholders tous résolus, aucun {{ résiduel, génération déterministe (EX-MSG-3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, loadTemplates, parseTemplates, VARIANTS } from "../lib/messages.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { STATION_BKK } from "./helpers.mjs";

const SCENARIO = { next_update_minutes: 30 };
const NOW = new Date(2026, 9, 4, 21, 45); // 4 octobre 2026 21:45 locale

// Ligne CERTAINE : stock mesuré, rien à confirmer, couchages suffisants. C'est la seule
// forme qui autorise la variante affirmative « affecte ».
const rowOk = {
  pnr: "SB001AAA", statut: "OK", provisoire: false, hotel: "Hyatt Regency BKK", hotel_url: "https://example.test/hyatt",
  mode_reglement: "compagnie",
  stock_mesure: true, chambres_fermes: 1, chambres_a_confirmer: 0, couchages_insuffisants: false,
};

test("messages : un message par dossier, en FR et en EN, sans {{ résiduel (EX-MSG-1)", () => {
  const plan = [rowOk, { ...rowOk, pnr: "SB002BBB", mode_reglement: "carte_prepayee" }];
  const msgs = buildMessages(plan, STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  assert.equal(msgs.length, 4); // 2 dossiers × 2 langues
  for (const m of msgs) {
    assert.ok(!m.subject.includes("{{") && !m.body.includes("{{"), `{{ résiduel dans ${m.pnr}/${m.lang}`);
    assert.ok(m.body.includes("22:15")); // 21:45 + 30 min
    assert.ok(m.body.includes("Bangkok Suvarnabhumi"));
    assert.ok(m.body.includes("taxi"));
  }
  assert.deepEqual([...new Set(msgs.map((m) => m.lang))].sort(), ["en", "fr"]);
});

test("messages : 3 variantes — affecté, provisoire, escalade", () => {
  const plan = [
    rowOk,
    { ...rowOk, pnr: "SB002BBB", provisoire: true },
    { pnr: "SB003CCC", statut: "ESCALADE DESK", provisoire: false, hotel: "", hotel_url: "", mode_reglement: "" },
  ];
  const msgs = buildMessages(plan, STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  const byPnr = (p, lang) => msgs.find((m) => m.pnr === p && m.lang === lang);
  assert.equal(byPnr("SB001AAA", "fr").variante, "affecte");
  assert.equal(byPnr("SB002BBB", "fr").variante, "provisoire");
  assert.equal(byPnr("SB003CCC", "fr").variante, "escalade");
  assert.match(byPnr("SB002BBB", "fr").body, /provisoire/i);
  assert.match(byPnr("SB003CCC", "en").body, /desk/i);
  assert.ok(byPnr("SB001AAA", "fr").body.includes("Hyatt Regency BKK"));
});

test("messages : une ligne OK adossée à du stock NON MESURÉ reçoit la variante provisoire, pas affecte", () => {
  // Non-régression : `provisoire` est un drapeau de RUN, faux sur toutes les lignes en fin
  // de run. La variante doit se choisir sur la certitude de la LIGNE, sinon 4 dossiers sur 5
  // reçoivent « une chambre vous est attribuée » pour un stock que personne n'a compté.
  const nonMesure = { ...rowOk, pnr: "SB010NNN", stock_mesure: false, chambres_fermes: 0, chambres_a_confirmer: 1 };
  const aConfirmer = { ...rowOk, pnr: "SB011CCC", stock_mesure: true, chambres_fermes: 1, chambres_a_confirmer: 1 };
  const sansCouchage = { ...rowOk, pnr: "SB012KKK", couchages_insuffisants: true };
  const msgs = buildMessages([nonMesure, aConfirmer, sansCouchage], STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  for (const p of ["SB010NNN", "SB011CCC", "SB012KKK"]) {
    const fr = msgs.find((m) => m.pnr === p && m.lang === "fr");
    assert.equal(fr.variante, "provisoire", `${p} : variante attendue provisoire`);
  }
  // et aucune variante n'annonce une réservation faite ou en cours auprès de l'hôtel
  for (const m of msgs) assert.ok(!/réservation est en cours de confirmation/i.test(m.body), m.pnr);
});

test("messages : le mode de règlement et les repas non renseignés (H-7) sont énoncés sans montant inventé", () => {
  const msgs = buildMessages([{ ...rowOk, mode_reglement: "carte_prepayee" }], STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  const fr = msgs.find((m) => m.lang === "fr");
  assert.match(fr.body, /carte prépayée/);
  assert.match(fr.body, /montant non renseigné/);
  // montant renseigné → il apparaît
  const policy = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  policy.allowances.meal_eur_per_pax_per_day = 25;
  const avec = buildMessages([rowOk], STATION_BKK, SCENARIO, policy, { now: NOW });
  assert.match(avec.find((m) => m.lang === "fr").body, /25 EUR par personne/);
  assert.match(avec.find((m) => m.lang === "en").body, /25 EUR per person/);
});

test("messages : gabarits data/messages/fr.md et en.md valides — 3 variantes, sujet présent", () => {
  const tpl = loadTemplates();
  for (const lang of ["fr", "en"]) {
    for (const v of VARIANTS) {
      assert.ok(tpl[lang][v].subject.length > 0, `${lang}/${v} : sujet vide`);
      assert.ok(tpl[lang][v].body.length > 0, `${lang}/${v} : corps vide`);
    }
  }
});

test("messages : gabarit invalide → erreur explicite (variante manquante, placeholder inconnu)", () => {
  assert.throws(() => parseTemplates("## affecte\nsujet: x\ncorps", "t"), /provisoire/);
  const tpl = loadTemplates();
  const cassé = structuredClone(tpl);
  cassé.fr.affecte.body = "Bonjour {{inconnu}}";
  assert.throws(
    () => buildMessages([rowOk], STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW, templates: cassé }),
    /placeholder inconnu/,
  );
});

test("messages : génération déterministe — deux appels identiques, même sortie (EX-MSG-3)", () => {
  const a = buildMessages([rowOk], STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  const b = buildMessages([rowOk], STATION_BKK, SCENARIO, DEFAULT_POLICY, { now: NOW });
  assert.deepEqual(a, b);
});
