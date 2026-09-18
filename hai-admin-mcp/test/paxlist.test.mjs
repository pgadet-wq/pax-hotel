/**
 * Ingestion de la liste passagers compagnie (PAXLIST v1, docs/format-liste-passagers.md).
 * Un test par règle : ce que le format REFUSE, ce qu'il TRADUIT, ce qu'il SIGNALE.
 * Tout hors ligne, aucune session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ingestPassagers, readPaxCsv, normalizePaxRows, splitPaxRows, IngestError, formatRapport,
} from "../lib/paxlist.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { allocate } from "../lib/allocate.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { ROOT, STATION_BKK, mkHotel, mkRoom } from "./helpers.mjs";

const HEAD = "pnr;nom;prenom;type_pax;cabine;categorie;statut_pax;assistance;droit_entree;chambres_demandees;age";
const line = (o = {}) => {
  const d = { pnr: "AB12CD", nom: "MARTIN", prenom: "Jean", type_pax: "ADT", cabine: "Y", categorie: "PAX", statut_pax: "EMBARQUE", assistance: "", droit_entree: "OUI", chambres_demandees: "", age: "40", ...o };
  return [d.pnr, d.nom, d.prenom, d.type_pax, d.cabine, d.categorie, d.statut_pax, d.assistance, d.droit_entree, d.chambres_demandees, d.age].join(";");
};
const csv = (...lines) => `${HEAD}\n${lines.join("\n")}\n`;

test("paxlist : le fichier d'exemple du dépôt est ingéré sans refus, avec ses cas remarquables", () => {
  const p = path.join(ROOT, "data", "exemples", "paxlist-exemple.csv");
  const ing = ingestPassagers(fs.readFileSync(p));
  assert.equal(ing.rapport.lignes.refusees, 0);
  const c = ing.rapport.compteurs;
  assert.ok(c.pmr >= 2, "les PMR du fichier d'exemple sont reconnus");
  assert.ok(c.escalades.nominative >= 2, "UMNR / MEDA sont des escalades nominatives");
  assert.ok(c.escalades.droit_entree >= 1);
  assert.equal(ing.equipage.length, 3, "PNT + PNC + DEADHEAD sortent du plan passagers");
  assert.equal(ing.exclus.length, 2, "no-show et autonome ne sont pas logés");
  // le champ cité contenant un point-virgule est relu ENTIER (parseur RFC 4180)
  assert.ok(ing.rows.some((r) => r.remarque.includes("fauteuil personnel; batterie seche")));
  assert.ok(formatRapport(ing.rapport).includes("À loger"));
});

test("paxlist : une cabine hors J/W/Y est REFUSÉE, jamais rabattue en Y en silence", () => {
  assert.throws(
    () => ingestPassagers(csv(line({ cabine: "C" }))),
    (err) => err instanceof IngestError && /cabine/.test(err.message) && /« C »/.test(err.message),
  );
  // l'ancien comportement (dossiers.mjs) coerçait en Y : on vérifie que ce n'est plus atteignable
  const { rows } = normalizePaxRows([{ pnr: "X", nom: "N", type_pax: "ADT", cabine: "C" }]);
  assert.equal(rows.length, 0, "aucune ligne canonique produite à partir d'une cabine inconnue");
  // les libellés texte, eux, sont traduits
  const ok = ingestPassagers(csv(line({ cabine: "BUSINESS" }), line({ pnr: "EF34GH", cabine: "premium eco" })));
  assert.deepEqual(ok.pax.map((r) => r.cabine), ["J", "W"]);
});

test("paxlist : types de passagers — ADULT/CNN/C05 traduits, valeur inconnue refusée", () => {
  assert.equal(ingestPassagers(csv(line({ type_pax: "ADULT" }))).pax[0].type_pax, "ADT");
  assert.throws(() => ingestPassagers(csv(line({ type_pax: "PAX2" }))), /type_pax/);
  const ing = ingestPassagers(csv(
    line({ type_pax: "ADT" }),
    line({ pnr: "AB12CD", type_pax: "CNN", age: "9" }),
    line({ pnr: "AB12CD", type_pax: "C05", age: "" }),
    line({ pnr: "AB12CD", type_pax: "INFT", age: "1" }),
  ));
  assert.deepEqual(ing.rapport.compteurs.parType, { ADT: 1, CHD: 2, INF: 1 });
  assert.equal(ing.pax.find((r) => r.age === "5").type_pax, "CHD", "C05 porte l'âge dans son code");
});

test("paxlist : tout code SSR d'assistance déclenche PMR, pas le seul littéral WCHR", () => {
  for (const code of ["WCHR", "WCHS", "WCHC", "WCBW", "BLND", "DEAF", "DPNA", "wchr", "WCHR BLND", "WCHR/BLND"]) {
    const ing = ingestPassagers(csv(line({ assistance: code })));
    assert.equal(ing.rapport.compteurs.pmr, 1, `${code} doit déclencher PMR`);
    const [d] = buildDossiers(ing.pax, DEFAULT_POLICY);
    assert.equal(d.overlays.pmr, true, `${code} : overlay PMR sur le dossier`);
  }
  // un code sans effet chambre ne déclenche rien, et ne fait pas échouer l'import
  const neutre = ingestPassagers(csv(line({ assistance: "BSCT VGML" })));
  assert.equal(neutre.rapport.compteurs.pmr, 0);
  assert.ok(neutre.rapport.avertissements.some((a) => a.code === "ssr_sans_effet"));
});

test("paxlist : UMNR, MEDA et STCR sortent du plan hôtel en escalade nominative", () => {
  const ing = ingestPassagers(csv(
    line({ pnr: "UM11AA", assistance: "UMNR", type_pax: "C14", age: "14" }),
    line({ pnr: "ME22BB", assistance: "MEDA" }),
    line({ pnr: "ST33CC", assistance: "STCR EXST" }),
  ));
  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  assert.deepEqual(
    new Set(dossiers.map((d) => d.escaladeNominative)),
    new Set(["civière", "médical", "mineur non accompagné"]),
  );
  const res = allocate({ dossiers, inventories: [mkHotel("h1")], policy: DEFAULT_POLICY, station: STATION_BKK });
  assert.equal(res.summary.ok, 0, "aucun n'est logé à l'hôtel");
  assert.equal(res.summary.horsPlan, 3);
  assert.deepEqual(Object.keys(res.gaps.chambresManquantes), [], "ils ne créent PAS de manque : l'extension ne doit pas payer pour eux");
});

test("paxlist : droit d'entrée REFUSÉ sort du plan ; INCONNU y reste sous réserve", () => {
  const ing = ingestPassagers(csv(line({ pnr: "NO11AA", droit_entree: "NON" }), line({ pnr: "UK22BB", droit_entree: "" })));
  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  assert.deepEqual(dossiers.map((d) => d.droitEntree).sort(), ["INCONNU", "NON"]);
  const res = allocate({ dossiers, inventories: [mkHotel("h1")], policy: DEFAULT_POLICY, station: STATION_BKK });
  const refuse = res.plan.find((r) => r.pnr === "NO11AA");
  const aVerifier = res.plan.find((r) => r.pnr === "UK22BB");
  // refusé : hors plan, aucune chambre cherchée pour lui (l'extension ne doit pas payer)
  assert.equal(refuse.escalade, "DESK (droit d'entrée)");
  assert.equal(refuse.hors_plan, "droit d'entrée");
  // à vérifier : logé normalement, mais la ligne le dit — sinon personne ne rouvre le dossier
  assert.equal(aVerifier.statut, "OK");
  assert.equal(aVerifier.sous_reserve, "droit d'entrée à vérifier");
  assert.match(aVerifier.notes, /SOUS RÉSERVE/);
  assert.deepEqual(Object.keys(res.gaps.chambresManquantes), [], "le dossier refusé ne crée pas de manque");
  // colonne ABSENTE : défaut explicite « entrant » + avertissement (jamais INCONNU sur tout le vol)
  const sans = ingestPassagers("pnr;nom;type_pax;cabine\nZZ1;N;ADT;Y\n");
  assert.equal(sans.pax[0].droit_entree, "OUI");
  assert.ok(sans.rapport.avertissements.some((a) => a.code === "colonne_absente:droit_entree"));
});

test("paxlist : PNR vide refusé, nom vide refusé", () => {
  assert.throws(() => ingestPassagers(csv(line({ pnr: "" }))), /pnr/);
  assert.throws(() => ingestPassagers(csv(line({ nom: "" }))), /nom/);
});

test("paxlist : structure — champ cité, ligne tronquée écartée, ligne vide ignorée", () => {
  const texte = `${HEAD};remarque\n${line()};"PMR ; allergie arachide"\n;;;;;;;;;;\nAB99ZZ;COURT;Jean\n`;
  const ing = ingestPassagers(texte);
  assert.equal(ing.pax.length, 1);
  assert.equal(ing.pax[0].remarque, "PMR ; allergie arachide", "le champ cité n'est pas tronqué au point-virgule");
  const ecartees = ing.rapport.avertissements.find((a) => a.code === "lignes_ignorees");
  assert.ok(ecartees && /ligne 4/.test(ecartees.message), "la ligne à 3 champs est écartée et nommée");
});

test("paxlist : séparateur virgule et en-têtes compagnie en majuscules sont acceptés par alias", () => {
  const texte = 'PNR,LAST NAME,FIRST NAME,PAX_TYPE,CLASS,SSR\nAB12CD,MARTIN,Jean,ADT,BUSINESS,WCHS\n';
  const ing = ingestPassagers(texte);
  assert.equal(ing.rapport.fichier.separateur, ",");
  assert.equal(ing.pax[0].cabine, "J");
  assert.equal(ing.pax[0].pmr, true);
  assert.ok(ing.rapport.fichier.alias_appliques.some((a) => /CLASS/.test(a)));
});

test("paxlist : encodage — windows-1252 décodé et SIGNALÉ, UTF-8 avec BOM silencieux", () => {
  const texte = csv(line({ nom: "LEFÈVRE" }));
  const cp1252 = Buffer.from(texte.replace("È", "È"), "latin1");
  const ing = ingestPassagers(cp1252);
  assert.equal(ing.pax[0].nom, "LEFÈVRE");
  assert.ok(ing.rapport.avertissements.some((a) => a.code === "encodage"));
  const utf8 = ingestPassagers(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(texte, "utf8")]));
  assert.equal(utf8.pax[0].nom, "LEFÈVRE");
  assert.ok(!utf8.rapport.avertissements.some((a) => a.code === "encodage"));
});

test("paxlist : équipage et non-embarqués sortent du plan passagers", () => {
  const ing = ingestPassagers(csv(
    line({ pnr: "PA11AA" }),
    line({ pnr: "CRW01", categorie: "PNT" }),
    line({ pnr: "CRW02", categorie: "cabin crew" }),
    line({ pnr: "NS11AA", statut_pax: "NOSHOW" }),
    line({ pnr: "AU11AA", statut_pax: "SELF" }),
  ));
  assert.equal(ing.pax.length, 1);
  assert.equal(ing.equipage.length, 2);
  assert.equal(ing.exclus.length, 2);
  assert.deepEqual(ing.rapport.compteurs.exclus, { NON_EMBARQUE: 1, AUTONOME: 1 });
  // « OK » (réservation confirmée) n'est PAS « embarqué »
  assert.throws(() => ingestPassagers(csv(line({ statut_pax: "OK" }))), /statut_pax/);
});

test("paxlist : chambres_demandees fait foi sur le chambrage calculé", () => {
  const famille = (chambres) => csv(
    line({ pnr: "FA11AA", chambres_demandees: chambres }),
    line({ pnr: "FA11AA", prenom: "Marie", chambres_demandees: chambres }),
    ...[1, 2, 3, 4, 5].map((i) => line({ pnr: "FA11AA", prenom: `E${i}`, type_pax: "CHD", age: "8", chambres_demandees: chambres })),
  );
  const [avec] = buildDossiers(ingestPassagers(famille("3")).pax, DEFAULT_POLICY);
  assert.equal(avec.rooms, 3);
  assert.equal(avec.roomsSource, "liste");
  const [sans] = buildDossiers(ingestPassagers(famille("")).pax, DEFAULT_POLICY);
  assert.equal(sans.rooms, 2, "sans la colonne, la règle historique s'applique (2 chambres)");
  assert.equal(sans.roomsSource, "calcul");
});

test("paxlist : rétrocompatible avec le CSV du générateur, et idempotent", () => {
  const ancien = "pnr;nom;prenom;type_pax;age;cabine;flying_blue;assistance;remarque\nSB001JRC;WAHEO;Thomas;ADT;64;J;NONE;;\nSB002LGN;GARNIER;Claire;ADT;41;J;GOLD;WCHR;\n";
  const ing = ingestPassagers(ancien);
  assert.equal(ing.pax.length, 2);
  assert.equal(ing.rapport.compteurs.pmr, 1);
  assert.deepEqual(ing.rapport.compteurs.parCabine, { J: 2, W: 0, Y: 0 });
  const again = normalizePaxRows(ing.rows).rows;
  assert.deepEqual(again.map((r) => ({ ...r, _ligne: null })), ing.rows.map((r) => ({ ...r, _ligne: null })));
});

test("paxlist : un PMR non logeable faute d'hôtel accessible est escaladé « accessibilité », pas « capacité »", () => {
  const ing = ingestPassagers(csv(line({ assistance: "WCHC" })));
  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  const inaccessible = mkHotel("h1", { amenities: { wifi_free: true, room_service: "24h", workspace: true, airport_shuttle: "gratuite", restaurant_late: true, accessible: false } }, [mkRoom({ price_per_night: 60 })]);
  const res = allocate({ dossiers, inventories: [inaccessible], policy: DEFAULT_POLICY, station: STATION_BKK });
  assert.equal(res.plan[0].escalade, "DESK (accessibilité)");
});

test("paxlist : en-tête dupliqué, colonne obligatoire absente et séparateur introuvable sont bloquants", () => {
  assert.throws(() => readPaxCsv("pnr;nom;type_pax;cabine;PNR\nA;B;ADT;Y;C\n"), /double/i);
  assert.throws(() => readPaxCsv("pnr;nom;type_pax\nA;B;ADT\n"), /Colonne manquante.*cabine/s);
  assert.throws(() => readPaxCsv("n'importe quoi\nvraiment n'importe quoi\n"), /Séparateur introuvable/);
});

test("paxlist : splitPaxRows tolère une ligne non normalisée (générateur, tests)", () => {
  const { pax, equipage, exclus } = splitPaxRows([{ pnr: "A", cabine: "Y", type_pax: "ADT" }]);
  assert.equal(pax.length, 1);
  assert.equal(equipage.length + exclus.length, 0);
});

/* ---- garde-fous issus de la relecture adverse du 19/09 ---- */

