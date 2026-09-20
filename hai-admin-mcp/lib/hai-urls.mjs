/**
 * Construction d'URL Booking et de filtres `nflt` — partie PURE du futur
 * `lib/hai.mjs` (CDC §6.2, EX-DIS-3). Séparée pour que la phase 2 reste sans
 * import de `hai-agents` ; la phase 3 (`lib/hai.mjs`) réexportera ces fonctions.
 *
 * C1 — la recherche obéit à la SAISIE : étoiles, note, rayon, prestations exigées
 * et plafond par nuit de la politique deviennent des filtres `nflt`. Ce qui n'a pas
 * de code de filtre sûr n'est jamais inventé : il ressort dans `non_filtrables`,
 * pour que l'opérateur sache ce que la recherche ne garantit pas.
 *
 * COURONNES — une passe de recherche PAR COURONNE de la fiche escale. Le rayon envoyé
 * à Booking est celui de la couronne (`rayon_m`) ; son `trajet_min` est un temps
 * DÉCLARÉ par l'exploitation, jamais mesuré : il n'entre dans AUCUN filtre, il ne sert
 * qu'à nommer la passe. L'outil n'a aucun service de routage et ne convertit jamais une
 * distance en durée.
 */
import { effectiveCaps } from "./policy.mjs";
import { couronnesDe } from "./stations.mjs";

/**
 * Date du relevé des codes de filtres ci-dessous. AVERTISSEMENT : ces codes n'ont
 * PAS été revérifiés depuis. Un code périmé ne fait pas échouer la recherche, il la
 * rétrécit en silence — une campagne réelle doit les réputer d'abord par une sonde.
 */
export const NFLT_CODES_RELEVES_LE = "2026-09-11";

/** Codes de filtres Booking relevés le 11/09/2026 (paramètre nflt, séparés par ';'). */
export const NFLT = {
  stars: (n) => `class=${n}`,
  review7plus: "review_score=70",
  review8plus: "review_score=80",
  reviewBucket: (b) => `review_score=${b}`,
  breakfast: "mealplan=1",
  wifi: "hotelfacility=107",
  shuttle: "hotelfacility=17",
  roomService: "hotelfacility=5",
  reception24h: "hotelfacility=8",
  restaurant: "hotelfacility=3",
  accessible: "hotelfacility=185",
  distanceKm: (km) => `distance=${Math.round(km * 1000)}`,
  distanceM: (m) => `distance=${Math.round(m)}`,
  freeCancel: "fc=2",
  hotelsOnly: "ht_id=204",
  price: (minEur, maxEur) => `price=EUR-${minEur}-${maxEur}-1`,
};

/**
 * Prestations du moteur (`AMENITY_KEYS`) → code de filtre. Une prestation absente de
 * cette table n'est PAS filtrable : elle part dans `non_filtrables`, jamais dans un
 * code deviné. Les entrées `exact: false` filtrent un SUR-ensemble (le filtre « room
 * service » ne dit rien du 24h/24, le filtre « restaurant » rien des horaires) :
 * elles n'excluent donc aucun hôtel conforme, `conformityOf` tranche sur le relevé.
 */
export const AMENITY_NFLT = {
  wifi_free: { code: NFLT.wifi, libelle: "wifi gratuit", exact: true },
  breakfast_available: { code: NFLT.breakfast, libelle: "petit-déjeuner inclus", exact: true },
  airport_shuttle: { code: NFLT.shuttle, libelle: "navette aéroport", exact: true },
  accessible: { code: NFLT.accessible, libelle: "accessibilité PMR", exact: true },
  room_service_24h: { code: NFLT.roomService, libelle: "room service", exact: false, note: "le filtre ne distingue pas le 24h/24" },
  restaurant_late: { code: NFLT.restaurant, libelle: "restaurant", exact: false, note: "le filtre ne dit rien des horaires de service" },
};

/** Prestations connues du moteur pour lesquelles aucun code de filtre n'est sûr. */
export const AMENITIES_SANS_FILTRE = {
  workspace: "aucun code de filtre Booking sûr pour l'espace de travail",
};

