/**
 * Conditions client C1 et C2 — vérification hors ligne, à 0 €.
 *
 * C1 « la recherche est pilotée par la saisie » : ce que l'opérateur saisit (escale,
 * étoiles, prestations exigées, rayon, plafond) doit ATTEINDRE la recherche, et ce qui
 * ne peut pas l'atteindre doit être DIT plutôt que deviné ou avalé en silence.
 *
 * C2 « des chambres pour la TOTALITÉ des passagers » : le vivier se juge en VOLUME de
 * chambres et non en nombre d'hôtels, une chambre non mesurée se compte à part au lieu
 * de passer pour acquise, et un plan qui laisse des personnes dehors ne se déclare
 * jamais complet.
 *
 * Aucune session d'agent, aucun appel réseau, aucune horloge réelle : toutes les dates
 * sont injectées. Le seul fichier écrit l'est sous `out/` et est supprimé ensuite.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { buildNflt, buildSearchPlan, buildSearchUrl, resolveRadius, priceNflt, HYPOTHESE_FILTRE_PRIX } from "../lib/hai-urls.mjs";
import { loadStation, stationExists, listStationCodes, stationsHelp } from "../lib/stations.mjs";
import { DEFAULT_POLICY, PolicySchema } from "../lib/policy.mjs";
import { discoveryNeeded } from "../lib/discovery.mjs";
import { normalizeInventaire, capaciteIndicative, candidatesFrom } from "../lib/inventaire.mjs";
import { allocate } from "../lib/allocate.mjs";
import { buildDossiers, computeNeeds } from "../lib/dossiers.mjs";
import { ROOT, STATION_BKK, mkHotel, mkRoom, mkPax, mkInv, mkInvEntry } from "./helpers.mjs";

/** Politique par défaut clonée puis re-validée : chaque test part d'une politique propre. */
const politique = (mut = () => {}) => {
  const p = PolicySchema.parse(structuredClone(DEFAULT_POLICY));
  mut(p);
  return p;
};

