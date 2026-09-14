/**
 * Tests inventaire (CDC §5.3, §12.2) : merge sans écraser le manuel (EX-INV-1),
 * drapeaux conservés, isStale (EX-INV-2), ordre des candidats + replis (EX-INV-3),
 * company_payment_possible recalculé (EX-INV-4), CLI hors ligne (EX-INV-6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadInventaire, normalizeInventaire, mergeInventaire, isStale, candidatesFrom, compatibleTiers, slugify, INVENTAIRE_DIR,
} from "../lib/inventaire.mjs";
import { loadStation } from "../lib/stations.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";
import { ROOT } from "./helpers.mjs";

const entry = (id, over = {}) => ({
  id, name: `Hôtel ${id}`, url: `https://www.booking.com/hotel/th/${id}.html`, source: "agent",
  stars: 4, review_score: 8.0, review_count: 1000, distance_km: 2, distance_ref: "airport",
  amenities: { wifi_free: true, room_service: "24h", workspace: "oui", airport_shuttle: "gratuite", restaurant_late: true, accessible: true, breakfast_available: true, family_capable: false },
  payment: { prepayment_online: "oui", pay_at_property_only: false },
  indicative_price_from_eur: 70, last_survey_at: "2026-09-14T09:00:00Z", ...over,
});
const inv = (hotels, over = {}) => ({ station: "BKK", updated_at: "2026-09-14T09:30:00Z", reference: { checkin: "2026-09-28", nights: 1 }, hotels, ...over });

test("inventaire : les 3 fichiers livrés sont valides — BKK 3 hôtels du POC, CDG/NOU vides", () => {
  const bkk = loadInventaire("BKK");
  assert.equal(bkk.hotels.length, 3);
  assert.deepEqual(bkk.hotels.map((h) => h.id).sort(), ["canalis-suvarnabhumi-airport", "divalux-resort-spa-bkk", "hyatt-regency-bkk-airport"]);
  // EX-INV-4 recalculé au chargement : les 3 modes de règlement sont couverts
  assert.deepEqual(
    Object.fromEntries(bkk.hotels.map((h) => [h.id, h.payment.company_payment_possible])),
    { "hyatt-regency-bkk-airport": "oui", "canalis-suvarnabhumi-airport": "a_confirmer", "divalux-resort-spa-bkk": "non" },
  );
  for (const code of ["CDG", "NOU"]) {
    const vide = loadInventaire(code);
    assert.equal(vide.hotels.length, 0);
    assert.equal(vide.updated_at, null);
    assert.equal(isStale(vide, DEFAULT_POLICY), true); // jamais rafraîchi = périmé
  }
  assert.equal(loadInventaire("ZZZ"), null); // absent = null, pas d'erreur
});

test("inventaire : schéma — id en double ou enum invalide rejetés avec message explicite", () => {
  assert.throws(() => normalizeInventaire(inv([entry("a"), entry("a")])), /id d'hôtel en double/);
  assert.throws(() => normalizeInventaire(inv([entry("a", { payment: { prepayment_online: "peut-etre" } })])), /invalide/);
  assert.throws(() => normalizeInventaire(inv([], { station: "XXX" })), /invalide/);
  // une valeur company_payment_possible stockée n'est jamais crue : elle est recalculée
  const menteur = normalizeInventaire(inv([entry("a", { payment: { prepayment_online: "non", pay_at_property_only: true, company_payment_possible: "oui" } })]));
  assert.equal(menteur.hotels[0].payment.company_payment_possible, "non");
  const contracte = normalizeInventaire(inv([entry("b", { contracted: true, payment: { prepayment_online: "non", pay_at_property_only: true } })]));
  assert.equal(contracte.hotels[0].payment.company_payment_possible, "oui"); // contracté prime
});

test("inventaire : isStale — absent, jamais rafraîchi, ou plus vieux que max_age_days (EX-INV-2)", () => {
  const now = new Date("2026-09-15T00:00:00Z");
  assert.equal(isStale(null, DEFAULT_POLICY, now), true);
  assert.equal(isStale(inv([], { updated_at: null }), DEFAULT_POLICY, now), true);
  assert.equal(isStale(inv([], { updated_at: "2026-09-14T09:30:00Z" }), DEFAULT_POLICY, now), false);
  assert.equal(isStale(inv([], { updated_at: "2026-08-10T00:00:00Z" }), DEFAULT_POLICY, now), true); // 36 jours > 30
});

test("inventaire : mergeInventaire — le manuel n'est ni supprimé ni modifié, les drapeaux survivent (EX-INV-1)", () => {
  const manuel = entry("desk-hotel", { source: "manuel", url: "", stars: null, notes: "ajouté au desk", payment: { prepayment_online: "non_precise", pay_at_property_only: null } });
  const existing = inv([manuel, entry("agent-1", { preferred: true, indicative_price_from_eur: 100 }), entry("agent-2", { excluded: true })], { updated_at: "2026-08-31T04:00:00Z" });
  const fresh = inv([
    entry("agent-1", { indicative_price_from_eur: 120, review_count: 1200 }), // mise à jour
    entry("desk-hotel", { stars: 5, notes: "l'agent croit mieux savoir" }),   // collision avec le manuel → ignorée
    entry("agent-3"),                                                          // nouveau
  ]);
  const merged = mergeInventaire(existing, fresh);
  assert.deepEqual(merged.hotels.map((h) => h.id), ["desk-hotel", "agent-1", "agent-2", "agent-3"]);
  const desk = merged.hotels.find((h) => h.id === "desk-hotel");
  assert.equal(desk.stars, null); // intouché
  assert.equal(desk.notes, "ajouté au desk");
  const a1 = merged.hotels.find((h) => h.id === "agent-1");
  assert.equal(a1.indicative_price_from_eur, 120); // données rafraîchies
  assert.equal(a1.preferred, true); // drapeau utilisateur conservé
  const a2 = merged.hotels.find((h) => h.id === "agent-2");
  assert.equal(a2.excluded, true); // entrée agent non revisitée conservée, drapeau compris
  assert.equal(merged.updated_at, "2026-09-14T09:30:00Z");
  assert.throws(() => mergeInventaire(inv([], { station: "CDG" }), fresh), /escales différentes/);
  // merge sur inventaire absent (null) : les fixtures deviennent l'inventaire
  assert.equal(mergeInventaire(null, fresh).hotels.length, 3);
});

test("inventaire : candidatesFrom — non exclus, contracté → préféré → score ; replis de la fiche en fin (EX-INV-3)", () => {
  const station = loadStation("BKK");
  const liste = inv([
    entry("banal", { stars: 3, review_score: 7.0, distance_km: 4 }),
    entry("excellent", { stars: 5, review_score: 9.2, distance_km: 1, indicative_price_from_eur: 60 }),
    entry("contracte", { contracted: true, stars: 3, review_score: 6.5 }),
    entry("prefere", { preferred: true, stars: 3, review_score: 6.8 }),
    entry("banni", { excluded: true, stars: 5, review_score: 9.9 }),
    entry("divalux-resort-spa-bkk", { url: "https://www.booking.com/hotel/th/divalux-resort-spa.html" }), // même URL qu'un repli
  ]);
  const cands = candidatesFrom(normalizeInventaire(liste), DEFAULT_POLICY, { station });
  assert.ok(!cands.some((c) => c.id === "banni")); // exclu écarté
  assert.equal(cands[0].id, "contracte");
  assert.equal(cands[1].id, "prefere");
  assert.equal(cands[2].id, "excellent"); // meilleur score des non marqués
  // replis : les 4 hôtels v1 moins Divalux (URL déjà présente) — ajoutés en fin, marqués fallback
  const fallbacks = cands.filter((c) => c.fallback);
  assert.deepEqual(fallbacks.map((f) => f.id), [
    "novotel-bangkok-suvarnabhumi-airport", "le-meridien-suvarnabhumi-golf-resort-spa", "amaranth-suvarnabhumi-hotel",
  ]);
  assert.deepEqual(cands.slice(-3).map((c) => c.id), fallbacks.map((f) => f.id)); // bien en fin de liste
  // inventaire absent : la liste de replis reste utilisable
  const sansInv = candidatesFrom(null, DEFAULT_POLICY, { station });
  assert.equal(sansInv.length, 4);
  assert.ok(sansInv.every((c) => c.fallback));
});

test("inventaire : compatibleTiers — étoiles sous minimum ou prestation explicitement absente excluent, l'inconnu reste à confirmer", () => {
  assert.deepEqual(compatibleTiers(normalizeInventaire(inv([entry("full")])).hotels[0], DEFAULT_POLICY), ["J", "W", "Y"]);
  const troisEtoiles = normalizeInventaire(inv([entry("h", { stars: 3 })])).hotels[0];
  assert.deepEqual(compatibleTiers(troisEtoiles, DEFAULT_POLICY), ["W", "Y"]); // 3★ < min J (4)
  const sansRoomService = normalizeInventaire(inv([entry("h", { amenities: { ...entry("h").amenities, room_service: "non" } })])).hotels[0];
  assert.deepEqual(compatibleTiers(sansRoomService, DEFAULT_POLICY), ["W", "Y"]);
  const inconnu = normalizeInventaire(inv([entry("h", { stars: null, amenities: {} })])).hotels[0];
  assert.deepEqual(compatibleTiers(inconnu, DEFAULT_POLICY), ["J", "W", "Y"]); // rien de connu : à confirmer, pas exclu
  const sansWifi = normalizeInventaire(inv([entry("h", { amenities: { ...entry("h").amenities, wifi_free: false } })])).hotels[0];
  assert.deepEqual(compatibleTiers(sansWifi, DEFAULT_POLICY), []);
  assert.equal(slugify("Le Méridien Suvarnabhumi Golf Resort & Spa"), "le-meridien-suvarnabhumi-golf-resort-spa");
});

/* ------------------------------------------------------------------ CLI */

