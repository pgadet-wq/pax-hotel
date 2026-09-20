#!/usr/bin/env node
/**
 * CLI v2 (CDC §12.1) — prise en charge hôtelière de passagers déroutés.
 *
 * L'outil s'arrête au PLAN : il ne réserve rien (INV-1), ne saisit rien en ligne
 * au nom d'un passager (INV-5) et n'envoie aucun message. Voir `--help`.
 *
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --help
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run [--station BKK]
 *   node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadStation, couronnesDe } from "../lib/stations.mjs";
import { loadInventaire, isStale, candidatesFrom, slugify, capaciteIndicative } from "../lib/inventaire.mjs";
import { DEFAULT_POLICY, effectiveCaps, CRITERE_LABELS } from "../lib/policy.mjs";
import { mergeConfig, resolveDates, DEFAULT_AVION, newRunId, stationClock, contexteEscale } from "../lib/scenario.mjs";
import { generatePassengers } from "../lib/passagers.mjs";
import { ingestPassagers, formatRapport, IngestError, normalizePaxRows, splitPaxRows } from "../lib/paxlist.mjs";
import { buildDossiers, computeNeeds, chambresHorsPortee, avertissementsDe } from "../lib/dossiers.mjs";
import { discoveryNeeded, runDiscovery } from "../lib/discovery.mjs";
import { planExtension, runProbe } from "../lib/capacite.mjs";
import { runReleves, resolveConcurrency } from "../lib/releve.mjs";
import { buildHotelUrl, buildProbeUrl, buildSearchPlan } from "../lib/hai-urls.mjs";
import { runPipeline, fixturesCollect } from "../lib/pipeline.mjs";
import { buildFiches, buildFichesCsv, buildFichesHtml, fichesFileNames } from "../lib/fiches.mjs";
import { carteLigne } from "../lib/cout.mjs";
import { mkEmitter } from "../lib/events.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = path.join(ROOT, "out");

/* ------------------------------------------------------------------ --help */

const AIDE = `Prise en charge hôtelière de passagers déroutés — plan d'hébergement, CDC §12.1.

Usage : node hai-admin-mcp/tools/rebooking-v2.mjs <mode> [options]

Modes GRATUITS (aucun agent, aucune session, 0 €)
  --dry-run                  ce que le run ferait : besoins, vivier, URL de recherche
                             réellement envoyée, couverture, durée estimée, bornes.
                             N'écrit rien.
  --offline <fixtures.json>  rejoue des relevés enregistrés → plan, liste d'appel,
                             fiches d'enregistrement, messages, coût, cartes.

Options
  --station <IATA>     escale (défaut BKK) — fiches dans data/stations/
  --checkin AAAA-MM-JJ arrivée (défaut : aujourd'hui à l'heure de l'escale)
  --nights <n>         nuits (1 à 7, défaut 1)
  --seed <n>           graine de la liste générée (défaut 42)
  --in <liste.csv>     liste passagers de la compagnie (PAXLIST v1, v2 ou v3) ; sans elle,
                       un A350-900 plein est généré
  --help               ce texte

Modes PAYANTS (INV-8) — exigent DEMO_ALLOW_PAID=1, réservés aux phases 5-6
  --probe-discovery                    1 session de découverte  → out/candidats-<run>.json
  --probe-releve <n>                   n sessions de relevé     → out/releves-<run>.json
  --probe-capacity <url> --rooms <n>   1 sonde de capacité      → out/probe-<run>.json
  --probe-inventaire --max <n>         Étage 0 (délégué à tools/inventaire.mjs --refresh)
  (aucun mode)                         run complet, sessions réelles

Avant un run payant, le pré-vol HTTP des fiches d'inventaire est gratuit :
  node hai-admin-mcp/tools/inventaire.mjs --station <IATA> --preflight

Ce que l'outil NE FAIT PAS (CDC §2.2-2.3) : aucune réservation (INV-1), aucune saisie
en ligne au nom d'un passager ni donnée passager confiée à un agent (INV-5), aucun envoi
de message, aucune émission de carte prépayée. Il produit un plan à valider et des
documents à imprimer ; la réservation reste un geste humain.`;

// `--help` seul : une invocation SANS mode reste un run complet (garde INV-8 ci-dessous).
if (flag("help") || argv.includes("-h")) {
  console.log(AIDE);
  process.exit(0);
}

/* ---------------------------------------------------- garde INV-8 (payant) */

const PAID_FLAGS = ["probe-discovery", "probe-releve", "probe-capacity", "probe-inventaire"];
const wantsPaid = PAID_FLAGS.some((f) => flag(f)) || (!flag("dry-run") && !opt("offline", null));
if (wantsPaid && process.env.DEMO_ALLOW_PAID !== "1") {
  console.error("refusé (INV-8) : cette commande lancerait des sessions d'agents PAYANTES.");
  console.error("Elle est réservée aux phases 5-6, sur demande explicite : exporter DEMO_ALLOW_PAID=1 pour l'autoriser.");
  console.error("Modes gratuits : --dry-run, --offline <fixtures.json>. Détail : --help.");
  process.exit(1);
}

/* ------------------------------------------------------------ paramètres */

const station = loadStation(opt("station", "BKK"));
const { policy, avion, scenario } = mergeConfig({
  scenario: {
    station: station.code,
    ...(opt("checkin", null) ? { checkin: opt("checkin", null) } : {}),
    nights: Number(opt("nights", "1")),
    seed: Number(opt("seed", "42")),
  },
});
const { checkin, checkout } = resolveDates(scenario, new Date(), station.timezone);

/* Liste passagers : fichier compagnie (ingestion PAXLIST v1, rapport imprimé et
   BLOQUANT sur valeur illisible) ou liste générée (avion plein, seed du scénario). */
let rows;
let ingestion = null;
if (opt("in", null)) {
  const fichier = path.resolve(opt("in", null));
  try {
    // v3 : sans contexte d'escale, un « HH:MM » seul reste indate et les controles
    // « anterieur a l'arrivee » / « au-dela de 72 h » ne tournent pas (PAXLIST §3.3ter).
    const ing = ingestPassagers(fs.readFileSync(fichier), { escale: contexteEscale(station, new Date()) });
    console.log(`Liste passagers : ${fichier}`);
    console.log(formatRapport(ing.rapport));
    if (ing.equipage.length) console.log(`  (${ing.equipage.length} ligne(s) d'équipage hors plan passagers)`);
    if (ing.exclus.length) console.log(`  (${ing.exclus.length} ligne(s) non à loger)`);
    console.log("");
    rows = ing.pax;
    ingestion = ing.rapport;
  } catch (err) {
    if (!(err instanceof IngestError)) throw err;
    console.error(`\nListe passagers REFUSÉE — ${fichier}\n`);
    console.error(err.message);
    if (err.rapport) console.error(`\n${formatRapport(err.rapport)}`);
    process.exit(2);
  }
} else {
  rows = generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
}

