/**
 * POLITIQUE DE PRISE EN CHARGE — budget de trajet, contrainte dure, critères cochables,
 * couronnes et colonnes de correspondance (chantier du 21/09/2026).
 *
 * Ce qui est vérifié ici tient en une phrase : l'horaire du vol suivant sert de RANG
 * (l'ordre de service) ET de BUDGET DE TRAJET (une contrainte DURE par dossier), et c'est
 * la seconde qui protège. Aucun rang ne permet d'outrepasser le budget de trajet.
 *
 * Deux règles du projet sont vérifiées en creux, à chaque test :
 *  - rien n'est estimé : pas d'horaire = pas de budget, jamais un budget par défaut ;
 *  - un temps de trajet est DÉCLARÉ par l'exploitation, jamais mesuré — l'outil n'a aucun
 *    service de routage et ne convertit pas une distance en durée.
 *
 * Tout hors ligne, déterministe, aucune session d'agent, aucun appel réseau.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDossiers, computeNeeds, avertissementsDe, chambresHorsPortee,
  calculerBudgetTrajet, satisfaitCritere, FILE_REPLI, ESCALADE_CORRESPONDANCE,
} from "../lib/dossiers.mjs";
import { allocate } from "../lib/allocate.mjs";
import { couronnesDe } from "../lib/stations.mjs";
import { DEFAULT_POLICY, CRITERES_DEFAUT, CRITERE_KEYS } from "../lib/policy.mjs";
import { ingestPassagers, PAXLIST_CORRESPONDANCE, PAXLIST_CORRESPONDANCE_DERIVEES } from "../lib/paxlist.mjs";
import { STATION_BKK, mkPax, mkHotel, mkRoom } from "./helpers.mjs";

/* ------------------------------------------------------------------ fabriques */

/** Politique dérivée du défaut, sans jamais muter DEFAULT_POLICY (partagé par tous les tests). */
const politique = (patch = () => {}) => {
  const p = structuredClone(DEFAULT_POLICY);
  patch(p);
  return p;
};

/** Remplace un critère coché par sa version modifiée, les autres restant intacts. */
const criteres = (par = {}) =>
  CRITERES_DEFAUT.map((c) => (par[c.cle] ? { ...c, ...par[c.cle] } : { ...c }));

/**
 * Fiche escale à DEUX couronnes déclarées : 15 min (≤ 5 km) et 60 min (≤ 40 km).
 * Ces minutes sont des DÉCLARATIONS d'exploitation, pas une mesure — c'est tout le sujet.
 */
const STATION_2C = {
  ...STATION_BKK,
  search: {
    ...STATION_BKK.search,
    couronnes: [
      { rang: 1, rayon_m: 5000, trajet_min: 15, mode: "taxi", note: "périmètre immédiat" },
      { rang: 2, rayon_m: 40000, trajet_min: 60, mode: "navette", note: "Bangkok est" },
    ],
  },
};

/** Prestations complètes : aucun test de ce fichier ne doit échouer sur la conformité. */
const AMENITES = {
  wifi_free: true, room_service: "24h", workspace: true,
  airport_shuttle: "gratuite", restaurant_late: true, accessible: true,
  breakfast_available: true,
};

/** Relevé d'hôtel à distance MESURÉE (`distance_ref` renseignée), avec n chambres. */
const hotelA = (id, km, n) =>
  mkHotel(id, { distance_km: km, distance_ref: "airport", amenities: AMENITES },
    [mkRoom({ quantity_available: n, quantity_displayed_max: n })]);

/** Heure murale d'escale servant de « maintenant » à tous les tests horaires. */
const MAINTENANT = "2026-09-20T23:10";

const parPnr = (plan) => Object.fromEntries(plan.map((r) => [r.pnr, r]));

/* ====================================================== 1. budget de trajet */

test("budget de trajet : un vol suivant à 05h40 quand il est 23h10 ne laisse AUCUN temps utile", () => {
  // 23:10 → 05:40 = 390 min. Les paramètres d'exploitation (policy.global.correspondance)
  // en retranchent 120 de présentation, 30 de marge et 240 de repos minimal : 390 − 390 = 0.
  // Le budget de trajet est donc nul, et un hôtel n'a plus de sens : escalade nominative,
  // repos côté piste à organiser au desk. Ce n'est PAS un manque de chambres.
  const [d] = buildDossiers(
    [mkPax("SERRE", { heure_correspondance: "2026-09-21T05:40", vol_correspondance: "TG930" })],
    DEFAULT_POLICY, { maintenantLocal: MAINTENANT },
  );
  assert.equal(d.correspondance.fenetre_min, 390);
  assert.equal(d.trajet_max_min, 0);
  assert.equal(d.correspondance.escalade, ESCALADE_CORRESPONDANCE);
  assert.equal(d.escaladeNominative, ESCALADE_CORRESPONDANCE);
  // l'explication nomme CHAQUE terme retranché : le chiffre est contestable au comptoir
  assert.deepEqual(
    {
      f: d.correspondance.explication.fenetre_min,
      a: d.correspondance.explication.avance_avant_vol_min,
      m: d.correspondance.explication.marge_min,
      r: d.correspondance.explication.repos_minimal_min,
      u: d.correspondance.explication.utile_min,
    },
    { f: 390, a: 120, m: 30, r: 240, u: 0 },
  );
});

