/**
 * Construction d'URL Booking et de filtres `nflt` — partie PURE du futur
 * `lib/hai.mjs` (CDC §6.2, EX-DIS-3). Séparée pour que la phase 2 reste sans
 * import de `hai-agents` ; la phase 3 (`lib/hai.mjs`) réexportera ces fonctions.
 */

/** Codes de filtres Booking vérifiés le 11/09/2026 (paramètre nflt, séparés par ';'). */
export const NFLT = {
  stars: (n) => `class=${n}`,
  review7plus: "review_score=70",
  review8plus: "review_score=80",
  breakfast: "mealplan=1",
  wifi: "hotelfacility=107",
  shuttle: "hotelfacility=17",
  roomService: "hotelfacility=5",
  reception24h: "hotelfacility=8",
  restaurant: "hotelfacility=3",
  accessible: "hotelfacility=185",
  distanceKm: (km) => `distance=${Math.round(km * 1000)}`,
  freeCancel: "fc=2",
  hotelsOnly: "ht_id=204",
};

/**
 * Filtres des deux passes de découverte, dérivés de la politique ET de la fiche
 * escale (EX-DIS-3) : `distance=` est omis quand `use_distance_filter = false`
 * (rayon relevé par l'agent, jugé par le score) ; `extra_nflt` est ajouté aux
 * deux passes. Socle Y : classes ≥ min Y, wifi, note, hôtels seulement ;
 * passe premium : 4-5★ + room service.
 */
export function buildNflt(policy, station) {
  const disc = policy.global.discovery;
  const search = station.search;
  const minStarsY = policy.cabins.Y.min_stars || 3;
  const starsAll = [];
  for (let s = Math.max(1, minStarsY); s <= 5; s += 1) starsAll.push(NFLT.stars(s));
  const review =
    disc.min_review_score >= 8 ? NFLT.review8plus : disc.min_review_score >= 7 ? NFLT.review7plus : disc.min_review_score >= 6 ? "review_score=60" : null;
  const distance = search.use_distance_filter ? [NFLT.distanceKm(search.radius_km)] : [];
  const extra = search.extra_nflt ?? [];
  const socle = [...starsAll, NFLT.wifi, ...(review ? [review] : []), ...distance, NFLT.hotelsOnly, ...extra];
  const premium = [NFLT.stars(4), NFLT.stars(5), NFLT.roomService, NFLT.hotelsOnly, ...extra];
  return { socle: socle.join(";"), premium: premium.join(";") };
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
  return `https://www.booking.com/searchresults.fr.html?${p.toString()}&nflt=${encodeURIComponent(nflt)}`;
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