/**
 * HYPOTHÈSE EXTERNE NON VALIDÉE (audit du 18/09/2026) : la syntaxe du filtre de prix
 * `price=EUR-<min>-<max>-1` n'a jamais été éprouvée par une sonde réelle. Une syntaxe
 * fausse ne se distingue pas, côté agent, d'une zone sans offre : elle rend « zéro
 * résultat ». Le drapeau `policy.global.discovery.apply_price_filter` permet de la
 * couper, et `buildSearchPlan()` fournit systématiquement l'URL SANS filtre de prix
 * (`url_sans_filtre_prix`) pour dégrader au lieu de rentrer bredouille.
 */
export const HYPOTHESE_FILTRE_PRIX = {
  id: "nflt_price_syntax",
  syntaxe: "price=EUR-<min>-<max>-1",
  statut: "non validée",
  releve_le: "2026-09-18",
  effet_si_fausse: "recherche sans résultat (indistinguable d'une zone sans offre)",
  parade: "relancer la passe avec url_sans_filtre_prix, ou mettre apply_price_filter à false",
};

/**
 * Filtre de prix par nuit, ou `null` si les bornes ne tiennent pas debout (jamais de
 * filtre bricolé sur une valeur douteuse).
 * @param {number} maxEur plafond par nuit, en euros
 * @param {{minEur?: number}} [opts]
 * @returns {string|null}
 */
export function priceNflt(maxEur, { minEur = 0 } = {}) {
  const max = Math.round(Number(maxEur));
  const min = Math.round(Number(minEur));
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(min) || min < 0 || min >= max) return null;
  return NFLT.price(min, max);
}

/**
 * Rayon de recherche effectif : `policy.global.discovery.radius_m` prime sur la fiche
 * escale, `null` = valeur de la fiche. Le filtre reste conditionné à
 * `search.use_distance_filter` (EX-STA-2 : rien de filtré quand la référence de
 * distance est le centre de zone) — un rayon saisi mais inapplicable est SIGNALÉ.
 * @returns {{metres: number|null, source: string, applique: boolean, avertissement: string|null}}
 */
export function resolveRadius(policy, station) {
  const saisi = policy?.global?.discovery?.radius_m ?? null;
  const fiche = Number(station?.search?.radius_km);
  const metres = saisi !== null ? Math.round(Number(saisi)) : Number.isFinite(fiche) && fiche > 0 ? Math.round(fiche * 1000) : null;
  const source = saisi !== null ? "saisie (policy.discovery.radius_m)" : "fiche escale";
  if (!Number.isFinite(metres) || metres <= 0) {
    return { metres: null, source, applique: false, avertissement: `rayon inexploitable (radius_m=${saisi}, radius_km=${station?.search?.radius_km}) : aucun filtre de distance` };
  }
  if (!station?.search?.use_distance_filter) {
    return {
      metres,
      source,
      applique: false,
      avertissement:
        saisi !== null
          ? `rayon saisi (${metres} m) NON envoyé à Booking : la fiche ${station?.code} interdit le filtre de distance (distance_ref=${station?.search?.distance_ref}, EX-STA-2) — la distance est jugée au relevé`
          : null,
    };
  }
  return { metres, source, applique: true, avertissement: null };
}

/**
 * Libellé exact de la règle EX-STA-2 appliquée aux couronnes, pour que l'interface, le
 * rapport et les événements de découverte la nomment tous de la même façon.
 */
export const COURONNES_NON_FILTRABLES =
  "aucune passe par couronne possible : la fiche escale interdit le filtre de distance (EX-STA-2)";

/**
 * Couronnes de recherche RÉELLEMENT exploitables pour cette escale.
 *
 * Une couronne ne devient une passe de recherche que si le filtre de distance peut
 * partir à Booking. Quand `distance_ref = zone_center` (EX-STA-2) ou que le rayon est
 * inexploitable, toutes les passes rendraient exactement le même vivier : on le DIT au
 * lieu de payer plusieurs sessions pour le même résultat, et la couronne d'un hôtel
 * restera à établir au relevé, par sa distance.
 *
 * `source` distingue une couronne DÉCLARÉE par l'exploitation d'une couronne DÉRIVÉE du
 * rayon de la fiche (voir `couronnesDe` dans `lib/stations.mjs`) : une dérivée n'est pas
 * une déclaration et ne doit jamais être présentée comme telle.
 *
 * @param {object} policy politique validée
 * @param {object} station fiche escale validée
 * @returns {{couronnes: Array, declarees: Array, source: "declaree"|"derivee",
 *   exploitables: boolean, raison: string|null}} `couronnes` est vide quand rien n'est
 *   exploitable ; `declarees` porte toujours ce que la fiche annonce.
 */