test("paxlist : un guillemet ouvert non refermé ne fait PAS disparaître le reste du fichier", () => {
  // un seul guillemet parasite en colonne `nom`, ligne 2, sur 6 passagers
  const lignes = [1, 2, 3, 4, 5, 6].map((i) => line({ pnr: `P${i}0000`, prenom: `Pax${i}` }));
  lignes[1] = lignes[1].replace(";MARTIN;", ';"MARTIN;');
  const ing = ingestPassagers(csv(...lignes));
  assert.equal(ing.pax.length, 5, "seule la ligne fautive est perdue, pas les suivantes");
  const anomalie = ing.rapport.fichier.lignes_ignorees.find((l) => /guillemet/.test(l.motif));
  assert.ok(anomalie, "l'anomalie est NOMMÉE, pas silencieuse");
  assert.equal(ing.rapport.lignes.lues, 5);
});

test("paxlist : tirets équivalents aux espaces dans les valeurs (NON-EMBARQUE, PREMIUM-ECO, TRANSIT-ONLY)", () => {
  const ing = ingestPassagers(csv(
    line({ pnr: "AA11AA", cabine: "PREMIUM-ECO" }),
    line({ pnr: "BB22BB", statut_pax: "NON-EMBARQUE" }),
    line({ pnr: "CC33CC", droit_entree: "TRANSIT-ONLY" }),
  ));
  assert.equal(ing.pax.find((r) => r.pnr === "AA11AA").cabine, "W");
  assert.equal(ing.exclus.length, 1);
  assert.equal(ing.pax.find((r) => r.pnr === "CC33CC").droit_entree, "NON");
});