test("budget de trajet : une heure un peu plus tardive rend un trajet COURT — seule la couronne 1 est atteignable", () => {
  // 23:10 → 06:40 = 450 min ; 450 − 390 = 60 min utiles, ALLER ET RETOUR → 30 min de trajet.
  // Face aux couronnes DÉCLARÉES de la fiche (15 min et 60 min), seule la première tient.
  const [d] = buildDossiers(
    [mkPax("COURT", { heure_correspondance: "2026-09-21T06:40" })],
    DEFAULT_POLICY, { maintenantLocal: MAINTENANT },
  );
  assert.equal(d.trajet_max_min, 30);
  assert.equal(d.correspondanceSerree, true, "450 min <= seuil_serree_min (480) : file « correspondance serrée »");
  assert.equal(d.file, "correspondance_serree");

  const { couronnes } = couronnesDe(STATION_2C);
  assert.deepEqual(couronnes.filter((c) => c.trajet_min <= d.trajet_max_min).map((c) => c.rang), [1]);

  // et l'allocation le confirme : seul l'hôtel de la couronne 1 lui est servi
  const plan = allocate({
    dossiers: [d], inventories: [hotelA("proche", 2, 9), hotelA("loin", 30, 9)],
    policy: DEFAULT_POLICY, station: STATION_2C, nights: 1,
  }).plan;
  assert.equal(plan[0].couronne, 1);
  assert.equal(plan[0].couronne_trajet_min_declare, 15);
});

test("budget de trajet : un vol à 22h LE LENDEMAIN autorise la couronne la plus lointaine", () => {
  // 23:10 → 22:00 le lendemain = 1 370 min ; utile 980 ; trajet 490 min au maximum.
  // Le dossier n'est pas « serré » (1 370 > 480) et aucune couronne ne lui est fermée.
  const [d] = buildDossiers(
    [mkPax("LARGE", { heure_correspondance: "2026-09-21T22:00" })],
    DEFAULT_POLICY, { maintenantLocal: MAINTENANT },
  );
  assert.equal(d.correspondance.fenetre_min, 1370);
  assert.equal(d.trajet_max_min, 490);
  assert.equal(d.correspondanceSerree, false);
  const { couronnes } = couronnesDe(STATION_2C);
  assert.deepEqual(couronnes.filter((c) => c.trajet_min <= d.trajet_max_min).map((c) => c.rang), [1, 2]);

  // vivier proche vide : il PEUT aller à 60 min de trajet déclarées, et il y va
  const plan = allocate({
    dossiers: [d], inventories: [hotelA("loin", 30, 9)],
    policy: DEFAULT_POLICY, station: STATION_2C, nights: 1,
  }).plan;
  assert.equal(plan[0].statut, "OK");
  assert.equal(plan[0].couronne, 2);
});

test("budget de trajet : une fenêtre inférieure au repos minimal sort en « correspondance trop serrée »", () => {
  // 23:10 → 02:00 = 170 min, soit moins que les 240 min de repos minimal à elles seules.
  const [d] = buildDossiers(
    [mkPax("NUIT", { heure_correspondance: "2026-09-21T02:00" })],
    DEFAULT_POLICY, { maintenantLocal: MAINTENANT },
  );
  assert.equal(d.correspondance.fenetre_min, 170);
  assert.ok(d.trajet_max_min < 0, "le budget est négatif, il n'est jamais ramené à zéro en silence");
  assert.equal(d.escaladeNominative, ESCALADE_CORRESPONDANCE);

  // le dossier sort du plan hôtel par le chemin NOMINATIF, avec son motif propre —
  // et surtout pas en « capacité », qui appellerait à relever d'autres hôtels
  const { plan, summary } = allocate({
    dossiers: [d], inventories: [hotelA("proche", 2, 9)],
    policy: DEFAULT_POLICY, station: STATION_2C, nights: 1,
  });
  assert.equal(plan[0].statut, "ESCALADE DESK");
  assert.equal(plan[0].hors_plan, ESCALADE_CORRESPONDANCE);
  assert.equal(summary.motifs?.["capacité"] ?? 0, 0);
});

