/**
 * Étage A — Découverte dynamique par zone (CDC §6.2).
 * Une session unique, deux à trois passes de recherche (socle, premium, et PMR quand
 * l'overlay d'accessibilité l'exige) par édition d'URL `nflt` ; lecture des cartes de
 * résultats uniquement ; retry × 1 ; repli sur les `fallback_hotels` de la fiche escale
 * (déjà servis par candidatesFrom).
 *
 * NB méthode : les probes du 11/09 ont montré qu'une URL de résultats ouverte à
 * froid est rejetée (errorc_searchstring_not_found, dest_id de session manquant).
 * La méthode fiable — recherche manuelle PUIS ajout de `&nflt=` sur l'URL de
 * résultats — remplace donc le `start_url` par overrides évoqué au CDC §6.2
 * (écart documenté dans ETAT.md).
 *
 * COURONNES — une session de découverte travaille sur UNE couronne de la fiche escale :
 * ses trois passes portent le `rayon_m` de cette couronne, et les candidats qu'elle
 * ramène sont marqués de son rang (`candidate.couronne`). Ce marquage est la source la
 * PLUS FIABLE dont dispose l'allocation, devant `distance_km` — nulle ou fausse sur 6 des
 * 9 hôtels de l'inventaire BKK. Le `trajet_min` d'une couronne est DÉCLARÉ par
 * l'exploitation, jamais mesuré : il n'entre dans aucun filtre et ne se déduit d'aucune
 * distance.
 *
 * Élargir coûte une session d'agent ET éloigne des passagers : `discoveryNeeded` juge la
 * couverture COURONNE PAR COURONNE pour ne jamais ouvrir une couronne dont les chambres
 * ne serviraient à personne.
 */
import {
  agentNameV2, ensureAgentV2, buildNflt, buildSearchUrl, discoverySchema,
  toDiscoveryCandidates, promptDiscovery, pumpToCompletion, budgetRestantMs,
} from "./hai.mjs";
import { couronnesRecherche } from "./hai-urls.mjs";
import { couronnesDe } from "./stations.mjs";
import { chambresHorsPortee } from "./dossiers.mjs";
import { isStale, candidatesFrom, slugify, capaciteIndicative } from "./inventaire.mjs";
import { MIN_DEMARRAGE_MS } from "./releve.mjs";

/** Budget serveur d'une session de découverte (s) — deux à trois passes de recherche. */
export const DISCOVERY_MAX_TIME_S = 800;

/** Badge que l'agent pose sur un candidat vu dans la passe PMR (convention de prompt). */
export const BADGE_PMR = "PMR";

/* ------------------------------------------------------------- couronnes */

/**
 * Distance à l'aéroport RÉELLEMENT MESURÉE d'une entrée d'inventaire, en km, ou `null`.
 *
 * MÊME RÈGLE que `distanceMesuree` dans `lib/allocate.mjs`, appliquée ici aux ENTRÉES
 * d'inventaire (avant relevé) : les deux modules doivent ranger un hôtel dans la même
 * couronne, sinon la découverte va chercher des chambres que l'allocation refusera.
 *  - `null`, `""` et une valeur négative signifient « non affichée », pas « à l'aéroport » ;
 *  - un `0` SANS `distance_ref` portée par l'entrée signifie « non mesuré » (2 des 9
 *    hôtels de `data/inventaire/BKK.json` sont dans ce cas) ;
 *  - une distance relevée depuis une AUTRE référence que celle de la fiche escale n'est
 *    pas comparable aux couronnes et n'est pas retenue.
 * @returns {number|null}
 */
function distanceMesureeEntree(entry, refStation) {
  const brute = entry?.distance_km ?? null;
  if (brute === null || brute === undefined || brute === "") return null;
  const d = Number(brute);
  if (!Number.isFinite(d) || d < 0) return null;
  const ref = entry?.distance_ref ?? null;
  if (d === 0 && !ref) return null;
  if (ref && refStation && ref !== refStation) return null;
  return d;
}

/**
 * Couronne d'un candidat / d'une entrée d'inventaire, par ordre de FIABILITÉ
 * DÉCROISSANTE — même hiérarchie que `lib/allocate.mjs` :
 *  a. `couronne` posée par la passe de recherche qui l'a trouvé ;
 *  b. sa distance, quand c'est une vraie mesure ;
 *  c. sinon la RÈGLE DE PRUDENCE : rattaché à la couronne la plus LOINTAINE. Un hôtel
 *     sans couronne n'est PAS proche par défaut — le supposer proche reviendrait à
 *     promettre un transfert court à un passager dont le vol repart dans 6 h.
 *
 * @returns {{rang: number, source: "passe"|"distance"|"inconnue"|"hors_couronnes"}}
 */