const CLI = path.join(ROOT, "hai-admin-mcp", "tools", "inventaire.mjs");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("CLI inventaire : --dry-run NOU — zone Nouméa, URL sans distance=, aucune écriture (EX-INV-6)", () => {
  const avant = fs.readFileSync(path.join(INVENTAIRE_DIR, "NOU.json"), "utf8");
  const r = run("--station", "NOU", "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Nouméa"));
  assert.ok(r.stdout.includes("searchresults"));
  assert.ok(!r.stdout.includes("distance="), "le dry-run NOU ne doit produire aucun filtre distance=");
  assert.equal(fs.readFileSync(path.join(INVENTAIRE_DIR, "NOU.json"), "utf8"), avant);
});

test("CLI inventaire : options payantes refusées avant la phase 3", () => {
  for (const args of [["--station", "BKK", "--refresh"], ["--station", "BKK", "--max", "10"], ["--station", "BKK"]]) {
    const r = run(...args);
    assert.equal(r.status, 1, `attendu refus pour ${args.join(" ")}`);
    assert.match(r.stderr, /non disponible avant la phase 3/);
  }
});

test("CLI inventaire : --offline fusionne les fixtures sans toucher l'entrée manuelle (critère d'acceptation)", () => {
  const file = path.join(INVENTAIRE_DIR, "BKK.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    // preuve EX-INV-1 : on ajoute une entrée manuelle AVANT la fusion
    const avecManuel = JSON.parse(original);
    avecManuel.hotels.push({
      id: "grand-inn-come-manuel", name: "Grand Inn Come Hotel (ajout desk)", url: "", source: "manuel",
      contracted: true, preferred: false, excluded: false,
      stars: null, review_score: null, review_count: null, distance_km: null, distance_ref: null,
      amenities: {}, payment: { prepayment_online: "non_precise", pay_at_property_only: null },
      indicative_price_from_eur: null, capacity_hint: null, contact: { phone: "+66 2 123 4567", email: null },
      notes: "entrée manuelle de test", last_survey_at: null,
    });
    fs.writeFileSync(file, JSON.stringify(avecManuel, null, 2) + "\n", "utf8");

    const r = run("--station", "BKK", "--offline", path.join(ROOT, "data", "simulate", "inventaire-demo.json"));
    assert.equal(r.status, 0, r.stderr);
    const merged = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(merged.updated_at, "2026-09-14T09:30:00Z");
    const manuel = merged.hotels.find((h) => h.id === "grand-inn-come-manuel");
    assert.ok(manuel, "l'entrée manuelle a disparu");
    assert.equal(manuel.notes, "entrée manuelle de test"); // intouchée
    assert.equal(manuel.payment.company_payment_possible, "oui"); // contractée (EX-INV-4)
    assert.ok(merged.hotels.some((h) => h.id === "novotel-bkk-airport"), "le Novotel des fixtures doit être ajouté");
    const hyatt = merged.hotels.find((h) => h.id === "hyatt-regency-bkk-airport");
    assert.equal(hyatt.indicative_price_from_eur, 134); // rafraîchi par les fixtures
  } finally {
    fs.writeFileSync(file, original, "utf8"); // l'inventaire committé reste l'état initial
  }
});
