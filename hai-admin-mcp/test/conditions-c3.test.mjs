/**
 * Condition client C3 — « préparer les formulaires de saisie des informations pour chaque
 * passager selon le format de chambre sélectionné : famille, PMR, business, éco, ou tout
 * autre critère sélectionné ».
 *
 * Trois chaînons, un fichier :
 *   1. le FORMAT de chambre est choisi (allocate + policy.cabins[].room_type_patterns,
 *      surcouche PMR, mineur sans adulte, couchages) ;
 *   2. la FICHE est produite par PERSONNE selon ce format (lib/fiches.mjs) ;
 *   3. l'IDENTITÉ qui remplit la fiche entre par la liste compagnie (PAXLIST v2).
 *
 * Ces tests documentent le comportement RÉEL du code de production. Tout est hors ligne :
 * aucune session d'agent, aucun appel réseau, aucune écriture disque, aucune lecture de
 * l'horloge réelle (les dates de référence sont injectées par `opts.now`). Les fixtures
 * sont fabriquées ici — aucune donnée passager réelle.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { ingestPassagers, PAXLIST_IDENTITE, PAXLIST_IDENTITE_ESSENTIELLE } from "../lib/paxlist.mjs";
import {
  buildFiches, buildFichesCsv, buildFichesHtml, formatChambre,
  A_REMPLIR, NON_FOURNI, FICHE_COLS,
} from "../lib/fiches.mjs";
import { mkHotel, mkRoom, mkPax, STATION_BKK } from "./helpers.mjs";

/** Date de référence unique de tout le fichier : rien ne dépend de l'horloge réelle. */
const NOW = new Date("2026-10-03T00:00:00Z");

/** Politique dérivée de la politique par défaut, modifiable sans la polluer. */
const policyAvec = (patch) => {
  const p = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  patch(p);
  return p;
};

/** Prestations d'un hôtel : l'objet est REMPLACÉ en entier par `mkHotel`, jamais fusionné. */
const amenities = (over = {}) => ({
  wifi_free: true, room_service: "24h", workspace: true,
  airport_shuttle: "gratuite", restaurant_late: true, accessible: false, ...over,
});

const alloue = (rows, inventories, over = {}) => {
  const policy = over.policy ?? DEFAULT_POLICY;
  return allocate({
    dossiers: buildDossiers(rows, policy), inventories, policy,
    station: STATION_BKK, nights: 1, ...over,
  });
};

/* ============================================================ 1. formats de chambre */

