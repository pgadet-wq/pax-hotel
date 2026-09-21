/**
 * Découverte MULTI-SOURCES (21/09/2026).
 *
 * La découverte ne travaillait que sur Booking : sur Suvarnabhumi cela plafonne le vivier
 * à ~12 établissements, très loin des ~25 à 40 hôtels qu'il faut pour loger 250 passagers.
 *
 * Deux familles de sources, et toute la difficulté est là : une PLATEFORME rend une fiche
 * réservable, donc un prix public, donc une ligne de plan chiffrée ; un ANNUAIRE (Maps)
 * rend un nom, une adresse et un TÉLÉPHONE, et aucun prix. Ces tests verrouillent la
 * frontière : un lead n'entre jamais au plan (INV-3) et ne consomme jamais de session de
 * relevé, mais il n'est pas perdu pour autant — il alimente le vivier à appeler.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_POLICY, PolicySchema, SOURCE_KEYS, SOURCE_NATURE, SOURCES_DEFAUT } from "../lib/policy.mjs";
import { loadStation } from "../lib/stations.mjs";
import { sourcesActives, mapsSearchUrl } from "../lib/hai-urls.mjs";
import { cleRecoupement, fusionnerSources, candidateToEntry } from "../lib/discovery.mjs";
import { candidatesFrom, leadsDe, normalizeInventaire } from "../lib/inventaire.mjs";

const BKK = loadStation("BKK");

const avecSources = (cles) =>
  PolicySchema.parse({
    ...DEFAULT_POLICY,
    global: {
      ...DEFAULT_POLICY.global,
      discovery: {
        ...DEFAULT_POLICY.global.discovery,
        sources: SOURCES_DEFAUT.map((s) => ({ ...s, actif: cles.includes(s.cle) })),
      },
    },
  });

test("sources : le catalogue et les natures sont cohérents", () => {
  assert.deepEqual([...SOURCE_KEYS].sort(), ["agoda", "booking", "expedia", "maps", "tripcom"]);
  for (const k of SOURCE_KEYS) assert.ok(["plateforme", "annuaire"].includes(SOURCE_NATURE[k]), `nature manquante : ${k}`);
  // Maps est la SEULE source d'annuaire : c'est elle qui rend le téléphone, et elle seule
  // qui ne rend pas de prix. Si une autre y passait, la frontière du plan bougerait.
  assert.deepEqual(SOURCE_KEYS.filter((k) => SOURCE_NATURE[k] === "annuaire"), ["maps"]);
});

test("sources : Booking seul est actif par défaut — chaque source coûte une session payante", () => {
  const { sources } = sourcesActives(DEFAULT_POLICY, BKK);
  assert.deepEqual(sources.map((s) => s.cle), ["booking"]);
});

test("sources : les sources actives sortent dans l'ordre de leur rang, avec leur point d'entrée", () => {
  const { sources, avertissements } = sourcesActives(avecSources(["booking", "agoda", "maps"]), BKK);
  assert.deepEqual(sources.map((s) => s.cle), ["booking", "agoda", "maps"]);
  assert.equal(avertissements.length, 0);
  for (const s of sources) assert.ok(s.entree.startsWith("http"), `point d'entrée absent : ${s.cle}`);
  // les codes de filtre n'ont été relevés que sur Booking : les autres sont abordées par
  // recherche manuelle, aucun filtre n'est inventé (un code erroné rendrait ZÉRO résultat)
  assert.equal(sources.find((s) => s.cle === "booking").filtres_releves, true);
  assert.equal(sources.find((s) => s.cle === "agoda").filtres_releves, false);
});

test("sources : aucune source active est DIT, jamais subi en silence", () => {
  const { sources, avertissements } = sourcesActives(avecSources([]), BKK);
  assert.equal(sources.length, 0);
  assert.match(avertissements.join(" "), /aucune source de découverte active/);
});

test("sources : l'URL d'annuaire porte la zone de l'escale, jamais un rayon inventé", () => {
  const url = decodeURIComponent(mapsSearchUrl(BKK, 40000));
  assert.match(url, /Suvarnabhumi/);
  assert.match(url, /40 km/);
  // sans rayon fourni, rien n'est ajouté : on ne suppose pas une zone de recherche
  assert.ok(!decodeURIComponent(mapsSearchUrl(BKK)).includes("km"));
});

test("recoupement : le même établissement se reconnaît d'une source à l'autre", () => {
  assert.equal(cleRecoupement("Hyatt Regency Bangkok Suvarnabhumi Airport"), cleRecoupement("Hyatt Regency Suvarnabhumi"));
  assert.notEqual(cleRecoupement("Novotel Bangkok Suvarnabhumi"), cleRecoupement("Orchid Resort"));
  assert.equal(cleRecoupement(""), "");
});

const surPlateforme = (nom, prix) =>
  candidateToEntry({ name: nom, url: `https://exemple/${nom}`, price_from_per_night: prix, stars: 4 }, { sourceCle: "booking", nature: "plateforme" });
const surAnnuaire = (nom, tel, adresse) =>
  candidateToEntry({ name: nom, phone: tel, address: adresse, stars: 3, review_score: 7.8 }, { sourceCle: "maps", nature: "annuaire" });

test("annuaire : une entrée de Maps est un LEAD — téléphone oui, prix JAMAIS", () => {
  const e = surAnnuaire("Orchid Garden Place", "+66 2 555 0000", "12 Kingkaew Rd");
  assert.equal(e.source, "lead");
  assert.equal(e.source_cle, "maps");
  assert.equal(e.contact.phone, "+66 2 555 0000");
  assert.equal(e.adresse, "12 Kingkaew Rd");
  assert.equal(e.url, "", "un lead n'a pas de page réservable");
  assert.equal(e.indicative_price_from_eur, null, "aucun prix public depuis un annuaire (INV-3)");
  assert.match(e.notes, /à APPELER/);
});

test("annuaire : un téléphone absent reste absent — aucun numéro n'est deviné", () => {
  const e = surAnnuaire("Hôtel Sans Numéro", "", "3 rue X");
  assert.equal(e.contact.phone, null);
  assert.match(e.notes, /téléphone non relevé/);
});

test("fusion : la fiche réservable gagne, et HÉRITE du téléphone de l'annuaire", () => {
  const { entrees, bilan } = fusionnerSources([
    { cle: "booking", nature: "plateforme", entrees: [surPlateforme("Hyatt Regency Bangkok Suvarnabhumi Airport", 120)] },
    { cle: "maps", nature: "annuaire", entrees: [surAnnuaire("Hyatt Regency Suvarnabhumi", "+66 2 131 1234", "999 Bang Na")] },
  ]);
  assert.equal(entrees.length, 1, "le même hôtel ne doit pas être relevé deux fois");
  const [h] = entrees;
  assert.equal(h.source, "agent", "la fiche réservable prime : elle seule permet un plan chiffré");
  assert.equal(h.indicative_price_from_eur, 120);
  assert.equal(h.contact.phone, "+66 2 131 1234", "le téléphone de l'annuaire est récupéré");
  assert.equal(bilan.promus, 1);
  assert.equal(bilan.leads, 0);
});

test("fusion : un établissement vu par le SEUL annuaire reste un lead", () => {
  const { entrees, bilan } = fusionnerSources([
    { cle: "booking", nature: "plateforme", entrees: [surPlateforme("Novotel Suvarnabhumi", 90)] },
    { cle: "maps", nature: "annuaire", entrees: [surAnnuaire("Orchid Garden Place", "+66 2 555 0000", "12 Kingkaew Rd")] },
  ]);
  assert.equal(entrees.length, 2);
  assert.equal(bilan.plateforme, 1);
  assert.equal(bilan.leads, 1);
  assert.equal(entrees.find((e) => e.source === "lead").name, "Orchid Garden Place");
});

test("frontière : un lead ne part JAMAIS en relevé et n'entre JAMAIS au plan", () => {
  const inv = normalizeInventaire({
    station: "BKK",
    updated_at: "2026-09-21T00:00:00.000Z",
    reference: null,
    hotels: [surPlateforme("Novotel Suvarnabhumi", 90), surAnnuaire("Orchid Garden Place", "+66 2 555 0000", "12 Kingkaew Rd")],
  });
  const candidats = candidatesFrom(inv, DEFAULT_POLICY, { station: BKK });
  assert.ok(!candidats.some((c) => c.source === "lead"), "un lead a été proposé au relevé : session dépensée pour rien");
  assert.ok(candidats.some((c) => c.name === "Novotel Suvarnabhumi"));

  // mais il n'est pas perdu : il alimente le vivier de repli à appeler
  const leads = leadsDe(inv);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].contact.phone, "+66 2 555 0000");
});

test("aller-retour au schéma : une entrée de découverte survit à l'écriture d'inventaire", () => {
  // RÉGRESSION du 21/09, trouvée par un run RÉEL tombé en erreur à 0,29 $ : le champ
  // `couronne` avait été déclaré `z.number()` alors que `couronneEntree()` y met un OBJET
  // {rang, rayon_m, trajet_min_declare, mode}. Résultat : « inventaire frais invalide »
  // sur les 12 hôtels, run perdu après la découverte. Aucun test ne faisait passer une
  // entrée fraîchement construite par le schéma — c'est ce que fait celui-ci.
  const couronne = { rang: 2, rayon_m: 15000, trajet_min: 35, mode: "taxi" };
  const plateforme = candidateToEntry(
    { name: "Test Plateforme", url: "https://exemple/x", price_from_per_night: 80, stars: 4 },
    { sourceCle: "booking", nature: "plateforme", couronne },
  );
  const lead = candidateToEntry(
    { name: "Test Annuaire", phone: "+66 2 000 0000", address: "1 rue X", review_score: 8 },
    { sourceCle: "maps", nature: "annuaire", couronne },
  );

  const inv = normalizeInventaire({
    station: "BKK", updated_at: "2026-09-21T00:00:00.000Z", reference: null,
    hotels: [plateforme, lead],
  });

  assert.equal(inv.hotels.length, 2, "le schéma a rejeté une entrée pourtant produite par le moteur");
  const [p, l] = inv.hotels;
  // la couronne doit SURVIVRE : c'est la source que l'allocation juge la plus fiable,
  // devant distance_km (nulle ou fausse sur 6 hôtels de BKK sur 9)
  assert.equal(p.couronne?.rang, 2);
  assert.equal(p.couronne?.trajet_min_declare, 35);
  assert.equal(p.couronne?.mode, "taxi");
  // et la source, le téléphone et l'adresse d'un lead aussi
  assert.equal(l.source, "lead");
  assert.equal(l.source_cle, "maps");
  assert.equal(l.contact.phone, "+66 2 000 0000");
  assert.equal(l.adresse, "1 rue X");
});

test("bornes : les défauts tiennent les 40 hôtels visés", () => {
  const d = DEFAULT_POLICY.global.discovery;
  const e = DEFAULT_POLICY.extension;
  assert.equal(d.max_hotels_total, 40);
  // mesure de l'Étage 0 du 21/09 : 0,13 $ et ~110 s par relevé. 40 relevés ≈ 5,2 $ et,
  // à concurrence 6, ~13 min : les trois bornes doivent laisser passer ce volume.
  assert.ok(e.max_sessions_per_run >= 40 + 5, `sessions ${e.max_sessions_per_run} : le run s'arrêterait sur la borne`);
  assert.ok(e.max_cost_usd_per_run >= 40 * 0.13, `coût ${e.max_cost_usd_per_run} $ insuffisant pour 40 relevés`);
  assert.ok(e.max_minutes_per_run >= 45, `horloge ${e.max_minutes_per_run} min`);
});