test("budget de trajet : PAS D'HORAIRE = aucune contrainte, et surtout aucun budget inventé", () => {
  const dossiers = buildDossiers([mkPax("MUET"), mkPax("MUET2", { cabine: "J" })], DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  for (const d of dossiers) {
    assert.equal(d.trajet_max_min, null, "null, pas 0 : « Number(null) === 0 » enverrait tout le plan en escalade");
    assert.equal(d.correspondanceSerree, false);
    assert.equal(d.correspondance.escalade, null);
    assert.equal(d.correspondance.explication, null);
  }
  const needs = computeNeeds(dossiers);
  assert.equal(needs.parTrajet.contraint.dossiers, 0);
  assert.equal(needs.parTrajet.libre.dossiers, 2);
  assert.deepEqual(needs.parTrajet.paliers, []);
  assert.equal(needs.total.trajetMinContraint, null);
  assert.equal(chambresHorsPortee(needs, 60).chambres, 0, "aucun budget : aucune chambre n'est hors de portée");

  // et l'allocation se comporte comme avant les couronnes : l'hôtel lointain est servi
  const plan = allocate({
    dossiers, inventories: [hotelA("loin", 30, 9)],
    policy: DEFAULT_POLICY, station: STATION_2C, nights: 1,
  }).plan;
  assert.deepEqual(plan.map((r) => r.statut), ["OK", "OK"]);
  assert.deepEqual(plan.map((r) => r.trajet_max_min), ["", ""], "colonne vide = aucune contrainte, jamais « 0 »");
});

test("budget de trajet : « maintenant » est INJECTÉ, jamais lu sur l'horloge du serveur", () => {
  const row = [mkPax("INJ", { heure_correspondance: "2030-01-01T10:00" })];

  // 1) sans injection : aucun budget calculé, et l'outil le DIT au lieu de se rabattre
  //    sur l'horloge globale (ce qui fabriquerait un budget faux sans que rien ne le montre)
  const sans = buildDossiers(row, DEFAULT_POLICY);
  assert.equal(sans[0].trajet_max_min, null);
  assert.ok(avertissementsDe(sans).some((a) => a.code === "correspondance_sans_horloge"));

  // 2) avec injection : le budget suit l'heure INJECTÉE (2030), pas la date du jour
  const avec = buildDossiers(row, DEFAULT_POLICY, { maintenantLocal: "2030-01-01T00:00" });
  assert.equal(avec[0].correspondance.fenetre_min, 600);
  assert.equal(avec[0].trajet_max_min, 105); // (600 − 390) / 2

  // 3) déterminisme : deux appels successifs rendent le même chiffre
  const bis = buildDossiers(row, DEFAULT_POLICY, { maintenantLocal: "2030-01-01T00:00" });
  assert.equal(bis[0].trajet_max_min, avec[0].trajet_max_min);

  // 4) une horloge illisible ne produit pas un budget approché : elle produit un avertissement
  const faux = buildDossiers(row, DEFAULT_POLICY, { maintenant: "pas une heure" });
  assert.equal(faux[0].trajet_max_min, null);
  assert.ok(avertissementsDe(faux).some((a) => a.code === "maintenant_illisible"));
});

test("budget de trajet : calculerBudgetTrajet n'invente rien sans cadre ni horaire", () => {
  const cfg = DEFAULT_POLICY.global.correspondance;
  assert.equal(calculerBudgetTrajet({ heure: "", cadre: null, correspondance: cfg }).trajet_max_min, null);
  const illisible = calculerBudgetTrajet({ heure: "demain 5h", cadre: null, correspondance: cfg, pnr: "X" });
  assert.equal(illisible.trajet_max_min, null);
  assert.ok(illisible.avertissements.some((a) => a.code === "correspondance_illisible"));
});

test("budget de trajet : une cellule en CHIFFRES COLLÉS est refusée, jamais lue comme une année", () => {
  // Défaut trouvé et corrigé pendant la recette. `lireHorodatage` se rabattait sur
  // `Date.parse`, qui lit « 0540 » comme le 1er janvier de l'an 540 et « 9999 » comme le
  // 1er janvier 9999. Avec les DEUX horloges injectées — le câblage réel de
  // pipeline.mjs, demo/server.mjs et tools/rebooking-v2.mjs — la comparaison devenait
  // possible et « 9999 » rendait un budget de 2 096 506 840 minutes SANS un seul
  // avertissement : une cellule fautive se transformait en « aucune contrainte de
  // distance », et le dossier pouvait partir à 40 km. `lib/paxlist.mjs` refuse déjà ces
  // formes à l'ingestion ; les deux modules doivent refuser les mêmes.
  const cadre = { maintenant: new Date("2026-09-20T16:10:00Z"), maintenantLocal: MAINTENANT };
  for (const brut of ["0540", "2026", "9999", "1200"]) {
    const d = buildDossiers([mkPax("X", { heure_correspondance: brut })], DEFAULT_POLICY, cadre);
    assert.equal(d[0].trajet_max_min, null, `« ${brut} » ne doit produire aucun budget`);
    assert.equal(d[0].correspondance.escalade, null, `« ${brut} » ne doit pas non plus fabriquer une escalade`);
    assert.ok(avertissementsDe(d).some((a) => a.code === "correspondance_illisible"),
      `« ${brut} » doit être refusé À VOIX HAUTE`);
  }
  // les quatre formes légitimes traversent toujours, avec la même fenêtre de 390 min
  for (const bon of ["2026-09-21T05:40", "2026-09-21 05:40", "2026-09-21T05:40:00+07:00", "2026-09-20T22:40:00Z"]) {
    const d = buildDossiers([mkPax("X", { heure_correspondance: bon })], DEFAULT_POLICY, cadre);
    assert.equal(d[0].correspondance.fenetre_min, 390, `forme admise refusée : ${bon}`);
  }
});

test("budget de trajet : une fenêtre ABERRANTE ne devient pas un budget confortable", () => {
  // Défaut trouvé et corrigé pendant la recette. Une année fautive — « 2029 » saisi pour
  // « 2026 » — donnait une fenêtre de 26 343 h, donc un budget de 790 105 minutes, AFFICHÉ
  // tel quel par le dry-run (« paliers de budget : <= 790105 min ») et par le rapport.
  // C'est deux fautes en une : un chiffre rassurant qui n'est pas mérité, et un dossier
  // tenu pour NON CONTRAINT alors que son vol part peut-être dans six heures.
  // `lib/paxlist.mjs` écarte déjà ces horaires au-delà de CORRESPONDANCE_MAX_H, mais
  // seulement quand on lui fournit `opts.escale.arrivee_locale` — ce qu'aucun appelant
  // ne fait. Le garde-fou doit donc exister aussi là où le budget se calcule vraiment.
  const d = buildDossiers(
    [mkPax("LOIN", { heure_correspondance: "2029-09-22T20:30" })],
    DEFAULT_POLICY, { maintenantLocal: MAINTENANT },
  );
  assert.equal(d[0].trajet_max_min, null, "aucun budget plutôt qu'un budget absurde");
  const a = avertissementsDe(d).find((x) => x.code === "correspondance_lointaine");
  assert.ok(a, "l'horaire aberrant doit être NOMMÉ, dossier par dossier");
  assert.match(a.message, /LOIN/);
  assert.match(a.message, /n'est PAS réputé libre de s'éloigner/);

  // la borne est celle de paxlist, pas une invention : 72 h passe, 73 h non
  const limite = buildDossiers([mkPax("OK72", { heure_correspondance: "2026-09-23T23:00" })], DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  assert.ok(limite[0].trajet_max_min > 0, "une correspondance à ~72 h reste légitime");
  assert.equal(avertissementsDe(limite).some((x) => x.code === "correspondance_lointaine"), false);
});

/* ============================================ 2. la contrainte dure prime sur le rang */

test("contrainte dure : le budget de trajet prime sur le RANG DE SERVICE", () => {
  // LE test qui protège le dispositif. Le vivier proche tient UNE chambre. Le dossier qui
  // en a besoin (budget 30 min) est servi EN DERNIER : critère `correspondance_serree`
  // décoché exprès, il repart en simple file « Y », derrière le PMR et la cabine affaires.
  // S'il suffisait d'être servi tôt pour prendre le vivier proche, il finirait à 60 min de
  // trajet déclarées et manquerait son vol. Il ne doit PAS.
  const policy = politique((p) => {
    p.global.prise_en_charge.criteres = criteres({ correspondance_serree: { actif: false } });
  });
  const rows = [
    mkPax("PMR1", { assistance: "WCHR" }),
    mkPax("BIZ1", { cabine: "J" }),
    mkPax("COURT", { heure_correspondance: "2026-09-21T06:40" }),
  ];
  const dossiers = buildDossiers(rows, policy, { maintenantLocal: MAINTENANT });
  assert.deepEqual(dossiers.map((d) => d.pnr), ["PMR1", "BIZ1", "COURT"], "COURT est bien servi EN DERNIER");
  assert.equal(dossiers.find((d) => d.pnr === "COURT").trajet_max_min, 30);

  const { plan, summary } = allocate({
    dossiers,
    inventories: [hotelA("proche", 2, 1), hotelA("loin", 30, 9)],
    policy, station: STATION_2C, nights: 1,
  });
  const r = parPnr(plan);
  assert.equal(r.COURT.couronne, 1, "la seule chambre proche va au dossier CONTRAINT, pas au premier servi");
  assert.equal(r.PMR1.couronne, 2, "un dossier qui PEUT aller loin n'épuise pas le vivier proche");
  assert.equal(r.BIZ1.couronne, 2);
  assert.equal(summary.ok, 3);
  // la note dit POURQUOI le vivier proche a été laissé de côté : c'est vérifiable au comptoir
  assert.match(r.PMR1.notes, /couronne proche RÉSERVÉE aux dossiers dont le budget de trajet est plus court/);
});

test("contrainte dure : faute de chambre dans le budget, escalade « temps de trajet » — jamais un hôtel hors budget", () => {
  const policy = politique((p) => {
    p.global.prise_en_charge.criteres = criteres({ correspondance_serree: { actif: false } });
  });
  const rows = [
    mkPax("PMR1", { assistance: "WCHR" }),
    mkPax("C1", { heure_correspondance: "2026-09-21T06:40" }),
    mkPax("C2", { heure_correspondance: "2026-09-21T06:40" }),
  ];
  const dossiers = buildDossiers(rows, policy, { maintenantLocal: MAINTENANT });
  const { plan, summary } = allocate({
    dossiers,
    inventories: [hotelA("proche", 2, 1), hotelA("loin", 30, 9)],
    policy, station: STATION_2C, nights: 1,
  });
  const r = parPnr(plan);
  const loges = ["C1", "C2"].filter((k) => r[k].statut === "OK");
  assert.equal(loges.length, 1, "une seule chambre proche : un seul des deux dossiers contraints est logé");
  assert.equal(r[loges[0]].couronne, 1);
  const sorti = loges[0] === "C1" ? "C2" : "C1";
  assert.equal(r[sorti].hotel, "", "l'autre n'est PAS envoyé au-delà de son budget");
  assert.equal(r[sorti].escalade, "DESK (temps de trajet)");
  assert.equal(summary.escaladesTempsTrajet, 1);
  assert.equal(summary.motifs?.["capacité"] ?? 0, 0,
    "un manque de TEMPS ne doit pas se présenter comme un manque de chambres : la suite à donner est inverse");
  assert.match(r[sorti].notes, /AUCUNE CHAMBRE DANS LE TEMPS DE TRAJET DISPONIBLE/);
});

test("contrainte dure : AUCUNE ligne du plan ne dépasse le budget de trajet de son dossier", () => {
  // Invariant, vérifié sur un plan entier aux budgets mélangés et au vivier proche rare.
  const policy = politique((p) => {
    p.global.prise_en_charge.criteres = criteres({ correspondance_serree: { actif: false } });
  });
  const heures = ["2026-09-21T06:40", "2026-09-21T22:00", null, "2026-09-21T08:00", null, "2026-09-21T07:10"];
  const rows = heures.map((h, i) =>
    mkPax(`D${i}`, { cabine: i % 2 ? "J" : "Y", ...(h ? { heure_correspondance: h } : {}) }));
  const dossiers = buildDossiers(rows, policy, { maintenantLocal: MAINTENANT });
  const { plan, summary } = allocate({
    dossiers,
    inventories: [hotelA("proche", 2, 2), hotelA("loin", 30, 9)],
    policy, station: STATION_2C, nights: 1,
  });
  let violations = 0;
  for (const row of plan) {
    if (row.statut !== "OK") continue;
    if (row.trajet_max_min === "") continue; // aucun budget : aucune limite
    assert.notEqual(row.couronne_trajet_min_declare, "", "une ligne logée sous budget porte un temps DÉCLARÉ");
    if (row.couronne_trajet_min_declare > row.trajet_max_min) violations += 1;
  }
  assert.equal(violations, 0);
  assert.equal(summary.dossiersAvecBudget, 4);
  assert.equal(summary.ok + summary.escalade, plan.length);
});

/* ============================================================ 3. critères cochables */

test("critères : décocher un critère le retire de la file, sans faire disparaître le dossier", () => {
  const rows = [
    mkPax("BB"), mkPax("BB", { type_pax: "INF", age: "0" }),
    mkPax("FA"), mkPax("FA", { type_pax: "CHD", age: "12" }),
  ];
  const avec = buildDossiers(rows, DEFAULT_POLICY, {});
  assert.equal(avec.find((d) => d.pnr === "BB").file, "bebe");
  assert.deepEqual(avec.map((d) => d.pnr), ["BB", "FA"], "bebe (rang 5) passe devant famille (rang 6)");

  const sansBebe = politique((p) => { p.global.prise_en_charge.criteres = criteres({ bebe: { actif: false } }); });
  const sans = buildDossiers(rows, sansBebe, {});
  assert.equal(sans.find((d) => d.pnr === "BB").file, "famille", "le dossier retombe dans la file suivante qu'il satisfait");
  assert.equal(sans.length, 2, "décocher un critère ne fait perdre aucun dossier");
  // le critère reste SATISFAIT (l'inventaire doit toujours le savoir), il ne pilote plus la file
  assert.equal(satisfaitCritere("bebe", sans.find((d) => d.pnr === "BB"), { ageBasMax: 6 }), true);
  assert.equal(computeNeeds(sans).parCritere.bebe, undefined,
    "un critère décoché ne compte plus dans parCritere : seuls les critères ACTIFS y figurent");
});

test("critères : changer un rang change l'ordre de service", () => {
  const rows = [mkPax("JJ", { cabine: "J" }), mkPax("YY", { cabine: "Y" })];
  assert.deepEqual(buildDossiers(rows, DEFAULT_POLICY, {}).map((d) => d.pnr), ["JJ", "YY"],
    "défaut : J rang 8 avant Y rang 10");

  const yDabord = politique((p) => { p.global.prise_en_charge.criteres = criteres({ Y: { rang: 1 } }); });
  const d = buildDossiers(rows, yDabord, {});
  assert.deepEqual(d.map((x) => x.pnr), ["YY", "JJ"]);
  assert.equal(d[0].fileRang, 1);
});

test("critères : flying_blue ne crée JAMAIS de file, il départage à l'intérieur d'une file", () => {
  const fbDefaut = CRITERES_DEFAUT.find((c) => c.cle === "flying_blue");
  assert.equal(fbDefaut.departage, true);

  const rows = [mkPax("N"), mkPax("P", { flying_blue: "PLATINUM" }), mkPax("S", { flying_blue: "SILVER" })];
  const d = buildDossiers(rows, DEFAULT_POLICY, {});
  assert.deepEqual(d.map((x) => x.file), ["Y", "Y", "Y"], "tous en file « Y » : flying_blue n'ouvre aucune file");
  assert.deepEqual(d.map((x) => x.pnr), ["P", "S", "N"], "ordre gradué PLATINUM > SILVER > aucun statut");

  // et un statut ne fait pas franchir une file : un PMR sans statut passe devant un PLATINUM
  const mixte = buildDossiers([mkPax("PLAT", { flying_blue: "PLATINUM" }), mkPax("PMR", { assistance: "WCHR" })], DEFAULT_POLICY, {});
  assert.deepEqual(mixte.map((x) => x.pnr), ["PMR", "PLAT"]);
});

test("critères : un dossier qui ne satisfait AUCUN critère actif est quand même servi", () => {
  const seulPmr = politique((p) => {
    p.global.prise_en_charge.criteres = [{ cle: "pmr", actif: true, rang: 1, proximite: "preferee", departage: false }];
  });
  const dossiers = buildDossiers([mkPax("A", { assistance: "WCHR" }), mkPax("B")], seulPmr, {});
  const b = dossiers.find((d) => d.pnr === "B");
  assert.equal(b.file, FILE_REPLI);
  assert.equal(b.proximite, "aucune");
  assert.deepEqual(dossiers.map((d) => d.pnr), ["A", "B"], "servi EN DERNIER, mais servi");

  const { plan, summary } = allocate({
    dossiers, inventories: [hotelA("proche", 2, 9)], policy: seulPmr, station: STATION_2C, nights: 1,
  });
  assert.equal(summary.ok, 2);
  assert.equal(parPnr(plan).B.statut, "OK", "la file de repli reçoit une chambre comme les autres");
});

test("critères : une politique ANCIENNE (priorities seul) se comporte exactement comme avant", () => {
  // Politique enregistrée avant le 21/09/2026 : aucune case cochée. L'ancien mécanisme
  // reprend la main — file pmr → famille → cabine (ordre de global.priorities), puis
  // Flying Blue décroissant, puis taille du dossier décroissante. La référence ci-dessous
  // rejoue cette règle à la main : c'est elle, et non le nouveau code, qui dit « comme avant ».
  const ancienne = politique((p) => {
    p.global.prise_en_charge.criteres = [];
    p.global.priorities = ["pmr", "famille", "J", "W", "Y"];
  });
  const rows = [
    mkPax("Y1"), mkPax("J1", { cabine: "J" }), mkPax("PM", { assistance: "WCHR" }),
    mkPax("FA"), mkPax("FA", { type_pax: "CHD", age: "4" }),
    mkPax("W1", { cabine: "W" }), mkPax("J2", { cabine: "J", flying_blue: "GOLD" }),
  ];
  const dossiers = buildDossiers(rows, ancienne, { maintenantLocal: MAINTENANT });

  const FB = { PLATINUM: 3, GOLD: 2, SILVER: 1, NONE: 0 };
  const fileAncienne = (d) => (d.overlays.pmr ? "pmr" : d.overlays.famille ? "famille" : d.cabin);
  const attendu = [...dossiers].sort((a, b) => {
    const fa = ancienne.global.priorities.indexOf(fileAncienne(a));
    const fb = ancienne.global.priorities.indexOf(fileAncienne(b));
    if (fa !== fb) return fa - fb;
    if (FB[b.fb] !== FB[a.fb]) return FB[b.fb] - FB[a.fb];
    return b.adults + b.children - (a.adults + a.children);
  });
  assert.deepEqual(dossiers.map((d) => d.pnr), attendu.map((d) => d.pnr));
  assert.deepEqual(dossiers.map((d) => d.file), dossiers.map((d) => fileAncienne(d)));

  // aucune protection de correspondance n'est inventée sous une politique ancienne,
  // mais l'outil DIT qu'il tourne en mode hérité plutôt que de laisser croire au contraire
  for (const d of dossiers) assert.equal(d.proximite, "aucune");
  assert.ok(avertissementsDe(dossiers).some((a) => a.code === "criteres_absents"));

  // un mot de `priorities` qui ne désigne aucun critère n'a jamais rien piloté : on le dit
  const bavarde = politique((p) => {
    p.global.prise_en_charge.criteres = [];
    p.global.priorities = ["pmr", "famille", "senior", "J", "W", "Y"];
  });
  const av = avertissementsDe(buildDossiers(rows, bavarde, {}));
  const sansEffet = av.find((a) => a.code === "priorities_sans_critere");
  assert.ok(sansEffet && /senior/.test(sansEffet.message));
});

/* ==================================================================== 4. couronnes */

test("couronnes : un temps de trajet est TOUJOURS présenté comme déclaré", () => {
  const dossiers = buildDossiers([mkPax("A"), mkPax("B", { cabine: "J" })], DEFAULT_POLICY, {});
  const { plan, summary } = allocate({
    dossiers, inventories: [hotelA("proche", 2, 9)], policy: DEFAULT_POLICY, station: STATION_2C, nights: 1,
  });
  for (const row of plan.filter((r) => r.statut === "OK")) {
    assert.match(row.transfert, /déclarées/, "aucun temps de trajet ne s'affiche comme une mesure");
    assert.doesNotMatch(row.transfert, /mesuré|estimé|environ/i);
  }
  assert.equal(summary.couronnes.source, "declaree");
  assert.equal(summary.parCouronne["1"].trajet_min_declare, 15);
  // le nom même de la colonne porte le mot : un consommateur du CSV ne peut pas s'y tromper
  assert.ok("couronne_trajet_min_declare" in plan[0]);
});

test("couronnes : une escale SANS couronne déclarée retombe sur une couronne unique DÉRIVÉE", () => {
  const { couronnes, source } = couronnesDe(STATION_BKK); // fiche d'essai : aucune couronne
  assert.equal(source, "derivee");
  assert.equal(couronnes.length, 1);
  assert.deepEqual(
    { rayon_m: couronnes[0].rayon_m, trajet_min: couronnes[0].trajet_min, mode: couronnes[0].mode },
    { rayon_m: 5000, trajet_min: 45, mode: "taxi" },
    "dérivée de search.radius_km et de transfer.max_transfer_min, rien d'autre",
  );
  assert.match(couronnes[0].note, /aucune couronne déclarée/);

  const dossiers = buildDossiers([mkPax("A")], DEFAULT_POLICY, {});
  const { plan, summary } = allocate({
    dossiers, inventories: [hotelA("h", 2, 9)], policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1,
  });
  assert.equal(summary.couronnes.source, "derivee");
  // le libellé NOMME le repli : l'opérateur ne doit pas lire « 45 min » comme une couronne déclarée
  assert.equal(plan[0].transfert, "taxi, max 45 min déclarées (couronne unique dérivée de la fiche escale)");

  // conséquence honnête, et elle se dit : un budget plus court que 45 min ne trouve rien
  const court = buildDossiers([mkPax("C", { heure_correspondance: "2026-09-21T06:40" })], DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  const r = allocate({ dossiers: court, inventories: [hotelA("h", 2, 9)], policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });
  assert.equal(r.plan[0].escalade, "DESK (temps de trajet)");
  assert.equal(r.summary.escaladesTempsTrajet, 1);
});

test("couronnes : « distance_km: 0 » sans distance_ref n'est PAS « à l'aéroport »", () => {
  // Deux hôtels de data/inventaire/BKK.json portent un 0 qui signifie « non mesuré ».
  // Le prendre pour une distance nulle en ferait les hôtels les PLUS PROCHES du vivier,
  // et donnerait leurs chambres aux dossiers les plus contraints. Règle de prudence :
  // sans référence, la distance n'existe pas, et l'hôtel est tenu pour le plus lointain.
  const dossiers = () => buildDossiers([mkPax("X")], DEFAULT_POLICY, {});
  const sansRef = { ...hotelA("zero", 2, 9), distance_km: 0 };
  delete sansRef.answer.distance_km;
  delete sansRef.answer.distance_ref;
  const a = allocate({ dossiers: dossiers(), inventories: [sansRef], policy: DEFAULT_POLICY, station: STATION_2C, nights: 1 });
  assert.equal(a.plan[0].couronne_source, "inconnue");
  assert.equal(a.plan[0].couronne, 2, "rattaché PAR PRUDENCE à la couronne la plus lointaine");
  assert.equal(a.summary.dossiersCouronneIndeterminee, 1);
  assert.match(a.plan[0].notes, /COURONNE À CONFIRMER/);

  // le MÊME 0, accompagné de sa référence, est une vraie mesure : couronne 1
  const avecRef = { ...sansRef, distance_ref: "airport" };
  const b = allocate({ dossiers: dossiers(), inventories: [avecRef], policy: DEFAULT_POLICY, station: STATION_2C, nights: 1 });
  assert.equal(b.plan[0].couronne_source, "distance");
  assert.equal(b.plan[0].couronne, 1);

  // et un hôtel de couronne indéterminée reste inaccessible à un budget court : on ne le
  // suppose jamais proche pour sauver un taux de couverture
  const court = buildDossiers([mkPax("C", { heure_correspondance: "2026-09-21T06:40" })], DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  const c = allocate({ dossiers: court, inventories: [sansRef], policy: DEFAULT_POLICY, station: STATION_2C, nights: 1 });
  assert.equal(c.plan[0].escalade, "DESK (temps de trajet)");
});

/* ================================================================= 5. PAXLIST v3 */

const HEAD_V1 = "pnr;nom;prenom;type_pax;cabine;categorie;statut_pax;assistance;droit_entree;chambres_demandees;age";
const ligneV1 = (o = {}) => {
  const d = { pnr: "AB12CD", nom: "MARTIN", prenom: "Jean", type_pax: "ADT", cabine: "Y", categorie: "PAX", statut_pax: "EMBARQUE", assistance: "", droit_entree: "OUI", chambres_demandees: "", age: "40", ...o };
  return [d.pnr, d.nom, d.prenom, d.type_pax, d.cabine, d.categorie, d.statut_pax, d.assistance, d.droit_entree, d.chambres_demandees, d.age].join(";");
};

test("PAXLIST v3 : une liste sans colonne de correspondance passe à l'identique", () => {
  const csv = `${HEAD_V1}\n${ligneV1()}\n${ligneV1({ pnr: "EF34GH", nom: "DUPONT", cabine: "J" })}\n`;
  const { rows } = ingestPassagers(csv);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    for (const col of [...PAXLIST_CORRESPONDANCE, ...PAXLIST_CORRESPONDANCE_DERIVEES]) {
      assert.equal(r[col], "", `${col} doit rester vide sur une liste sans correspondance`);
    }
  }
  // la colonne AJOUTÉE mais vide ne change aucune valeur : l'ajout v3 est strictement additif
  const avecColonnes = ingestPassagers(
    `${HEAD_V1};vol_correspondance;heure_correspondance\n${ligneV1()};;\n${ligneV1({ pnr: "EF34GH", nom: "DUPONT", cabine: "J" })};;\n`,
  );
  assert.deepEqual(avecColonnes.rows, rows);

  // le manque est CHIFFRÉ plutôt que passé sous silence : c'est le nombre de dossiers
  // qui n'auront aucune contrainte de distance
  const absente = ingestPassagers(csv).rapport.avertissements.find((a) => a.code === "correspondance_absente");
  assert.ok(absente && /2 dossier\(s\) sur 2/.test(absente.message));

  // et aucun budget n'apparaît en bout de chaîne
  const dossiers = buildDossiers(rows, DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  assert.deepEqual(dossiers.map((d) => d.trajet_max_min), [null, null]);
});

test("PAXLIST v3 : un horaire de correspondance complet est LU et devient un budget de trajet", () => {
  const csv =
    `${HEAD_V1};vol_correspondance;heure_correspondance\n` +
    `${ligneV1()};TG930;2026-09-21T06:40\n`;
  const { rows } = ingestPassagers(csv);
  assert.equal(rows[0].vol_correspondance, "TG930");
  assert.equal(rows[0].heure_correspondance, "2026-09-21T06:40");
  assert.equal(rows[0].correspondance_date_source, "declaree");
  assert.equal(rows[0].correspondance_fuseau, "escale", "horloge MURALE de l'escale, jamais convertie en silence");
  assert.equal(rows[0].correspondance_utc, "", "aucun instant absolu sans décalage déclaré par la compagnie");

  const [d] = buildDossiers(rows, DEFAULT_POLICY, { maintenantLocal: MAINTENANT });
  assert.equal(d.volCorrespondance, "TG930");
  assert.equal(d.trajet_max_min, 30);
  assert.equal(d.file, "correspondance_serree");
});

test("PAXLIST v3 : une date INFÉRÉE produit un avertissement nommé, et rien n'est daté sans référence", () => {
  const csv = `${HEAD_V1};vol_correspondance;heure_correspondance\n${ligneV1()};TG930;05:40\n`;

  // 1) sans contexte d'escale, l'ingestion REFUSE de dater : la valeur brute est conservée
  const nu = ingestPassagers(csv);
  assert.equal(nu.rows[0].heure_correspondance, "");
  assert.equal(nu.rows[0].correspondance_date_source, "indeterminee");
  assert.equal(nu.rows[0].heure_correspondance_brute, "05:40");

  // 2) avec l'arrivée du vol dérouté, la date est INFÉRÉE — première occurrence
  //    strictement postérieure à l'arrivée — et l'inférence est NOMMÉE
  const avec = ingestPassagers(csv, {
    escale: { code: "BKK", timezone: "Asia/Bangkok", arrivee_locale: "2026-09-20T23:15", offset_min: 420 },
  });
  assert.equal(avec.rows[0].heure_correspondance, "2026-09-21T05:40", "05:40 après une arrivée à 23h15 tombe le LENDEMAIN");
  assert.equal(avec.rows[0].correspondance_date_source, "inferee");
  const inferee = avec.rapport.avertissements.find((a) => a.code === "correspondance_date_inferee");
  assert.ok(inferee, "une date inférée doit porter un avertissement nommé");
  assert.match(inferee.message, /strictement postérieure/);
});

/* ------------------------------------------------- garde-fou de vocabulaire */

test("prise en charge : les 13 critères cochables sont tous implémentés", () => {
  // Une case cochée dans l'interface qui ne serait reliée à aucun prédicat serait le pire
  // des chiffres rassurants : un réglage visible et sans effet, comme l'ancien `priorities`.
  const d = buildDossiers([mkPax("A")], DEFAULT_POLICY, {})[0];
  for (const cle of CRITERE_KEYS) {
    assert.equal(typeof satisfaitCritere(cle, d, { ageBasMax: 6 }), "boolean", `critère ${cle} sans prédicat`);
  }
  assert.equal(CRITERES_DEFAUT.length, CRITERE_KEYS.length);
  assert.equal(satisfaitCritere("inconnu", d, {}), false, "une clé inconnue rend false, jamais une exception");
});