describe("C3 — le format de chambre suit la cabine et les surcouches", () => {
  const roomsJ = (prixDeluxe) => [
    mkRoom({ room_type: "Standard Double Room", price_per_night: 100 }),
    mkRoom({ room_type: "Deluxe King Room", price_per_night: prixDeluxe }),
  ];

  test("format : la chambre du format de cabine passe avant la moins chère, SOUS le plafond", () => {
    // J : plafond 250 EUR, motifs « suite, executive, club, deluxe, premium ».
    // Les deux chambres sont sous le plafond : c'est le FORMAT qui tranche, pas le prix.
    const { plan } = alloue([mkPax("J1", { cabine: "J" })], [mkHotel("j", { stars: 5 }, roomsJ(180))]);
    assert.equal(plan[0].statut, "OK");
    assert.equal(plan[0].room_type, "Deluxe King Room", "un passager business ne reçoit pas la chambre la moins chère");
    assert.equal(plan[0].format_cabine, "conforme");
    assert.equal(plan[0].prix_total, 180);
    assert.equal(plan[0].notes, "", "aucune réserve : le format attendu a été obtenu");
  });

  test("format : au-dessus du plafond, la chambre standard est retenue et le repli est DIT", () => {
    const { plan } = alloue([mkPax("J1", { cabine: "J" })], [mkHotel("j", { stars: 5 }, roomsJ(300))]);
    assert.equal(plan[0].room_type, "Standard Double Room", "le plafond prime sur le format");
    assert.equal(plan[0].format_cabine, "defaut");
    assert.match(plan[0].notes, /format J \(suite, executive, club, deluxe, premium\) indisponible sous le plafond/);
  });

  test("format : une liste de motifs VIDE ne change rien — le tri reste celui du prix", () => {
    const sansMotifs = policyAvec((p) => { p.cabins.J.room_type_patterns = []; });
    const { plan } = alloue([mkPax("J1", { cabine: "J" })], [mkHotel("j", { stars: 5 }, roomsJ(180))], { policy: sansMotifs });
    assert.equal(plan[0].room_type, "Standard Double Room");
    assert.equal(plan[0].prix_total, 100);
    // colonne vide, et non pas « defaut » : sans motif, il n'y a aucun format à respecter
    assert.equal(plan[0].format_cabine, "");
    assert.equal(plan[0].notes, "", "pas de réserve pour un format qui n'a jamais été demandé");
    // Y ne porte aucun motif dans la politique par défaut : même comportement sans patch
    const eco = alloue([mkPax("Y1", { cabine: "Y" })], [mkHotel("eco", { stars: 3 }, [
      mkRoom({ room_type: "Standard Room", price_per_night: 60 }),
      mkRoom({ room_type: "Deluxe Room", price_per_night: 75 }),
    ])]);
    assert.equal(eco.plan[0].room_type, "Standard Room");
    assert.equal(eco.plan[0].format_cabine, "");
  });

  test("format PMR : un dossier PMR n'est jamais placé dans un hôtel non accessible", () => {
    const pasAccessible = mkHotel("pasacc", { stars: 4, review_score: 9.5, amenities: amenities() }, [mkRoom({ price_per_night: 50 })]);
    const accessible = mkHotel("acc", { stars: 4, review_score: 7.5, amenities: amenities({ accessible: true }) }, [mkRoom({ price_per_night: 75 })]);

    // l'hôtel non accessible est mieux noté ET moins cher : seule l'accessibilité l'écarte
    const { plan } = alloue([mkPax("P1", { cabine: "Y", assistance: "WCHR" })], [pasAccessible, accessible]);
    assert.equal(plan[0].overlays, "PMR");
    assert.equal(plan[0].hotel, "Hôtel acc");

    // aucune solution accessible : ESCALADE, et le motif est « accessibilité », pas « capacité »
    const seul = alloue([mkPax("P1", { cabine: "Y", assistance: "WCHC" })], [pasAccessible]);
    assert.equal(seul.plan[0].statut, "ESCALADE DESK");
    assert.equal(seul.plan[0].escalade, "DESK (accessibilité)");
    assert.deepEqual(seul.summary.motifs, { accessibilité: 1 });

    // `require_accessible: false` est la seule façon d'y loger le dossier — c'est une décision de politique
    const souple = policyAvec((p) => { p.global.overlays.pmr.require_accessible = false; });
    const relache = alloue([mkPax("P1", { cabine: "Y", assistance: "WCHC" })], [pasAccessible], { policy: souple });
    assert.equal(relache.plan[0].statut, "OK");
    assert.equal(relache.plan[0].hotel, "Hôtel pasacc");
  });

  test("format : un mineur sans adulte au dossier sort en escalade NOMINATIVE, hors plan hôtel", () => {
    const mineurSeul = [mkPax("MIN333", { type_pax: "CHD", age: "10", nom: "PETIT", prenom: "Lea" })];
    const [dossier] = buildDossiers(mineurSeul, DEFAULT_POLICY);
    assert.equal(dossier.mineurSeul, true);
    assert.equal(dossier.escaladeNominative, "mineur sans adulte");
    assert.equal(computeNeeds([dossier]).total.mineursSeuls, 1);

    // un hôtel avec du stock est disponible : ce n'est pas la capacité qui l'écarte
    const { plan, summary, gaps } = alloue(mineurSeul, [mkHotel("eco", { stars: 3 })]);
    assert.equal(plan[0].statut, "ESCALADE DESK");
    assert.equal(plan[0].escalade, "DESK (mineur sans adulte)");
    assert.equal(plan[0].hors_plan, "mineur sans adulte");
    assert.match(plan[0].notes, /prise en charge nominative par le desk, hors plan hôtel/);
    assert.equal(summary.horsPlan, 1);
    // un dossier hors plan ne crée AUCUN manque : inutile de dépenser des agents pour lui
    assert.deepEqual(gaps.chambresManquantes, {});

    // option désactivée : le dossier repasse en chambre ordinaire (comportement du code)
    const sansEscalade = policyAvec((p) => { p.global.rooming.minor_alone_escalates = false; });
    const relache = alloue(mineurSeul, [mkHotel("eco", { stars: 3 })], { policy: sansEscalade });
    assert.equal(relache.plan[0].statut, "OK");
    assert.equal(relache.plan[0].hors_plan, "");
  });

  test("format : les couchages insuffisants sont comptés, visibles en note et en réserve", () => {
    // 3 adultes sous un même PNR avec « chambres_demandees = 1 » : une chambre à 2 couchages
    const trois = ["A", "B", "C"].map((prenom) => mkPax("T1", { prenom, chambres_demandees: 1 }));
    const { plan, summary, gaps } = alloue(trois, [mkHotel("eco", { stars: 3 })]);

    assert.equal(plan[0].statut, "OK", "la chambre existe : le statut ne se dégrade pas");
    assert.equal(plan[0].chambres, 1);
    assert.equal(plan[0].couchages_insuffisants, true);
    assert.equal(plan[0].couchages_manquants, 1);
    assert.match(plan[0].notes, /COUCHAGES : 2 place\(s\) déclarée\(s\) pour 3 personnes/);

    assert.equal(summary.couchagesInsuffisants, 1);
    assert.equal(summary.paxSansCouchage, 1);
    assert.equal(summary.complet, false, "un plan avec un couchage manquant ne se déclare jamais complet");
    assert.ok(summary.reserves.some((r) => /couchage suffisant/.test(r)));
    // le manque se dit en CHAMBRES pour l'extension, sans s'ajouter à chambresManquantes
    assert.deepEqual(gaps.couchagesManquants, { Y: 1 });
    assert.deepEqual(gaps.chambresManquantes, {});
  });
});