/**
 * Mesures RÉELLES consignées dans `docs/recette-demo-v2.md` (§3 et §4) : seule base
 * de l'estimation de durée du dry-run. Aucune valeur n'est extrapolée d'ailleurs ;
 * quand un run réel donnera un meilleur point de mesure, il s'ajoute ici.
 * @type {Array<{ref: string, sessions: number, secondes: number, concurrence: number}>}
 */
const MESURES_REELLES = [
  { ref: "Étage 0 BKK du 15/09", sessions: 11, secondes: 693, concurrence: 3 },
  { ref: "run complet BKK mu3lnxm4 du 16/09", sessions: 17, secondes: 1500, concurrence: 5 },
];

/* ---------------------------------------------------------------- dry-run */

if (flag("dry-run")) {
  const maintenant = new Date();
  const horloge = stationClock(maintenant, station.timezone);
  // HEURE DE L'ESCALE injectée : sans elle, AUCUN budget de trajet n'est calculé et le
  // dry-run annoncerait « 0 dossier contraint », c'est-à-dire un chiffre rassurant que
  // rien ne mérite. `maintenantLocal` est l'horloge MURALE de l'escale (cadre de
  // `heure_correspondance`), `maintenant` l'instant absolu (cadre de `correspondance_utc`).
  const maintenantLocal = horloge.heure ? `${horloge.date}T${horloge.heure}` : null;
  const dossiers = buildDossiers(rows, policy, { maintenant, maintenantLocal });
  const needs = computeNeeds(dossiers);
  const caps = effectiveCaps(policy, station);
  console.log(`Escale ${station.code} — ${station.name} · séjour du ${checkin} au ${checkout} (${scenario.nights} nuit${scenario.nights > 1 ? "s" : ""})`);
  console.log(`  heure locale escale : ${horloge.date} ${horloge.heure} (${station.timezone}) — c'est CETTE nuit qui sera relevée`);
  console.log(`${rows.length} passagers, ${dossiers.length} dossiers — plafonds effectifs J ${caps.J} / W ${caps.W} / Y ${caps.Y} EUR/nuit`);
  console.log("\nBesoins par tier :");
  for (const tier of ["J", "W", "Y"]) {
    const n = needs.parTier[tier] ?? { dossiers: 0, chambres: 0 };
    console.log(`  ${tier} : ${n.dossiers} dossiers, ${n.chambres} chambres`);
  }
  console.log("Files de priorité :", Object.entries(needs.parFile).map(([f, v]) => `${f} ${v.dossiers}d/${v.chambres}ch`).join(" · "));

  const inv = loadInventaire(station.code);
  const stale = isStale(inv, policy);
  console.log(`\nInventaire ${station.code} : ${inv ? `${inv.hotels.length} hôtel(s), mis à jour le ${inv.updated_at ?? "jamais"}` : "absent"} · périmé : ${stale ? "oui" : "non"}`);

  const decision = discoveryNeeded({ inv, policy, station, needs: needs.parTier, force: scenario.force_discovery });
  console.log(`Découverte : ${decision.run ? "EXÉCUTÉE" : "SAUTÉE"} — ${decision.reason}`);

  /* --- C1 : la recherche RÉELLEMENT envoyée, avant de la payer ------------- */
  // Réglage de base de la découverte : `buildNflt(policy, station)`, c'est-à-dire
  // sans restriction aux cabines à loger et sans passe PMR. C'est le socle que
  // l'étage A envoie ; montrer davantage afficherait une intention, pas la requête
  // que l'opérateur s'apprête à payer.
  const planRecherche = buildSearchPlan({ policy, station, checkin, checkout, needs: null, pmr: false });
  console.log(`\nRecherche envoyée (C1) — zone « ${planRecherche.station.zone_query} », séjour ${planRecherche.sejour.checkin} → ${planRecherche.sejour.checkout}, ${planRecherche.passes.length} passe(s) :`);
  for (const passe of planRecherche.passes) {
    console.log(`\n  [${passe.id}] ${passe.libelle}`);
    console.log(`    filtres : ${passe.filtres.map((f) => `${f.libelle} (${f.origine})`).join(" · ") || "aucun"}`);
    console.log(`    URL : ${passe.url}`);
    if (passe.url_sans_filtre_prix) console.log(`    repli sans filtre de prix : ${passe.url_sans_filtre_prix}`);
  }
  console.log(`\n  rayon : ${planRecherche.rayon.metres ?? "non exploitable"}${planRecherche.rayon.metres ? " m" : ""} (${planRecherche.rayon.source}) — ${planRecherche.rayon.applique ? "envoyé à Booking" : "PAS envoyé à Booking"}`);
  // le filtre de prix est OPT-IN (`discovery.apply_price_filter`, défaut false) parce que
  // sa syntaxe n'est pas validée : annoncer un plafond « filtré » quand rien ne l'est
  // ferait croire à un vivier déjà borné.
  const prixFiltre = planRecherche.passes.some((passe) => passe.filtres.some((f) => f.origine === "prix"));
  console.log(`  filtre de prix : ${prixFiltre ? "ACTIF" : "INACTIF (discovery.apply_price_filter = false — opt-in, syntaxe non validée)"}`);
  console.log(`    plafonds retenus : socle ${planRecherche.plafonds_eur.socle} EUR/nuit · premium ${planRecherche.plafonds_eur.premium} EUR/nuit` +
    `${prixFiltre ? " (envoyés à la recherche)" : " — appliqués au jugement du relevé, pas à la recherche"}`);
  console.log(`  codes de filtres relevés le ${planRecherche.codes_releves_le}, non revérifiés depuis`);
  if (planRecherche.non_filtrables.length) {
    console.log("  exigences NON filtrables — elles ne seront jugées qu'au relevé :");
    for (const nf of planRecherche.non_filtrables) console.log(`    - ${nf.prestation} (cabine ${nf.cabine}) : ${nf.raison}`);
  }
  for (const a of planRecherche.avertissements) console.log(`  ⚠ ${a}`);
  for (const h of planRecherche.hypotheses) {
    console.log(`  hypothèse « ${h.id} » (${h.syntaxe}) — ${h.statut}, relevée le ${h.releve_le}`);
    console.log(`    si elle est fausse : ${h.effet_si_fausse} · parade : ${h.parade}`);
  }

  // Écart entre la recherche envoyée et celle que les besoins de CETTE liste
  // justifieraient : dit, jamais comblé en silence.
  // `parCritere.pmr` et non `parFile.pmr` (mesure de recette du 21/09/2026) : depuis la
  // politique de prise en charge, un PMR qui est AUSSI « correspondance serrée » ou
  // « médical » est servi dans CETTE file-là — `parFile.pmr` tombe alors à 0 et le
  // dry-run cessait de signaler la passe PMR manquante, alors que des dossiers PMR
  // existent et exigent une chambre accessible. Même lecture que lib/pipeline.mjs et
  // demo/server.mjs ; le repli sur `parFile` sert les plans restitués d'avant.
  const pmrVoulu = (needs.parCritere?.pmr?.dossiers ?? needs.parFile?.pmr?.dossiers ?? 0) > 0;
  const planCible = buildSearchPlan({ policy, station, checkin, checkout, needs: needs.parTier, pmr: pmrVoulu });
  const ecarts = [];
  for (const passe of planCible.passes) {
    const envoyee = planRecherche.passes.find((x) => x.id === passe.id);
    if (!envoyee) ecarts.push(`passe « ${passe.id} » jamais envoyée`);
    else if (envoyee.nflt !== passe.nflt) ecarts.push(`passe « ${passe.id} » : filtres non restreints aux cabines réellement à loger`);
  }
  if (ecarts.length) {
    console.log(`  écart à vérifier — ${ecarts.join(" ; ")}.`);
    console.log("    Ces options (filtres restreints aux cabines à loger, passe PMR) sont portées par");
    console.log("    lib/discovery.mjs : au run, l'événement « phase/discovery » donne les URL réellement émises.");
  }

  const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });
  const maxB = policy.global.discovery.max_hotels_stage_b;
  const besoinTotal = ["J", "W", "Y"].reduce((n, t) => n + (needs.parTier[t]?.chambres ?? 0), 0);
  const cap = capaciteIndicative(candidates);
  console.log(`\nCouverture (C2) : ${cap.total} chambre(s) indicative(s) pour ${besoinTotal} demandée(s)` +
    ` — ${needs.total.personnes} personne(s) À COUCHER (hors ${needs.total.pax - needs.total.personnes} nourrisson(s), ${needs.total.pax} à bord) dans ${needs.total.dossiers} dossier(s), ${cap.hotels} candidat(s) au vivier`);
  console.log(`  dont ${cap.connue} vue(s) à un relevé précédent et ${cap.estimee} SUPPOSÉE(S)` +
    ` (9 par hôtel sans indice de capacité : hypothèse de cadrage, jamais une mesure)`);
  console.log("  « indicatif » n'est pas « disponible » : seul le relevé du jour engage un stock.");
  if (cap.total < besoinTotal) {
    console.log("  ATTENTION : le vivier ne peut PAS couvrir le besoin — le run s'arrêtera « épuisé » et escaladera.");
    console.log(`  Avant le run : DEMO_ALLOW_PAID=1 node hai-admin-mcp/tools/inventaire.mjs --station ${station.code} --refresh --max 20`);
    console.log("  ou cocher « Forcer la découverte » pour chercher des hôtels au-delà de l'inventaire.");
  }
  /* --- COURONNES : la décision d'élargir, prise avant de payer ------------------------
     Trois questions, dans cet ordre, parce que la réponse à la troisième dépend des deux
     premières : combien de dossiers EXIGENT un hôtel proche (leur vol suivant le leur
     impose), ce que le vivier offre COURONNE PAR COURONNE, et quelles couronnes il
     faudra donc probablement ouvrir. Aucun temps de trajet n'est mesuré ici : ils sont
     tous DÉCLARÉS par l'exploitation dans la fiche escale. --------------------------- */
  const { couronnes, source: couronnesSource } = couronnesDe(station);

  const criteres = policy.global.prise_en_charge?.criteres ?? [];
  const coches = criteres.filter((c) => c.actif);
  console.log(`\nPolitique de prise en charge — ${coches.length} critère(s) coché(s) sur ${criteres.length} :`);
  for (const c of [...coches].sort((a, b) => a.rang - b.rang)) {
    console.log(
      `  rang ${String(c.rang).padStart(2)} · ${CRITERE_LABELS[c.cle] ?? c.cle}` +
        ` — proximité « ${c.proximite} »${c.departage ? " (départage seulement, ne crée pas de file)" : ""}`,
    );
  }
  console.log("  Le rang décide de l'ORDRE DE SERVICE ; la proximité, du droit aux couronnes proches.");
  console.log("  Ni l'un ni l'autre ne permet d'outrepasser le budget de trajet, qui est une contrainte DURE.");

  const trajetNeeds = needs.parTrajet;
  console.log(`\nContrainte de distance — combien de dossiers exigent un hôtel PROCHE :`);
  console.log(
    `  SOUS CONTRAINTE : ${trajetNeeds.contraint.dossiers} dossier(s), ${trajetNeeds.contraint.chambres} chambre(s), ` +
      `${trajetNeeds.contraint.personnes} personne(s) — leur vol suivant borne le temps de trajet`,
  );
  console.log(
    `  LIBRES          : ${trajetNeeds.libre.dossiers} dossier(s), ${trajetNeeds.libre.chambres} chambre(s) — ` +
      `aucun horaire de vol suivant connu. Ce n'est PAS « ils peuvent aller loin », c'est « on ne sait pas ».`,
  );
  if (trajetNeeds.impossible.dossiers) {
    console.log(
      `  IMPOSSIBLES     : ${trajetNeeds.impossible.dossiers} dossier(s), ${trajetNeeds.impossible.personnes} personne(s) — ` +
        `l'hôtel n'a plus de sens, repos côté piste à organiser au desk`,
    );
  }
  if (trajetNeeds.paliers.length) {
    console.log(
      `  paliers de budget : ` +
        trajetNeeds.paliers.map((p) => `<= ${p.trajet_max_min} min -> ${p.chambres} ch. (cumul ${p.cumul.chambres})`).join(" · "),
    );
    console.log(`  budget le plus court : ${needs.total.trajetMinContraint} min — aucune couronne plus lente ne peut les servir.`);
  } else {
    console.log(
      `  AUCUN budget de trajet n'a pu être calculé : la liste ne porte pas d'horaire de vol suivant exploitable ` +
        `(colonnes « vol_correspondance » / « heure_correspondance »).`,
    );
    console.log(`  Les couronnes ci-dessous décrivent la géographie du vivier ; elles ne protégeront AUCUNE correspondance`);
    console.log(`  tant que la compagnie n'aura pas transmis ces horaires.`);
  }

  /* Couronne d'un candidat — MÊME RÈGLE QUE `lib/allocate.mjs` (`distanceMesuree` et
     `couronneDeHotel`), reproduite ici parce qu'elle n'y est pas exportée. Deux pièges
     qu'elle désamorce, et qui sont réels sur l'inventaire BKK livré :
       - `distance_km: null` (4 hôtels sur 9) n'est PAS 0 km ;
       - `distance_km: 0` SANS `distance_ref` (2 hôtels sur 9) veut dire « non mesuré »,
         pas « collé à l'aérogare ».
     Un hôtel de distance non mesurée est rattaché PAR PRUDENCE à la couronne la plus
     lointaine : le supposer proche reviendrait à promettre un temps de trajet sur rien. */
  const refStation = station.search?.distance_ref ?? null;
  const distanceCandidat = (c) => {
    const brute = c.distance_km ?? c.distance_to_airport_km ?? null;
    if (brute === null || brute === undefined || brute === "") return null;
    const d = Number(brute);
    if (!Number.isFinite(d) || d < 0) return null;
    const ref = c.distance_ref ?? null;
    if (d === 0 && !ref) return null;
    if (ref && refStation && ref !== refStation) return null;
    return d;
  };
  const derniere = couronnes[couronnes.length - 1];
  const parCouronne = new Map(couronnes.map((c) => [c.rang, { hotels: 0, chambres: 0, mesures: 0, prudence: 0, horsCouronnes: 0 }]));
  for (const c of candidates) {
    const d = distanceCandidat(c);
    const cr = d === null ? derniere : (couronnes.find((x) => d * 1000 <= x.rayon_m) ?? derniere);
    const e = parCouronne.get(cr.rang);
    e.hotels += 1;
    // même hypothèse de cadrage que `capaciteIndicative` : 9 chambres pour un hôtel sans
    // indice de capacité. C'est une hypothèse, jamais une mesure — et c'est dit.
    const hint = c.capacity_hint?.rooms_displayed_max;
    e.chambres += Number.isFinite(hint) && hint > 0 ? hint : 9;
    if (d === null) e.prudence += 1;
    else {
      e.mesures += 1;
      if (d * 1000 > derniere.rayon_m) e.horsCouronnes += 1;
    }
  }

  console.log(
    `\nLe vivier par couronne — couronnes ${couronnesSource === "declaree" ? "DÉCLARÉES par l'exploitation" : "DÉRIVÉES du rayon (aucune couronne déclarée dans la fiche escale)"} :`,
  );
  for (const cr of couronnes) {
    const e = parCouronne.get(cr.rang);
    console.log(
      `  couronne ${cr.rang} — <= ${Math.round(cr.rayon_m / 1000)} km, ${cr.trajet_min} min DÉCLARÉES en ${cr.mode} : ` +
        `${e.hotels} hôtel(s), ${e.chambres} chambre(s) indicative(s) — ${e.mesures} distance(s) réellement mesurée(s)`,
    );
    if (e.prudence) {
      console.log(
        `      dont ${e.prudence} hôtel(s) à distance NON MESURÉE, rattaché(s) PAR PRUDENCE à la couronne la plus ` +
          `lointaine : ils ne sont PAS réputés proches`,
      );
    }
    if (e.horsCouronnes) {
      console.log(`      dont ${e.horsCouronnes} hôtel(s) mesuré(s) au-delà de la dernière couronne : aucun temps de trajet déclaré ne les couvre`);
    }
    if (cr.note) console.log(`      « ${cr.note} »`);
  }
  console.log("  « indicatif » n'est ni « disponible » ni « mesuré » : seul le relevé du jour engage un stock.");

  console.log(`\nCouronnes qu'il faudra probablement ouvrir :`);
  let cumulOffre = 0;
  let couvertA = null;
  /** Chambres CAPTIVES d'une couronne proche que le vivier proche ne couvre pas. */
  let captifsDecouverts = 0;
  for (const [i, cr] of couronnes.entries()) {
    cumulOffre += parCouronne.get(cr.rang).chambres;
    // ce qui ne peut PAS aller au-delà de cette couronne : les dossiers dont le budget est
    // inférieur au temps déclaré de la couronne SUIVANTE. Contrainte DURE, aucun rang ne
    // permet de l'outrepasser — les éloigner ne les logerait pas, cela leur ferait manquer
    // leur vol.
    const suivante = couronnes[i + 1] ?? null;
    const captifs = suivante ? chambresHorsPortee(needs, suivante.trajet_min) : null;
    const suffit = cumulOffre >= besoinTotal;
    if (suffit && couvertA === null) couvertA = cr.rang;
    if (captifs?.chambres && cumulOffre < captifs.chambres) captifsDecouverts = Math.max(captifsDecouverts, captifs.chambres - cumulOffre);
    console.log(
      `  jusqu'à la couronne ${cr.rang} (${cr.trajet_min} min déclarées) : ${cumulOffre} chambre(s) indicative(s) cumulée(s) ` +
        `pour ${besoinTotal} demandée(s) -> ${suffit ? "suffirait" : "INSUFFISANT"}`,
    );
    if (captifs?.chambres) {
      console.log(
        `      ${captifs.chambres} chambre(s) ne peuvent PAS aller au-delà (budget < ${suivante.trajet_min} min déclarées) : ` +
          (cumulOffre >= captifs.chambres
            ? "le cumul proche les couvre"
            : "LE VIVIER PROCHE NE LES COUVRE PAS — ouvrir une couronne plus lointaine n'y changera rien, il faut des chambres PLUS PROCHES"),
      );
    }
  }
  if (couvertA === null) {
    console.log(
      `  Même en ouvrant TOUTES les couronnes déclarées, le vivier reste sous le besoin (${cumulOffre} chambre(s) pour ` +
        `${besoinTotal}) : élargir la distance ne suffira pas seule, il faut relever d'autres hôtels.`,
    );
  } else if (captifsDecouverts) {
    // un total « couvert » qui masque des dossiers captifs d'une couronne vide serait
    // exactement le chiffre rassurant que ce dry-run existe pour empêcher.
    console.log(
      `  Le VOLUME total serait couvert à partir de la couronne ${couvertA}, mais ce n'est PAS un plan réalisable : ` +
        `${captifsDecouverts} chambre(s) manquent dans les couronnes PROCHES, pour des dossiers qui ne peuvent pas aller`,
    );
    console.log(`  plus loin sans manquer leur vol suivant. Élargir la distance ne les logera pas.`);
  } else {
    console.log(`  Le besoin TOTAL serait couvert à partir de la couronne ${couvertA} — sous réserve du relevé du jour.`);
  }
  if (policy.global.prise_en_charge?.elargir_si_insuffisant === false) {
    console.log("  ATTENTION : « élargir si insuffisant » est DÉSACTIVÉ dans la politique — le run escaladera au lieu d'ouvrir une couronne plus lointaine.");
  }
  for (const a of avertissementsDe(dossiers)) console.log(`  ⚠ ${a.message ?? a}`);

  console.log(`\nRelevés étage B (${Math.min(maxB, candidates.length)} premiers sur ${candidates.length} candidats) :`);
  for (const c of candidates.slice(0, 5)) {
    console.log(`  - ${c.name}${c.fallback ? " [repli]" : ""} (tiers ${c.tiers.join("/")})`);
    console.log(`    ${c.url ? buildHotelUrl(c.url, { checkin, checkout }) : "(pas d'URL : recherche par nom)"}`);
  }

  // plan d'extension théorique : tout manque (aucun relevé encore fait)
  const gaps = { chambresManquantes: Object.fromEntries(["J", "W", "Y"].map((t) => [t, needs.parTier[t]?.chambres ?? 0])) };
  const surveyed = new Set(candidates.slice(0, maxB).map((c) => c.id));
  const theorique = planExtension({
    gaps, inventories: [], candidates, surveyedKeys: surveyed, probedKeys: new Set(),
    policy, station, wave: 1, sessionsUsed: 0, costUsd: 0,
  });
  console.log(`\nPlan d'extension théorique (vague 1, si tout manquait après l'étage B) :`);
  console.log(`  bornes : ${theorique.limits.sessions_max} sessions · ${theorique.limits.max_waves} vagues · ${theorique.limits.cost_max} $` + ` · ${theorique.limits.minutes_max ?? "—"} min d'horloge · sonde d'abord : ${policy.extension.probe_same_hotel_first ? "oui (H-3)" : "non"}`);
  if (theorique.stop) console.log(`  → ${theorique.reason}`);
  else console.log(`  → sondes : ${theorique.probes.length} (aucun relevé encore fait) · relevés supplémentaires : ${theorique.surveys.map((s) => s.name).join(", ") || "aucun"}`);

  /* --- C5 : combien de temps, d'après ce qui a été MESURÉ ------------------- */
  const concurrence = resolveConcurrency(policy);
  const sessionsSocle = (decision.run ? 1 : 0) + Math.min(maxB, candidates.length);
  const sessionsPlafond = sessionsSocle + policy.extension.max_sessions_per_run;
  const budgetMin = policy.extension.max_minutes_per_run;
  const fourchette = (sessions) => {
    const minutes = MESURES_REELLES.map((m) => Math.round(((sessions / concurrence) * (m.secondes * m.concurrence)) / m.sessions / 60));
    return { bas: Math.min(...minutes), haut: Math.max(...minutes) };
  };
  const fSocle = fourchette(sessionsSocle);
  const fPlafond = fourchette(sessionsPlafond);
  console.log(`\nDurée ESTIMÉE (C5) — une estimation, pas un engagement :`);
  console.log(`  socle : ${sessionsSocle} session(s) à concurrence ${concurrence} → ~${fSocle.bas} à ${fSocle.haut} min`);
  console.log(`  plafond : ${sessionsPlafond} session(s) (socle + ${policy.extension.max_sessions_per_run} d'extension) → ~${fPlafond.bas} à ${fPlafond.haut} min`);
  console.log(`  budget horloge du run : ${budgetMin} min (policy.extension.max_minutes_per_run) — l'extension s'arrête à l'échéance`);
  if (fPlafond.haut > budgetMin) console.log(`  ⚠ au plafond de sessions, l'estimation haute (${fPlafond.haut} min) dépasse le budget : le run sera coupé par l'horloge avant d'avoir tout relevé.`);
  if (fPlafond.haut > 60) console.log("  ⚠ l'estimation haute dépasse l'heure visée par la compagnie (C5).");
  console.log(`  base : ${MESURES_REELLES.map((m) => `${m.ref} — ${m.sessions} sessions en ${m.secondes} s à concurrence ${m.concurrence}`).join(" ; ")}.`);
  console.log("  Ces deux mesures viennent d'une seule escale (BKK) et de deux journées : rien n'a été mesuré");
  console.log("  sur cette escale, ce volume ni cette concurrence. Le temps humain de validation n'y est pas compté.");

  console.log(`\nAvant un run payant, le pré-vol HTTP des fiches d'inventaire est gratuit :`);
  console.log(`  node hai-admin-mcp/tools/inventaire.mjs --station ${station.code} --preflight`);

  console.log("\nDry-run : aucun agent, aucun réseau, aucune écriture.");
  process.exit(0);
}