export function couronneDeCandidat(entry, couronnes, refStation = null) {
  const derniere = couronnes[couronnes.length - 1];
  const rangPorte = rangDe(entry?.couronne ?? null);
  if (rangPorte !== null) {
    const c = couronnes.find((x) => x.rang === rangPorte);
    if (c) return { rang: c.rang, source: "passe" };
  }
  const d = distanceMesureeEntree(entry, refStation);
  if (d !== null) {
    const c = couronnes.find((x) => d * 1000 <= x.rayon_m);
    if (c) return { rang: c.rang, source: "distance" };
    return { rang: derniere.rang, source: "hors_couronnes" };
  }
  return { rang: derniere.rang, source: "inconnue" };
}

/**
 * COUVERTURE COURONNE PAR COURONNE — le calcul qui décide s'il faut ouvrir une couronne
 * de plus, et laquelle.
 *
 * Le raisonnement en masse (« 85 chambres pour 173 demandées ») ne dit PAS s'il faut
 * chercher plus loin : une chambre à 40 km n'aide en rien un passager dont le vol suivant
 * décolle dans 6 h. Pour chaque couronne on compare donc deux nombres :
 *  - `captives` : les chambres qui ne peuvent PAS aller au-delà de cette couronne, parce
 *    que le temps de trajet DÉCLARÉ de la suivante dépasse leur budget ;
 *  - `cumul_indicatives` : le stock indicatif des hôtels connus dans les couronnes ≤ rang.
 *
 * `manque_captif` = ce qui manque et qu'aucune couronne plus lointaine ne pourra combler :
 * il faut chercher DAVANTAGE D'HÔTELS PROCHES, pas plus loin. `apport_utile` = la part du
 * manque global que l'ouverture de cette couronne PEUT combler — quand elle vaut 0,
 * ouvrir cette couronne dépenserait une session pour des chambres que personne ne pourra
 * prendre.
 *
 * Fonction PURE. `besoins` absent = aucun budget de trajet connu : la ventilation n'est
 * pas calculée (`null`) plutôt que calculée sur des zéros, qui mentiraient.
 *
 * @param {{candidates: Array, couronnes: Array, besoins: object|null,
 *   refStation?: string|null, ouvertes?: Iterable<number>}} args
 * @returns {{lignes: Array, deficit: number, demandees: number, aOuvrir: object|null}|null}
 */
export function couvertureParCouronne({ candidates = [], couronnes = [], besoins = null, refStation = null, ouvertes = [] }) {
  if (!besoins || !couronnes.length) return null;
  /* AUCUN dossier contraint = aucun budget de trajet connu. Ventiler quand même
   * afficherait des chambres « captives » qui ne le sont pas : sans horaire de vol
   * suivant, on ne sait PAS jusqu'où ces passagers peuvent aller — ce n'est pas la même
   * chose que « ils peuvent aller loin », et ce n'est pas non plus « ils sont captifs ».
   * On ne rend donc rien plutôt qu'un chiffre que la donnée ne mérite pas. */
  if ((besoins.total?.contraints ?? 0) <= 0) return null;
  const dejaOuvertes = new Set([...ouvertes].map(Number));
  const demandees = besoins.total?.chambres ?? 0;

  // stock indicatif par couronne — même borne basse que `capaciteIndicative`
  const parRang = new Map(couronnes.map((c) => [c.rang, []]));
  for (const cand of candidates) {
    parRang.get(couronneDeCandidat(cand, couronnes, refStation).rang)?.push(cand);
  }

  const lignes = [];
  let cumulHotels = 0;
  let cumulConnue = 0;
  let cumulEstimee = 0;
  for (let i = 0; i < couronnes.length; i += 1) {
    const c = couronnes[i];
    const suivante = couronnes[i + 1] ?? null;
    const dedans = parRang.get(c.rang) ?? [];
    const cap = capaciteIndicative(dedans);
    cumulHotels += cap.hotels;
    cumulConnue += cap.connue;
    cumulEstimee += cap.estimee;
    const cumul = cumulConnue + cumulEstimee;
    // captives = chambres qui ne peuvent pas atteindre la couronne SUIVANTE ; sur la
    // DERNIÈRE couronne, tout ce qui reste à loger doit y tenir — mais ce n'est plus une
    // contrainte de TRAJET, c'est la fin du vivier : `derniere` le distingue, pour qu'un
    // manque de chambres ne se lise jamais comme un manque de proximité.
    const captives = suivante ? chambresHorsPortee(besoins, suivante.trajet_min).chambres : demandees;
    // servables = chambres dont le budget de trajet accepte le temps DÉCLARÉ de cette couronne
    const servables = demandees - chambresHorsPortee(besoins, c.trajet_min).chambres;
    lignes.push({
      rang: c.rang,
      rayon_m: c.rayon_m,
      trajet_min_declare: c.trajet_min,
      mode: c.mode,
      derniere: !suivante,
      ouverte: dejaOuvertes.has(c.rang),
      hotels: cap.hotels,
      indicatives: cap.total,
      relevees: cap.connue,
      supposees: cap.estimee,
      cumul_hotels: cumulHotels,
      cumul_indicatives: cumul,
      cumul_relevees: cumulConnue,
      captives,
      servables,
      manque_captif: Math.max(0, captives - cumul),
      suffisante: cumul >= captives,
    });
  }

  const stockTotal = lignes.length ? lignes[lignes.length - 1].cumul_indicatives : 0;
  const deficit = Math.max(0, demandees - stockTotal);
  for (let i = 0; i < lignes.length; i += 1) {
    // ce qu'une couronne PEUT combler : le manque global, moins la part captive des
    // couronnes plus proches — que cette couronne-ci ne servira jamais
    const captifAvant = i === 0 ? 0 : lignes[i - 1].manque_captif;
    lignes[i].apport_utile = Math.max(0, Math.min(deficit - captifAvant, lignes[i].servables));
  }

  // la prochaine couronne à ouvrir : la plus PROCHE non encore ouverte qui apporte
  // quelque chose à quelqu'un. Élargir est un dernier recours, pas un réflexe.
  const aOuvrir = lignes.find((l) => !l.ouverte && l.apport_utile > 0) ?? null;
  return { lignes, deficit, demandees, aOuvrir };
}