export function couronnesRecherche(policy, station) {
  const { couronnes, source } = couronnesDe(station);
  const rayon = resolveRadius(policy, station);
  if (!rayon.applique) {
    const pourquoi = station?.search?.use_distance_filter
      ? `rayon inexploitable (${rayon.source})`
      : `distance_ref=${station?.search?.distance_ref}`;
    return {
      couronnes: [],
      declarees: couronnes,
      source,
      exploitables: false,
      raison: `${COURONNES_NON_FILTRABLES} — ${station?.code ?? "escale"} : ${pourquoi}. Les ${couronnes.length} couronne(s) de la fiche restent affichables, mais aucune ne peut RESTREINDRE une recherche : la couronne d'un hôtel ne sera connue qu'au relevé, par sa distance.`,
    };
  }
  return { couronnes, declarees: couronnes, source, exploitables: true, raison: null };
}

/**
 * Résout la couronne demandée (objet de couronne, ou rang) contre la fiche escale.
 * @returns {{couronne: object|null, rang: number|null, total: number, source: string,
 *   erreur: string|null}} `couronne` null = rang inconnu de la fiche (jamais inventé).
 */
function resoudreCouronne(station, demandee) {
  const { couronnes, source } = couronnesDe(station);
  const rang = Number(demandee?.rang ?? demandee);
  if (!Number.isFinite(rang)) {
    return { couronne: null, rang: null, total: couronnes.length, source, erreur: `couronne « ${JSON.stringify(demandee)} » illisible` };
  }
  const c = couronnes.find((x) => x.rang === rang) ?? null;
  return {
    couronne: c,
    rang,
    total: couronnes.length,
    source,
    erreur: c ? null : `couronne ${rang} inconnue de la fiche ${station?.code ?? "?"} (déclarées : ${couronnes.map((x) => x.rang).join(", ") || "aucune"})`,
  };
}

/**
 * Seuils de note RELEVÉS (voir `NFLT_CODES_RELEVES_LE`), du plus exigeant au plus
 * large. Aucun palier au-dessus de 8/10 n'a été relevé : une note exigée plus haute
 * filtre au palier 8 — un SUR-ensemble, qui n'exclut aucun hôtel conforme — plutôt
 * qu'un `review_score=90` extrapolé, qui viderait la recherche en silence s'il était
 * faux. L'écart est dit à l'opérateur, car RIEN ne le rattrape après le relevé.
 */
const PALIERS_NOTE = [80, 70, 60];

/**
 * Filtre de note dérivé de `discovery.min_review_score` (note /10).
 * @returns {{code: string|null, avertissement: string|null}} `code` null = note non filtrée
 */
function filtreNote(minReviewScore) {
  const n = Number(minReviewScore);
  if (!Number.isFinite(n) || n <= 0) return { code: null, avertissement: null };
  const cible = Math.round(n * 10);
  const palier = PALIERS_NOTE.find((p) => p <= cible);
  if (palier === undefined) {
    return { code: null, avertissement: `note minimale ${minReviewScore}/10 : aucun palier de filtre relevé en dessous de 6/10, note NON filtrée` };
  }
  if (palier < cible) {
    return {
      code: NFLT.reviewBucket(palier),
      avertissement: `note minimale ${minReviewScore}/10 : le palier de filtre relevé le plus proche est ${palier / 10}/10 — la recherche est plus LARGE que la saisie, et aucun contrôle ne rattrape l'écart après le relevé`,
    };
  }
  return { code: NFLT.reviewBucket(palier), avertissement: null };
}

/** Filtres d'étoiles : `min_stars = 0` = AUCUNE exigence, donc aucun filtre `class=`. */
function filtresEtoiles(minStars, avertissements, origine) {
  if (!Number.isInteger(minStars) || minStars < 0 || minStars > 5) {
    avertissements.push(`${origine} : min_stars=${minStars} inexploitable, aucun filtre d'étoiles appliqué`);
    return [];
  }
  // « 0★ » veut dire « élargis » : class=1..5 exclurait au contraire les non classés
  if (minStars === 0) return [];
  const out = [];
  for (let s = minStars; s <= 5; s += 1) out.push({ code: NFLT.stars(s), origine: "étoiles", libelle: `${s}★` });
  return out;
}