/* ------------------------------------------------- livrables du run (C3, §8) */

/**
 * Fiches d'enregistrement par passager (C3) — 8e livrable du run, au format de la
 * chambre affectée. Le pipeline peut déjà les porter (`outputs.fichesCsv` /
 * `outputs.fichesHtml`, contrat de vague 1) ; sinon la CLI les construit ici depuis
 * les MÊMES entrées, sans rien réinventer.
 *
 * Aucune de ces données ne part vers un agent (INV-5) : elles sont écrites sur le
 * disque du poste et détruites selon `policy.retention`.
 *
 * Cette fonction est appelée AVANT la boucle d'écriture : une exception ici ferait
 * perdre les six livrables d'un run PAYANT déjà consommé. Elle échoue donc à vide,
 * en NOMMANT l'échec — le run garde son plan, et l'opérateur sait qu'il lui manque
 * les fiches et pourquoi. Un silence, lui, ferait croire à un run complet.
 *
 * @param {object} result sortie de `runPipeline`
 * @returns {Array<[string, string]>} paires [nom de fichier, contenu] ; vide si l'échec
 */
function livrablesFiches(result) {
  try {
    return construireFiches(result);
  } catch (e) {
    console.error(`[fiches] ÉCHEC de la construction des fiches d'enregistrement : ${e.message}`);
    console.error("[fiches] les 6 autres livrables du run sont écrits ; C3 n'a PAS de livrable pour ce run.");
    console.error("[fiches] rejouer les fiches hors ligne depuis out/releves-<run>.json ne coûte aucune session.");
    return [];
  }
}