/**
 * EX-DIS-1 / C2 : la découverte s'exécute si `force_discovery`, si l'inventaire est
 * absent/périmé, si le vivier ne peut pas couvrir le VOLUME de chambres demandé, ou si
 * un tier ayant des besoins compte moins de `inventory.min_candidates_per_tier`
 * candidats compatibles. Fonction pure.
 *
 * Le juge de suffisance comparait un NOMBRE DE CANDIDATS à un besoin exprimé en
 * CHAMBRES : deux candidats par cabine suffisaient à déclarer « inventaire suffisant »
 * pour 173 chambres que le vivier ne pouvait pas porter, et le run s'arrêtait « épuisé »
 * avec tout son budget. Le volume est maintenant jugé le premier, et dit en clair.
 *
 * COURONNES — quand l'appelant fournit `besoins` (sortie complète de `computeNeeds`), la
 * couverture est en plus jugée COURONNE PAR COURONNE : un vivier « suffisant en masse »
 * peut ne rien valoir si les chambres sont à 40 km et que 60 d'entre elles doivent rester
 * à moins de 15 minutes déclarées. `couverture.parCouronne` porte cette ventilation et
 * `couronneAOuvrir` désigne la prochaine couronne qui apporterait quelque chose à
 * quelqu'un — `null` quand élargir ne servirait personne. Sans `besoins`, rien de tout
 * cela n'est calculé : des zéros seraient un chiffre rassurant non mérité.
 *
 * @param {{inv: object|null, policy: object, station: object, needs: object|null,
 *   besoins?: object|null, couronnesOuvertes?: Iterable<number>, force?: boolean, now?: Date}} args
 *   `needs` = `computeNeeds().parTier` (inchangé) ; `besoins` = la sortie complète, ADDITIF.
 * @returns {{run: boolean, reason: string, couverture: {hotels, indicatives, relevees,
 *   supposees, demandees, suffisante, suffisante_mesuree, parCouronne, couronnes_source,
 *   couronnes_exploitables}, couronneAOuvrir: object|null}} `couverture` est additif.
 *   `suffisante` inclut les chambres SUPPOSÉES ; `suffisante_mesuree` ne compte que les
 *   chambres réellement relevées — les deux diffèrent dès que le compte tient sur du supposé.
 */