/**
 * Prestations exigées d'une cabine → filtres, plus la liste de celles qu'aucun code
 * ne couvre. `apply` à false : rien n'est filtré, tout est reporté au relevé.
 */
function filtresPrestations(keys, { apply, cabine }) {
  const filtres = [];
  const non_filtrables = [];
  for (const key of keys ?? []) {
    const map = AMENITY_NFLT[key];
    if (!apply) {
      non_filtrables.push({ prestation: key, cabine, raison: "filtres de prestations désactivés (discovery.apply_amenity_filters = false)" });
      continue;
    }
    if (!map) {
      non_filtrables.push({ prestation: key, cabine, raison: AMENITIES_SANS_FILTRE[key] ?? "aucun code de filtre connu pour cette prestation" });
      continue;
    }
    filtres.push({ code: map.code, origine: "prestation", libelle: map.libelle, prestation: key, exact: map.exact, note: map.note ?? null });
  }
  return { filtres, non_filtrables };
}

/**
 * Plafond effectif le plus élevé parmi les cabines retenues : filtrer au plafond Y
 * exclurait les hôtels des cabines J et W, le filtre doit être le plus LARGE des
 * plafonds réellement en jeu. `needs` absent = les trois cabines.
 */
function plafondMax(policy, station, tiers, needs) {
  const caps = effectiveCaps(policy, station);
  const actifs = tiers.filter((t) => !needs || (needs?.[t]?.chambres ?? 0) > 0);
  const retenus = actifs.length ? actifs : tiers;
  return { eur: Math.max(...retenus.map((t) => caps[t])), cabines: retenus };
}

const dedupe = (filtres) => {
  const vus = new Set();
  return filtres.filter((f) => (vus.has(f.code) ? false : (vus.add(f.code), true)));
};

/**
 * Filtres des passes de découverte, dérivés de la politique ET de la fiche escale
 * (EX-DIS-3, C1). Trois passes :
 * - `socle` : plancher commun (cabine Y) — étoiles ≥ min Y, note, rayon, prestations
 *   exigées de Y, plafond de prix, hôtels seulement ;
 * - `premium` : 4-5★ + prestations exigées de la cabine J ;
 * - `pmr` : le socle plus l'accessibilité, quand l'overlay PMR l'exige.
 *
 * `distance=` reste omis quand `use_distance_filter = false` ; `extra_nflt` de la
 * fiche est ajouté à toutes les passes.
 *
 * @param {object} policy politique validée (`PolicySchema`)
 * @param {object} station fiche escale validée (`StationSchema`)
 * @param {{needs?: object|null, pmr?: boolean|null, couronne?: object|number|null}} [options]
 *        `needs` = besoins par cabine (`{J|W|Y: {chambres}}`), pour ne filtrer qu'aux
 *        plafonds en jeu ; `pmr` force (true) ou interdit (false) la passe PMR, `null` =
 *        selon l'overlay ; `couronne` (couronne de la fiche escale, ou son rang) remplace
 *        le rayon ordinaire par le `rayon_m` de cette couronne — ADDITIF : absent, le
 *        comportement est exactement celui d'avant les couronnes.
 * @returns {{socle: string, premium: string, pmr: string|null, details: object}}
 *          `socle`/`premium` gardent leur forme ; `pmr` et `details` sont additifs.
 *          `details.couronne` dit quelle couronne a RÉELLEMENT filtré, ou pourquoi non.
 */