/** Construction proprement dite — voir `livrablesFiches`, qui en tient l'échec. */
function construireFiches(result) {
  const noms = fichesFileNames(result.runId);
  if (result.outputs?.fichesCsv && result.outputs?.fichesHtml) {
    // chemin normal : le pipeline les a construites AVANT le rapport, qui les compte donc.
    // On répète ici le décompte à l'écran — l'opérateur voit ce qui part en blanc.
    const r = result.fiches?.resume;
    if (r) {
      console.log(
        `[fiches] ${r.fiches} fiche(s) — ${r.logees} avec hôtel, ${r.non_logees} au comptoir, ` +
          `${r.incompletes} à identité incomplète (blancs à remplir passeport en main)`,
      );
    }
    return [[noms.csv, result.outputs.fichesCsv], [noms.html, result.outputs.fichesHtml]];
  }
  // `runPipeline` normalise sa copie des lignes passagers sans la rendre : on refait
  // ici exactement le même passage, pour que les fiches portent les mêmes personnes.
  const canoniques = ingestion ? rows : splitPaxRows(normalizePaxRows(rows).rows).pax;
  const ctx = {
    runId: result.runId,
    station,
    checkin: result.checkin ?? checkin,
    checkout: result.checkout ?? checkout,
    nights: scenario.nights,
  };
  const built = buildFiches({
    ...ctx,
    plan: result.alloc?.plan ?? [],
    rows: canoniques,
    dossiers: result.dossiers ?? null,
    policy,
    // C7 : le montant vient de `carteLigne`, jamais d'un calcul refait ici. Une ligne
    // sans montant chiffrable rend null — la fiche portera « [à remplir] », pas un chiffre inventé.
    montantCartePar: (planRow) => {
      const carte = carteLigne(planRow, policy, { nights: ctx.nights });
      if (!carte || carte.montant_par_carte === null) return null;
      // La colonne de la fiche s'appelle `montant_carte_eur` et s'imprime « (EUR) ».
      // `carteLigne` peut rendre une carte libellée dans la devise du relevé (chambre en
      // THB sans indemnité chiffrée) : livrer le nombre nu ferait lire 3500 THB comme
      // 3500 EUR au comptoir. Aucune conversion n'est faite ici — il n'y a pas de taux
      // dans l'outil et en inventer un serait pire que de dire la devise.
      const reference = policy.global?.currency ?? "EUR";
      const reserves = [];
      if (carte.devise !== reference) reserves.push(`carte libellée en ${carte.devise}, NON convertie`);
      if (carte.motifs.includes("devise_non_affichee")) reserves.push(`devise du relevé non affichée, montant SUPPOSÉ en ${reference}`);
      // `incomplet` : au moins un poste n'a pas pu être chiffré. Le montant existe mais ne
      // couvre pas tout ; le taire chargerait une carte insuffisante sans jamais le dire,
      // et la note « montant non calculé » de la fiche ne s'affiche plus dès qu'il y a un chiffre.
      const manquants = [...carte.postes_non_renseignes, ...carte.postes_non_convertibles];
      if (manquants.length) reserves.push(`PARTIEL — poste(s) non chiffré(s) : ${manquants.join(", ")}`);
      else if (carte.incomplet) reserves.push("PARTIEL — montant incomplet, voir le fichier coût du run");
      if (carte.plafond_depasse) reserves.push(`au-dessus du plafond de carte (${carte.plafond_eur} ${reference})`);
      if (carte.cartes === 1 && Number(planRow.pax) > 1) reserves.push("carte unique du dossier");
      const valeur = carte.devise === reference ? carte.montant_par_carte : `${carte.montant_par_carte} ${carte.devise}`;
      return reserves.length ? `${valeur} (${reserves.join(" ; ")})` : valeur;
    },
  });
  for (const a of built.avertissements) console.log(`[fiches] ${a}`);
  const r = built.resume;
  console.log(
    `[fiches] ${r.fiches} fiche(s) — ${r.logees} avec hôtel, ${r.non_logees} au comptoir, ` +
      `${r.incompletes} à identité incomplète (blancs à remplir passeport en main)`,
  );
  return [
    [noms.csv, buildFichesCsv(built.fiches)],
    [noms.html, buildFichesHtml(built.fiches, { ...ctx, vol: "", resume: r, avertissements: built.avertissements })],
  ];
}