export function discoveryNeeded({ inv, policy, station, needs, besoins = null, couronnesOuvertes = [], force = false, now = new Date() }) {
  const cands = candidatesFrom(inv, policy, { station, needs });
  const demandees = ["J", "W", "Y"].reduce((n, t) => n + (needs?.[t]?.chambres ?? 0), 0);
  const cap = capaciteIndicative(cands);
  const dispo = couronnesRecherche(policy, station);
  const { couronnes } = couronnesDe(station);
  const ventilation = couvertureParCouronne({
    candidates: cands,
    couronnes,
    besoins,
    refStation: station?.search?.distance_ref ?? null,
    ouvertes: couronnesOuvertes,
  });
  const couverture = {
    hotels: cap.hotels,
    indicatives: cap.total,
    relevees: cap.connue,
    supposees: cap.estimee,
    demandees,
    suffisante: demandees <= 0 ? true : cap.total >= demandees,
    // « rien n'est estimé » : une suffisance portée par des chambres SUPPOSÉES n'est pas
    // une suffisance mesurée. Sans ce drapeau, le run saute la découverte sur des chiffres
    // qu'aucun relevé n'a vus, et personne n'est averti.
    suffisante_mesuree: demandees <= 0 ? true : cap.connue >= demandees,
    /** Ventilation par couronne, ou null quand aucun budget de trajet n'est connu. */
    parCouronne: ventilation?.lignes ?? null,
    /** « declaree » = couronnes d'exploitation ; « derivee » = repli sur le rayon de la fiche. */
    couronnes_source: dispo.source,
    /** false = EX-STA-2 : aucune couronne ne peut RESTREINDRE une recherche sur cette escale. */
    couronnes_exploitables: dispo.exploitables,
  };
  // « supposées » = hôtels sans indice de capacité, comptés au plafond d'affichage de
  // Booking : c'est une borne basse assumée, jamais une mesure — elle est nommée.
  const dire =
    `${cap.total} chambre(s) indicative(s)` +
    (cap.estimee > 0 ? ` (${cap.connue} relevée(s), ${cap.estimee} supposée(s))` : "") +
    ` pour ${demandees} demandée(s)`;
  const verdict = (run, reason) => ({ run, reason, couverture, couronneAOuvrir: ventilation?.aOuvrir ?? null });

  if (force) return verdict(true, "force_discovery");
  if (isStale(inv, policy, now)) return verdict(true, inv ? "inventaire périmé" : "inventaire absent");
  if (demandees > 0 && cap.total < demandees) {
    return verdict(true, `vivier insuffisant en volume : ${dire}`);
  }
  /* COURONNES — un vivier suffisant EN MASSE peut être insuffisant LÀ OÙ IL FAUT. On
   * cherche la couronne la plus proche dont les chambres captives dépassent le stock
   * connu à sa portée : aucune couronne plus lointaine ne comblera ce manque-là. */
  // la DERNIÈRE couronne est exclue : un manque qui n'apparaît que là est un manque de
  // CHAMBRES (fin du vivier), déjà dit par le verdict de volume — pas un manque de proximité.
  const captif = couverture.parCouronne?.find((l) => l.manque_captif > 0 && !l.derniere) ?? null;
  if (captif) {
    return verdict(
      true,
      `couronne ${captif.rang} insuffisante LÀ OÙ IL FAUT : ${captif.captives} chambre(s) ne peuvent pas aller ` +
        `au-delà de ${captif.trajet_min_declare} min DÉCLARÉES, et les couronnes ≤ ${captif.rang} n'offrent que ` +
        `${captif.cumul_indicatives} chambre(s) indicative(s) — il manque ${captif.manque_captif} chambre(s) PROCHES, ` +
        `qu'aucune couronne plus lointaine ne remplacera`,
    );
  }
  const min = policy.inventory.min_candidates_per_tier;
  for (const tier of ["J", "W", "Y"]) {
    if ((needs?.[tier]?.chambres ?? 0) <= 0) continue;
    const n = cands.filter((c) => c.tiers.includes(tier)).length;
    if (n < min) return verdict(true, `tier ${tier} : ${n} candidat(s) compatible(s) < ${min}`);
  }
  if (!couverture.suffisante_mesuree) {
    // « rien n'est estimé » vaut aussi pour les DÉCISIONS : tant que la suffisance repose
    // sur des chambres supposées, on va chercher des hôtels plutôt que de parier. Une
    // découverte coûte une session ; un plan qui s'effondre coûte une nuit d'escale.
    if (policy.inventory.decide_on_measured_capacity) {
      return verdict(true, `suffisance NON MESURÉE (portée par les chambres supposées) — ${dire}`);
    }
    // option coupée : la découverte reste sautée, mais le motif dit sur quoi repose ce
    // « peut suffire » — l'appelant en fait un avertissement nommé
    return verdict(false, `inventaire frais, suffisance NON MESURÉE (portée par les chambres supposées) — ${dire}`);
  }
  return verdict(false, `inventaire frais et suffisant — ${dire}`);
}

/**
 * Couronne la plus PROCHE de deux marquages (rang le plus petit gagne).
 *
 * Un hôtel déjà vu dans la couronne 1 qui reparaît dans la passe de la couronne 3 est
 * toujours à 5 km : c'est le rayon de la recherche qui a grandi, pas l'hôtel qui s'est
 * éloigné. Garder le rang le plus lointain le rendrait inaccessible aux dossiers dont le
 * budget de trajet est court — c'est-à-dire exactement ceux qu'il faut protéger.
 *
 * @param {object|number|null} a @param {object|number|null} b
 * @returns {object|null} la couronne retenue, telle qu'elle a été fournie
 */
export function couronnePlusProche(a, b) {
  const ra = rangDe(a);
  const rb = rangDe(b);
  if (ra === null) return rb === null ? null : b;
  if (rb === null) return a;
  return ra <= rb ? a : b;
}

/**
 * Rang d'une couronne exprimée en objet ou en nombre, ou `null`.
 * `null`/`undefined` ne valent PAS 0 : `Number(null)` rend 0, et un « rang 0 » serait
 * lu comme la couronne la plus proche de toutes — la promesse la plus dangereuse.
 */
function rangDe(x) {
  if (x === null || x === undefined) return null;
  const brut = typeof x === "object" ? x.rang : x;
  if (brut === null || brut === undefined || brut === "") return null;
  const n = Number(brut);
  return Number.isFinite(n) ? n : null;
}

/** Couronne réduite au contrat lu par `allocate.mjs` (`{rang}` suffit) et par le rapport. */
const couronneEntree = (c) => {
  const rang = rangDe(c);
  if (rang === null) return null;
  return {
    rang,
    rayon_m: c?.rayon_m ?? null,
    trajet_min_declare: c?.trajet_min ?? c?.trajet_min_declare ?? null,
    mode: c?.mode ?? "",
  };
};