export function buildNflt(policy, station, options = {}) {
  const disc = policy.global.discovery;
  const search = station.search;
  const needs = options.needs ?? null;
  const avertissements = [];
  const non_filtrables = [];

  const applyAmenities = disc.apply_amenity_filters !== false;
  const applyPrice = disc.apply_price_filter !== false;
  if (!applyAmenities) {
    avertissements.push("discovery.apply_amenity_filters = false : aucune prestation exigée n'atteint la recherche, tout est jugé après relevé");
  }

  const note = filtreNote(disc.min_review_score);
  if (note.avertissement) avertissements.push(note.avertissement);
  const filtresNote = note.code ? [{ code: note.code, origine: "note", libelle: `note ≥ ${Number(note.code.split("=")[1]) / 10}/10` }] : [];

  const rayonFiche = resolveRadius(policy, station);
  if (rayonFiche.avertissement) avertissements.push(rayonFiche.avertissement);

  /* COURONNE — le rayon de la couronne demandée remplace le rayon ordinaire. Il ne s'y
   * AJOUTE pas : deux codes `distance=` dans un même `nflt` n'auraient aucun sens.
   * Le `trajet_min` de la couronne n'entre dans aucun filtre — c'est une DÉCLARATION
   * d'exploitation, pas une mesure, et Booking ne filtre pas sur des minutes. */
  let rayon = rayonFiche;
  let couronneDetail = null;
  const demandee = options.couronne ?? null;
  if (demandee !== null && demandee !== undefined) {
    const res = resoudreCouronne(station, demandee);
    if (!res.couronne) {
      // rang inconnu : on ne l'invente pas, on retombe sur le rayon de la fiche et on le dit
      avertissements.push(`${res.erreur} — recherche menée au rayon ordinaire (${rayonFiche.metres ?? "?"} m)`);
      couronneDetail = { rang: res.rang, appliquee: false, source: res.source, raison: res.erreur };
    } else if (!rayonFiche.applique) {
      // EX-STA-2 (ou rayon inexploitable) : filtrer quand même serait mentir sur la portée
      const raison = `${COURONNES_NON_FILTRABLES} — couronne ${res.couronne.rang} DEMANDÉE mais NON appliquée : la recherche reste celle du rayon ordinaire et ramènera le même vivier que toute autre couronne`;
      avertissements.push(raison);
      couronneDetail = { ...res.couronne, appliquee: false, source: res.source, total: res.total, raison };
    } else {
      rayon = {
        metres: res.couronne.rayon_m,
        source: `couronne ${res.couronne.rang}/${res.total} de la fiche escale (${res.source === "declaree" ? "déclarée" : "dérivée du rayon de la fiche"})`,
        applique: true,
        avertissement: rayonFiche.avertissement,
      };
      couronneDetail = { ...res.couronne, appliquee: true, source: res.source, total: res.total, raison: null };
    }
  }
  const filtresDistance = rayon.applique
    ? [
        {
          code: NFLT.distanceM(rayon.metres),
          origine: couronneDetail?.appliquee ? "couronne" : "rayon",
          libelle: couronneDetail?.appliquee
            ? `≤ ${rayon.metres} m (couronne ${couronneDetail.rang}/${couronneDetail.total}, ${couronneDetail.trajet_min} min DÉCLARÉES en ${couronneDetail.mode})`
            : `≤ ${rayon.metres} m (${rayon.source})`,
        },
      ]
    : [];

  const extra = (search.extra_nflt ?? []).map((code) => ({ code, origine: "fiche escale", libelle: code }));

  const prestaSocle = filtresPrestations(policy.cabins.Y.required_amenities, { apply: applyAmenities, cabine: "Y" });
  const prestaPremium = filtresPrestations(policy.cabins.J.required_amenities, { apply: applyAmenities, cabine: "J" });
  non_filtrables.push(...prestaSocle.non_filtrables, ...prestaPremium.non_filtrables);

  // prix — syntaxe assumée et signalée (HYPOTHESE_FILTRE_PRIX)
  const capSocle = plafondMax(policy, station, ["J", "W", "Y"], needs);
  const capPremium = plafondMax(policy, station, ["J", "W"], needs);
  const prixSocle = applyPrice ? priceNflt(capSocle.eur) : null;
  const prixPremium = applyPrice ? priceNflt(capPremium.eur) : null;
  if (applyPrice && prixSocle === null) avertissements.push(`plafond de prix inexploitable (${capSocle.eur} EUR) : aucun filtre de prix`);
  // filtrer au plafond retire du vivier les hôtels que `allow_above_cap_if_no_alternative`
  // autorisait en dernier recours : l'échappatoire ne peut plus jouer, il faut le dire
  if (prixSocle && ["J", "W", "Y"].some((t) => policy.cabins[t].allow_above_cap_if_no_alternative)) {
    avertissements.push(
      `filtre de prix actif : aucun hôtel au-dessus de ${capSocle.eur} EUR/nuit n'entrera dans le vivier, donc « allow_above_cap_if_no_alternative » ne pourra pas jouer faute de candidat — parade : relancer sur url_sans_filtre_prix, ou couper discovery.apply_price_filter`,
    );
  }
  const filtresPrix = prixSocle
    ? [{ code: prixSocle, origine: "prix", libelle: `≤ ${capSocle.eur} EUR/nuit (cabines ${capSocle.cabines.join("/")})`, hypothese: HYPOTHESE_FILTRE_PRIX.id }]
    : [];
  const filtresPrixPremium = prixPremium
    ? [{ code: prixPremium, origine: "prix", libelle: `≤ ${capPremium.eur} EUR/nuit (cabines ${capPremium.cabines.join("/")})`, hypothese: HYPOTHESE_FILTRE_PRIX.id }]
    : [];

  const hotelsOnly = [{ code: NFLT.hotelsOnly, origine: "type d'hébergement", libelle: "hôtels uniquement" }];

  const fSocle = dedupe([
    ...filtresEtoiles(policy.cabins.Y.min_stars, avertissements, "cabine Y"),
    ...prestaSocle.filtres,
    ...filtresNote,
    ...filtresDistance,
    ...filtresPrix,
    ...hotelsOnly,
    ...extra,
  ]);
  const fPremium = dedupe([
    { code: NFLT.stars(4), origine: "étoiles", libelle: "4★" },
    { code: NFLT.stars(5), origine: "étoiles", libelle: "5★" },
    ...prestaPremium.filtres,
    // La passe premium n'a JAMAIS porté le rayon (elle ratisse large sur les 4-5★). En
    // mode couronne, elle DOIT le porter : sans lui, les candidats qu'elle ramène ne
    // sont pas dans la couronne, et les marquer de son rang serait une affirmation
    // fausse — exactement ce que l'allocation prend pour la source la plus fiable.
    ...(couronneDetail?.appliquee ? filtresDistance : []),
    ...filtresPrixPremium,
    ...hotelsOnly,
    ...extra,
  ]);

  const overlayPmr = policy.global.overlays?.pmr?.require_accessible !== false;
  const veutPmr = options.pmr === undefined || options.pmr === null ? overlayPmr : Boolean(options.pmr);
  let fPmr = null;
  if (veutPmr) {
    if (!applyAmenities) {
      non_filtrables.push({ prestation: "accessible", cabine: "PMR", raison: "filtres de prestations désactivés (discovery.apply_amenity_filters = false)" });
    } else {
      const acc = AMENITY_NFLT.accessible;
      fPmr = dedupe([...fSocle, { code: acc.code, origine: "prestation", libelle: acc.libelle, prestation: "accessible", exact: true, note: null }]);
    }
  }

  const codes = (l) => l.map((f) => f.code).join(";");
  return {
    socle: codes(fSocle),
    premium: codes(fPremium),
    pmr: fPmr ? codes(fPmr) : null,
    details: {
      filtres: { socle: fSocle, premium: fPremium, pmr: fPmr },
      non_filtrables,
      avertissements,
      rayon,
      /** Couronne qui a RÉELLEMENT filtré (`appliquee: true`), ou pourquoi non. null = aucune demandée. */
      couronne: couronneDetail,
      plafonds_eur: { socle: capSocle.eur, premium: capPremium.eur },
      hypotheses: prixSocle || prixPremium ? [HYPOTHESE_FILTRE_PRIX] : [],
      codes_releves_le: NFLT_CODES_RELEVES_LE,
    },
  };
}

