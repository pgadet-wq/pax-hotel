/**
 * C6 — point de validation humaine — et robustesse d'exploitation.
 *
 * Tout est HORS LIGNE et à 0 € : aucune session d'agent, aucun appel réseau
 * sortant, aucune dépendance à l'horloge réelle (les dates et les échéances de
 * rétention sont injectées, on ne dort jamais). Les fixtures sont écrites dans
 * un répertoire temporaire du système, jamais dans le dépôt, et supprimées par
 * `t.after` — comme `run-manager.test.mjs` et `demo-server.test.mjs`.
 *
 * Ce que ce fichier verrouille :
 * - la décision humaine est consignée avec son horodatage et l'EMPREINTE
 *   SHA-256 du plan réellement affiché ; une empreinte qui ne correspond plus
 *   au plan courant est refusée (409) et n'écrit RIEN ;
 * - la validation partielle exige un motif par ligne écartée ;
 * - un plan PROVISOIRE (run annulé, interrompu, en erreur) n'est pas signable ;
 * - le journal est append-only et survit à un redémarrage du serveur ;
 * - sans identité fournie par un proxy, le journal écrit « non authentifiée »
 *   en toutes lettres et n'invente aucune traçabilité ;
 * - INV-1 : aucune route, aucun bouton, aucun chemin de code ne réserve —
 *   garde-fou permanent du périmètre ;
 * - l'état d'un run est persisté puis rechargé après redémarrage ;
 * - la purge de rétention ne touche que `out/`, ne supprime que les sorties
 *   NOMINATIVES périmées, épargne le reste et journalise ce qu'elle efface.
 *
 * ÉCART CONNU (documenté, pas contourné) : le CDC demande « poursuite vers la
 * confirmation de réservation » après validation. Le code ne l'implémente pas
 * et le DIT (INV-1). Les tests ci-dessous documentent le comportement réel :
 * la validation s'arrête à la consigne d'une décision.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createRunManager,
  HttpError,
  empreintePlan,
  stateFileName,
  validationFileName,
} from "../../demo/run-manager.mjs";
import { createDemoServer } from "../../demo/server.mjs";
import { createSimulation, loadSimInventaire } from "../../demo/simulate.mjs";
import { loadStation } from "../lib/stations.mjs";
import { mergeConfig } from "../lib/scenario.mjs";
import { ROOT } from "./helpers.mjs";

/* ------------------------------------------------------------- fabriques */

/** Simulation accélérée : la suite entière doit rester sous quelques secondes. */
const SPEED = 1000;

/** Bus SSE enregistreur (aucun réseau). */
function hubEnregistreur() {
  const events = [];
  return {
    events,
    publish(type, ev) {
      events.push({ type, ev });
      return events.length;
    },
  };
}

/**
 * Répertoires temporaires créés par ce fichier. Le nettoyage est fait DEUX fois :
 * à la fin de chaque test, puis à la sortie du process. La seconde passe n'est
 * pas de la ceinture-bretelle : le manager persiste l'état par un `setTimeout`
 * non bloquant (1,5 s) qui, s'il se réveille après le test, recrée le dossier.
 */
const TMP_CREES = [];
process.on("exit", () => {
  for (const dir of TMP_CREES) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* rien à nettoyer */
    }
  }
});