/**
 * Candidat de découverte → entrée d'inventaire minimale (fusion EN MÉMOIRE, EX-DIS-2).
 *
 * COURONNES — `couronne` (de l'option, sinon celle que la passe a posée sur le candidat)
 * est recopiée sur l'entrée : c'est la source que `lib/allocate.mjs` juge la plus fiable,
 * devant `distance_km`. Elle est aussi DITE en clair dans `notes`, parce que le schéma
 * d'inventaire (`lib/inventaire.mjs`, hors de ce lot) ne connaît pas encore le champ
 * `couronne` et le retire à l'écriture sur disque : la note, elle, survit — et le
 * pipeline conserve le marquage EN MÉMOIRE pour toute la durée du run.
 *
 * @param {object} candidate @param {{observedAt?: string|null, couronne?: object|number|null}} [opts]
 */
export function candidateToEntry(candidate, { observedAt = null, couronne = null } = {}) {
  const anneau = couronneEntree(couronnePlusProche(couronne, candidate?.couronne ?? null));
  return {
    couronne: anneau,
    id: slugify(candidate.name),
    name: candidate.name,
    url: candidate.url || "",
    source: "agent",
    contracted: false, preferred: false, excluded: false,
    stars: candidate.stars ?? null,
    review_score: candidate.review_score ?? null,
    review_count: candidate.review_count ?? null,
    distance_km: candidate.distance_km ?? null,
    distance_ref: null,
    amenities: {}, // badges de carte non confirmés : rien n'est affirmé avant relevé
    payment: { prepayment_online: "non_precise", pay_at_property_only: null },
    indicative_price_from_eur: candidate.price_from_per_night ?? null,
    capacity_hint: null,
    contact: { phone: null, email: null },
    // les badges restent une OBSERVATION de carte : ils alimentent `notes`, jamais
    // `amenities` — un hôtel n'est déclaré accessible qu'au relevé (C1/C3)
    notes: [
      candidate.amenities_seen?.length ? `badges vus : ${candidate.amenities_seen.join(", ")}` : "",
      candidate.premium_pass ? "passe premium" : "",
      candidate.pmr_pass ? "vu dans la passe PMR (filtre d'accessibilité Booking) — accessibilité à confirmer au relevé" : "",
      // temps de trajet DÉCLARÉ par l'exploitation, jamais mesuré : la note le dit
      anneau
        ? `trouvé dans la couronne ${anneau.rang} (recherche ≤ ${anneau.rayon_m ?? "?"} m` +
          (anneau.trajet_min_declare === null ? "" : `, ${anneau.trajet_min_declare} min DÉCLARÉES en ${anneau.mode || "transfert"}`) +
          ")"
        : "",
    ].filter(Boolean).join(" ; "),
    last_survey_at: observedAt,
  };
}

/**
 * Élargit la recherche pour une RE-DÉCOUVERTE (C2) sans jamais muter la politique ni la
 * fiche escale du run : clones superficiels, lus par `buildNflt` seul.
 *
 * COURONNES — `el.couronne` (couronne de la fiche, ou son rang) est le levier à préférer :
 * il ouvre une couronne DÉCLARÉE par l'exploitation, dont le temps de trajet est connu,
 * au lieu de multiplier un rayon par un facteur arbitraire dont personne ne sait ce qu'il
 * vaut en minutes. Quand il est fourni, `rayonFacteur` est ignoré et la note le dit — les
 * deux se contrediraient sur le rayon envoyé à Booking.
 *
 * @param {object} policy politique validée ; @param {object} station fiche escale
 * @param {{rayonFacteur?: number, sansFiltrePrix?: boolean, candidatsMax?: boolean,
 *   couronne?: object|number|null}|null} el
 * @returns {{policy: object, station: object, couronne: object|number|null, notes: string[]}}
 *   `notes` dit ce qui a RÉELLEMENT été élargi — un levier qui n'a pas pu jouer est nommé,
 *   pas passé sous silence.
 */
