/**
 * Regroupement des passagers par dossier (PNR), tiers et overlays.
 *
 * La CABINE est le tier de la politique (J/W/Y) ; Flying Blue ne joue que sur
 * l'ordre de service intra-tier ; PMR et famille sont des overlays cumulables qui
 * ajoutent des contraintes sans changer le tier (EX-POL-2).
 */

const FB_RANK = { PLATINUM: 3, GOLD: 2, SILVER: 1, NONE: 0 };
const CABIN_RANK = { J: 2, W: 1, Y: 0 };

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
    const pmr = pax.some((p) => p.assistance === "WCHR");
    const cabin = pax.reduce((m, p) => (CABIN_RANK[p.cabine] > CABIN_RANK[m] ? p.cabine : m), "Y");
    const fb = pax.reduce((m, p) => (FB_RANK[p.flying_blue] > FB_RANK[m] ? p.flying_blue : m), "NONE");
    const famille = children + infants > 0;

    // chambrage : unité familiale jusqu'à family_unit_max, sinon 2 chambres même hôtel ;
    // les nourrissons ne consomment pas de capacité (rooming.infants_no_capacity)
    let rooms;
    let familyUnit = false;
    if (children > 0) {
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
      overlays: { pmr, famille },
      familyUnit,
      rooms,
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