/** URL de recherche de zone (page de résultats) pour une passe de découverte. */
export function buildSearchUrl({ station, checkin, checkout, nflt }) {
  const p = new URLSearchParams({
    ss: station.search.zone_query,
    checkin,
    checkout,
    group_adults: "2",
    no_rooms: "1",
    group_children: "0",
    selected_currency: "EUR",
  });
  const base = `https://www.booking.com/searchresults.fr.html?${p.toString()}`;
  // politique sans aucune exigence : on n'envoie pas un « &nflt= » vide
  return nflt ? `${base}&nflt=${encodeURIComponent(nflt)}` : base;
}

/**
 * C1 — plan de recherche RÉELLEMENT construit : pour chaque passe, l'URL, les filtres
 * appliqués avec leur origine, et ce qui n'a PAS pu être filtré. Destiné au dry-run :
 * l'opérateur voit la recherche qu'il va payer avant de la payer, au lieu de valider
 * une intention qu'il n'a jamais vue.
 *
 * Chaque passe porte aussi `url_sans_filtre_prix` (null s'il n'y a pas de filtre de
 * prix) : la parade si l'hypothèse `HYPOTHESE_FILTRE_PRIX` se révèle fausse.
 *
 * COURONNES (additif) — `couronne` construit le plan pour UNE couronne, `couronnes: true`
 * pour TOUTES celles que la fiche déclare et que le filtre de distance peut atteindre.
 * Sans l'une ni l'autre, le plan est exactement celui d'avant : trois passes, un rayon.
 * Le champ `couronnes` du retour est TOUJOURS présent : il dit ce que la fiche déclare et
 * si ces couronnes sont exploitables, même quand le plan n'en ouvre aucune — c'est ce que
 * le dry-run affiche pour montrer les passes qu'un élargissement ouvrirait.
 *
 * @param {{policy: object, station: object, checkin: string, checkout: string,
 *   needs?: object|null, pmr?: boolean|null, couronne?: object|number|null,
 *   couronnes?: boolean}} args
 * @returns {{station: object, sejour: object, passes: object[], non_filtrables: object[],
 *   avertissements: string[], hypotheses: object[], rayon: object, plafonds_eur: object,
 *   codes_releves_le: string, couronnes: object, couronne: object|null}}
 */