export function elargirRecherche(policy, station, el = null) {
  if (!el) return { policy, station, couronne: null, notes: [] };
  const notes = [];
  let p = policy;
  let st = station;

  const couronne = el.couronne ?? null;
  const facteur = Number(el.rayonFacteur);
  if (couronne !== null && couronne !== undefined) {
    const rang = Number(couronne?.rang ?? couronne);
    notes.push(`couronne ${rang} ouverte (rayon de la fiche escale, temps de trajet DÉCLARÉ)`);
    if (Number.isFinite(facteur) && facteur > 1) {
      notes.push(`facteur de rayon ×${facteur} IGNORÉ : la couronne ${rang} porte déjà le rayon de la recherche`);
    }
  } else if (Number.isFinite(facteur) && facteur > 1) {
    const saisi = policy?.global?.discovery?.radius_m ?? null;
    const ficheKm = Number(station?.search?.radius_km);
    if (saisi !== null && Number.isFinite(Number(saisi))) {
      const m = Math.round(Number(saisi) * facteur);
      p = { ...p, global: { ...p.global, discovery: { ...p.global.discovery, radius_m: m } } };
      notes.push(`rayon ${saisi} → ${m} m`);
    } else if (Number.isFinite(ficheKm) && ficheKm > 0) {
      const km = Math.round(ficheKm * facteur * 10) / 10;
      st = { ...st, search: { ...st.search, radius_km: km } };
      notes.push(`rayon ${ficheKm} → ${km} km`);
    } else {
      notes.push("rayon NON élargi : ni policy.discovery.radius_m ni la fiche escale ne portent un rayon exploitable");
    }
  }

  if (el.sansFiltrePrix) {
    if (p.global.discovery.apply_price_filter === false) {
      notes.push("filtre de prix déjà inactif : rien à relever de ce côté");
    } else {
      p = { ...p, global: { ...p.global, discovery: { ...p.global.discovery, apply_price_filter: false } } };
      notes.push("plafond de prix relevé : le filtre de prix sort de la RECHERCHE (le plafond reste jugé à l'allocation)");
    }
  }

  if (el.candidatsMax) {
    // bornes hautes du schéma de politique (`PolicySchema.global.discovery`) : on relève
    // au maximum documenté, jamais au-delà
    const nSocle = Math.max(p.global.discovery.n_socle, 10);
    const maxCand = Math.max(p.global.discovery.max_candidates, 12);
    if (nSocle !== p.global.discovery.n_socle || maxCand !== p.global.discovery.max_candidates) {
      notes.push(`plafond de candidats relevé : n_socle ${p.global.discovery.n_socle} → ${nSocle}, max_candidates ${p.global.discovery.max_candidates} → ${maxCand}`);
      p = { ...p, global: { ...p.global, discovery: { ...p.global.discovery, n_socle: nSocle, max_candidates: maxCand } } };
    }
  }
  return { policy: p, station: st, couronne, notes };
}

/** Consigne de la troisième passe (accessibilité). Le badge est la seule marque demandée. */
const suitePmr = (nfltPmr) =>
  `\n\n6. Passe PMR, FACULTATIVE, à jouer APRÈS l'étape 5 et avant de rédiger ta réponse : modifie l'URL ` +
  `COURANTE en remplaçant son bloc nflt par : ${nfltPmr}\n` +
  `   Cette passe ne garde que les établissements que la plateforme déclare accessibles aux personnes à mobilité ` +
  `réduite. Les nouveaux établissements (2 maximum) vont DANS candidates avec toutes leurs données de carte, et ` +
  `tu écris « ${BADGE_PMR} » EN TÊTE de leur champ badges. Si un établissement déjà listé réapparaît dans cette ` +
  `passe, ajoute seulement « ${BADGE_PMR} » en tête de ses badges. AU PREMIER incident sur cette passe ` +
  `(redirection, autre zone, erreur), abandonne-la DÉFINITIVEMENT et rédige immédiatement ta réponse, passe ` +
  `signalée dans notes.`;

const aBadgePmr = (c) => (c.amenities_seen ?? []).some((b) => String(b).trim().toUpperCase() === BADGE_PMR);

/**
 * Lance la session de découverte (1 session, 2 à 3 passes). Retourne les candidats ;
 * en échec après retry, liste vide avec warning (le repli `fallback_hotels` est
 * assuré par candidatesFrom).
 *
 * C1/C3 — `needs` (besoins par cabine, `computeNeeds().parTier`) restreint le plafond de
 * prix aux cabines RÉELLEMENT à loger et déclenche la passe PMR. INV-5 : `needs` ne sert
 * qu'à construire des filtres d'URL, aucune donnée passager n'entre dans le prompt.
 *
 * C5 — `deadlineAt` / `budgetRemainingMs` bornent le suivi ET interdisent de lancer une
 * session qui ne pourrait plus finir ; `maxTimeS` (défaut `DISCOVERY_MAX_TIME_S`) est le
 * budget serveur, désormais relayé au suivi (la pompe suivait 15 min une session de 13).
 *
 * C2 — `elargissement` rejoue une découverte élargie (rayon, plafond de prix, plafond de
 * candidats) sans muter la politique du run.
 *
 * COURONNES — `couronne` (couronne de la fiche escale, ou son rang) fait porter aux TROIS
 * passes le rayon de cette couronne, et marque chaque candidat rendu de son rang
 * (`candidate.couronne`). Un candidat déjà vu dans une couronne plus proche garde la plus
 * proche. `couronne` absente = comportement d'avant les couronnes : rayon ordinaire, et
 * AUCUN marquage — la couronne des hôtels sera alors établie au relevé, par leur distance,
 * ou par la règle de prudence de `allocate.mjs`. Rien n'est marqué qui n'ait été filtré.
 *
 * @param {{needs?: object|null, pmr?: boolean|null, deadlineAt?: number|null,
 *          budgetRemainingMs?: number|null, maxTimeS?: number,
 *          elargissement?: object|null, couronne?: object|number|null}} args
 *          options additives (défauts = comportement actuel)
 */