/** Répertoire temporaire supprimé à la fin du test (jamais dans le dépôt). */
function tmpDir(t, prefixe = "pax-c6-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  TMP_CREES.push(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Ligne de plan minimale — fixture inventée, aucune donnée passager réelle. */
const ligne = (pnr, over = {}) => ({
  pnr,
  occupants: "[non nominatif]",
  pax: 2,
  cabine: "Y",
  categorie: "PAX",
  hotel: "Hôtel Alpha",
  hotel_url: "https://example.test/alpha",
  room_type: "Twin Room",
  chambres: 1,
  prix_total: 70,
  devise: "EUR",
  conformite: "OK",
  mode_reglement: "carte prépayée",
  provisoire: false,
  statut: "OK",
  stock_mesure: true,
  ...over,
});

/** Plan de référence : 2 dossiers logés (2 hôtels) + 1 escalade. */
const PLAN_REF = [
  ligne("AA11BB"),
  ligne("CC22DD", { hotel: "Hôtel Beta", hotel_url: "https://example.test/beta", chambres: 2, pax: 3, stock_mesure: false }),
  ligne("EE33FF", { hotel: "", hotel_url: "", room_type: "", chambres: 0, prix_total: 0, statut: "ESCALADE", escalade: "DESK (capacité)" }),
];

/**
 * Écrit un état de run persisté, tel que `run-manager` l'écrit lui-même.
 * C'est la forme que `restaurer()` relit au démarrage : elle permet de tester
 * la validation sans jouer de run, donc sans horloge et en quelques millisecondes.
 */
function ecrireEtat(outDir, { runId, state = "done", plan = PLAN_REF, outputs = null }) {
  fs.mkdirSync(outDir, { recursive: true });
  const snap = {
    state,
    runId,
    simulate: true,
    station: "BKK",
    checkin: "2026-10-04",
    checkout: "2026-10-05",
    nights: 1,
    startedAt: "2026-10-03T08:00:00.000Z",
    finishedAt: state === "running" ? null : "2026-10-03T08:40:00.000Z",
    phase: "sorties",
    planOrder: plan.map((r) => r.pnr),
    plan: Object.fromEntries(plan.map((r) => [r.pnr, r])),
    planSummary: { ok: plan.filter((r) => r.statut === "OK").length, escalade: plan.filter((r) => r.statut !== "OK").length },
    outputs: outputs ?? [`plan-${runId}.csv`],
    persiste_le: "2026-10-03T08:40:01.000Z",
  };
  fs.writeFileSync(path.join(outDir, stateFileName(runId)), JSON.stringify(snap, null, 2) + "\n", "utf8");
  return snap;
}

/** Manager restauré depuis un état persisté (aucun run joué). */
function managerRestaure(t, { runId = "r-c6", state = "done", plan = PLAN_REF } = {}) {
  const outDir = tmpDir(t);
  ecrireEtat(outDir, { runId, state, plan });
  const hub = hubEnregistreur();
  return { manager: createRunManager({ hub, outDir }), outDir, hub, runId };
}

/** Validateur SANS identité : le cas nominal d'un serveur sans proxy authentifiant. */
const ANONYME = { identite: null, source: "aucune", authentifiee: false, remote: "127.0.0.1" };
/** Validateur dont l'identité vient d'un en-tête posé par un reverse proxy. */
const DERRIERE_PROXY = {
  identite: "chef.escale@compagnie.test",
  source: "en-tête x-forwarded-user",
  authentifiee: true,
  remote: "10.0.0.2",
};

const T0 = new Date("2026-10-03T10:15:00.000Z");
const lireJournal = (outDir, runId) => JSON.parse(fs.readFileSync(path.join(outDir, validationFileName(runId)), "utf8"));

/* ================================================================ C6 */

describe("C6 — la décision humaine est consignée, pas devinée", () => {
  test("la validation enregistre décision, horodatage, empreinte SHA-256 et synthèse de ce qui est engagé", (t) => {
    const { manager, outDir, runId, hub } = managerRestaure(t);

    // avant toute décision : le plan est signable, et l'empreinte est celle du plan affiché
    const avant = manager.snapshot();
    assert.equal(avant.state, "done");
    assert.equal(avant.validable, true, "un run terminé et non encore validé est signable");
    assert.equal(avant.validation, null);

    const empreinte = manager.empreinteDe(runId);
    assert.match(empreinte, /^[0-9a-f]{64}$/, "SHA-256 hexadécimal");
    assert.equal(empreinte, empreintePlan(PLAN_REF), "l'empreinte porte sur le CSV canonique du plan");

    const entree = manager.valider({ runId, decision: "valide", empreinte, validateur: DERRIERE_PROXY, commentaire: "vu ligne à ligne", now: T0 });

    assert.equal(entree.seq, 1);
    assert.equal(entree.runId, runId);
    assert.equal(entree.decision, "valide");
    assert.equal(entree.at, T0.toISOString(), "horodatage injecté, jamais l'horloge réelle");
    assert.equal(entree.empreinte_plan, empreinte);
    assert.equal(entree.empreinte_soumise, empreinte);
    assert.equal(entree.lignes_plan, 3);
    assert.equal(entree.commentaire, "vu ligne à ligne");
    assert.match(entree.portee, /AUCUNE réservation/, "INV-1 est écrit dans le journal lui-même");

    // C2 — ce qui est engagé se compte en PERSONNES, et le stock non mesuré est dit
    assert.equal(entree.resume.dossiers_valides, 2);
    assert.equal(entree.resume.personnes_valides, 5);
    assert.equal(entree.resume.chambres_valides, 3);
    assert.equal(entree.resume.chambres_sur_stock_non_mesure, 2, "les chambres non mesurées ne passent pas pour acquises");
    assert.equal(entree.resume.dossiers_deja_escalades, 1);
    assert.deepEqual(entree.resume.hotels.map((h) => h.hotel), ["Hôtel Beta", "Hôtel Alpha"], "trié par chambres décroissantes");
    assert.deepEqual(entree.resume.hotels[0], { hotel: "Hôtel Beta", chambres: 2, dossiers: 1, pax: 3 });
    assert.equal(entree.resume.dossiers_ecartes, 0);

    // journal sur disque + état et sorties mis à jour
    const journal = lireJournal(outDir, runId);
    assert.equal(journal.runId, runId);
    assert.equal(journal.entrees.length, 1);
    assert.equal(journal.derniere_decision, "valide");
    assert.equal(journal.mis_a_jour_le, T0.toISOString());

    const apres = manager.snapshot();
    assert.equal(apres.state, "valide");
    assert.equal(apres.validable, false, "un plan déjà validé ne se re-signe pas à l'écran");
    assert.equal(apres.validation.seq, 1);
    assert.equal(apres.planEmpreinte, empreinte);
    assert.ok(apres.outputs.includes(validationFileName(runId)), "le journal est référencé dans les sorties");
    assert.ok(manager.isOutputAllowed(validationFileName(runId)), "le journal est téléchargeable");

    // la décision est annoncée sur le bus, telle quelle
    const publies = hub.events.filter((e) => e.type === "validation");
    assert.equal(publies.length, 1);
    assert.equal(publies[0].ev.data.empreinte_plan, empreinte);
  });

  test("une empreinte qui ne correspond plus au plan courant est refusée (409) et n'écrit RIEN", (t) => {
    const { manager, outDir, runId } = managerRestaure(t);
    // le validateur a sous les yeux un plan d'une ligne de plus : il ne signe pas celui-ci
    const empreinteVue = empreintePlan([...PLAN_REF, ligne("GG44HH")]);
    assert.notEqual(empreinteVue, manager.empreinteDe(runId));

    assert.throws(
      () => manager.valider({ runId, decision: "valide", empreinte: empreinteVue, validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 409 && /le plan a changé depuis son affichage/.test(err.message),
    );
    assert.ok(
      !fs.existsSync(path.join(outDir, validationFileName(runId))),
      "un refus d'empreinte ne laisse aucune trace de décision : rien n'a été signé",
    );
    assert.equal(manager.snapshot().state, "done", "l'état du run n'a pas bougé");
    assert.equal(manager.snapshot().validation, null);

    // l'empreinte est OBLIGATOIRE pour VALIDER : sans elle, rien ne prouve que le plan
    // signé est celui qui était à l'écran, et le seul contrôle anti-dérive du dispositif
    // se contournerait par un appel direct.
    assert.throws(
      () => manager.valider({ runId, decision: "valide", empreinte: null, validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /empreinte du plan affiché est obligatoire/.test(err.message),
    );
    assert.equal(manager.snapshot().validation, null, "une validation sans empreinte n'écrit rien");

    // un REFUS, lui, n'exige pas d'avoir tout lu : on peut rejeter un plan sans le signer
    const refus = manager.valider({ runId, decision: "refuse", empreinte: null, validateur: ANONYME, now: T0 });
    assert.equal(refus.decision, "refuse");
    assert.equal(refus.empreinte_soumise, null);
    assert.equal(refus.empreinte_plan, manager.empreinteDe(runId));
  });

  test("validation partielle : une ligne écartée exige un motif, et le résumé retire ce qui est écarté", (t) => {
    const { manager, runId, outDir } = managerRestaure(t);

    assert.throws(
      () => manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), exclusions: [{ pnr: "CC22DD" }], validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /écartée sans motif/.test(err.message),
    );
    assert.throws(
      () => manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), exclusions: [{ pnr: "", motif: "x" }], validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /sans PNR/.test(err.message),
    );
    assert.throws(
      () => manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), exclusions: [{ pnr: "ZZ99ZZ", motif: "x" }], validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /inconnue du plan/.test(err.message),
    );
    assert.throws(
      () => manager.valider({ runId, decision: "refuse", exclusions: [{ pnr: "CC22DD", motif: "x" }], validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /un refus global ne se combine pas/.test(err.message),
    );
    assert.ok(!fs.existsSync(path.join(outDir, validationFileName(runId))), "aucune tentative refusée n'est journalisée");

    const entree = manager.valider({
      runId,
      decision: "valide",
      empreinte: manager.empreinteDe(runId),
      exclusions: [{ pnr: "CC22DD", motif: "hôtel injoignable au téléphone" }],
      validateur: ANONYME,
      now: T0,
    });
    assert.deepEqual(entree.exclusions, [{ pnr: "CC22DD", motif: "hôtel injoignable au téléphone" }]);
    assert.equal(entree.resume.dossiers_valides, 1);
    assert.equal(entree.resume.personnes_valides, 2);
    assert.equal(entree.resume.chambres_valides, 1);
    assert.equal(entree.resume.dossiers_ecartes, 1);
    assert.equal(entree.resume.personnes_ecartees, 3, "les personnes écartées sont comptées, pas seulement les dossiers");
    assert.deepEqual(entree.resume.hotels.map((h) => h.hotel), ["Hôtel Alpha"]);
    // l'empreinte reste celle du plan ENTIER : ce qui est signé est le plan affiché
    assert.equal(entree.empreinte_plan, empreintePlan(PLAN_REF));
  });

  test("un refus est consigné comme tel, sans résumé d'engagement", (t) => {
    const { manager, runId, outDir } = managerRestaure(t);
    const entree = manager.valider({ runId, decision: "refuse", validateur: ANONYME, commentaire: "plafond Y inacceptable", now: T0 });
    assert.equal(entree.decision, "refuse");
    assert.equal(entree.resume, null, "un refus n'engage rien : aucun résumé de chambres");
    assert.equal(manager.snapshot().state, "refuse");
    assert.equal(lireJournal(outDir, runId).derniere_decision, "refuse");

    assert.throws(
      () => manager.valider({ runId, decision: "peut-être", validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 400 && /décision inconnue/.test(err.message),
    );
  });

  test("un plan PROVISOIRE (annulé, interrompu, en erreur) n'est pas validable", (t) => {
    for (const etat of ["cancelled", "error", "interrupted"]) {
      const { manager, runId, outDir } = managerRestaure(t, { runId: `r-${etat}`, state: etat });
      assert.equal(manager.snapshot().validable, false, `${etat} : l'écran n'offre pas la signature`);
      assert.throws(
        () => manager.valider({ runId, decision: "valide", validateur: ANONYME, now: T0 }),
        (err) => err instanceof HttpError && err.status === 409 && /PROVISOIRE/.test(err.message),
        `${etat} refusé`,
      );
      assert.ok(!fs.existsSync(path.join(outDir, validationFileName(runId))));
    }

    // état « done » mais lignes encore provisoires : refusé aussi (réallocation non faite)
    const encore = managerRestaure(t, {
      runId: "r-provisoire",
      plan: [ligne("AA11BB"), ligne("CC22DD", { provisoire: true })],
    });
    assert.throws(
      () => encore.manager.valider({ runId: "r-provisoire", decision: "valide", validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 409 && /lignes provisoires/.test(err.message),
    );

    // run inconnu : 404 explicite, jamais un plan vide qui aurait l'air normal
    assert.throws(
      () => encore.manager.valider({ runId: "r-fantome", decision: "valide", validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 404 && /aucun plan connu/.test(err.message),
    );
  });

  test("INV-10 : pendant un run, le plan n'est pas définitif et la validation est refusée", async (t) => {
    const outDir = tmpDir(t);
    const manager = createRunManager({ hub: hubEnregistreur(), outDir });
    const station = loadStation("BKK");
    const { policy, avion, scenario } = mergeConfig({ scenario: { station: "BKK" } });
    const { runId } = manager.start({
      policy, avion, scenario, station,
      inventaire: loadSimInventaire(),
      simulate: true,
      collectFactory: ({ signal, extensionSignal }) => createSimulation({ speed: SPEED, signal, extensionSignal }),
    });
    // `start` positionne l'état de façon synchrone : le test n'a aucune course à jouer
    assert.throws(
      () => manager.valider({ runId, decision: "valide", validateur: ANONYME, now: T0 }),
      (err) => err instanceof HttpError && err.status === 409 && /un run est en cours/.test(err.message),
    );
    await manager.wait();
    // une fois le run terminé, le même plan devient signable
    assert.equal(manager.snapshot().validable, true);
    const entree = manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), validateur: ANONYME, now: T0 });
    assert.equal(entree.seq, 1);
    assert.equal(entree.lignes_plan, manager.snapshot().plan.length);
  });

  test("le journal est append-only et survit à un redémarrage du serveur", (t) => {
    const outDir = tmpDir(t);
    const runId = "r-journal";
    ecrireEtat(outDir, { runId });

    const m1 = createRunManager({ hub: hubEnregistreur(), outDir });
    const e1 = m1.valider({ runId, decision: "refuse", validateur: ANONYME, commentaire: "premier passage", now: new Date("2026-10-03T10:00:00.000Z") });
    const e2 = m1.valider({ runId, decision: "valide", empreinte: m1.empreinteDe(runId), validateur: DERRIERE_PROXY, commentaire: "corrigé, accepté", now: new Date("2026-10-03T10:30:00.000Z") });
    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);

    const apresDeux = lireJournal(outDir, runId);
    assert.equal(apresDeux.entrees.length, 2);
    assert.deepEqual(apresDeux.entrees[0], e1, "la première entrée n'a pas été réécrite");

    // REDÉMARRAGE : nouveau manager sur le même out/
    const m2 = createRunManager({ hub: hubEnregistreur(), outDir });
    const journalRelu = m2.journalValidation(runId);
    assert.equal(journalRelu.entrees.length, 2);
    assert.deepEqual(journalRelu.entrees[0], e1);
    assert.deepEqual(journalRelu.entrees[1], e2);
    assert.equal(m2.snapshot().state, "valide", "l'état validé a été persisté avec le run");
    assert.equal(m2.snapshot().validation.seq, 2);

    // une décision de plus s'ajoute, sans toucher aux précédentes
    const e3 = m2.valider({ runId, decision: "refuse", validateur: ANONYME, now: new Date("2026-10-03T11:00:00.000Z") });
    assert.equal(e3.seq, 3);
    const final = lireJournal(outDir, runId);
    assert.deepEqual(final.entrees.map((e) => [e.seq, e.decision]), [[1, "refuse"], [2, "valide"], [3, "refuse"]]);
    assert.deepEqual(final.entrees[0], e1);
    assert.deepEqual(final.entrees[1], e2);

    // runId hors forme : null, jamais une lecture de fichier arbitraire
    assert.equal(m2.journalValidation("../etc/passwd"), null);
    assert.equal(m2.journalValidation(""), null);
  });

  test("sans identité fournie par le proxy, le journal écrit « non authentifiée » et n'invente aucune traçabilité", (t) => {
    const { manager, runId } = managerRestaure(t);
    const entree = manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), validateur: ANONYME, now: T0 });
    const v = entree.validateur;
    assert.equal(v.identite, null, "aucun nom inventé");
    assert.equal(v.source, "aucune");
    assert.equal(v.authentifiee, false);
    assert.match(v.mention, /identité non authentifiée/);
    assert.match(v.mention, /le serveur n'a aucune authentification/);
    assert.equal(v.remote, "127.0.0.1", "l'adresse d'origine est notée, mais elle n'est pas une identité");

    // objet validateur absent : même prudence, aucun défaut silencieux
    const sansRien = managerRestaure(t, { runId: "r-sans-validateur" });
    const e2 = sansRien.manager.valider({ runId: "r-sans-validateur", decision: "valide", empreinte: sansRien.manager.empreinteDe("r-sans-validateur"), now: T0 });
    assert.equal(e2.validateur.identite, null);
    assert.equal(e2.validateur.source, "aucune");
    assert.equal(e2.validateur.authentifiee, false);
    assert.match(e2.validateur.mention, /non authentifiée/);

    // identité fournie par un proxy : reprise telle quelle, avec sa limite écrite
    const avecProxy = managerRestaure(t, { runId: "r-proxy" });
    const e3 = avecProxy.manager.valider({ runId: "r-proxy", decision: "valide", empreinte: avecProxy.manager.empreinteDe("r-proxy"), validateur: DERRIERE_PROXY, now: T0 });
    assert.equal(e3.validateur.identite, "chef.escale@compagnie.test");
    assert.equal(e3.validateur.authentifiee, true);
    assert.match(e3.validateur.mention, /reverse proxy/, "la portée de cette identité est dite, pas supposée");
    assert.match(e3.validateur.mention, /le serveur lui-même n'authentifie personne/);
  });
});

/* ============================================ C6 par la route HTTP */

describe("C6 — la route de validation, de bout en bout", () => {
  /** Serveur sur port éphémère, répertoires temporaires, fermé par t.after. */
  async function boot(t) {
    const base0 = tmpDir(t, "pax-c6-srv-");
    const dirs = {
      outDir: path.join(base0, "out"),
      presetsDir: path.join(base0, "presets"),
      inventaireDir: path.join(base0, "inventaire"),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const app = createDemoServer({ port: 0, dirs, hub: undefined });
    const addr = await app.listen();
    t.after(() => app.close());
    const url = `http://127.0.0.1:${addr.port}`;
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(url + p, {
        method,
        headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const ctype = res.headers.get("content-type") ?? "";
      return { status: res.status, data: ctype.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return { app, call, dirs };
  }

  test("POST /api/validation : empreinte contrôlée, journal écrit, téléchargeable, et AUCUNE réservation", async (t) => {
    const { app, call, dirs } = await boot(t);
    const started = await call("POST", "/api/run", { scenario: { station: "BKK", simulate: true }, sim_speed: SPEED });
    assert.equal(started.status, 202);
    const { runId } = started.data;
    await app.manager.wait();

    // avant décision : empreinte disponible, journal encore vide
    const avant = await call("GET", `/api/validation?runId=${runId}`);
    assert.equal(avant.status, 200);
    assert.match(avant.data.empreinte_plan, /^[0-9a-f]{64}$/);
    assert.equal(avant.data.journal, null, "aucune décision : aucun journal inventé");

    // empreinte périmée : 409, rien n'est signé
    const perimee = await call("POST", "/api/validation", { runId, decision: "valide", empreinte: "0".repeat(64) });
    assert.equal(perimee.status, 409);
    assert.match(perimee.data.error, /rechargez la répartition/);
    assert.equal((await call("GET", `/api/validation?runId=${runId}`)).data.journal, null);

    // décision réelle, sans proxy d'identité
    const ok = await call("POST", "/api/validation", {
      runId,
      decision: "valide",
      empreinte: avant.data.empreinte_plan,
      commentaire: "répartition acceptée",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.enregistre, true);
    assert.equal(ok.data.journal, `validation-${runId}.json`);
    assert.equal(ok.data.entree.validateur.authentifiee, false);
    assert.match(ok.data.entree.validateur.mention, /non authentifiée/);
    // INV-1 dit deux fois : dans la réponse ET dans l'entrée de journal
    assert.match(ok.data.suite, /aucune réservation n'a été faite/i);
    assert.match(ok.data.entree.portee, /AUCUNE réservation/);

    // le journal est sur disque, append-only, et téléchargeable
    const surDisque = JSON.parse(fs.readFileSync(path.join(dirs.outDir, `validation-${runId}.json`), "utf8"));
    assert.equal(surDisque.entrees.length, 1);
    const dl = await call("GET", `/api/outputs/validation-${runId}.json`);
    assert.equal(dl.status, 200);

    const apres = await call("GET", `/api/validation?runId=${runId}`);
    assert.equal(apres.data.journal.entrees.length, 1);
    assert.equal(apres.data.journal.derniere_decision, "valide");

    // l'état visible à l'écran porte la décision, et le plan n'est plus « à signer »
    const etat = await call("GET", "/api/state");
    assert.equal(etat.data.state, "valide");
    assert.equal(etat.data.validable, false);
    assert.equal(etat.data.validation.decision, "valide");

    // entrées mal formées : refus explicites, jamais un enregistrement approximatif
    assert.equal((await call("POST", "/api/validation", { decision: "valide" })).status, 400);
    assert.equal((await call("POST", "/api/validation", { runId: "../x", decision: "valide" })).status, 400);
    assert.equal((await call("POST", "/api/validation", { runId, decision: "ok" })).status, 400);
    assert.equal((await call("GET", "/api/validation?runId=")).status, 400);
  });

  test("identité du validateur : un en-tête SEUL n'authentifie personne, seul un proxy déclaré le fait", async (t) => {
    const { app, call } = await boot(t);
    const started = await call("POST", "/api/run", { scenario: { station: "BKK", simulate: true }, sim_speed: SPEED });
    const { runId } = started.data;
    await app.manager.wait();

    // Cas NOMINAL de la démo : aucun proxy de confiance n'est déclaré. L'en-tête est posé
    // ici en direct par le client — exactement ce que n'importe qui joignant le serveur
    // peut faire. L'identité est donc CONSIGNÉE mais NON authentifiée : la compter comme
    // authentifiée donnerait au journal une force probante qu'il n'a pas.
    delete process.env.DEMO_TRUSTED_PROXY;
    const empreinte = (await call("GET", `/api/validation?runId=${runId}`)).data.empreinte_plan;
    const ok = await call("POST", "/api/validation", { runId, decision: "valide", empreinte }, { "x-forwarded-user": "chef.escale@compagnie.test" });
    assert.equal(ok.status, 200);
    const v = ok.data.entree.validateur;
    assert.equal(v.identite, "chef.escale@compagnie.test", "l'identité déclarée est consignée telle quelle");
    assert.equal(v.source, "en-tête x-forwarded-user");
    assert.equal(v.declaree, true, "un en-tête a bien été reçu");
    assert.equal(v.authentifiee, false, "aucun proxy de confiance déclaré : rien n'est authentifié");
    assert.match(v.mention, /NON authentifiée/);
    assert.match(v.mention, /DEMO_TRUSTED_PROXY/, "la mention dit comment cette identité pourrait valoir");
    assert.match(v.mention, /reverse proxy/);

    // Cas EXPLOITATION : l'exploitant déclare que le serveur n'est joignable que par son
    // proxy authentifiant. C'est cette déclaration — pas l'en-tête — qui fonde l'authentification.
    process.env.DEMO_TRUSTED_PROXY = "any";
    t.after(() => { delete process.env.DEMO_TRUSTED_PROXY; });
    const derriere = await call("POST", "/api/validation", { runId, decision: "valide", empreinte }, { "x-forwarded-user": "chef.escale@compagnie.test" });
    assert.equal(derriere.status, 200);
    const w = derriere.data.entree.validateur;
    assert.equal(w.declaree, true);
    assert.equal(w.authentifiee, true);
    assert.match(w.mention, /reverse proxy/);
    assert.match(w.mention, /le serveur lui-même n'authentifie personne/);

    // adresse de confiance qui NE correspond PAS à l'origine de la requête : refus d'authentifier
    process.env.DEMO_TRUSTED_PROXY = "10.99.99.99";
    const ailleurs = await call("POST", "/api/validation", { runId, decision: "valide", empreinte }, { "x-forwarded-user": "chef.escale@compagnie.test" });
    assert.equal(ailleurs.status, 200);
    assert.equal(ailleurs.data.entree.validateur.authentifiee, false, "la requête ne vient pas du proxy déclaré");
    delete process.env.DEMO_TRUSTED_PROXY;

    // un en-tête vide ne vaut pas identité
    const vide = await call("POST", "/api/validation", { runId, decision: "refuse" }, { "x-forwarded-user": "   " });
    assert.equal(vide.status, 200);
    assert.equal(vide.data.entree.validateur.declaree, false);
    assert.equal(vide.data.entree.validateur.authentifiee, false);
    assert.equal(vide.data.entree.validateur.identite, null);
  });
});

/* ================================================== INV-1 : garde-fou */

describe("INV-1 — aucune route, aucun bouton, aucun chemin de code ne réserve", () => {
  const SERVER_SRC = fs.readFileSync(path.join(ROOT, "demo", "server.mjs"), "utf8");
  const APP_SRC = fs.readFileSync(path.join(ROOT, "demo", "public", "app.js"), "utf8");
  const INDEX_SRC = fs.readFileSync(path.join(ROOT, "demo", "public", "index.html"), "utf8");

  /**
   * Surface HTTP autorisée. Toute route AJOUTÉE fera échouer ce test : c'est
   * voulu. Le périmètre de l'outil s'étend par décision consciente, jamais par
   * inadvertance — et jamais vers une route qui réserve.
   */
  const ROUTES_EXACTES = new Set([
    "GET /", "GET /api/config", "GET /api/stations", "GET /api/health", "GET /api/state",
    "GET /api/events", "GET /api/screenshot", "GET /api/messages", "GET /api/cout",
    "GET /api/presets", "POST /api/presets",
    "POST /api/generate-passengers", "POST /api/passengers",
    "POST /api/run", "POST /api/cancel", "POST /api/cancel-extension", "POST /api/replay",
    "GET /api/validation", "POST /api/validation", "POST /api/retention-purge",
  ]);
  /** Routes à segment (regex dans le routeur), tenues à jour ici volontairement. */
  const ROUTES_SEGMENT = ["GET|PUT /api/inventaire/:code", "POST /api/inventaire/:code/run", "GET /api/outputs/:nom", "GET /:statique"];

  /** Tout ce qui, dans un nom de route ou un libellé, signalerait un acte d'achat. */
  const MOT_RESERVATION = /r[ée]serv|\bbook(ing|er|ed)?\b|checkout|panier|commande|payer|paiement|acheter/i;

  test("la surface HTTP du serveur est exactement celle attendue, et aucune route ne réserve", () => {
    const trouvees = [...SERVER_SRC.matchAll(/case\s+"((?:GET|POST|PUT|DELETE|PATCH) \/[^"]*)"/g)].map((m) => m[1]);
    assert.ok(trouvees.length >= 15, "routes exactes relevées dans le routeur");
    for (const r of trouvees) {
      assert.ok(ROUTES_EXACTES.has(r), `route « ${r} » non prévue : ajout de périmètre à valider explicitement (INV-1)`);
    }
    for (const r of ROUTES_EXACTES) {
      assert.ok(trouvees.includes(r), `route « ${r} » disparue du routeur`);
    }
    for (const r of [...trouvees, ...ROUTES_SEGMENT]) {
      assert.doesNotMatch(r, MOT_RESERVATION, `la route « ${r} » nomme un acte de réservation (INV-1)`);
    }
    // les routes à segment déclarées ci-dessus sont bien celles du routeur
    assert.match(SERVER_SRC, /\/\^\\\/api\\\/inventaire\\\/\(\[A-Za-z\]\{3\}\)\$\//);
    assert.match(SERVER_SRC, /\/\^\\\/api\\\/outputs\\\//);
  });

  test("le client n'appelle que des routes du serveur : aucun point d'entrée caché", () => {
    const familles = new Set(ROUTES_SEGMENT.concat([...ROUTES_EXACTES]).map((r) => r.split(" /api/")[1]?.split("/")[0]).filter(Boolean));
    const appelees = new Set([...APP_SRC.matchAll(/["'`]\/api\/([a-z0-9-]+)/g)].map((m) => m[1]));
    assert.ok(appelees.size >= 10, "appels /api relevés dans le client");
    for (const f of appelees) {
      assert.ok(familles.has(f), `le client appelle /api/${f}, qui n'est pas une route du serveur`);
    }
    assert.ok(appelees.has("validation"), "le client passe bien par le point de validation");
  });

  test("aucun bouton de l'interface ne réserve : le seul emploi du mot est « sans réserver »", () => {
    const libelles = [...INDEX_SRC.matchAll(/<button[^>]*>([^<]*)/g)].map((m) => m[1].trim()).filter(Boolean);
    assert.ok(libelles.length >= 10, "boutons relevés dans l'interface");
    for (const l of libelles) {
      if (/r[ée]serv/i.test(l)) {
        assert.match(l, /sans réserver/i, `le bouton « ${l} » laisse croire à une réservation (INV-1)`);
      } else {
        assert.doesNotMatch(l, MOT_RESERVATION, `le bouton « ${l} » laisse croire à un acte d'achat (INV-1)`);
      }
    }
    assert.ok(
      libelles.some((l) => /sans réserver/i.test(l)),
      "le bouton de validation dit explicitement qu'il ne réserve pas",
    );
  });

  test("la validation ne déclenche aucune sortie, aucun appel ni aucune promesse de réservation", (t) => {
    const { manager, outDir, runId } = managerRestaure(t);
    const avant = fs.readdirSync(outDir).sort();
    const entree = manager.valider({ runId, decision: "valide", empreinte: manager.empreinteDe(runId), validateur: ANONYME, now: T0 });
    const apres = fs.readdirSync(outDir).sort();

    // le SEUL fichier nouveau est le journal de décision
    assert.deepEqual(
      apres.filter((f) => !avant.includes(f)),
      [validationFileName(runId)],
      "valider n'écrit qu'un journal de décision : aucun bon, aucune confirmation",
    );
    // et rien dans l'entrée ne ressemble à une confirmation d'hôtel
    const texte = JSON.stringify(entree);
    assert.doesNotMatch(texte, /confirmation_reservation|booking_id|numero_reservation|voucher/i);
    assert.match(entree.portee, /à demander aux hôtels/, "ce qui est signé est une DEMANDE, pas une réservation");

    // écart CDC assumé et écrit dans le code : la « poursuite vers la confirmation »
    // n'existe pas dans l'outil, et le code le dit au lieu de le laisser croire.
    assert.match(SERVER_SRC, /arbitrage client non rendu/);
  });
});

/* ====================================== robustesse : persistance, rétention */

describe("Robustesse — l'état d'un run survit à un redémarrage", () => {
  function simStart(manager) {
    const station = loadStation("BKK");
    const { policy, avion, scenario } = mergeConfig({ scenario: { station: "BKK" } });
    return manager.start({
      policy, avion, scenario, station,
      inventaire: loadSimInventaire(),
      simulate: true,
      collectFactory: ({ signal, extensionSignal }) => createSimulation({ speed: SPEED, signal, extensionSignal }),
    });
  }

  test("un run terminé est rechargé depuis out/ : plan, sorties et signabilité intacts", async (t) => {
    const outDir = tmpDir(t);
    const m1 = createRunManager({ hub: hubEnregistreur(), outDir });
    const { runId } = simStart(m1);
    await m1.wait();
    const s1 = m1.snapshot();
    assert.equal(s1.state, "done");

    // REDÉMARRAGE
    const m2 = createRunManager({ hub: hubEnregistreur(), outDir });
    const s2 = m2.snapshot();
    assert.equal(s2.runId, runId);
    assert.equal(s2.state, "done");
    assert.equal(s2.plan.length, s1.plan.length);
    assert.deepEqual(s2.planSummary, s1.planSummary);
    assert.equal(s2.validable, true, "le plan rechargé reste signable : 25 minutes de relevés ne sont pas perdues");
    assert.equal(m2.empreinteDe(runId), m1.empreinteDe(runId), "même plan, même empreinte après redémarrage");
    for (const f of s1.outputs) assert.ok(m2.isOutputAllowed(f), `${f} reste téléchargeable`);

    // ce qui NE survit pas est dit, pas simulé
    assert.equal(s2.capturesPerdues, true);
    assert.ok(Object.values(s2.agents).every((a) => a.captures === 0), "les vignettes ne pointent pas dans le vide");
    assert.equal(m2.captureSource("hyatt-regency-bkk-airport", 0), null, "les sources de capture ne sont pas persistées (§11)");
    assert.equal(m2.result(runId).messages, null, "les messages nominatifs ne sont pas persistés : le CSV du run fait foi");

    // et le plan rechargé se valide normalement
    const entree = m2.valider({ runId, decision: "valide", empreinte: m2.empreinteDe(runId), validateur: ANONYME, now: T0 });
    assert.equal(entree.seq, 1);
    assert.equal(entree.lignes_plan, s1.plan.length);
  });

  test("un run coupé en vol est rendu « interrupted », jamais « done »", (t) => {
    const outDir = tmpDir(t);
    ecrireEtat(outDir, { runId: "r-coupe", state: "running", outputs: [] });
    const manager = createRunManager({ hub: hubEnregistreur(), outDir });
    const snap = manager.snapshot();
    assert.equal(snap.state, "interrupted");
    assert.ok(snap.finishedAt, "une fin est datée : l'écran ne montre pas un run éternellement en cours");
    assert.ok(snap.warnings.some((w) => /INTERROMPU par un arrêt du serveur/.test(w.message)));
    assert.equal(snap.validable, false);
    assert.equal(manager.isRunning(), false, "un run mort ne bloque pas le suivant (INV-10)");
  });
});

describe("Rétention RGPD — la purge ne touche que les sorties nominatives périmées de out/", () => {
  const MAINTENANT = new Date("2026-10-10T12:00:00.000Z");
  const heures = (n) => MAINTENANT.getTime() - n * 3_600_000;

  /** Écrit un fichier de sortie et lui donne l'âge voulu (aucune attente réelle). */
  function poser(dir, nom, ageHeures) {
    const f = path.join(dir, nom);
    fs.writeFileSync(f, "contenu de test\n", "utf8");
    const t = new Date(heures(ageHeures));
    fs.utimesSync(f, t, t);
    return nom;
  }

  const NOMINATIFS = [
    "plan-r-vieux.csv",
    "rooming-r-vieux.csv",
    "messages-r-vieux.csv",
    "fiches-r-vieux.csv",
    "fiches-r-vieux.html",
    "run-r-vieux.state.json",
  ];
  const NON_NOMINATIFS = [
    "candidats-r-vieux.json",
    "releves-r-vieux.json",
    "cout-r-vieux.json",
    "pax-r-vieux.json",
    "validation-r-vieux.json",
  ];

  test("seules les sorties nominatives périmées disparaissent ; le reste et le journal de validation sont épargnés", (t) => {
    const base = tmpDir(t);
    const outDir = path.join(base, "out");
    const horsOut = path.join(base, "ailleurs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(horsOut, { recursive: true });

    // manager créé sur un out/ VIDE : aucun run courant, donc aucun fichier protégé
    const hub = hubEnregistreur();
    const manager = createRunManager({ hub, outDir });

    for (const f of NOMINATIFS) poser(outDir, f, 100);
    for (const f of NON_NOMINATIFS) poser(outDir, f, 100);
    poser(outDir, "rapport-r-vieux.md", 100); // nominatif mais hors liste client : conservé, et dit
    poser(outDir, "plan-r-recent.csv", 1); // nominatif mais pas encore périmé
    poser(horsOut, "plan-r-vieux.csv", 100); // hors de out/ : jamais touché

    const bilan = manager.purgerNominatives({ retention: { nominative_hours: 72 } }, { now: MAINTENANT, raison: "test" });

    assert.equal(bilan.heures, 72);
    assert.equal(bilan.raison, "test");
    assert.deepEqual(bilan.supprimes.slice().sort(), NOMINATIFS.slice().sort());
    assert.deepEqual(bilan.erreurs, []);
    assert.ok(bilan.conserves >= 1, "le fichier nominatif récent est COMPTÉ comme conservé");

    for (const f of NOMINATIFS) assert.ok(!fs.existsSync(path.join(outDir, f)), `${f} supprimé`);
    for (const f of NON_NOMINATIFS) assert.ok(fs.existsSync(path.join(outDir, f)), `${f} épargné (non nominatif)`);
    assert.ok(fs.existsSync(path.join(outDir, "validation-r-vieux.json")), "le journal de validation n'est JAMAIS purgé");
    assert.ok(fs.existsSync(path.join(outDir, "rapport-r-vieux.md")), "rapport-*.md conservé (arbitrage client non rendu)");
    assert.ok(fs.existsSync(path.join(outDir, "plan-r-recent.csv")), "un fichier non périmé reste");
    assert.ok(fs.existsSync(path.join(horsOut, "plan-r-vieux.csv")), "rien hors de out/ n'est touché");

    // journal de purge : ce qui a été effacé est écrit, avec la borne appliquée
    const lignes = fs.readFileSync(path.join(outDir, "retention.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].ts, MAINTENANT.toISOString());
    assert.equal(lignes[0].heures, 72);
    assert.equal(lignes[0].raison, "test");
    assert.deepEqual(lignes[0].supprimes.slice().sort(), NOMINATIFS.slice().sort());

    // et la purge est annoncée sur le bus, y compris la réserve sur rapport-*.md
    const logs = hub.events.filter((e) => e.type === "log").map((e) => e.ev.data.message);
    assert.ok(logs.some((m) => /rétention RGPD \(test\)/.test(m) && /plan-r-vieux\.csv/.test(m)));
    assert.ok(logs.some((m) => /rapport\(s\) « rapport-\*\.md » conservé/.test(m)));

    // deuxième passage : plus rien à supprimer, et aucune ligne de journal vide
    const bilan2 = manager.purgerNominatives({ retention: { nominative_hours: 72 } }, { now: MAINTENANT, raison: "test" });
    assert.deepEqual(bilan2.supprimes, []);
    assert.equal(fs.readFileSync(path.join(outDir, "retention.log"), "utf8").trim().split("\n").length, 1);
  });

  test("sans borne de rétention explicite, rien n'est supprimé et l'absence de borne est dite", (t) => {
    const outDir = tmpDir(t);
    const manager = createRunManager({ hub: hubEnregistreur(), outDir });
    poser(outDir, "plan-r-vieux.csv", 1000);

    for (const pol of [{}, { retention: {} }, { retention: { nominative_hours: "72" } }, { retention: { nominative_hours: 0 } }]) {
      const bilan = manager.purgerNominatives(pol, { now: MAINTENANT });
      assert.deepEqual(bilan.supprimes, [], "aucune suppression sur une borne absente ou non numérique");
      assert.equal(bilan.heures, null);
    }
    assert.ok(fs.existsSync(path.join(outDir, "plan-r-vieux.csv")));
    assert.ok(!fs.existsSync(path.join(outDir, "retention.log")), "aucun journal de purge sans purge");
    const avertissements = manager.snapshot().warnings.map((w) => w.message);
    assert.ok(avertissements.some((m) => /aucune suppression sur une borne inventée/.test(m)));
  });

  test("les sorties du run COURANT ne sont jamais purgées, même périmées — et elles sont comptées", (t) => {
    const outDir = tmpDir(t);
    ecrireEtat(outDir, { runId: "r-courant" });
    const manager = createRunManager({ hub: hubEnregistreur(), outDir });
    assert.equal(manager.snapshot().runId, "r-courant");

    // tout est périmé de très loin
    poser(outDir, "plan-r-courant.csv", 5000);
    poser(outDir, stateFileName("r-courant"), 5000);
    poser(outDir, "plan-r-autre.csv", 5000);

    const bilan = manager.purgerNominatives({ retention: { nominative_hours: 1 } }, { now: MAINTENANT, raison: "test" });
    assert.deepEqual(bilan.supprimes, ["plan-r-autre.csv"]);
    assert.equal(bilan.conserves, 2, "les 2 fichiers du run courant sont comptés, pas passés sous silence");
    assert.ok(fs.existsSync(path.join(outDir, "plan-r-courant.csv")));
    assert.ok(fs.existsSync(path.join(outDir, stateFileName("r-courant"))));
  });

  test("POST /api/retention-purge : purge manuelle sur le même critère d'âge, bilan rendu à l'opérateur", async (t) => {
    const base = tmpDir(t, "pax-c6-purge-");
    const dirs = {
      outDir: path.join(base, "out"),
      presetsDir: path.join(base, "presets"),
      inventaireDir: path.join(base, "inventaire"),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const app = createDemoServer({ port: 0, dirs, hub: undefined });
    const addr = await app.listen();
    t.after(() => app.close());

    // un fichier nominatif largement périmé au regard du défaut (72 h)
    const vieux = path.join(dirs.outDir, "plan-r-vieux.csv");
    fs.writeFileSync(vieux, "x\n", "utf8");
    const t0 = new Date(Date.now() - 500 * 3_600_000);
    fs.utimesSync(vieux, t0, t0);
    const recent = path.join(dirs.outDir, "plan-r-recent.csv");
    fs.writeFileSync(recent, "x\n", "utf8");
    const cout = path.join(dirs.outDir, "cout-r-vieux.json");
    fs.writeFileSync(cout, "{}\n", "utf8");
    fs.utimesSync(cout, t0, t0);

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/retention-purge`, { method: "POST" });
    const bilan = await res.json();
    assert.equal(res.status, 200);
    assert.equal(bilan.heures, 72, "borne de la politique par défaut, jamais devinée");
    assert.match(bilan.raison, /demande explicite de l'opérateur/);
    assert.deepEqual(bilan.supprimes, ["plan-r-vieux.csv"]);
    assert.ok(!fs.existsSync(vieux));
    assert.ok(fs.existsSync(recent), "sortie récente conservée");
    assert.ok(fs.existsSync(cout), "sortie non nominative conservée");
  });
});