/* ---------------------------------------------------------------- offline */

const offline = opt("offline", null);
if (offline) {
  const file = path.resolve(offline);
  if (!fs.existsSync(file)) throw new Error(`Fixtures introuvables : ${file}`);
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(records)) throw new Error(`${offline} : un tableau de relevés est attendu`);

  const emit = mkEmitter({ run_id: null }, (ev) => {
    if (["phase", "warning", "inventory_status", "extension", "done"].includes(ev.type)) {
      const d = ev.data;
      if (ev.type === "phase") console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.wave ? ` vague ${d.wave}` : ""}`);
      else if (ev.type === "warning") console.log(`[warn ] ${d.message}`);
      else if (ev.type === "inventory_status") console.log(`[inv  ] ${d.station} : ${d.hotels_count} hôtel(s), périmé ${d.stale ? "oui" : "non"}, utilisé ${d.used ? "oui" : "non"}`);
      else if (ev.type === "extension") console.log(`[ext  ] vague ${d.wave} : ${d.reason} — sondes ${d.planned.probes}, relevés ${d.planned.surveys} (sessions ${d.limits.sessions_used}/${d.limits.sessions_max})`);
      else if (ev.type === "done") console.log(`[done ] OK ${d.ok} · escalade ${d.escalade} · sessions ${d.sessions_used ?? "non rapporté"} · coût ${d.cost_usd === null || d.cost_usd === undefined ? "NON MESURÉ" : `${d.cost_usd} $`}`);
    }
  });

  const result = await runPipeline({
    policy, station, scenario, avion, rows, ingestion,
    emit, collect: fixturesCollect(records),
  });

  // construites AVANT d'écrire : leurs avertissements précèdent la liste des fichiers
  const fiches = livrablesFiches(result);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const w = (name, content) => {
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, content, "utf8");
    console.log(`écrit ${path.relative(ROOT, p)}`);
  };
  w(`plan-${result.runId}.csv`, result.outputs.planCsv);
  w(`rapport-${result.runId}.md`, result.outputs.rapportMd);
  w(`messages-${result.runId}.csv`, result.outputs.messagesCsv);
  w(`rooming-${result.runId}.csv`, result.outputs.roomingCsv);
  w(`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n");
  w(`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n");
  for (const [nom, contenu] of fiches) w(nom, contenu);

  console.log(`\nRejeu hors ligne terminé : ${result.alloc.summary.ok} dossiers logés, ${result.alloc.summary.escalade} en escalade — coût agents : 0,00 $ (aucune session lancée).`);
  // compté, jamais affirmé : si les fiches ont échoué, il y en a 6 et le dire est le minimum
  console.log(`Ces ${6 + fiches.length} fichiers sont un PLAN à faire valider : aucune chambre n'est réservée (INV-1).`);
  process.exit(0);
}

/* ------------------------------------- modes payants (derrière DEMO_ALLOW_PAID) */
/* Probes phase 5 (CDC §12.1) : chaque probe archive un fichier out/*-{runId}.json
 * VALIDÉ contre son schéma, imprime le flux pensées/captures et un bilan mesuré
 * (durée, steps, coût, files/429) pour ETAT.md et CDC §13. */

if (PAID_FLAGS.some((f) => flag(f))) {
  const { createClient, apiOrigin, readApiKey, discoverySchema, releveSchema, probeSchema } = await import("../lib/hai.mjs");

  /* --probe-inventaire : Étage 0 limité, délégué à l'outil dédié (même code que la fiche) */
  if (flag("probe-inventaire")) {
    const args = [
      path.join(ROOT, "hai-admin-mcp", "tools", "inventaire.mjs"),
      "--station", station.code, "--refresh", "--max", opt("max", "10"),
      "--nights", String(scenario.nights),
      ...(opt("checkin", null) ? ["--checkin", opt("checkin", null)] : []),
    ];
    const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
    process.exit(r.status ?? 1);
  }

  const runId = newRunId();
  const groupId = `${station.code.toLowerCase()}-v2-${checkin}-${runId}`;
  const t0 = Date.now();
  const captures = []; // {hotel_key, seq, source, imageType, mediaType} — téléchargées en fin de probe
  const metricsByKey = new Map(); // hotel_key → dernier {steps, cost_usd, tokens}
  let queue429 = 0;

  const emit = mkEmitter({ run_id: runId }, (ev) => {
    const d = ev.data;
    const key = ev.hotel_key ?? "?";
    switch (ev.type) {
      case "phase":
        console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.done ? ` — terminé (${d.count} candidats)` : ""}`);
        break;
      case "agent_status":
        if (d.status) console.log(`[agent] ${key} : ${d.status}${d.live_view_url ? ` — vue live : ${d.live_view_url}` : ""}`);
        else if (d.live_view_url) console.log(`[agent] ${key} — vue live : ${d.live_view_url}`);
        break;
      case "agent_thought":
        console.log(`[pensée] ${key} : ${d.text}`);
        break;
      case "screenshot": {
        const seq = captures.filter((c) => c.hotel_key === key).length;
        captures.push({ hotel_key: key, seq, source: d.source, imageType: d.imageType ?? null, mediaType: d.mediaType ?? "image/png" });
        console.log(`[capture] ${key} #${seq} (${d.imageType ?? "url"})`);
        break;
      }
      case "candidate":
        console.log(`[cand ] ${d.name} (${d.stars ?? "?"}★, ${d.review_score ?? "?"}/10, à partir de ${d.price_from_per_night ?? "?"} EUR)`);
        break;
      case "metrics":
        if (ev.hotel_key) metricsByKey.set(key, d);
        break;
      case "probe":
        console.log(`[sonde] ${d.hotel} : ${d.status}${d.result ? ` — max sélectionnable ${d.result.rooms_available_max}, plafonné ${d.result.cap_reached}` : ""}`);
        break;
      case "warning":
        console.log(`[warn ] ${d.message}`);
        if (/429|rate.?limit|file d'attente|queue/i.test(d.message)) queue429 += 1;
        break;
      case "error":
        console.log(`[erreur] ${d.message}`);
        break;
      default:
        break;
    }
  });

  /** Bilan mesuré du probe (ETAT.md / CDC §13). */
  function bilan(label) {
    const duration_s = Math.round((Date.now() - t0) / 1000);
    let cost_usd = 0, steps = 0, tokens = 0;
    for (const m of metricsByKey.values()) {
      cost_usd = cost_usd === null || m.cost_usd === null || m.cost_usd === undefined ? null : cost_usd + m.cost_usd;
      steps += m.steps ?? 0;
      tokens += m.tokens ?? 0;
    }
    cost_usd = cost_usd === null ? null : Math.round(cost_usd * 10000) / 10000;
    console.log(`\n${label} — durée ${duration_s} s · ${metricsByKey.size} session(s) · ${steps} steps · ${cost_usd === null ? "coût NON MESURÉ" : `${cost_usd} $`} · files/429 : ${queue429}`);
    return { duration_s, sessions: metricsByKey.size, steps, tokens, cost_usd, queue_or_429: queue429 };
  }

  /** Télécharge les captures relevées (bearer vers l'origine API H uniquement, INV-4). */
  async function saveCaptures(dir) {
    if (!captures.length) return 0;
    fs.mkdirSync(dir, { recursive: true });
    const origin = new URL(apiOrigin()).origin;
    let saved = 0;
    for (const c of captures) {
      try {
        const src = String(c.source ?? "");
        let buf = null;
        let ext = String(c.mediaType ?? "").includes("jpeg") ? ".jpg" : ".png";
        if (c.imageType === "base64" && !src.startsWith("data:")) {
          buf = Buffer.from(src, "base64");
        } else if (src.startsWith("data:")) {
          const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
          if (!m) continue;
          buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
        } else if (/^https:\/\//.test(src)) {
          const r = await fetch(src, new URL(src).origin === origin ? { headers: { Authorization: `Bearer ${readApiKey()}` } } : undefined);
          if (!r.ok) continue;
          buf = Buffer.from(await r.arrayBuffer());
          if ((r.headers.get("content-type") ?? "").includes("jpeg")) ext = ".jpg";
        } else {
          continue;
        }
        fs.writeFileSync(path.join(dir, `${c.hotel_key.replace(/[^a-z0-9_-]/gi, "_")}-${String(c.seq).padStart(2, "0")}${ext}`), buf);
        saved += 1;
      } catch {
        /* capture manquée : sans gravité, le flux a déjà été journalisé */
      }
    }
    if (saved) console.log(`captures enregistrées : ${saved} → ${path.relative(ROOT, dir)}/`);
    return saved;
  }

  const writeOut = (name, obj) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
    console.log(`écrit ${path.relative(ROOT, p)}`);
  };

  /* ---------------------------------------------------------- --probe-discovery */
  if (flag("probe-discovery")) {
    console.log(`Probe découverte — ${station.code}, séjour ${checkin} → ${checkout}, runId ${runId} (~0,21 $ attendu)`);
    const client = createClient();
    const disc = await runDiscovery({ client, policy, station, checkin, checkout, groupId, emit });
    const mesures = bilan("Découverte");
    const v = disc.flat ? discoverySchema.safeParse(disc.flat) : { success: false, error: { issues: [{ path: [], message: "réponse absente" }] } };
    if (!v.success) console.log(`⚠ réponse plate NON conforme au discoverySchema : ${v.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ")}`);
    writeOut(`candidats-${runId}.json`, {
      runId, kind: "probe-discovery", station: station.code, checkin, checkout, groupId,
      sessionId: disc.sessionId, status: disc.status, outcome: disc.outcome,
      currency: disc.currency, notes: disc.notes, schema_valid: v.success,
      answer: disc.flat, candidates: disc.candidates, mesures,
    });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    console.log(`\n${disc.candidates.length} candidat(s), devise ${disc.currency}, schéma ${v.success ? "valide" : "NON valide"}.`);
    process.exit(disc.candidates.length && v.success ? 0 : 1);
  }

  /* ------------------------------------------------------------- --probe-releve n */
  if (flag("probe-releve")) {
    const n = Number(opt("probe-releve", "1"));
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      console.error(`--probe-releve attend un entier de 1 à 5 (reçu : ${opt("probe-releve", "1")})`);
      process.exit(1);
    }
    const inv = loadInventaire(station.code);
    const dossiers = buildDossiers(rows, policy);
    const needs = computeNeeds(dossiers);
    const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier }).filter((c) => c.url); // navigation directe
    const selection = candidates.slice(0, n).map((c) => ({ candidate: c, tiers: c.tiers }));
    if (!selection.length) {
      console.error("aucun candidat avec URL dans l'inventaire — lancer d'abord la découverte ou l'inventaire Étage 0");
      process.exit(1);
    }
    console.log(`Probe relevés — ${selection.length} session(s) sur : ${selection.map((s) => s.candidate.name).join(", ")} (~0,30 $/session attendu)`);
    const client = createClient();
    const records = await runReleves({ client, policy, station, selection, substitutes: {}, checkin, checkout, groupId, emit });
    const mesures = bilan("Relevés");
    let allValid = records.length > 0;
    for (const r of records) {
      const v = r.flat ? releveSchema.safeParse(r.flat) : { success: false };
      if (!v.success) {
        allValid = false;
        console.log(`⚠ ${r.name} : réponse absente ou non conforme au releveSchema`);
      }
      console.log(
        `- ${r.name} : ${r.status}` +
          (r.answer?.found
            ? ` — ${r.answer.rooms.length} type(s) de chambre, prépaiement ${r.answer.payment?.prepayment_online ?? "?"}`
            : " — found=false") +
          ` (${r.steps ?? 0} steps, ${r.costUsd ?? 0} $)`,
      );
    }
    writeOut(`releves-${runId}.json`, records); // format fixtures : rejouable par --offline
    writeOut(`releves-${runId}.mesures.json`, { runId, kind: "probe-releve", n: records.length, groupId, mesures });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    process.exit(allValid ? 0 : 1);
  }

  /* -------------------------------------------- --probe-capacity <url> --rooms n */
  if (flag("probe-capacity")) {
    const capUrl = opt("probe-capacity", null);
    const roomsN = Number(opt("rooms", "12"));
    if (!capUrl || !/^https:\/\/www\.booking\.com\/hotel\//.test(capUrl)) {
      console.error("--probe-capacity attend une URL de fiche Booking (https://www.booking.com/hotel/...)");
      process.exit(1);
    }
    if (!Number.isInteger(roomsN) || roomsN < 2 || roomsN > 50) {
      console.error(`--rooms attend un entier de 2 à 50 (reçu : ${opt("rooms", "12")})`);
      process.exit(1);
    }
    const hotelKey = slugify(new URL(capUrl).pathname.split("/").pop().replace(/\.[a-z.]+$/i, "")) || "sonde";
    const probe = { hotelKey, name: hotelKey, url: capUrl, requested_rooms: roomsN };
    console.log(`Sonde de capacité (H-3) — ${roomsN} chambres (${2 * roomsN} adultes), runId ${runId} (~0,15 $ attendu)`);
    console.log(`URL sonde : ${buildProbeUrl(capUrl, { checkin, checkout, noRooms: roomsN })}`);
    const client = createClient();
    const answer = await runProbe({ client, policy, station, probe, checkin, checkout, groupId, emit });
    const mesures = bilan("Sonde");
    const v = answer ? probeSchema.safeParse(answer) : { success: false };
    // H-3 : concluante si la page a affiché une disponibilité LISIBLE pour ce volume
    const conclusive = Boolean(answer?.found && answer.rooms_selectable_max >= 0);
    const h3 = {
      conclusive,
      verdict: !conclusive
        ? "non concluant : disponibilité illisible à ce volume → probe_same_hotel_first = false (extension par candidats suivants seulement)"
        : answer.rooms_selectable_max > 9
          ? `concluant : ${answer.rooms_selectable_max} chambres lisibles au-delà du plafond d'affichage (9) → sonde conservée`
          : `lisible mais borné à ${answer.rooms_selectable_max} (≤ 9) : la sonde n'apporte rien au-delà du relevé → à trancher avec notes`,
    };
    writeOut(`probe-${runId}.json`, {
      runId, kind: "probe-capacity", station: station.code, checkin, checkout, groupId,
      url: capUrl, probe_url: buildProbeUrl(capUrl, { checkin, checkout, noRooms: roomsN }),
      requested_rooms: roomsN, schema_valid: v.success, answer, h3, mesures,
    });
    await saveCaptures(path.join(OUT_DIR, `captures-${runId}`));
    console.log(`\nH-3 : ${h3.verdict}`);
    process.exit(answer && v.success ? 0 : 1);
  }
}