test("paxlist : chambres_demandees — maximum retenu sur contradiction, notation exotique refusée", () => {
  const ing = ingestPassagers(csv(
    line({ pnr: "FA11AA", chambres_demandees: "1" }),
    line({ pnr: "FA11AA", prenom: "Marie", chambres_demandees: "4" }),
  ));
  assert.ok(ing.rapport.avertissements.some((a) => a.code === "chambres_contradictoires"));
  const [d] = buildDossiers(ing.pax, DEFAULT_POLICY);
  assert.equal(d.rooms, 4, "jamais sous-loger : le maximum l'emporte, pas l'ordre des lignes");
  const exotique = ingestPassagers(csv(line({ chambres_demandees: "2e1" })));
  assert.equal(exotique.pax[0].chambres_demandees, null);
  assert.ok(exotique.rapport.avertissements.some((a) => a.code === "chambres"));
  const age = ingestPassagers(csv(line({ age: "1e2" })));
  assert.equal(age.pax[0].age, "");
});

test("paxlist : nom au format PNL « NOM/PRENOM TITRE » découpé", () => {
  const texte = "pnr;nom;type_pax;cabine\nAB12CD;MARTIN/JEAN MR;ADT;Y\n";
  const ing = ingestPassagers(texte);
  assert.equal(ing.pax[0].nom, "MARTIN");
  assert.equal(ing.pax[0].prenom, "JEAN");
});