export async function runDiscovery({
  client, policy, station, checkin, checkout, groupId, emit, signal, attempt = 1,
  needs = null, pmr = null, deadlineAt = null, budgetRemainingMs = null,
  maxTimeS = DISCOVERY_MAX_TIME_S, elargissement = null, couronne = null,
}) {
  // le résiduel devient une échéance absolue UNE fois, ici : sinon le retry repartirait
  // avec le même « il reste 20 minutes » et la borne ne bornerait rien (C5)
  const echeance = Number.isFinite(deadlineAt)
    ? deadlineAt
    : Number.isFinite(budgetRemainingMs)
      ? Date.now() + budgetRemainingMs
      : null;
  const suite = (n) => ({
    client, policy, station, checkin, checkout, groupId, emit, signal, attempt: n,
    needs, pmr, deadlineAt: echeance, budgetRemainingMs: null, maxTimeS, elargissement, couronne,
  });

  const restantMs = budgetRestantMs({ deadlineAt: echeance });
  if (restantMs !== null && restantMs < MIN_DEMARRAGE_MS) {
    emit("warning", {
      message: `budget d'horloge du run épuisé (${Math.max(0, Math.round(restantMs / 1000))} s) — découverte non lancée`,
    });
    return { candidates: [], sessionId: null, status: "skipped_budget", outcome: null, notes: "budget d'horloge du run épuisé", steps: 0, costUsd: 0 };
  }

  const elargi = elargirRecherche(policy, station, elargissement);
  const policyRech = elargi.policy;
  const stationRech = elargi.station;
  if (attempt === 1 && elargi.notes.length) {
    emit("warning", { message: `découverte élargie : ${elargi.notes.join(" ; ")}` });
  }

  // la couronne de l'élargissement prime sur celle de l'appel : c'est la décision la plus
  // récente (la vague d'extension qui a décidé d'ouvrir plus loin)
  const anneauDemande = elargi.couronne ?? couronne ?? null;

  await ensureAgentV2(client, station, policy);
  const nflt = buildNflt(policyRech, stationRech, { needs, pmr, couronne: anneauDemande });
  /* Le marquage ne vaut que si la couronne a RÉELLEMENT filtré l'URL : une couronne
   * demandée mais non appliquée (EX-STA-2) laisserait un rang faux sur des hôtels que
   * l'allocation croirait proches. `details.couronne.appliquee` est le seul feu vert. */
  const anneauApplique = nflt.details.couronne?.appliquee ? nflt.details.couronne : null;
  // une passe PMR identique au socle (la cabine Y exige déjà l'accessibilité) coûterait
  // des étapes pour le même résultat : elle n'est pas jouée, et on le dit
  const nfltPmr = nflt.pmr && nflt.pmr !== nflt.socle && nflt.pmr !== nflt.premium ? nflt.pmr : null;
  const urls = {
    socle: buildSearchUrl({ station: stationRech, checkin, checkout, nflt: nflt.socle }),
    premium: buildSearchUrl({ station: stationRech, checkin, checkout, nflt: nflt.premium }),
    ...(nfltPmr ? { pmr: buildSearchUrl({ station: stationRech, checkin, checkout, nflt: nfltPmr }) } : {}),
  };
  if (attempt === 1) {
    // C1 — tout ce que la recherche applique, et tout ce qu'elle ne garantit PAS
    for (const a of nflt.details.avertissements) emit("warning", { message: `recherche : ${a}` });
    if (nflt.details.non_filtrables.length) {
      emit("warning", {
        message:
          "prestations NON filtrables à la recherche, à juger au relevé : " +
          nflt.details.non_filtrables.map((n) => `${n.prestation} (${n.cabine})`).join(", "),
      });
    }
    if (nflt.pmr && !nfltPmr) {
      emit("warning", { message: "passe PMR non jouée : ses filtres sont identiques à une passe déjà lancée (l'accessibilité y est déjà exigée)" });
    }
    if (!nflt.pmr && pmr !== false) {
      emit("warning", { message: "aucune passe PMR : l'overlay d'accessibilité est désactivé ou les filtres de prestations sont coupés — l'accessibilité ne sera jugée qu'au relevé" });
    }
  }
  emit("phase", {
    phase: "discovery", urls, attempt, passes: Object.keys(urls), plafonds_eur: nflt.details.plafonds_eur,
    // quelle couronne est réellement ouverte par cette session, et son temps DÉCLARÉ
    couronne: anneauApplique
      ? { rang: anneauApplique.rang, rayon_m: anneauApplique.rayon_m, trajet_min_declare: anneauApplique.trajet_min, mode: anneauApplique.mode, source: anneauApplique.source }
      : null,
  });

  let handle;
  try {
    handle = await client.startSession({
      agent: agentNameV2(station),
      messages:
        promptDiscovery({
          station: stationRech, checkin, checkout, nflt,
          nSocle: policyRech.global.discovery.n_socle,
          maxCandidates: policyRech.global.discovery.max_candidates,
        }) + (nfltPmr ? suitePmr(nfltPmr) : ""),
      maxSteps: nfltPmr ? 45 : 35,
      maxTimeS,
      // idleTimeoutS par défaut : null clôturait la session au moindre passage idle (constaté aux probes)
      groupId,
      answerSchema: discoverySchema,
    });
  } catch (err) {
    if (attempt < 2 && !signal?.aborted) {
      emit("warning", { message: `découverte : échec de lancement (${err?.message ?? err}), nouvelle tentative` });
      return runDiscovery(suite(attempt + 1));
    }
    emit("warning", { message: `découverte abandonnée (${err?.message ?? err}) — repli sur l'inventaire et les hôtels de secours` });
    return { candidates: [], sessionId: null, status: "error", outcome: null, notes: String(err?.message ?? err) };
  }
  // `costUsd: null` = session lancee dont la plateforme n'a PAS rapporte de cout.
  // Zero serait un mensonge : la session facture, le budget du run ne peut plus etre controle.
  const usage = { steps: 0, costUsd: null };
  const scoped = (type, data) => {
    if (type === "metrics") {
      usage.steps = data.steps ?? usage.steps;
      // seule une mesure remplace la precedente : une absence ne ramene pas le total a 0
      if (typeof data.cost_usd === "number" && Number.isFinite(data.cost_usd)) usage.costUsd = data.cost_usd;
    }
    return emit(type, data, { session_id: handle.id, hotel_key: "_discovery" });
  };
  scoped("agent_status", { status: "running" });

  let result;
  try {
    result = await pumpToCompletion(handle, scoped, { signal, maxTimeS, deadlineAt: echeance });
  } catch (err) {
    // échéance de suivi atteinte ou coupure : le run continue sur l'inventaire, il ne
    // meurt pas sur une exception de découverte
    emit("warning", { message: `découverte : suivi interrompu (${err?.message ?? err}) — repli sur l'inventaire et les hôtels de secours` });
    return { candidates: [], sessionId: handle.id, status: "error", outcome: null, notes: String(err?.message ?? err), steps: usage.steps, costUsd: usage.costUsd };
  }
  let answer = result.answer;
  if (typeof answer === "string") {
    try { answer = JSON.parse(answer); } catch { answer = null; }
  }
  // marque PMR : le badge de convention est retiré des badges de carte (ce n'est pas un
  // équipement observé) et devient un drapeau explicite sur le candidat.
  // MARQUE DE COURONNE : posée seulement si la couronne a réellement filtré les passes.
  const marqueCouronne = anneauApplique
    ? { rang: anneauApplique.rang, rayon_m: anneauApplique.rayon_m, trajet_min: anneauApplique.trajet_min, mode: anneauApplique.mode }
    : null;
  const candidates = toDiscoveryCandidates(answer).map((c) => {
    const base = aBadgePmr(c)
      ? { ...c, pmr_pass: true, amenities_seen: c.amenities_seen.filter((b) => String(b).trim().toUpperCase() !== BADGE_PMR) }
      : { ...c, pmr_pass: false };
    return marqueCouronne ? { ...base, couronne: couronnePlusProche(base.couronne ?? null, marqueCouronne) } : base;
  });
  const failed = !answer || result.status === "failed" || result.outcome === "blocked" || !candidates.length;
  if (failed && attempt < 2 && !signal?.aborted) {
    emit("warning", { message: "découverte sans résultat exploitable, nouvelle tentative" });
    return runDiscovery(suite(attempt + 1));
  }
  const nPmr = candidates.filter((c) => c.pmr_pass).length;
  if (nfltPmr && !nPmr && candidates.length) {
    // la passe a été demandée mais rien n'en revient : on ne présume RIEN, on le dit
    emit("warning", {
      message: "passe PMR : aucun candidat marqué accessible — passe abandonnée ou sans résultat ; l'accessibilité reste entièrement à confirmer au relevé",
    });
  }
  for (const c of candidates) emit("candidate", c);
  emit("phase", {
    phase: "discovery", done: true, count: candidates.length, pmr: nPmr,
    outcome: result.outcome ?? null, notes: answer?.notes ?? result.error ?? "",
    // CE QUE LA COURONNE A RAPPORTÉ : le chiffre qui justifie (ou non) la session dépensée
    couronne: marqueCouronne?.rang ?? null,
    couronne_trajet_min_declare: marqueCouronne?.trajet_min ?? null,
  });
  return {
    candidates,
    /** Couronne réellement ouverte par cette session (null = recherche au rayon ordinaire). */
    couronne: marqueCouronne,
    currency: answer?.currency ?? "EUR",
    sessionId: handle.id,
    status: result.status,
    outcome: result.outcome ?? null,
    notes: answer?.notes ?? "",
    flat: answer, // réponse plate (discoverySchema) — archivée par --probe-discovery (phase 5)
    steps: usage.steps,
    costUsd: usage.costUsd,
    pmrCount: nPmr,
    elargissement: elargissement ? { ...elargissement, effets: elargi.notes } : null,
  };
}