// Run complet PAYANT (phases 5-6) : sessions réelles via realCollect.
const { createClient } = await import("../lib/hai.mjs");
const { realCollect } = await import("../lib/pipeline.mjs");
const emit = mkEmitter({ run_id: null }, (ev) => {
  const d = ev.data;
  if (ev.type === "phase") console.log(`[phase] ${d.phase}${d.reason ? ` (${d.reason})` : ""}${d.wave ? ` vague ${d.wave}` : ""}`);
  else if (ev.type === "warning") console.log(`[warn ] ${d.message}`);
  else if (ev.type === "extension") console.log(`[ext  ] vague ${d.wave} : sondes ${d.planned.probes}, relevés ${d.planned.surveys} (sessions ${d.limits.sessions_used}/${d.limits.sessions_max}, coût ${d.limits.cost_usd === null || d.limits.cost_usd === undefined ? "NON MESURÉ" : d.limits.cost_usd}/${d.limits.cost_max} $)`);
  else if (ev.type === "agent_status" && d.status) console.log(`[agent] ${ev.hotel_key ?? "?"} : ${d.status}`);
  else if (ev.type === "done") console.log(`[done ] OK ${d.ok} · escalade ${d.escalade} · sessions ${d.sessions_used ?? "non rapporté"} · coût ${d.cost_usd === null || d.cost_usd === undefined ? "NON MESURÉ" : `${d.cost_usd} $`}`);
});
const client = createClient();
const result = await runPipeline({ client, policy, station, scenario, avion, rows, ingestion, emit });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, content] of [
  [`plan-${result.runId}.csv`, result.outputs.planCsv],
  [`rapport-${result.runId}.md`, result.outputs.rapportMd],
  [`messages-${result.runId}.csv`, result.outputs.messagesCsv],
  [`rooming-${result.runId}.csv`, result.outputs.roomingCsv],
  [`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n"],
  [`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n"],
  ...livrablesFiches(result),
]) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, "utf8");
  console.log(`écrit out/${name}`);
}