export function buildSearchPlan({ policy, station, checkin, checkout, needs = null, pmr = null, couronne = null, couronnes = false }) {
  const dispo = couronnesRecherche(policy, station);
  const doublons = [];
  const vues = new Map();
  const passes = [];

  const passe = (id, libelle, filtres, chaine, anneau) => {
    if (!filtres || chaine === null) return null;
    const sansPrix = filtres.filter((f) => f.origine !== "prix");
    const aDuPrix = sansPrix.length !== filtres.length;
    return {
      id,
      libelle,
      nflt: chaine,
      url: buildSearchUrl({ station, checkin, checkout, nflt: chaine }),
      url_sans_filtre_prix: aDuPrix ? buildSearchUrl({ station, checkin, checkout, nflt: sansPrix.map((f) => f.code).join(";") }) : null,
      filtres,
      // couronne RÉELLEMENT portée par l'URL (`appliquee: true`), sinon null : une passe
      // qui n'a pas pu filtrer sur la couronne ne doit pas se présenter comme telle
      couronne: anneau?.appliquee ? { rang: anneau.rang, rayon_m: anneau.rayon_m, trajet_min_declare: anneau.trajet_min, mode: anneau.mode, note: anneau.note ?? "" } : null,
    };
  };

  /** Trois passes pour un jeu de filtres donné ; dédupliquées sur la chaîne `nflt`. */
  const ajouter = (nflt, suffixe, libelleAnneau) => {
    const d = nflt.details;
    const anneau = d.couronne;
    for (const p of [
      passe(`socle${suffixe}`, `Socle — plancher commun (cabine Y)${libelleAnneau}`, d.filtres.socle, nflt.socle, anneau),
      passe(`premium${suffixe}`, `Premium — cabines J/W${libelleAnneau}`, d.filtres.premium, nflt.premium, anneau),
      passe(`pmr${suffixe}`, `PMR — socle + accessibilité${libelleAnneau}`, d.filtres.pmr, nflt.pmr, anneau),
    ]) {
      if (!p) continue;
      // deux passes aux filtres identiques (la cabine Y exige déjà l'accessibilité, par
      // exemple) coûteraient deux sessions pour le même résultat
      const jumelle = vues.get(p.nflt);
      if (jumelle !== undefined) {
        doublons.push(`passe « ${p.id} » identique à « ${jumelle} » (mêmes filtres) : non répétée`);
        continue;
      }
      vues.set(p.nflt, p.id);
      passes.push(p);
    }
    return d;
  };

  let d;
  const anneaux = [];
  if (couronnes === true && dispo.exploitables && dispo.couronnes.length > 1) {
    // une passe PAR couronne, de la plus proche à la plus lointaine
    for (const c of dispo.couronnes) {
      const n = buildNflt(policy, station, { needs, pmr, couronne: c });
      const dd = ajouter(n, `_c${c.rang}`, ` — couronne ${c.rang} (≤ ${c.rayon_m} m, ${c.trajet_min} min déclarées)`);
      anneaux.push(dd.couronne);
      d ??= dd;
      if (dd !== d) {
        // les avertissements hors distance sont identiques d'une couronne à l'autre :
        // seuls ceux qui parlent de la couronne méritent d'être répétés
        for (const a of dd.avertissements) if (/couronne/i.test(a) && !d.avertissements.includes(a)) d.avertissements.push(a);
      }
    }
  } else {
    if (couronnes === true && !dispo.exploitables) doublons.push(dispo.raison);
    if (couronnes === true && dispo.exploitables && dispo.couronnes.length <= 1) {
      doublons.push(`une seule couronne ${dispo.source === "declaree" ? "déclarée" : "dérivée"} pour ${station.code} : le plan par couronne est le plan ordinaire`);
    }
    const n = buildNflt(policy, station, { needs, pmr, couronne });
    d = ajouter(n, "", "");
    if (d.couronne) anneaux.push(d.couronne);
  }

  return {
    station: { code: station.code, name: station.name, zone_query: station.search.zone_query },
    sejour: { checkin, checkout },
    passes,
    non_filtrables: d.non_filtrables,
    avertissements: [...d.avertissements, ...doublons],
    hypotheses: d.hypotheses,
    rayon: d.rayon,
    /** Ce que la fiche DÉCLARE et si ces couronnes peuvent filtrer — toujours présent. */
    couronnes: {
      source: dispo.source,
      exploitables: dispo.exploitables,
      raison: dispo.raison,
      liste: dispo.declarees.map((c) => ({ rang: c.rang, rayon_m: c.rayon_m, trajet_min_declare: c.trajet_min, mode: c.mode, note: c.note ?? "" })),
      ouvertes: anneaux.filter((a) => a?.appliquee).map((a) => a.rang),
    },
    /** Couronne du plan quand il n'en porte qu'une, sinon null. */
    couronne: anneaux.length === 1 && anneaux[0]?.appliquee ? { rang: anneaux[0].rang, rayon_m: anneaux[0].rayon_m, trajet_min_declare: anneaux[0].trajet_min, mode: anneaux[0].mode } : null,
    plafonds_eur: d.plafonds_eur,
    codes_releves_le: d.codes_releves_le,
  };
}