test("messages : un dossier hors plan ne reçoit NI convocation au comptoir NI promesse de transfert", async () => {
  const { buildMessages } = await import("../lib/messages.mjs");
  const ing = ingestPassagers(csv(
    line({ pnr: "ST11AA", assistance: "STCR" }),
    line({ pnr: "OK22BB" }),
  ));
  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  const { plan } = allocate({ dossiers, inventories: [mkHotel("h1")], policy: DEFAULT_POLICY, station: STATION_BKK });
  const msgs = buildMessages(plan, STATION_BKK, { next_update_minutes: 30 }, DEFAULT_POLICY, { now: new Date("2026-09-20T10:00:00Z") });
  const civiere = msgs.find((m) => m.pnr === "ST11AA" && m.lang === "fr");
  assert.doesNotMatch(civiere.body, /présentez-vous|vous présenter/i, "un passager sur civière n'est pas convoqué au comptoir");
  assert.doesNotMatch(civiere.body, /taxi|transfert/i);
  assert.match(civiere.body, /RESTER À VOTRE PLACE/);
  const loge = msgs.find((m) => m.pnr === "OK22BB" && m.lang === "fr");
  assert.match(loge.body, /Hôtel/);
});

test("rapport : la section « Liste passagers (ingestion) » porte les réserves du fichier", async () => {
  const { buildRapportMd } = await import("../lib/rapport.mjs");
  const ing = ingestPassagers(csv(line({ assistance: "PETC" }), line({ pnr: "CR11AA", categorie: "PNC" })));
  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  const alloc = allocate({ dossiers, inventories: [mkHotel("h1")], policy: DEFAULT_POLICY, station: STATION_BKK });
  const md = buildRapportMd(alloc, [mkHotel("h1")], {
    station: STATION_BKK, policy: DEFAULT_POLICY, checkin: "2026-09-20", checkout: "2026-09-21", nights: 1,
    ingestion: ing.rapport, warnings: [],
  });
  assert.match(md, /## Liste passagers \(ingestion\)/);
  assert.match(md, /équipage 1/);
  assert.match(md, /animal/i, "la réserve « animaux » suit jusque dans le livrable archivé");
});