/** Répertoire de travail jetable, sous `out/` (jamais ailleurs dans le dépôt). */
const bacASable = (prefixe) => {
  const base = path.join(ROOT, "out");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefixe}-`));
};

/** Fiche escale minimale VALIDE, pour l'escale imprévue du test de dépôt à chaud. */
const FICHE_KUL = {
  code: "KUL",
  name: "Kuala Lumpur International",
  country: "MY",
  timezone: "Asia/Kuala_Lumpur",
  search: { zone_query: "KLIA Sepang", radius_km: 6, distance_ref: "airport", use_distance_filter: true, extra_nflt: [] },
  transfer: { default_mode: "navette", max_transfer_min: 40, note: "" },
  constraints: { entry_visa_check: true, transit_hotel_airside: false, notes: "" },
  pricing: { price_cap_factor: 1 },
  fallback_hotels: [],
  demo_priority: 9,
};

const SEJOUR = { checkin: "2026-10-04", checkout: "2026-10-05" };

/** Passager économique minimal (fixture locale, aucune donnée réelle). */
const paxY = (pnr, over = {}) => mkPax(pnr, { cabine: "Y", ...over });

/** Raccourci d'allocation : dossiers construits avec la MÊME politique que l'allocation. */
const allouer = (rows, inventories, over = {}) => {
  const policy = over.policy ?? DEFAULT_POLICY;
  return allocate({ dossiers: buildDossiers(rows, policy), inventories, policy, station: STATION_BKK, ...over });
};

describe("C1 — la recherche obéit à la saisie", () => {
  test("C1 : une escale non fichée est refusée avec un message qui dit ce qui existe et où déposer la fiche", () => {
    assert.equal(stationExists("ZZZ"), false);
    assert.throws(
      () => loadStation("ZZZ"),
      (err) => {
        assert.match(err.message, /Fiche escale introuvable/);
        // le message doit être ACTIONNABLE : les escales disponibles, le chemin à créer
        assert.match(err.message, /escales fichées : BKK, CDG, NOU/);
        assert.match(err.message, /<IATA>\.json/);
        return true;
      },
    );
    // un code qui n'est même pas un IATA ne fait pas semblant d'exister
    assert.equal(stationExists("bangkok"), false);
    assert.match(stationsHelp(), /escales fichées : BKK, CDG, NOU/);
  });

  test("C1 : une fiche déposée sur disque est prise en compte sans redémarrage", () => {
    const dir = bacASable("c1-fiche");
    try {
      assert.deepEqual(listStationCodes({ dir }), []);
      assert.equal(stationExists("KUL", { dir }), false);
      assert.throws(() => loadStation("KUL", { dir }), /Fiche escale introuvable/);

      // dépôt à chaud, dans le MÊME processus : c'est le cas nominal d'un déroutement
      fs.writeFileSync(path.join(dir, "KUL.json"), JSON.stringify(FICHE_KUL), "utf8");

      assert.equal(stationExists("KUL", { dir }), true);
      assert.deepEqual(listStationCodes({ dir }), ["KUL"]);
      const kul = loadStation("kul", { dir }); // casse tolérée
      assert.equal(kul.name, "Kuala Lumpur International");
      // et la fiche fraîche PILOTE réellement la recherche
      const nflt = buildNflt(DEFAULT_POLICY, kul);
      assert.ok(nflt.socle.includes("distance=6000"), nflt.socle);
      assert.ok(buildSearchUrl({ station: kul, ...SEJOUR, nflt: nflt.socle }).includes("ss=KLIA+Sepang"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C1 : min_stars = 0 n'émet AUCUN filtre d'étoiles — surtout pas le 3★ de la politique par défaut", () => {
    // référence : la politique livrée exige 3★ en cabine Y, et cela se voit dans le nflt
    assert.ok(buildNflt(DEFAULT_POLICY, STATION_BKK).socle.includes("class=3;class=4;class=5"));

    const sansEtoiles = buildNflt(politique((p) => { p.cabins.Y.min_stars = 0; }), STATION_BKK);
    assert.ok(!sansEtoiles.socle.includes("class="), sansEtoiles.socle);
    assert.ok(!sansEtoiles.socle.includes("class=3"), "« 0★ » veut dire élargir, jamais reconduire le 3★ par défaut");
    // le reste de la saisie continue d'atteindre la recherche
    assert.ok(sansEtoiles.socle.includes("hotelfacility=107")); // wifi exigé en Y
    assert.ok(sansEtoiles.socle.includes("review_score=70"));
    assert.deepEqual(sansEtoiles.details.avertissements, []);
    // la passe premium garde ses 4-5★ : elle dérive de la cabine J, pas de Y
    assert.ok(sansEtoiles.premium.startsWith("class=4;class=5"));

    // une valeur d'étoiles inexploitable ne se rattrape pas en silence : elle se dit
    const aberrant = buildNflt(politique((p) => { p.cabins.Y.min_stars = 7; }), STATION_BKK);
    assert.ok(!aberrant.socle.includes("class="));
    assert.ok(aberrant.details.avertissements.some((a) => /min_stars=7 inexploitable/.test(a)), aberrant.details.avertissements.join(" | "));
  });

  test("C1 : les prestations exigées de la cabine atteignent le nflt, cabine par cabine", () => {
    const p = politique((x) => {
      x.cabins.Y.required_amenities = ["wifi_free", "breakfast_available", "airport_shuttle", "accessible"];
      x.cabins.J.required_amenities = ["wifi_free", "room_service_24h", "restaurant_late"];
    });
    const nflt = buildNflt(p, STATION_BKK);

    // socle = cabine Y
    for (const code of ["hotelfacility=107", "mealplan=1", "hotelfacility=17", "hotelfacility=185"]) {
      assert.ok(nflt.socle.includes(code), `${code} absent du socle : ${nflt.socle}`);
    }
    // premium = cabine J
    assert.ok(nflt.premium.includes("hotelfacility=5"), nflt.premium); // room service
    assert.ok(nflt.premium.includes("hotelfacility=3"), nflt.premium); // restaurant
    assert.ok(!nflt.premium.includes("mealplan=1"), "le petit-déjeuner exigé en Y ne doit pas fuir dans la passe J");
    // rien n'est perdu en route : chaque filtre porte son origine et son libellé
    const presta = nflt.details.filtres.socle.filter((f) => f.origine === "prestation").map((f) => f.prestation);
    assert.deepEqual(presta, ["wifi_free", "breakfast_available", "airport_shuttle", "accessible"]);
    // aucune prestation filtrable n'est parallèlement annoncée comme non filtrable
    assert.deepEqual(nflt.details.non_filtrables.filter((n) => n.cabine === "Y"), []);
  });

  test("C1 : une prestation sans code de filtre sûr ressort dans non_filtrables au lieu d'être devinée", () => {
    const p = politique((x) => { x.cabins.Y.required_amenities = ["wifi_free", "workspace"]; });
    const nflt = buildNflt(p, STATION_BKK);

    // « workspace » n'a pas de code Booking sûr : il est NOMMÉ, jamais inventé
    const dit = nflt.details.non_filtrables.filter((n) => n.prestation === "workspace");
    assert.ok(dit.length >= 1, JSON.stringify(nflt.details.non_filtrables));
    assert.ok(dit.some((n) => n.cabine === "Y"));
    assert.match(dit[0].raison, /aucun code de filtre Booking sûr/);
    // et surtout : aucun code fabriqué n'est parti dans la chaîne
    assert.equal(nflt.socle.split(";").filter((c) => c.startsWith("hotelfacility=")).length, 1); // le seul wifi

    // filtres de prestations coupés : TOUT part en non_filtrables, avec l'avertissement
    const coupe = buildNflt(politique((x) => { x.global.discovery.apply_amenity_filters = false; }), STATION_BKK);
    assert.ok(!coupe.socle.includes("hotelfacility="), coupe.socle);
    assert.equal(coupe.pmr, null, "sans filtre de prestation, la passe PMR n'a plus de raison d'être");
    assert.ok(coupe.details.non_filtrables.some((n) => n.cabine === "PMR" && n.prestation === "accessible"));
    assert.ok(coupe.details.avertissements.some((a) => /apply_amenity_filters = false/.test(a)));
  });

  test("C1 : radius_m saisi prime sur la fiche escale ; inapplicable, il est signalé et non envoyé", () => {
    const bkk = loadStation("BKK"); // fiche : 5 km, filtre de distance autorisé
    assert.deepEqual(resolveRadius(DEFAULT_POLICY, bkk), {
      metres: 5000, source: "fiche escale", applique: true, avertissement: null,
    });

    const saisi = politique((p) => { p.global.discovery.radius_m = 12000; });
    const r = resolveRadius(saisi, bkk);
    assert.equal(r.metres, 12000);
    assert.match(r.source, /saisie/);
    assert.equal(r.applique, true);
    assert.ok(buildNflt(saisi, bkk).socle.includes("distance=12000"));

    // EX-STA-2 : une fiche qui interdit le filtre de distance ne se laisse pas forcer,
    // et le rayon saisi ne disparaît pas en silence — il est dit
    const nou = loadStation("NOU");
    const rNou = resolveRadius(saisi, nou);
    assert.equal(rNou.metres, 12000);
    assert.equal(rNou.applique, false);
    assert.match(rNou.avertissement, /NON envoyé à Booking/);
    const nfltNou = buildNflt(saisi, nou);
    assert.ok(!nfltNou.socle.includes("distance="), nfltNou.socle);
    assert.ok(nfltNou.details.avertissements.some((a) => /NON envoyé à Booking/.test(a)));
  });

  test("C1 : buildSearchPlan rend une URL réellement construite, passe par passe", () => {
    const plan = buildSearchPlan({ policy: DEFAULT_POLICY, station: STATION_BKK, ...SEJOUR });

    assert.deepEqual(plan.passes.map((p) => p.id), ["socle", "premium", "pmr"]);
    assert.deepEqual(plan.sejour, SEJOUR);
    assert.equal(plan.station.code, "BKK");
    for (const passe of plan.passes) {
      const url = new URL(passe.url);
      assert.equal(url.origin + url.pathname, "https://www.booking.com/searchresults.fr.html");
      // l'URL porte VRAIMENT les filtres de la passe, pas une intention
      assert.equal(url.searchParams.get("nflt"), passe.nflt);
      assert.equal(url.searchParams.get("ss"), STATION_BKK.search.zone_query);
      assert.equal(url.searchParams.get("checkin"), SEJOUR.checkin);
      assert.equal(url.searchParams.get("checkout"), SEJOUR.checkout);
      assert.equal(url.searchParams.get("selected_currency"), "EUR");
      assert.ok(passe.filtres.length > 0);
      assert.equal(passe.nflt, passe.filtres.map((f) => f.code).join(";"));
    }
    assert.equal(plan.codes_releves_le, "2026-09-11");

    // deux passes aux filtres identiques ne sont pas payées deux fois — et c'est dit
    const pmrDejaDansY = politique((p) => { p.cabins.Y.required_amenities = ["wifi_free", "accessible"]; });
    const plan2 = buildSearchPlan({ policy: pmrDejaDansY, station: STATION_BKK, ...SEJOUR });
    assert.deepEqual(plan2.passes.map((p) => p.id), ["socle", "premium"]);
    assert.ok(plan2.avertissements.some((a) => /passe « pmr » identique à « socle »/.test(a)));
  });

  test("C1 : le filtre de prix est opt-in — absent par défaut, signalé comme hypothèse quand il est activé", () => {
    // défaut FAUX : la syntaxe n'a jamais été éprouvée, elle ne part pas sur un run payant
    assert.equal(DEFAULT_POLICY.global.discovery.apply_price_filter, false);
    const defaut = buildSearchPlan({ policy: DEFAULT_POLICY, station: STATION_BKK, ...SEJOUR });
    assert.ok(!defaut.passes[0].nflt.includes("price="), defaut.passes[0].nflt);
    assert.equal(defaut.passes[0].url_sans_filtre_prix, null);
    assert.deepEqual(defaut.hypotheses, []);

    const avecPrix = buildSearchPlan({ policy: politique((p) => { p.global.discovery.apply_price_filter = true; }), station: STATION_BKK, ...SEJOUR });
    const socle = avecPrix.passes.find((p) => p.id === "socle");
    assert.ok(socle.nflt.includes("price=EUR-0-250-1"), socle.nflt); // plafond le plus large (cabine J)
    // l'hypothèse est NOMMÉE et la parade est fournie, au lieu d'un « zéro résultat » muet
    assert.deepEqual(avecPrix.hypotheses.map((h) => h.id), [HYPOTHESE_FILTRE_PRIX.id]);
    assert.equal(HYPOTHESE_FILTRE_PRIX.statut, "non validée");
    assert.ok(socle.url_sans_filtre_prix !== null);
    assert.ok(!new URL(socle.url_sans_filtre_prix).searchParams.get("nflt").includes("price="));
    assert.ok(avecPrix.avertissements.some((a) => /allow_above_cap_if_no_alternative/.test(a)));

    // bornes de prix qui ne tiennent pas debout : aucun filtre bricolé
    assert.equal(priceNflt(80), "price=EUR-0-80-1");
    assert.equal(priceNflt(0), null);
    assert.equal(priceNflt(50, { minEur: 60 }), null);
    assert.equal(priceNflt("abc"), null);
  });
});

describe("C2 — des chambres pour la totalité des passagers", () => {
  const fraisLe = "2026-09-20T09:00:00Z";
  const maintenant = new Date("2026-09-21T09:00:00Z");

  test("C2 : le juge de suffisance raisonne en VOLUME de chambres, pas en nombre de candidats", () => {
    // trois hôtels, donc DEUX candidats par cabine largement atteints : l'ancien juge
    // déclarait l'inventaire « suffisant » pour 173 chambres qu'il ne pouvait pas porter
    const inv = normalizeInventaire(mkInv([mkInvEntry("h1"), mkInvEntry("h2"), mkInvEntry("h3")], { updated_at: fraisLe }));
    const candidats = candidatesFrom(inv, DEFAULT_POLICY, { station: STATION_BKK, needs: { Y: { chambres: 173 } } });
    assert.ok(candidats.filter((c) => c.tiers.includes("Y")).length >= DEFAULT_POLICY.inventory.min_candidates_per_tier);

    const verdict = discoveryNeeded({ inv, policy: DEFAULT_POLICY, station: STATION_BKK, needs: { Y: { chambres: 173 } }, now: maintenant });
    assert.equal(verdict.run, true);
    assert.match(verdict.reason, /vivier insuffisant en volume/);
    assert.equal(verdict.couverture.demandees, 173);
    assert.equal(verdict.couverture.suffisante, false);
    // le volume annoncé est celui du vivier, pas un nombre d'hôtels
    assert.equal(verdict.couverture.hotels, 3);
    assert.equal(verdict.couverture.indicatives, capaciteIndicative(candidats).total);
    assert.ok(verdict.couverture.indicatives > verdict.couverture.hotels);
  });

  test("C2 : une suffisance portée par des chambres SUPPOSÉES n'est pas une suffisance mesurée", () => {
    const sansIndice = normalizeInventaire(mkInv([mkInvEntry("h1"), mkInvEntry("h2"), mkInvEntry("h3")], { updated_at: fraisLe }));
    const suppose = discoveryNeeded({ inv: sansIndice, policy: DEFAULT_POLICY, station: STATION_BKK, needs: { Y: { chambres: 10 } }, now: maintenant });
    // Le vivier PEUT suffire — mais uniquement si l'on compte les chambres supposées.
    // « Rien n'est estimé » vaut aussi pour les DÉCISIONS : par défaut on va chercher des
    // hôtels plutôt que de parier sur un stock qu'aucun relevé n'a vu.
    assert.equal(suppose.couverture.suffisante, true);
    assert.equal(suppose.couverture.suffisante_mesuree, false);
    assert.equal(suppose.couverture.relevees, 0);
    assert.equal(suppose.run, true, "la découverte doit être lancée quand la suffisance n'est que supposée");
    assert.match(suppose.reason, /suffisance NON MESURÉE/);

    // L'option se coupe explicitement — et le motif dit alors sur quoi repose le pari.
    const parieur = PolicySchema.parse({
      ...DEFAULT_POLICY,
      inventory: { ...DEFAULT_POLICY.inventory, decide_on_measured_capacity: false },
    });
    const sansDecouverte = discoveryNeeded({ inv: sansIndice, policy: parieur, station: STATION_BKK, needs: { Y: { chambres: 10 } }, now: maintenant });
    assert.equal(sansDecouverte.run, false);
    assert.match(sansDecouverte.reason, /suffisance NON MESURÉE/);

    const hint = (n) => ({ capacity_hint: { rooms_displayed_max: n, cap_reached: false, observed_at: fraisLe } });
    const mesure = normalizeInventaire(mkInv([mkInvEntry("h1", hint(40)), mkInvEntry("h2", hint(40))], { updated_at: fraisLe }));
    const compte = discoveryNeeded({ inv: mesure, policy: DEFAULT_POLICY, station: STATION_BKK, needs: { Y: { chambres: 50 } }, now: maintenant });
    assert.equal(compte.run, false);
    assert.equal(compte.couverture.relevees, 80);
    assert.equal(compte.couverture.supposees, 0);
    assert.equal(compte.couverture.suffisante_mesuree, true);
    assert.match(compte.reason, /inventaire frais et suffisant/);
  });

  test("C2 : une chambre adossée à un sélecteur plafonné est marquée stock_mesure: false et comptée à part", () => {
    const plafonne = [mkHotel("cap", { stars: 3 }, [mkRoom({ quantity_available: 5, cap_reached: true })])];
    const r = allouer([paxY("A"), paxY("B")], plafonne);

    assert.equal(r.summary.ok, 2);
    for (const row of r.plan) {
      assert.equal(row.statut, "OK"); // le niveau 2 reste ALLOUABLE : pas d'escalade de capacité
      assert.equal(row.stock_mesure, false);
      assert.equal(row.chambres_fermes, 0);
      assert.equal(row.chambres_a_confirmer, row.chambres);
      assert.match(row.notes, /CHAMBRE À CONFIRMER auprès de l'hôtel/);
    }
    // décompte à DEUX NIVEAUX, dont la somme est le total du plan
    assert.equal(r.summary.chambresFermes, 0);
    assert.equal(r.summary.chambresAConfirmer, 2);
    assert.equal(r.summary.chambresFermes + r.summary.chambresAConfirmer, r.summary.chambres);
    assert.equal(r.summary.partAConfirmer, 1);
    assert.equal(r.summary.stockNonMesure, 2);
    assert.deepEqual(r.summary.parHotel["Hôtel cap"], {
      chambres: 2, chambres_fermes: 0, chambres_a_confirmer: 2, dossiers: 2, pax: 2, stock_mesure: false,
    });
    assert.ok(r.summary.reserves.some((x) => /chambre\(s\) À CONFIRMER/.test(x)), r.summary.reserves.join(" | "));

    // sélecteur NON plafonné : mesure ferme, aucune réserve de stock
    const ferme = [mkHotel("ok", { stars: 3 }, [mkRoom({ quantity_available: 5, cap_reached: false })])];
    const rf = allouer([paxY("A")], ferme);
    assert.equal(rf.plan[0].stock_mesure, true);
    assert.equal(rf.summary.chambresFermes, 1);
    assert.equal(rf.summary.chambresAConfirmer, 0);
    assert.deepEqual(rf.summary.reserves, []);
  });

  test("C2 : un plan ne se déclare jamais complet tant que des passagers restent sans chambre", () => {
    const uneSeule = [mkHotel("ok", { stars: 3 }, [mkRoom({ quantity_available: 1, cap_reached: false })])];
    const r = allouer([paxY("A"), paxY("B"), paxY("C")], uneSeule);

    assert.equal(r.summary.ok, 1);
    assert.equal(r.summary.escalade, 2);
    assert.equal(r.summary.complet, false);
    assert.ok(r.summary.reserves.some((x) => /dossier\(s\) sans chambre/.test(x)), r.summary.reserves.join(" | "));
    // le manque remonte à l'extension, exprimé en chambres et par cabine
    assert.deepEqual(r.gaps.chambresManquantes, { Y: 2 });

    // stock juste suffisant : et seulement là, le plan se déclare complet
    const troisChambres = [mkHotel("ok", { stars: 3 }, [mkRoom({ quantity_available: 3, cap_reached: false })])];
    const plein = allouer([paxY("A"), paxY("B"), paxY("C")], troisChambres);
    assert.equal(plein.summary.escalade, 0);
    assert.equal(plein.summary.paxNonLoges, 0);
    assert.deepEqual(plein.summary.reserves, []);
    assert.equal(plein.summary.complet, true);
    assert.deepEqual(plein.gaps.chambresManquantes, {});
  });

  test("C2 : le résumé compte des PERSONNES et pas seulement des dossiers", () => {
    // un seul dossier, quatre personnes : le chiffre décisif n'est pas « 1 escalade »
    const famille = [
      mkPax("F1", { cabine: "Y" }),
      mkPax("F1", { cabine: "Y" }),
      mkPax("F1", { cabine: "Y", type_pax: "CHD", age: "6" }),
      mkPax("F1", { cabine: "Y", type_pax: "CHD", age: "8" }),
    ];
    const complet = [mkHotel("plein", { stars: 3 }, [mkRoom({ quantity_available: 0, cap_reached: false })])];
    const r = allouer(famille, complet);

    assert.equal(r.summary.escalade, 1);
    assert.equal(r.summary.paxTotal, 4);
    assert.equal(r.summary.paxNonLoges, 4);
    assert.equal(r.summary.paxLoges, 0);
    // la réserve lue par le validateur porte les DEUX unités
    assert.ok(r.summary.reserves.some((x) => /1 dossier\(s\) sans chambre \(4 personne\(s\)\)/.test(x)), r.summary.reserves.join(" | "));

    // même exigence côté besoins : dossiers, chambres ET personnes
    const needs = computeNeeds(buildDossiers(famille, DEFAULT_POLICY));
    assert.equal(needs.total.dossiers, 1);
    assert.equal(needs.total.personnes, 4);
    assert.equal(needs.total.pax, 4);
    assert.ok(needs.total.chambres >= 1);
    assert.equal(needs.parTier.Y.personnes, 4);

    // les nourrissons ne consomment pas de capacité mais restent comptés en `pax`
    const avecBebe = computeNeeds(buildDossiers([...famille, mkPax("F1", { cabine: "Y", type_pax: "INF", age: "1" })], DEFAULT_POLICY));
    assert.equal(avecBebe.total.personnes, 4);
    assert.equal(avecBebe.total.pax, 5);
  });

  test("C2 : une quantité aberrante est ramenée au plafond de prudence, avec avertissement", () => {
    const seuil = DEFAULT_POLICY.extension.room_qty_sane_max;   // 60
    const plafond = DEFAULT_POLICY.extension.hotel_cap_without_probe; // 20
    const delirant = [mkHotel("fou", { stars: 3 }, [mkRoom({ quantity_available: seuil + 190, cap_reached: false })])];
    const rows = Array.from({ length: 40 }, (_, i) => paxY(`P${i}`));
    const r = allouer(rows, delirant);

    // le relevé promettait 250 chambres : le plan n'en engage que le plafond de prudence
    assert.equal(r.summary.ok, plafond);
    assert.equal(r.summary.chambres, plafond);
    assert.equal(r.summary.escalade, rows.length - plafond);
    assert.ok(
      r.summary.avertissements.some((a) => /relevé jugé aberrant/.test(a) && a.includes(String(seuil)) && a.includes(String(plafond))),
      r.summary.avertissements.join(" | "),
    );
    assert.equal(r.summary.complet, false);
    assert.ok(r.summary.reserves.some((x) => /avertissement\(s\) de stock/.test(x)));

    // juste sous le seuil : rien n'est raboté, rien n'est signalé
    const sain = [mkHotel("sain", { stars: 3 }, [mkRoom({ quantity_available: seuil, cap_reached: false })])];
    const ok = allouer(rows, sain);
    assert.equal(ok.summary.ok, rows.length);
    assert.deepEqual(ok.summary.avertissements, []);
  });
});