/* ================================================================== 2. les fiches */

/** Liste fixture : famille, PMR + accompagnant, mineure seule, business. Identité partielle. */
const ENTETE_V2 = [
  "pnr", "nom", "prenom", "type_pax", "cabine", "categorie", "statut_pax", "assistance",
  "droit_entree", "chambres_demandees", "age", "date_naissance", "nationalite", "passeport_num", "sexe",
];
const ligneV2 = (o) => {
  const d = {
    pnr: "", nom: "", prenom: "", type_pax: "ADT", cabine: "Y", categorie: "PAX",
    statut_pax: "EMBARQUE", assistance: "", droit_entree: "OUI", chambres_demandees: "",
    age: "", date_naissance: "", nationalite: "", passeport_num: "", sexe: "", ...o,
  };
  return ENTETE_V2.map((c) => d[c]).join(";");
};
const csvV2 = (...lignes) => `${ENTETE_V2.join(";")}\n${lignes.join("\n")}\n`;

/** Le jeu d'essai complet : ingestion + plan + fiches, tout hors ligne. */
function scenarioFiches() {
  const ing = ingestPassagers(csvV2(
    // famille : un adulte renseigné, une enfant sans identité
    ligneV2({ pnr: "FAM111", nom: "DURAND", prenom: "Marc", age: "40", date_naissance: "1986-05-02", nationalite: "FRA", passeport_num: "12AB34567", sexe: "M" }),
    ligneV2({ pnr: "FAM111", nom: "DURAND", prenom: "Julie", type_pax: "CHD", age: "8" }),
    // PMR non ambulante + accompagnant sans assistance propre
    ligneV2({ pnr: "PMR222", nom: "LEROY", prenom: "Anne", assistance: "WCHC", age: "70", date_naissance: "1956-01-01", nationalite: "FRA", passeport_num: "99ZZ11111", sexe: "F" }),
    ligneV2({ pnr: "PMR222", nom: "LEROY", prenom: "Paul", age: "72" }),
    // mineure sans adulte : hors plan hôtel
    ligneV2({ pnr: "MIN333", nom: "PETIT", prenom: "Lea", type_pax: "CHD", age: "10" }),
    // business : le format de chambre doit suivre
    ligneV2({ pnr: "BIZ444", nom: "ROY", prenom: "Eve", cabine: "J", age: "50" }),
  ), { now: NOW });

  const inventories = [mkHotel("acc", { stars: 4, amenities: amenities({ accessible: true }) }, [
    mkRoom({ room_type: "Accessible Twin", price_per_night: 70 }),
    mkRoom({ room_type: "Family Room", price_per_night: 78, family_capable: true, occupancy_children: 2 }),
    mkRoom({ room_type: "Deluxe Suite", price_per_night: 200 }),
  ])];

  const dossiers = buildDossiers(ing.pax, DEFAULT_POLICY);
  const { plan } = allocate({ dossiers, inventories, policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });
  const fiches = buildFiches({
    plan, rows: ing.pax, dossiers, policy: DEFAULT_POLICY, station: STATION_BKK,
    checkin: "2026-10-04", checkout: "2026-10-05", nights: 1, runId: "RUN1", vol: "SB800",
  });
  return { ing, plan, dossiers, ...fiches };
}