/** URL de fiche hôtel avec dates et devise (base 2 adultes, 1 chambre). */
export function buildHotelUrl(candidateUrl, { checkin, checkout }) {
  try {
    const u = new URL(candidateUrl);
    u.search = "";
    u.hash = "";
    const p = new URLSearchParams({ checkin, checkout, group_adults: "2", no_rooms: "1", group_children: "0", selected_currency: "EUR" });
    return `${u.toString()}?${p.toString()}`;
  } catch {
    return candidateUrl;
  }
}

/**
 * URL de sonde de capacité (H-3, tranchée en phase 5 par --probe-capacity) :
 * même fiche hôtel, `no_rooms = n` et `group_adults = 2 × n` pour lire la
 * disponibilité affichée à ce volume. Une sonde ne substitue jamais un hôtel
 * (EX-EXT-5).
 */
export function buildProbeUrl(candidateUrl, { checkin, checkout, noRooms, groupAdults = null }) {
  if (!Number.isInteger(noRooms) || noRooms < 1) throw new Error(`buildProbeUrl : noRooms invalide (${noRooms})`);
  try {
    const u = new URL(candidateUrl);
    u.search = "";
    u.hash = "";
    const p = new URLSearchParams({
      checkin,
      checkout,
      group_adults: String(groupAdults ?? 2 * noRooms),
      no_rooms: String(noRooms),
      group_children: "0",
      selected_currency: "EUR",
    });
    return `${u.toString()}?${p.toString()}`;
  } catch {
    throw new Error(`buildProbeUrl : URL hôtel invalide (${candidateUrl})`);
  }
}
