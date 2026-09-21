/**
 * Tests des conditions client C5 (réserver en moins d'une heure — budget d'horloge du run)
 * et C7 (règlement par cartes prépayées).
 *
 * Tout est HORS LIGNE et à 0 € : aucune session d'agent n'est lancée, aucun appel réseau
 * n'est fait, et aucune horloge réelle n'est attendue — les échéances sont INJECTÉES
 * (`deadlineAt`, `minutesUsed`, `max_minutes_per_run`) et les collecteurs du pipeline sont
 * des fonctions locales. Le client de plateforme passé aux fonctions de session est un
 * mandataire qui LÈVE à la moindre lecture : si un test ouvrait une session, il échouerait
 * au lieu de facturer (INV-8).
 *
 * Les fixtures sont construites ici et dans `helpers.mjs` : aucune donnée passager réelle.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planExtension, runProbe } from "../lib/capacite.mjs";
import { runReleve, MIN_DEMARRAGE_MS } from "../lib/releve.mjs";
import { runDiscovery } from "../lib/discovery.mjs";
import { runPipeline } from "../lib/pipeline.mjs";
import { normalizeInventaire } from "../lib/inventaire.mjs";
import { carteLigne, agregerCartes, computeCost } from "../lib/cout.mjs";
import { modeReglement } from "../lib/reglement.mjs";
import { buildRapportMd } from "../lib/rapport.mjs";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { mkHotel, mkPax, mkRoom, mkRecord, mkInv, mkInvEntry, STATION_BKK } from "./helpers.mjs";

const NOW = new Date("2026-09-15T12:00:00Z");
const SCENARIO = { station: "BKK", checkin: "2026-10-04", nights: 1, seed: 42, simulate: false, force_discovery: false, next_update_minutes: 30 };

/** Politique validée, puis surchargée champ par champ (les surcharges sont ADDITIVES). */
const politique = (over = {}) => {
  const p = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  Object.assign(p.global.discovery, over.discovery ?? {});
  Object.assign(p.extension, over.extension ?? {});
  Object.assign(p.agents, over.agents ?? {});
  Object.assign(p.allowances, over.allowances ?? {});
  if (over.payment) Object.assign(p.payment, over.payment);
  if (over.prepaid_card) Object.assign(p.payment.prepaid_card, over.prepaid_card);
  return p;
};

/** Client de plateforme INTERDIT : toute lecture lève — garantie « zéro session ». */
const CLIENT_INTERDIT = new Proxy(
  {},
  { get: (_c, prop) => { throw new Error(`session d'agent interdite dans ce test (client.${String(prop)})`); } },
);

/** Échéance injectée trop proche pour qu'une session puisse démarrer (C5). */
const echeanceTropProche = () => Date.now() + MIN_DEMARRAGE_MS - 5_000;

const cand = (id, tiers = ["J", "W", "Y"]) => ({ id, name: `Hôtel ${id}`, url: `https://x.test/${id}`, tiers, fallback: false, score: 0.5 });

/* ------------------------------------------------------------------- */
/* C5 — le temps est une borne du run, au même rang que les trois autres */
/* ------------------------------------------------------------------- */

