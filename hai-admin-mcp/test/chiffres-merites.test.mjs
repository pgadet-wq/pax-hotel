/**
 * Non-régressions du fil rouge du projet : « rien n'est estimé, et aucun chiffre
 * rassurant n'est affiché s'il n'est pas mérité ».
 *
 * Chaque cas ci-dessous a été mesuré sur l'outil avant correction : il produisait un 0,
 * un « complet », ou une promesse au passager que rien n'étayait. Tout est HORS LIGNE
 * et à 0 € : aucune session d'agent, aucun appel réseau (INV-8).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers } from "../lib/dossiers.mjs";
import { computeCost } from "../lib/cout.mjs";
import { buildPlanCsv, buildRoomingCsv, PLAN_COLS } from "../lib/rapport.mjs";
import { translateSessionEvent } from "../lib/events.mjs";
import { planExtension } from "../lib/capacite.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { mkHotel, mkPax, mkRoom, STATION_BKK } from "./helpers.mjs";

const SCENARIO = { station: "BKK", checkin: "2026-10-04", nights: 1, seed: 42, simulate: false, next_update_minutes: 30 };

const dossiersDe = (rows, policy = DEFAULT_POLICY) => buildDossiers(rows, policy);

describe("aucun chiffre rassurant non mérité", () => {
  test("un plan dont TOUS les non-logés sont HORS PLAN HÔTEL ne se déclare pas « complet »", () => {
    // civière et médical : escaladés, hors plan hôtel, sans chambre. Le verdict de
    // synthèse les ignorait (`escalade > horsPlan` était faux) et l'écran de validation
    // écrivait « tous les dossiers sont logés » pour 2 personnes sur 3 sans chambre.
    const rows = [
      mkPax("P001"),
      mkPax("P002", { assistance: "STCR" }),
      mkPax("P003", { assistance: "MEDA" }),
    ];
    const dossiers = dossiersDe(rows);
    const inventories = [mkHotel("h1", {}, [mkRoom({ quantity_available: 9, cap_reached: false })])];
    const r = allocate({ dossiers, inventories, policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });

    assert.ok(r.summary.horsPlan > 0, "le scénario doit produire des dossiers hors plan");
    assert.equal(r.summary.complet, false, "un plan avec des personnes sans chambre n'est jamais complet");
    assert.ok(
      r.summary.reserves.some((x) => /HORS PLAN HÔTEL/.test(x)),
      `réserve hors plan attendue : ${r.summary.reserves.join(" | ")}`,
    );
  });

  test("`complet` reste vrai quand tout le monde a une chambre sur du stock mesuré", () => {
    const dossiers = dossiersDe([mkPax("P001"), mkPax("P002")]);
    const inventories = [mkHotel("h1", {}, [mkRoom({ quantity_available: 9, cap_reached: false })])];
    const r = allocate({ dossiers, inventories, policy: DEFAULT_POLICY, station: STATION_BKK, nights: 1 });
    assert.equal(r.summary.escalade, 0);
    assert.deepEqual(r.summary.reserves, []);
    assert.equal(r.summary.complet, true);
  });

  test("tous les prix illisibles → coût « indéterminé », jamais 0 EUR", () => {
    // `par_devise` vide, la réduction sur zéro devise rendait 0 : le rapport imprimait
    // « par nuit : J 0 EUR + W 0 EUR + Y 0 EUR = 0 EUR » pour un montant totalement inconnu.
    const plan = [
      { pnr: "A", statut: "OK", cabine: "Y", chambres: 1, prix_total: "n/a", devise: "EUR", pax: 1, hotel: "H", mode_reglement: "compagnie" },
      { pnr: "B", statut: "OK", cabine: "Y", chambres: 1, prix_total: "sur demande", devise: "EUR", pax: 1, hotel: "H", mode_reglement: "compagnie" },
    ];
    const cost = computeCost(plan, DEFAULT_POLICY, SCENARIO, { station: STATION_BKK });
    assert.equal(cost.per_night.total, null);
    assert.equal(cost.per_night.Y, null);
    assert.equal(cost.projection_total, null);
    assert.ok(
      (cost.avertissements ?? []).some((a) => a.code === "prix_illisible"),
      "l'avertissement prix_illisible doit rester émis",
    );
  });

  test("les colonnes de carte prépayée (C7) sont renseignées quand la politique active la carte", () => {
    const policy = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
    policy.payment.prepaid_card.enabled = true;
    const plan = [
      {
        pnr: "A", statut: "OK", cabine: "Y", chambres: 1, prix_total: 100, devise: "EUR", pax: 2,
        hotel: "H", hotel_url: "https://example.test/h", mode_reglement: "carte_prepayee", room_type: "Twin",
      },
    ];
    const cost = computeCost(plan, policy, SCENARIO, { station: STATION_BKK });
    const csv = buildPlanCsv(plan, { cost }).replace(/^﻿/, "");
    const [entete, ligne] = csv.trim().split(/\r?\n/);
    const idx = entete.split(";").indexOf("carte_montant");
    assert.ok(idx >= 0, "la colonne carte_montant doit exister");
    assert.notEqual(ligne.split(";")[idx].replace(/"/g, ""), "", "carte_montant ne doit pas rester vide");
    // et la liste d'appel porte le même montant
    const rooming = buildRoomingCsv(plan, { cost }).replace(/^﻿/, "");
    const jRooming = rooming.trim().split(/\r?\n/);
    const idxR = jRooming[0].split(";").indexOf("carte_montant");
    assert.notEqual(jRooming[1].split(";")[idxR].replace(/"/g, ""), "");
  });

  test("une ligne SANS carte garde ses colonnes C7 vides (aucune carte inventée)", () => {
    const plan = [{ pnr: "A", statut: "OK", cabine: "Y", chambres: 1, prix_total: 100, devise: "EUR", pax: 1, hotel: "H", mode_reglement: "compagnie" }];
    const csv = buildPlanCsv(plan).replace(/^﻿/, "");
    const [entete, ligne] = csv.trim().split(/\r?\n/);
    for (const col of ["carte_montant", "carte_devise", "carte_nb", "carte_incomplet"]) {
      assert.ok(PLAN_COLS.includes(col));
      assert.equal(ligne.split(";")[entete.split(";").indexOf(col)].replace(/"/g, ""), "");
    }
  });

  test("des métriques sans `totalCost` ne valent pas 0 $ : le coût remonte `null`", () => {
    const [ev] = translateSessionEvent({
      type: "MetricsUpdateEvent",
      data: { metrics: { steps: 12, costPerModel: [{ inputTokens: 100, outputTokens: 50 }] } },
    });
    assert.equal(ev.data.cost_usd, null, "un coût non rapporté n'est pas une dépense nulle");
    assert.equal(ev.data.steps, 12);
    assert.equal(ev.data.tokens, 150);

    const [vide] = translateSessionEvent({ type: "MetricsUpdateEvent", data: { metrics: {} } });
    assert.deepEqual(vide.data, { steps: null, cost_usd: null, tokens: null });

    const [mesure] = translateSessionEvent({
      type: "MetricsUpdateEvent",
      data: { metrics: { steps: 3, totalCost: 0.42, costPerModel: [{ inputTokens: 10, outputTokens: 5 }] } },
    });
    assert.equal(mesure.data.cost_usd, 0.42);
  });

  test("un coût de run NON MESURÉ arrête l'extension au lieu de la laisser courir sans frein", () => {
    const plan = planExtension({
      gaps: { chambresManquantes: { Y: 10 } },
      inventories: [], candidates: [],
      policy: DEFAULT_POLICY, station: STATION_BKK, wave: 1, sessionsUsed: 0, costUsd: null,
    });
    assert.equal(plan.stop, true);
    assert.match(plan.reason, /NON MESURÉ/);
  });
});