describe("C3 — une fiche de saisie par personne, au format de sa chambre", () => {
  test("fiches : une par PERSONNE à loger, y compris les dossiers non logés et les escalades", () => {
    const { ing, plan, fiches, resume } = scenarioFiches();
    assert.equal(ing.pax.length, 6, "six personnes à loger dans la fixture");
    assert.equal(plan.length, 4, "quatre dossiers au plan");
    assert.equal(fiches.length, 6, "une fiche par personne, pas une par dossier");
    assert.equal(resume.fiches, 6);

    // la mineure seule est ESCALADÉE : elle reçoit quand même sa fiche, c'est au comptoir qu'elle sert
    const escalade = fiches.find((f) => f.pnr === "MIN333");
    assert.equal(escalade.statut_fiche, "NON LOGÉ — COMPTOIR");
    assert.equal(escalade.hotel, "— aucun hôtel affecté —");
    assert.ok(escalade.escalade_motif, "une fiche non logée porte toujours un motif d'escalade");
    assert.match(escalade.notes, /MINEUR SANS ADULTE au dossier/);
    // un dossier sans chambre n'a pas de transfert : rien n'est promis sur un document signé
    assert.equal(escalade.pmr_transfert, "");
    assert.equal(escalade.chambre_no, "");
    assert.equal(resume.logees, 5);
    assert.equal(resume.non_logees, 1);

    // `resume.formats` compte les DOSSIERS (un format = un bloc de chambres), pas les fiches
    assert.equal(Object.values(resume.formats).reduce((s, n) => s + n, 0), plan.length);
    // le bloc comptoir est marqué `loge: false` : ses chambres sont à TROUVER
    const comptoir = resume.hotels.find((h) => h.loge === false);
    assert.equal(comptoir.hotel, "(sans hôtel — comptoir)");
    assert.equal(comptoir.fiches, 1);
  });

  test("fiches : le contenu suit la surcouche (PMR, famille) et le format de chambre", () => {
    const { fiches } = scenarioFiches();
    const par = (pnr, prenom) => fiches.find((f) => f.pnr === pnr && f.prenom === prenom);

    // libellé de format : surcouches d'abord (ce qui contraint la chambre), cabine ensuite (le barème)
    assert.equal(formatChambre({ overlays: "PMR+FAMILLE", cabine: "J" }), "PMR + FAMILLE + business (J)");
    assert.equal(formatChambre({ overlays: "", cabine: "W" }), "premium éco (W)");
    assert.equal(formatChambre({ overlays: "", cabine: "" }), "cabine non renseignée");

    const anne = par("PMR222", "Anne");
    assert.equal(anne.format_chambre, "PMR + éco (Y)");
    assert.equal(anne.pmr_chambre_accessible, "EXIGÉE");
    assert.match(anne.pmr_assistance, /^WCHC : /, "le code SSR brut est traduit en phrase pour le réceptionniste");
    // La fiche reprend maintenant le transfert de la LIGNE DE PLAN (couronne retenue, temps
    // déclaré) au lieu du seul libellé de la fiche escale — chantier du 21/09/2026.
    assert.match(
      anne.pmr_transfert,
      /taxi, max 45 min déclarées \(couronne unique dérivée de la fiche escale\) — véhicule adapté à confirmer/,
    );

    // l'accompagnant dort dans la chambre accessible SANS porter d'assistance : la fiche le dit
    const paul = par("PMR222", "Paul");
    assert.equal(paul.pmr_chambre_accessible, "EXIGÉE");
    assert.equal(paul.pmr_assistance, "", "aucune assistance n'est prêtée à qui n'en a pas demandé");
    assert.match(paul.notes, /le passager assisté est Anne LEROY, pas le titulaire de cette fiche/);

    // famille : la mineure porte un adulte référent nommé, et l'occupant de la chambre est complet
    const julie = par("FAM111", "Julie");
    assert.equal(julie.format_chambre, "FAMILLE + éco (Y)");
    assert.equal(julie.adulte_referent, "Marc DURAND");
    assert.equal(julie.occupants_chambre, "Marc DURAND, Julie DURAND");
    assert.equal(par("FAM111", "Marc").adulte_referent, "", "un adulte n'a pas de référent");

    // business : le format de cabine a bien piloté la chambre relevée
    const eve = par("BIZ444", "Eve");
    assert.equal(eve.format_chambre, "business (J)");
    assert.equal(eve.room_type, "Deluxe Suite");
    assert.equal(eve.bareme_eur_nuit, "250 EUR/nuit");
    assert.equal(anne.bareme_eur_nuit, "80 EUR/nuit", "le barème imprimé est celui de la cabine du dossier");
  });

  test("fiches : un champ non collecté est un BLANC marqué, jamais une valeur inventée", () => {
    const { fiches, resume } = scenarioFiches();
    const julie = fiches.find((f) => f.prenom === "Julie");

    // rien n'est deviné : ni date de naissance, ni nationalité, ni passeport
    for (const col of PAXLIST_IDENTITE) assert.equal(julie[col], NON_FOURNI, `${col} non transmis par la compagnie`);
    assert.equal(julie.age, "8", "l'âge, lui, était fourni : il n'est pas effacé");

    // deux marqueurs distincts, et la distinction est le sujet : à remplir ≠ non fourni
    const marc = fiches.find((f) => f.prenom === "Marc");
    assert.equal(marc.date_naissance, "1986-05-02");
    assert.equal(marc.passeport_num, "12AB34567");
    assert.equal(marc.chambre_no, A_REMPLIR, "le numéro de chambre est rempli par l'hôtel");
    assert.equal(marc.hotel_adresse, A_REMPLIR, "l'adresse n'est pas relevée par les agents (INV-3)");
    assert.equal(marc.signature, A_REMPLIR);
    assert.notEqual(A_REMPLIR, NON_FOURNI);

    // le CSV porte les mêmes marqueurs, sans jamais fabriquer un numéro de passeport
    const csv = buildFichesCsv(fiches);
    assert.equal(csv.charCodeAt(0), 0xfeff, "UTF-8 avec BOM (Excel)");
    assert.equal(csv.trim().split(/\r?\n/).length, fiches.length + 1);
    assert.ok(csv.includes(NON_FOURNI));
    // 45 → 52 : les 7 colonnes de géographie et de correspondance ajoutées le 21/09/2026
    // (couronne, temps de trajet déclaré, budget de trajet, heures limites de retour).
    assert.equal(FICHE_COLS.length, 52);
    assert.ok(FICHE_COLS.every((c) => c in fiches[0]), "toute colonne documentée existe sur la fiche");

    // le rendu imprimable annonce le nombre de fiches à identité incomplète, et échappe le texte
    const html = buildFichesHtml(fiches, { runId: "RUN1", vol: "SB800", station: STATION_BKK, resume });
    assert.ok(html.includes(`${resume.incompletes} fiche(s) à identité incomplète`));
    const injecte = buildFiches({
      plan: [{ pnr: "X", cabine: "Y", overlays: "", statut: "OK", hotel: "<script>alert(1)</script>", chambres: 1 }],
      rows: null, policy: DEFAULT_POLICY, station: STATION_BKK, runId: "R",
    });
    const htmlInjecte = buildFichesHtml(injecte.fiches, { runId: "R", resume: injecte.resume });
    assert.ok(!htmlInjecte.includes("<script>alert(1)</script>"));
    assert.ok(htmlInjecte.includes("&lt;script&gt;"));
  });

  test("fiches : le compte de fiches incomplètes est exact et cohérent avec l'ingestion", () => {
    const { ing, fiches, resume, avertissements } = scenarioFiches();

    // 2 personnes sur 6 portent les trois colonnes essentielles → 4 fiches incomplètes
    const attendu = fiches.filter((f) => PAXLIST_IDENTITE_ESSENTIELLE.some((c) => f[c] === NON_FOURNI)).length;
    assert.equal(resume.incompletes, 4);
    assert.equal(resume.incompletes, attendu, "le compteur est le décompte réel, pas une estimation");
    assert.equal(ing.rapport.compteurs.fiches.attendues, 6);
    assert.equal(ing.rapport.compteurs.fiches.completes, 2);
    assert.equal(ing.rapport.compteurs.fiches.attendues - ing.rapport.compteurs.fiches.completes, resume.incompletes);

    // le détail par colonne est chiffré des deux côtés, à l'identique
    assert.deepEqual(resume.manques, ing.rapport.compteurs.fiches.manques);
    assert.equal(resume.manques.date_naissance, 4);
    assert.equal(resume.manques.adresse_domicile, 6, "colonne jamais fournie par la fixture");
    assert.ok(avertissements.some((a) => /4 fiche\(s\) sur 6 partent avec une identité incomplète/.test(a)));
  });

  test("fiches : sans liste nominative, une fiche par DOSSIER — et l'écart est annoncé", () => {
    const planRow = {
      pnr: "AB12CD", occupants: "Jean MARTIN", pax: 1, cabine: "Y", overlays: "", statut: "OK",
      hotel: "Hôtel X", hotel_url: "https://x.test", room_type: "Twin", chambres: 1,
      mode_reglement: "carte_prepayee", devise: "EUR", conformite: "CONFORME",
    };
    const sansListe = buildFiches({ plan: [planRow], rows: null, policy: DEFAULT_POLICY, station: STATION_BKK, runId: "R" });
    assert.equal(sansListe.fiches.length, 1);
    assert.equal(sansListe.fiches[0].nom, A_REMPLIR, "aucun nom n'est déduit de la colonne occupants");
    assert.equal(sansListe.fiches[0].occupants_chambre, "Jean MARTIN");
    assert.ok(sansListe.avertissements.some((a) => /une fiche par DOSSIER au lieu d'une par personne/.test(a)));
    // COMPORTEMENT RÉEL À CONNAÎTRE : la fiche est comptée incomplète, mais le détail
    // `manques` reste à zéro — il n'est alimenté que par des personnes réellement lues.
    assert.equal(sansListe.resume.incompletes, 1);
    assert.deepEqual(sansListe.resume.manques, Object.fromEntries(PAXLIST_IDENTITE.map((c) => [c, 0])));

    // C7 : le montant de carte n'est jamais deviné — blanc marqué + note, ou valeur calculée
    assert.equal(sansListe.fiches[0].montant_carte_eur, A_REMPLIR);
    assert.match(sansListe.fiches[0].notes, /montant à charger non calculé par le run/);
    const avecMontant = buildFiches({
      plan: [planRow], rows: null, policy: DEFAULT_POLICY, station: STATION_BKK, runId: "R",
      montantCartePar: () => 120,
    });
    assert.equal(avecMontant.fiches[0].montant_carte_eur, 120);
  });
});

/* ======================================================== 3. PAXLIST v1 / v2 (C3) */

describe("C3 — la liste compagnie alimente les fiches sans jamais rien inventer", () => {
  /** En-tête PAXLIST v1 : 18 colonnes, aucune colonne d'identité. */
  const ENTETE_V1 = [
    "pnr", "nom", "prenom", "type_pax", "cabine", "categorie", "statut_pax", "assistance",
    "droit_entree", "destination_finale", "chambres_demandees", "flying_blue", "groupe",
    "age", "email", "telephone", "vol", "remarque",
  ];
  const ligneV1 = (pnr) => [pnr, "MARTIN", "Jean", "ADT", "Y", "PAX", "EMBARQUE", "", "OUI", "CDG", "", "NONE", "", "40", "j@x.test", "+687751234", "SB800", ""].join(";");
  const csvV1 = (...pnrs) => `${ENTETE_V1.join(";")}\n${pnrs.map(ligneV1).join("\n")}\n`;

  test("PAXLIST : une liste v1 (18 colonnes) reste acceptée à l'identique, avec un manque CHIFFRÉ", () => {
    assert.equal(ENTETE_V1.length, 18);
    const ing = ingestPassagers(csvV1("AB12CD", "EF34GH"), { now: NOW });

    assert.equal(ing.rapport.lignes.refusees, 0, "une liste v1 n'est jamais refusée pour cause d'identité absente");
    assert.equal(ing.rapport.lignes.retenues, 2);
    assert.deepEqual(ing.rapport.fichier.colonnes_ignorees, [], "aucune colonne v1 n'est perdue");
    // les champs d'identité existent sur la ligne canonique, vides — additifs, jamais devinés
    for (const col of PAXLIST_IDENTITE) assert.equal(ing.pax[0][col], "", `${col} reste vide`);
    assert.deepEqual(ing.pax[0].identite_hors_format, []);
    assert.equal(ing.pax[0].age, "40", "le socle v1 est lu exactement comme avant");
    assert.equal(ing.pax[0].age_source, "age");

    // le manque est un CHIFFRE, pas une impression, et il nomme les colonnes à réclamer
    const f = ing.rapport.compteurs.fiches;
    assert.equal(f.attendues, 2);
    assert.equal(f.completes, 0);
    for (const col of PAXLIST_IDENTITE) assert.equal(f.manques[col], 2);
    const avert = ing.rapport.avertissements.find((a) => a.code === "fiches_incompletes");
    assert.ok(avert, "une liste v1 déclenche toujours l'avertissement fiches_incompletes");
    assert.match(avert.message, /2 fiche\(s\) sur 2 seront incomplètes/);
    assert.match(avert.message, /date_naissance absent sur 2, nationalite absent sur 2, passeport_num absent sur 2/);
    assert.match(avert.message, /Colonnes à demander à la compagnie : date_naissance, nationalite, passeport_num/);
    // aucune colonne d'identité n'étant FOURNIE, « identité partielle » n'a pas de sens ici
    assert.ok(!ing.rapport.avertissements.some((a) => a.code === "identite_partielle"));
  });

  test("PAXLIST : une colonne d'identité fournie est LUE, et non plus écartée en silence", () => {
    const ing = ingestPassagers(
      "pnr;nom;type_pax;cabine;date_naissance;nationalite;passeport_num;numero_siege\n" +
        "AB12CD;MARTIN;ADT;Y;1986-05-02;FRA;12AB34567;12A\n",
      { now: NOW },
    );
    // lue, normalisée, portée sur la ligne canonique
    assert.equal(ing.pax[0].date_naissance, "1986-05-02");
    assert.equal(ing.pax[0].nationalite, "FRA");
    assert.equal(ing.pax[0].passeport_num, "12AB34567");
    assert.equal(ing.pax[0].age, "40", "l'âge est déduit de la date de naissance à la date injectée");
    assert.equal(ing.pax[0].age_source, "date_naissance");
    assert.equal(ing.rapport.compteurs.fiches.completes, 1);

    // une colonne réellement inconnue, elle, est nommée : elle ne disparaît plus en silence
    assert.deepEqual(ing.rapport.fichier.colonnes_ignorees, ["numero_siege"]);
    const ignorees = ing.rapport.avertissements.find((a) => a.code === "colonnes_ignorees");
    assert.match(ignorees.message, /numero_siege/);

    // une identité fournie mais ILLISIBLE est écartée AVEC son motif — jamais devinée
    const ambigu = ingestPassagers("pnr;nom;type_pax;cabine;date_naissance\nAB12CD;MARTIN;ADT;Y;03/04/1982\n", { now: NOW });
    assert.equal(ambigu.pax[0].date_naissance, "", "03/04 est le 3 avril ou le 4 mars : rien n'est tranché");
    const ecart = ambigu.rapport.avertissements.find((a) => a.code === "identite:date_naissance");
    assert.match(ecart.message, /écartée/);
    assert.match(ecart.message, /la fiche portera un blanc à remplir au comptoir/);
  });

  test("PAXLIST : les alias d'en-tête plausibles d'un DCS sont reconnus, les valeurs traduites", () => {
    const ing = ingestPassagers(
      "Record Locator;Last Name;First Name;PTC;Cabin Class;Date of Birth;Nationality;Passport Number;Gender\n" +
        "ZZ99YY;NGUYEN;Linh;ADT;BUSINESS;14MAR1982;Viet Nam;ab-12 345;FEMALE\n",
      { now: NOW },
    );
    assert.deepEqual(ing.rapport.fichier.colonnes_ignorees, [], "aucun en-tête anglais n'est perdu");
    assert.equal(ing.pax[0].pnr, "ZZ99YY");
    assert.equal(ing.pax[0].cabine, "J", "« BUSINESS » est traduit en tier J");
    assert.equal(ing.pax[0].date_naissance, "1982-03-14", "la forme PNR 14MAR1982 est acceptée");
    assert.equal(ing.pax[0].sexe, "F");
    // mise en forme du passeport : les séparateurs partent, les caractères signifiants restent
    assert.equal(ing.pax[0].passeport_num, "AB12345");
    assert.ok(ing.rapport.alias_valeurs.some((a) => /passeport_num : espaces et séparateurs retirés/.test(a)));
    assert.ok(ing.rapport.fichier.alias_appliques.includes("Date of Birth → date_naissance"));

    // un nom de pays en clair est CONSERVÉ et signalé, ni jeté ni converti au jugé
    assert.equal(ing.pax[0].nationalite, "VIET NAM");
    assert.deepEqual(ing.pax[0].identite_hors_format, ["nationalite"]);
    const horsFormat = ing.rapport.avertissements.find((a) => a.code === "identite_hors_format");
    assert.match(horsFormat.message, /hors format ISO 3166-1/);

    // la fiche porte alors la mention « identité à vérifier », sans altérer la valeur
    const plan = [{ pnr: "ZZ99YY", cabine: "J", overlays: "", statut: "OK", hotel: "Hôtel X", room_type: "Suite", chambres: 1 }];
    const { fiches } = buildFiches({ plan, rows: ing.pax, policy: DEFAULT_POLICY, station: STATION_BKK, runId: "R" });
    assert.equal(fiches[0].nationalite, "VIET NAM");
    assert.equal(fiches[0].identite_a_verifier, "nationalite");
    assert.match(fiches[0].notes, /identité à vérifier : nationalite hors format ISO 3166-1/);
  });
});