describe("C5 — budget d'horloge du run", () => {
  test("C5 : max_minutes_per_run est une borne au même rang que les vagues, les sessions et le coût", () => {
    const base = {
      gaps: { chambresManquantes: { Y: 5 } }, inventories: [], candidates: [cand("b")],
      surveyedKeys: new Set(), probedKeys: new Set(), station: STATION_BKK, wave: 1, sessionsUsed: 0, costUsd: 0,
    };
    const policy = politique({ extension: { max_minutes_per_run: 45 } });

    // sous l'échéance : l'extension continue, et l'horloge est DÉJÀ rapportée
    const enCours = planExtension({ ...base, policy, minutesUsed: 44.2 });
    assert.equal(enCours.stop, false);
    assert.equal(enCours.limits.minutes_max, 45);
    assert.equal(enCours.limits.minutes_used, 44.2);

    // à l'échéance : arrêt, exactement comme pour max_waves / max_sessions / max_cost
    const stop = planExtension({ ...base, policy, minutesUsed: 45 });
    assert.equal(stop.stop, true);
    assert.match(stop.reason, /max_minutes_per_run \(45 min\)/);
    assert.deepEqual(stop.probes, []);
    assert.deepEqual(stop.surveys, []);
    // les trois autres bornes rendent la même forme d'arrêt
    assert.match(planExtension({ ...base, policy, wave: 9 }).reason, /max_waves/);
    // defauts releves le 21/09 : 18 -> 50 sessions, 10 -> 15 $ (40 hotels multi-sources)
    assert.match(planExtension({ ...base, policy, sessionsUsed: 50 }).reason, /max_sessions_per_run/);
    assert.match(planExtension({ ...base, policy, costUsd: 15 }).reason, /max_cost_usd_per_run/);
  });

  test("C5 : sans horloge fournie, l'extension ne s'arrête jamais sur ce critère", () => {
    const policy = politique();
    policy.extension.max_minutes_per_run = null; // injection : pas de budget d'horloge
    const plan = planExtension({
      gaps: { chambresManquantes: { Y: 5 } }, inventories: [], candidates: [cand("b")],
      surveyedKeys: new Set(), probedKeys: new Set(), policy, station: STATION_BKK,
      wave: 1, sessionsUsed: 0, costUsd: 0, minutesUsed: 10_000,
    });
    assert.equal(plan.stop, false);
    assert.equal(plan.limits.minutes_max, null);
  });

  test("C5 : l'échéance arrête l'extension et le motif dit « temps », jamais « épuisé »", async () => {
    // `max_minutes_per_run = 0` est injecté APRÈS validation (le schéma plancher à 5 min) :
    // c'est la seule façon de faire tomber l'échéance sans faire dormir la suite de tests.
    const policy = politique({ discovery: { max_hotels_stage_b: 1 } });
    policy.extension.max_minutes_per_run = 0;
    const events = [];
    const res = await runPipeline({
      policy, station: STATION_BKK, scenario: SCENARIO,
      rows: Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`)),
      inventaire: invAvecPlein(), collect: collecteur({ calls: [], record: (c) => foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]) }),
      emit: (type, data, extra) => events.push({ type, data, ...extra }), now: NOW,
    });

    assert.match(res.extensionStopReason, /max_minutes_per_run/);
    assert.doesNotMatch(res.extensionStopReason, /épuisé/); // manque de TEMPS ≠ manque d'hôtels
    assert.equal(res.deadlineHit, true);
    assert.equal(res.minutesMax, 0);

    const deadline = events.find((e) => e.type === "deadline");
    assert.ok(deadline, "un événement `deadline` doit être émis");
    assert.equal(deadline.data.phase, "extension");
    const warn = events.find((e) => e.type === "warning" && /échéance du run atteinte/.test(e.data.message));
    assert.ok(warn, "l'échéance doit être dite en clair à l'opérateur");
    assert.match(warn.data.message, /arrêté par le TEMPS, pas par l'inventaire/);
    // le run va quand même au bout : le manque sort en escalade chiffrée, pas en silence
    assert.equal(res.alloc.summary.escalade, 6);
    assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).data.deadline_hit, true);
  });

  test("C5 : une session qui ne peut plus finir n'est pas lancée — relevé, sonde et découverte (skipped_budget, 0 session, 0 $)", async () => {
    const deadlineAt = echeanceTropProche();
    const evts = [];
    const emit = (type, data, extra) => evts.push({ type, data, ...extra });
    const commun = {
      client: CLIENT_INTERDIT, policy: politique(), station: STATION_BKK,
      checkin: "2026-10-04", checkout: "2026-10-05", groupId: "g", emit, deadlineAt,
    };

    const releve = await runReleve({ ...commun, candidate: cand("b"), tiers: ["Y"] });
    assert.equal(releve.status, "skipped_budget");
    assert.equal(releve.sessionId, null); // aucune session ouverte
    assert.equal(releve.answer, null);

    const sonde = await runProbe({ ...commun, probe: { hotelKey: "b", name: "Hôtel b", url: "https://x.test/b", requested_rooms: 6 } });
    assert.equal(sonde.status, "skipped_budget");
    assert.equal(sonde.started, false); // « jamais lancée » : c'est la marque qui vaut
    assert.equal(sonde.costUsd, 0);
    assert.equal(sonde.definitif, false); // le budget n'est pas un défaut de l'hôtel

    const decouverte = await runDiscovery({ ...commun });
    assert.equal(decouverte.status, "skipped_budget");
    assert.equal(decouverte.sessionId, null);
    assert.equal(decouverte.costUsd, 0);
    assert.deepEqual(decouverte.candidates, []);

    // les trois le disent, et le disent avec le temps qu'il restait
    const budgets = evts.filter((e) => e.type === "warning" && /budget d'horloge du run épuisé/.test(e.data.message));
    assert.equal(budgets.length, 3);
  });

  test("C5 : un relevé d'extension jamais lancé ne bannit pas son hôtel des vagues suivantes, et ne consomme ni session ni coût", async () => {
    const calls = [];
    let bSaute = false;
    const collect = collecteur({
      calls,
      record: (c, ctx) => {
        if (c.id === "plein") return foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]);
        if (c.id === "b" && !bSaute) { bSaute = true; return sauteBudget(c); }
        return notFound(c, ctx);
      },
    });
    const events = [];
    const res = await runPipeline({
      policy: politique({
        discovery: { max_hotels_stage_b: 1 },
        agents: { concurrency: 3 },
        extension: { probe_same_hotel_first: false, max_waves: 2 },
      }),
      station: STATION_BKK, scenario: SCENARIO,
      rows: Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`)),
      inventaire: invCinq(), collect, emit: (type, data, extra) => events.push({ type, data, ...extra }), now: NOW,
    });

    assert.equal(calls[1], "releves:b,c,d"); // vague 1 : b, c, d
    assert.ok(calls[2]?.startsWith("releves:"), "une vague 2 doit avoir lieu");
    assert.ok(calls[2].includes("b"), "« b » n'a jamais été relevé : il doit revenir, pas être banni");
    // 3 relevés demandés en vague 1 dont 1 jamais lancé → 2 sessions seulement
    const nouveauxEnVague2 = calls[2].slice("releves:".length).split(",").length;
    assert.equal(res.sessionsUsed, 2 + nouveauxEnVague2);
    assert.equal(res.costUsd, 0); // fixtures : aucun coût, et surtout aucune session facturée
    const deadline = events.find((e) => e.type === "deadline");
    assert.ok(deadline, "un relevé sauté faute d'horloge doit être rapporté comme une échéance");
    assert.equal(deadline.data.phase, "relevés d'extension");
  });

  test("C5 : une sonde en échec a droit à un retry borné et n'est pas bannie avant son résultat", async () => {
    const calls = [];
    const collect = collecteur({
      calls,
      record: (c) => foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]),
      // la sonde a bien tourné (`started: true`) mais n'a rien mesuré, sans être définitive
      probeAnswer: () => ({ hotel: "plein", found: false, started: true, definitif: false, status: "sans_reponse", costUsd: 0 }),
    });
    const events = [];
    const res = await runPipeline({
      policy: politique({ discovery: { max_hotels_stage_b: 1 } }),
      station: STATION_BKK, scenario: SCENARIO,
      rows: Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`)),
      inventaire: normalizeInventaire(mkInv([mkInvEntry("plein", { review_score: 9 })])),
      collect, emit: (type, data, extra) => events.push({ type, data, ...extra }), now: NOW,
    });

    const sondes = calls.filter((c) => c === "probe:plein");
    assert.equal(sondes.length, 2, "une seconde tentative, et une seule : le retry est borné (2 tentatives)");
    assert.equal(res.sessionsUsed, 2); // deux sondes réellement lancées
    const warns = events.filter((e) => e.type === "warning").map((e) => e.data.message);
    assert.ok(warns.some((m) => /nouvelle tentative prévue à la vague suivante/.test(m)), "la 1re tentative n'écarte pas l'hôtel");
    assert.ok(warns.some((m) => /après 2 tentative\(s\)[\s\S]*écarté des sondes suivantes/.test(m)), "la 2e tentative clôt le sujet, en le disant");
  });

  test("C5 : une sonde jamais lancée (budget) ne consomme ni session ni coût, et ne bannit pas l'hôtel", async () => {
    const calls = [];
    const collect = collecteur({
      calls,
      record: (c) => foundRecord(c, [mkRoom({ cap_reached: true, price_per_night: 70 })]),
      probeAnswer: (p) => ({ hotel: p.hotelKey, found: false, started: false, definitif: false, status: "skipped_budget", costUsd: 0 }),
    });
    const events = [];
    const res = await runPipeline({
      policy: politique({ discovery: { max_hotels_stage_b: 1 }, extension: { max_waves: 3 } }),
      station: STATION_BKK, scenario: SCENARIO,
      rows: Array.from({ length: 15 }, (_, i) => mkPax(`P${i}`)),
      inventaire: normalizeInventaire(mkInv([mkInvEntry("plein", { review_score: 9 })])),
      collect, emit: (type, data, extra) => events.push({ type, data, ...extra }), now: NOW,
    });

    assert.ok(calls.filter((c) => c === "probe:plein").length >= 2, "le temps a manqué, pas l'hôtel : il reste sondable");
    assert.equal(res.sessionsUsed, 0, "aucune session : une sonde non lancée ne consomme pas de borne");
    assert.equal(res.costUsd, 0);
    const deadline = events.find((e) => e.type === "deadline");
    assert.ok(deadline);
    assert.equal(deadline.data.phase, "sonde");
    // et surtout : jamais le message de bannissement réservé aux sondes en échec
    assert.ok(!events.some((e) => e.type === "warning" && /écarté des sondes suivantes/.test(e.data.message ?? "")));
  });
});

/* -------------------------------------------------- */
/* C7 — règlement des passagers par cartes prépayées   */
/* -------------------------------------------------- */

/** Ligne de plan minimale destinée à `carteLigne` / `computeCost`. */
const ligne = (over = {}) => ({
  pnr: "P1", cabine: "Y", hotel: "Hôtel b", pax: 2, chambres: 1,
  prix_total: 160, devise: "EUR", mode_reglement: "carte_prepayee", statut: "OK", ...over,
});

/** Politique « mode nominal client » : carte prépayée, indemnités renseignées. */
const politiqueCarte = (prepaid = {}, allowances = {}) =>
  politique({
    payment: { default_mode: "carte_prepayee" },
    prepaid_card: { enabled: true, load_includes: ["nuit", "repas", "transport"], per: "dossier", marge_eur: 0, arrondi_eur: 10, plafond_eur: null, ...prepaid },
    allowances: { meal_eur_per_pax_per_day: 25, transport_eur_per_pax: 10, ...allowances },
  });

describe("C7 — cartes prépayées", () => {
  test("C7 : default_mode = carte_prepayee → la ligne sort en carte quel que soit company_payment_possible", () => {
    const policy = politiqueCarte();
    for (const [nom, hotel, cpp] of [
      ["prépaiement en ligne possible", { payment: { prepayment_online: "oui" } }, "oui"],
      ["paiement compagnie impossible", { payment: { prepayment_online: "non", pay_at_property_only: true } }, "non"],
      ["plateforme muette", { payment: { prepayment_online: "non_precise", pay_at_property_only: null } }, "a_confirmer"],
      ["hôtel contracté sans prépaiement", { contracted: true, payment: { prepayment_online: "non" } }, "oui"],
    ]) {
      const r = modeReglement(hotel, policy);
      assert.equal(r.mode, "carte_prepayee", `${nom} : la carte est un mode VOULU, pas un repli`);
      assert.equal(r.escalade, false);
      assert.equal(r.company_payment_possible, cpp);
      assert.equal(r.source, "mode_nominal");
    }
    // seule exception : contracté ET déjà prépayé en ligne — charger une carte paierait deux fois
    const deja = modeReglement({ contracted: true, payment: { prepayment_online: "oui" } }, policy);
    assert.equal(deja.mode, "compagnie");
    assert.equal(deja.source, "prepaiement_en_ligne_contracte");
  });

  test("C7 : carte désactivée alors que la politique la désigne → avertissement, jamais un basculement muet", () => {
    const policy = politiqueCarte({ enabled: false });
    const r = modeReglement({ payment: { prepayment_online: "oui" } }, policy);
    assert.equal(r.source, "politique_incoherente");
    assert.match(r.avertissement, /aucune carte ne sera émise/);
    assert.equal(r.mode, "compagnie");
  });

  test("C7 : le montant de carte est calculé depuis load_includes, poste par poste", () => {
    const policy = politiqueCarte({ arrondi_eur: 0 });
    const c = carteLigne(ligne(), policy, { nights: 2 });
    assert.deepEqual(c.postes, { nuit: 160, repas: 25 * 2 * 2, transport: 10 * 2 });
    assert.equal(c.base, 160 + 100 + 20);
    assert.equal(c.montant_par_carte, 280);
    assert.equal(c.incomplet, false);
    assert.deepEqual(c.postes_non_renseignes, []);

    // retirer un poste de `load_includes` le retire du montant — rien d'autre ne bouge
    const nuitSeule = carteLigne(ligne(), politiqueCarte({ load_includes: ["nuit"], arrondi_eur: 0 }), { nights: 2 });
    assert.deepEqual(nuitSeule.postes, { nuit: 160, repas: null, transport: null });
    assert.equal(nuitSeule.base, 160);
    assert.equal(nuitSeule.incomplet, false); // un poste non demandé ne manque pas

    // aucun poste demandé : le montant n'est pas « 0 », il n'est pas calculable
    const aucun = carteLigne(ligne(), politiqueCarte({ load_includes: [] }), { nights: 1 });
    assert.equal(aucun.base, null);
    assert.equal(aucun.montant_par_carte, null);
    assert.equal(aucun.incomplet, true);
    assert.ok(aucun.motifs.includes("aucun_poste"));
  });

  test("C7 : une indemnité null n'est JAMAIS estimée — poste « non renseigné » et carte incomplète (EX-COU-1, H-7)", () => {
    const policy = politiqueCarte({ arrondi_eur: 0 }, { meal_eur_per_pax_per_day: null });
    const c = carteLigne(ligne(), policy, { nights: 2 });
    assert.equal(c.postes.repas, null, "aucune estimation : le repas n'est pas chiffré");
    assert.ok(c.postes_non_renseignes.includes("repas"));
    assert.ok(c.motifs.includes("repas_non_renseigne"));
    assert.equal(c.incomplet, true);
    // le montant ne porte QUE les postes réellement chiffrés
    assert.equal(c.base, 160 + 20);
    assert.ok(c.avertissements.some((a) => /indemnité repas non renseignée/.test(a)));

    // et l'agrégat le redit à celui qui commande les cartes
    const agg = agregerCartes([c], policy);
    assert.equal(agg.cartes_incompletes, 1);
    assert.equal(agg.cartes_completes, 0);
    assert.deepEqual(agg.postes_non_renseignes, ["repas"]);
    assert.equal(agg.montant_total_a_charger, null, "un montant partiel ne se présente pas comme un total à charger");
    assert.deepEqual(agg.montant_partiel_par_devise, { EUR: 180 });
    assert.ok(agg.avertissements.some((a) => /à compléter avant émission/.test(a)));
  });

  test("C7 : marge_eur, arrondi_eur et per sont appliqués", () => {
    // marge puis arrondi au multiple SUPÉRIEUR : 280 + 15 = 295 → 300
    const avecMarge = carteLigne(ligne(), politiqueCarte({ marge_eur: 15, arrondi_eur: 25 }), { nights: 2 });
    assert.equal(avecMarge.base, 280);
    assert.equal(avecMarge.marge_eur, 15);
    assert.equal(avecMarge.arrondi_eur, 25);
    assert.equal(avecMarge.montant_par_carte, 300);
    assert.equal(avecMarge.cartes, 1); // per = dossier
    assert.equal(avecMarge.montant_total, 300);

    // per = personne : une carte par personne du dossier, montant réparti, marge sur CHAQUE carte
    const parPersonne = carteLigne(ligne(), politiqueCarte({ per: "personne", marge_eur: 15, arrondi_eur: 25 }), { nights: 2 });
    assert.equal(parPersonne.per, "personne");
    assert.equal(parPersonne.cartes, 2);
    // 280/2 = 140, +15 = 155, arrondi au multiple SUPÉRIEUR de 25 → 175 (et non 155)
    assert.equal(parPersonne.montant_par_carte, 175);
    assert.equal(parPersonne.montant_total, 350); // 2 cartes : l'arrondi et la marge sont par carte
  });

  test("C7 : un dépassement de plafond_eur escalade, il n'est pas corrigé en silence", () => {
    const policy = politiqueCarte({ plafond_eur: 200, arrondi_eur: 0 });
    const c = carteLigne(ligne(), policy, { nights: 2 });
    assert.equal(c.montant_par_carte, 280);
    assert.equal(c.plafond_eur, 200);
    assert.equal(c.plafond_depasse, true);
    assert.equal(c.escalade, "carte insuffisante");
    assert.ok(c.motifs.includes("plafond_depasse"));

    const agg = agregerCartes([c], policy);
    assert.equal(agg.escalades.length, 1);
    assert.deepEqual(agg.escalades[0], { pnr: "P1", motif: "carte insuffisante", montant_par_carte: 280, devise: "EUR", plafond_eur: 200 });
    assert.ok(agg.avertissements.some((a) => /au-dessus du plafond de 200 EUR/.test(a)));

    // sous le plafond : aucune escalade
    const ok = carteLigne(ligne({ prix_total: 40 }), policy, { nights: 1 });
    assert.equal(ok.plafond_depasse, false);
    assert.equal(ok.escalade, "");
  });

  test("C7 : plafond en EUR et carte dans la devise du relevé → contrôle non exécuté, et dit comme tel", () => {
    // seule la nuit est chargée : la carte est alors libellée dans la devise du relevé
    const policy = politiqueCarte({ load_includes: ["nuit"], plafond_eur: 200, arrondi_eur: 0 });
    const c = carteLigne(ligne({ prix_total: 9000, devise: "THB" }), policy, { nights: 1 });
    assert.equal(c.devise, "THB");
    assert.equal(c.montant_par_carte, 9000);
    assert.equal(c.plafond_depasse, false, "aucun taux de change n'est inventé pour comparer THB et EUR");
    assert.ok(c.motifs.includes("plafond_non_verifiable"));
    assert.ok(c.motifs.includes("carte_en_devise_relevee"));
  });

  test("C7 : chambre et indemnités dans deux devises → poste « nuit » non converti, carte incomplète", () => {
    const policy = politiqueCarte({ arrondi_eur: 0 });
    const c = carteLigne(ligne({ prix_total: 9000, devise: "THB" }), policy, { nights: 1 });
    assert.equal(c.postes.nuit, null);
    assert.deepEqual(c.postes_non_convertibles, ["nuit"]);
    assert.equal(c.devise, "EUR");
    assert.equal(c.base, 25 * 2 + 10 * 2); // seules les indemnités EUR sont additionnées
    assert.equal(c.incomplet, true);
    assert.ok(c.motifs.includes("poste_non_convertible"));
  });

  test("C7 : un plan à devises mixtes ne produit pas un total faux, et le rapport n'écrit pas « 0 »", () => {
    const policy = politiqueCarte();
    // plan réel : deux dossiers, deux hôtels à une seule chambre, facturés dans deux devises
    const uneChambre = (prix) => [mkRoom({ quantity_available: 1, quantity_displayed_max: 1, price_per_night: prix })];
    const inventories = [
      mkHotel("eur", { review_score: 9 }, uneChambre(70)),
      mkHotel("thb", { currency: "THB", review_score: 8 }, uneChambre(75)),
    ];
    const alloc = allocate({
      dossiers: buildDossiers([mkPax("P1"), mkPax("P2")], policy),
      inventories, policy, station: STATION_BKK, nights: 1,
    });
    const devises = alloc.plan.map((r) => r.devise).sort();
    assert.deepEqual(devises, ["EUR", "THB"], "le plan doit bien mélanger deux devises");

    const cost = computeCost(alloc.plan, policy, { nights: 1 });
    assert.equal(cost.bloquant, true);
    assert.equal(cost.per_night.total, null, "additionner EUR et THB donnerait un total faux");
    assert.equal(cost.projection_total, null);
    assert.equal(cost.devise_unique, null);
    assert.deepEqual(cost.devises, ["EUR", "THB"]);
    assert.equal(cost.par_devise.EUR.Y, 70); // les montants restent lisibles, séparés
    assert.equal(cost.par_devise.THB.Y, 75);
    const bloc = cost.avertissements.find((a) => a.code === "devises_multiples");
    assert.ok(bloc && bloc.bloquant === true);

    const md = buildRapportMd(alloc, inventories, {
      station: STATION_BKK, policy, checkin: "2026-10-04", checkout: "2026-10-05", nights: 1, runId: "c7", cost,
    });
    assert.match(md, /aucun total consolidé/);
    assert.match(md, /EUR, THB/);
    // aucune ligne de total : ni « par nuit », ni « projection » — un « 0 » s'y lirait
    // « rien à payer » là où le moteur dit « indéterminé »
    assert.doesNotMatch(md, /- par nuit :/);
    assert.doesNotMatch(md, /- projection /);
    assert.match(md, /Coût total relevé : \*\*70 EUR \+ 75 THB\*\*/); // ventilé, jamais fusionné
    assert.match(md, /EUR : J 0 · W 0 · Y 70 — total 70/);

    // une seule devise : le total redevient exploitable (aucune régression)
    const unique = computeCost(alloc.plan.filter((r) => r.devise === "EUR"), policy, { nights: 1 });
    assert.equal(unique.bloquant, false);
    assert.equal(unique.per_night.total, 70);
    assert.equal(unique.projection_total, 70);
    assert.equal(unique.devise_unique, "EUR");
  });

  test("C7 : l'agrégat ventile par devise et ne consolide qu'à devise unique", () => {
    const policy = politiqueCarte({ load_includes: ["nuit"], arrondi_eur: 0 });
    const eur = carteLigne(ligne({ pnr: "A", prix_total: 160 }), policy, { nights: 1 });
    const thb = carteLigne(ligne({ pnr: "B", prix_total: 9000, devise: "THB" }), policy, { nights: 1 });
    const agg = agregerCartes([eur, thb], policy);
    assert.deepEqual(agg.devises, ["EUR", "THB"]);
    assert.deepEqual(agg.montant_total_par_devise, { EUR: 160, THB: 9000 });
    assert.equal(agg.montant_total_a_charger, null);
    assert.ok(agg.avertissements.some((a) => /devise par devise/.test(a)));

    // à devise unique, le montant à charger est chiffré
    const seul = agregerCartes([eur], policy);
    assert.equal(seul.montant_total_a_charger, 160);
    assert.equal(seul.cartes_completes, 1);
  });

  test("C7 : aucune carte pour une ligne réglée autrement, escaladée, ou quand la carte est désactivée", () => {
    const policy = politiqueCarte();
    assert.equal(carteLigne(ligne({ mode_reglement: "compagnie" }), policy, { nights: 1 }), null);
    assert.equal(carteLigne(ligne({ statut: "ESCALADE DESK", prix_total: "" }), policy, { nights: 1 }), null);
    assert.equal(carteLigne(ligne(), politiqueCarte({ enabled: false }), { nights: 1 }), null);
    // `nights` illisible est refusé : le tolérer donnerait une carte sous-chargée en silence
    assert.throws(() => carteLigne(ligne(), policy, { nights: 0 }), /nights invalide/);
  });
});

/* ---------------------------------------------------------------- */
/* Fabriques locales du pipeline (collecteurs injectés, zéro agent)  */
/* ---------------------------------------------------------------- */

function collecteur({ record = null, probeAnswer = null, calls }) {
  return {
    discovery: null,
    async releves(ctx, selection, substitutes, onInventory) {
      calls.push(`releves:${selection.map((s) => (s.candidate ?? s).id).join(",")}`);
      const out = [];
      for (const s of selection) {
        const c = s.candidate ?? s;
        const rec = record ? record(c, ctx) : notFound(c, ctx);
        out.push(rec);
        if (onInventory) onInventory(rec, out);
      }
      return out;
    },
    async probe(ctx, probe) {
      calls.push(`probe:${probe.hotelKey}`);
      return probeAnswer ? probeAnswer(probe) : null;
    },
  };
}

const foundRecord = (c, rooms) => ({ ...mkRecord(c.id, {}, rooms), name: c.name, url: c.url });

const notFound = (c, ctx) => ({
  hotel: c.id, hotelKey: c.id, name: c.name, url: c.url ?? "", tiers: c.tiers, sessionId: null, status: "completed",
  outcome: null, error: null, costUsd: 0,
  answer: { hotel: c.name, url: c.url ?? "", found: false, checkin: ctx.checkin, checkout: ctx.checkout, currency: "EUR", rooms: [], notes: "complet", observed_at: "2026-09-15T12:00:00Z" },
});

/** Relevé JAMAIS lancé faute de temps (ce que rend `runReleve` sur échéance). */
const sauteBudget = (c) => ({
  hotel: c.id, hotelKey: c.id, name: c.name, url: c.url ?? "", tiers: c.tiers, sessionId: null,
  status: "skipped_budget", outcome: null, error: "budget d'horloge du run épuisé", answer: null, costUsd: 0,
});

/** Inventaire dont le premier hôtel affiche un stock plafonné. */
const invAvecPlein = () => normalizeInventaire(mkInv([mkInvEntry("plein", { review_score: 9 }), mkInvEntry("b"), mkInvEntry("c")]));

/** Cinq hôtels : un relevé à l'étage B, quatre candidats pour l'extension. */
const invCinq = () =>
  normalizeInventaire(mkInv([
    mkInvEntry("plein", { review_score: 9 }),
    mkInvEntry("b"), mkInvEntry("c"), mkInvEntry("d"), mkInvEntry("e"),
  ]));
