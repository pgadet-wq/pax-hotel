/**
 * Regroupement des passagers par dossier (PNR), tiers et overlays.
 *
 * La CABINE est le tier de la politique (J/W/Y) ; Flying Blue ne joue que sur
 * l'ordre de service intra-tier ; PMR et famille sont des overlays cumulables qui
 * ajoutent des contraintes sans changer le tier (EX-POL-2).
 */

import { paxIsPmr, paxEscalade, paxAnimal, parseSsr, ssrNotes } from "./paxlist.mjs";

const FB_RANK = { PLATINUM: 3, GOLD: 2, SILVER: 1, NONE: 0 };
const CABIN_RANK = { J: 2, W: 1, Y: 0 };
const DROIT_RANK = { NON: 2, INCONNU: 1, OUI: 0 };

/**
 * @param {Array<object>} rows lignes CSV passagers
 * @param {object} policy politique validée (rooming + priorités)
 * @returns {Array<object>} dossiers triés dans l'ordre de traitement
 */
export function buildDossiers(rows, policy) {
  const rooming = policy.global.rooming;
  const byPnr = new Map();
  for (const r of rows) {
    if (!byPnr.has(r.pnr)) byPnr.set(r.pnr, []);
    byPnr.get(r.pnr).push(r);
  }

  const dossiers = [];
  for (const [pnr, pax] of byPnr) {
    const adults = pax.filter((p) => p.type_pax === "ADT").length;
    const children = pax.filter((p) => p.type_pax === "CHD").length;
    const infants = pax.filter((p) => p.type_pax === "INF").length;
    // PMR : tout code SSR d'assistance déclencheur (WCHR/WCHS/WCHC/WCBD/WCBW/WCMP/BLND/DEAF/DPNA),
    // pas le seul littéral « WCHR » — voir lib/paxlist.mjs
    const pmr = pax.some(paxIsPmr);
    const cabin = pax.reduce((m, p) => (CABIN_RANK[p.cabine] > CABIN_RANK[m] ? p.cabine : m), "Y");
    const fb = pax.reduce((m, p) => (FB_RANK[p.flying_blue] > FB_RANK[m] ? p.flying_blue : m), "NONE");
    const famille = children + infants > 0;
    const animal = pax.some(paxAnimal);
    const groupe = pax.map((p) => p.groupe).find(Boolean) ?? "";
    // hors plan hôtel : traitement nominatif au desk (civière, médical, mineur non accompagné)
    const escaladeNominative = pax.map(paxEscalade).find(Boolean) ?? null;
    // droit d'entrée sur le territoire de l'escale : le plus contraignant du dossier
    const droitEntree = pax.reduce((m, p) => (DROIT_RANK[p.droit_entree] > DROIT_RANK[m] ? p.droit_entree : m), "OUI");
    const ssr = [...new Set(pax.flatMap((p) => p.ssr ?? parseSsr(p.assistance)))];

    // chambrage : `chambres_demandees` de la liste fait foi (familles nombreuses, groupes,
    // PMR à chambre individuelle) ; sinon unité familiale jusqu'à family_unit_max, sinon
    // 2 chambres même hôtel. Les nourrissons ne consomment pas de capacité.
    // plusieurs valeurs sous un même PNR : on retient le MAXIMUM (ne jamais sous-loger) ;
    // la contradiction est signalée par le rapport d'ingestion
    const demandesPnr = pax.map((p) => Number(p.chambres_demandees)).filter((n) => Number.isInteger(n) && n > 0);
    const demandees = demandesPnr.length ? Math.max(...demandesPnr) : null;
    let rooms;
    let familyUnit = false;
    if (demandees) {
      rooms = demandees;
      familyUnit = demandees === 1 && children > 0;
    } else if (children > 0) {
      const max = rooming.family_unit_max;
      if (adults <= max.adults && children <= max.children) {
        rooms = 1;
        familyUnit = true;
      } else rooms = 2;
    } else rooms = Math.max(1, Math.ceil(adults / 2));

    dossiers.push({
      pnr,
      occupants: pax.map((p) => `${p.prenom} ${p.nom}${p.type_pax !== "ADT" ? ` (${p.type_pax})` : ""}`).join(", "),
      adults,
      children,
      infants,
      cabin,
      fb,
      overlays: { pmr, famille, groupe: Boolean(groupe), animal },
      familyUnit,
      rooms,
      roomsSource: demandees ? "liste" : "calcul",
      groupe,
      escaladeNominative,
      droitEntree,
      ssrNotes: ssrNotes(ssr),
    });
  }

  // file de priorité : pmr → famille → J → W → Y (ordre de policy.global.priorities) ;
  // intra-file : Flying Blue décroissant puis taille du dossier décroissante
  const priorities = policy.global.priorities;
  const fileOf = (d) => (d.overlays.pmr ? "pmr" : d.overlays.famille ? "famille" : d.cabin);
  dossiers.sort((a, b) => {
    const fa = priorities.indexOf(fileOf(a));
    const fb2 = priorities.indexOf(fileOf(b));
    if (fa !== fb2) return fa - fb2;
    if (FB_RANK[b.fb] !== FB_RANK[a.fb]) return FB_RANK[b.fb] - FB_RANK[a.fb];
    return b.adults + b.children - (a.adults + a.children);
  });
  for (const d of dossiers) d.file = fileOf(d);
  return dossiers;
}

/** Besoins agrégés en chambres, par file de priorité et par tier. */
export function computeNeeds(dossiers) {
  const parFile = {};
  const parTier = {};
  for (const d of dossiers) {
    parFile[d.file] ??= { dossiers: 0, chambres: 0 };
    parFile[d.file].dossiers += 1;
    parFile[d.file].chambres += d.rooms;
    parTier[d.cabin] ??= { dossiers: 0, chambres: 0 };
    parTier[d.cabin].dossiers += 1;
    parTier[d.cabin].chambres += d.rooms;
  }
  return { parFile, parTier };
}
