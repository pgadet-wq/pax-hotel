/**
 * Allocation dossiers → chambres (CDC §7). Fonction PURE et rapide : rejouée après
 * chaque relevé terminé et après chaque sonde pour le plan incrémental (EX-ALL-1),
 * sans effet de bord sur les entrées.
 *
 * Étapes : conformité de chaque hôtel pour chaque tier (plafonds effectifs de
 * l'escale) → stock dédupliqué par type physique, borné par `rooms_available_max`
 * (EX-ALL-5) → parcours des dossiers dans l'ordre de priorité → prise de chambres
 * chez le meilleur hôtel admissible : CONFORME → PARTIELLE → HORS_BAREME (si
 * dérogation) → ESCALADE DESK (EX-ALL-4). Le mode de règlement est porté par
 * chaque ligne ; un hôtel au paiement impossible (carte désactivée) est écarté
 * et l'escalade porte le motif « règlement » (EX-ALL-6).
 */
import { conformityOf, conformityLabel, effectiveCaps } from "./policy.mjs";
import { modeReglement } from "./reglement.mjs";

const LEVEL_RANK = { CONFORME: 0, PARTIELLE: 1, HORS_BAREME: 2 };
const TIER_UP = { Y: "W", W: "J", J: null };

/**
 * Stock d'un hôtel : une ligne par type PHYSIQUE — les variantes tarifaires d'un même
 * type partagent le même stock (dédup : annulation gratuite prioritaire si la politique
 * la préfère, puis la moins chère). La quantité allouable est bornée par
 * `rooms_available_max` (sonde) sinon par la quantité affichée (EX-ALL-5) ;
 * `cap_reached` sans sonde = borne basse, signalée dans le plan. Une quantité non
 * affichée (-1) vaut `assumedStock` et la prise est marquée « à confirmer ».
 */
function buildStock(answer, preferFreeCancel, assumedStock = 6) {
  const byType = new Map();
  for (const r of answer.rooms ?? []) {
    const prev = byType.get(r.room_type);
    const better =
      !prev ||
      (preferFreeCancel && r.free_cancellation && !prev.free_cancellation) ||
      ((!preferFreeCancel || r.free_cancellation === prev.free_cancellation) && r.price_per_night < prev.price_per_night);
    if (better) byType.set(r.room_type, r);
  }
  return [...byType.values()].map((r) => {
    const displayed = r.quantity_available ?? r.quantity_displayed_max ?? 0;
    const probed = r.rooms_available_max ?? null;
    return {
      room_type: r.room_type,
      occupancy_adults: r.occupancy_adults,
      occupancy_children: r.occupancy_children ?? 0,
      family_capable: Boolean(r.family_capable),
      price: r.price_per_night,
      free_cancellation: Boolean(r.free_cancellation),
      breakfast_included: Boolean(r.breakfast_included),
      assumed: displayed < 0 && probed === null,
      capReached: r.cap_reached === true && probed === null,
      left: probed !== null ? Math.max(0, probed) : displayed < 0 ? assumedStock : Math.max(0, displayed),
    };
  });
}

/**
 * @param {object} args
 * @param {Array} args.dossiers sortie de buildDossiers (ordre de priorité respecté)
 * @param {Array} args.inventories relevés, même partiels : [{hotel|hotelKey, sessionId?, contracted?, preferred?, fallback?, payment?, answer}]
 * @param {object} args.policy politique validée
 * @param {object} [args.station] fiche escale (plafond effectif, rayon, transfert) ; null accepté
 * @param {number} [args.nights]
 * @param {boolean} [args.provisoire] true tant qu'un relevé ou une extension est en cours (§5.7)
 * @returns {{plan: Array, summary: object, gaps: object}}
 */
export function allocate({ dossiers, inventories, policy, station = null, nights = 1, provisoire = false, assumedStock = 6 }) {
  const preferFC = policy.global.free_cancellation_preferred;
  const pmrCfg = policy.global.overlays.pmr;
  const caps = effectiveCaps(policy, station);
  const radiusKm = station?.search?.radius_km ?? 5;
  const transfert = station ? `${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min` : "";

  // état interne par hôtel : conformité par tier, règlement, stock mutable (copie locale)
  const hotels = inventories
    .filter((inv) => inv.answer?.found)
    .map((inv) => {
      const conf = {};
      for (const tier of ["J", "W", "Y"]) {
        conf[tier] = conformityOf(inv, policy.cabins[tier], policy.global, { capEur: caps[tier], radiusKm });
      }
      return {
        key: inv.hotelKey ?? inv.hotel,
        name: inv.answer.hotel || inv.name || inv.hotelKey || inv.hotel,
        url: inv.answer.url ?? inv.url ?? "",
        currency: inv.answer.currency || "?",
        sessionId: inv.sessionId ?? "",
        source: inv.contracted === true ? "contracted" : inv.preferred === true ? "preferred" : inv.fallback === true ? "fallback" : "agent",
        // lue directement sur le relevé : la conformité d'un tier peut sortir en
        // NON_CONFORME sans porter les équipements, ce qui perdrait l'accessibilité
        accessible: inv.answer.amenities?.accessible === true,
        reglement: modeReglement({ contracted: inv.contracted === true, payment: inv.payment ?? inv.answer.payment }, policy),
        conf,
        stock: buildStock(inv.answer, preferFC, assumedStock),
      };
    });

  /** Hôtels admissibles pour un tier, triés (niveau puis score, boost distance PMR). */
  function rankedFor(tier, { pmrBoost = false } = {}) {
    const tierPolicy = policy.cabins[tier];
    return hotels
      .map((h) => {
        const c = h.conf[tier];
        if (c.level === "NON_CONFORME") return null;
        if (c.level === "HORS_BAREME" && !tierPolicy.allow_above_cap_if_no_alternative) return null;
        let score = c.score;
        if (pmrBoost && c.parts) {
          score += (pmrCfg.distance_weight_boost - 1) * policy.global.scoring.w_distance * c.parts.distScore;
        }
        return { h, c, score };
      })
      .filter(Boolean)
      .sort((a, b) => LEVEL_RANK[a.c.level] - LEVEL_RANK[b.c.level] || b.score - a.score);
  }

  /** Offres utilisables d'un hôtel pour un tier, triées prix croissant. */
  function usableOffers(h, tier, overCapAllowed) {
    const cap = caps[tier];
    return h.stock.filter((o) => o.left > 0 && (overCapAllowed || o.price <= cap)).sort((a, b) => a.price - b.price);
  }

  /** L'hôtel pourrait-il loger le dossier ? (vérification SANS décrément, pour le motif d'escalade) */
  function couldFit(h, dossier, tier, overCapAllowed) {
    const sorted = usableOffers(h, tier, overCapAllowed);
    if (dossier.familyUnit) {
      return sorted.some((o) => o.left >= 1 && (o.family_capable || o.occupancy_adults + o.occupancy_children >= dossier.adults + dossier.children)) ||
        sorted.some((o) => o.left >= 2 && o.occupancy_adults >= 2);
    }
    return sorted.some((o) => o.left >= dossier.rooms && o.occupancy_adults >= Math.min(2, dossier.adults));
  }

  /** Tente de loger un dossier chez un hôtel ; retourne la prise (stock décrémenté) ou null. */
  function takeRooms(entry, dossier, tier) {
    const { h, c } = entry;
    const overCapAllowed = c.level === "HORS_BAREME";
    const sorted = usableOffers(h, tier, overCapAllowed);

    const take = (offer, count, note = null) => {
      offer.left -= count;
      return { rooms: [{ type: offer.room_type, count, price: offer.price, assumed: offer.assumed, capReached: offer.capReached, occupancy_adults: offer.occupancy_adults, occupancy_children: offer.occupancy_children }], hotel: h, conf: c, note };
    };

    if (dossier.familyUnit) {
      const fit = sorted.find(
        (o) => o.left >= 1 && (o.family_capable || o.occupancy_adults + o.occupancy_children >= dossier.adults + dossier.children),
      );
      if (fit) return take(fit, 1);
      // repli : 2 chambres standard dans le MÊME hôtel (communicantes à confirmer)
      const two = sorted.find((o) => o.left >= 2 && o.occupancy_adults >= 2);
      if (two) return take(two, 2, "communicantes à confirmer");
      return null;
    }

    const fit = sorted.find((o) => o.left >= dossier.rooms && o.occupancy_adults >= Math.min(2, dossier.adults));
    // famille au-delà de l'unité familiale : 2 chambres même hôtel, communicantes à confirmer
    if (fit) return take(fit, dossier.rooms, dossier.overlays.famille && dossier.rooms >= 2 ? "communicantes à confirmer" : null);
    return null;
  }

  const plan = [];
  for (const d of dossiers) {
    const isPmr = d.overlays.pmr;
    let placed = null;
    let tierUsed = d.cabin;
    let paymentBlocked = false;
    let accessBlocked = false;

    // Dossiers HORS PLAN HÔTEL : traitement nominatif au desk (civière, médical, mineur
    // non accompagné) ou pas de droit d'entrée sur le territoire de l'escale (fiche escale
    // `constraints.entry_visa_check` — CDC §5.2 « traitement nominatif GHA »). Ils ne
    // consomment aucun stock et ne nourrissent PAS l'extension : relever plus d'hôtels ne
    // les logera pas.
    // Seul un droit d'entrée REFUSÉ sort du plan. « INCONNU » = à vérifier au comptoir :
    // le dossier reste dans le plan et sa capacité reste provisionnée — sinon l'extension
    // ne chercherait aucune chambre pour lui et l'immigration pourrait l'admettre sans lit.
    const horsPlan = d.escaladeNominative ?? (d.droitEntree === "NON" ? "droit d'entrée" : null);
    const droitAVerifier = d.droitEntree === "INCONNU";

    // Parcours du tier du dossier ; pour un PMR sans solution accessible, on préfère un
    // SURCLASSEMENT de tier (jugé contre la politique du tier supérieur) à une dérogation
    // de prix dans son tier — la dérogation HORS_BAREME reste le dernier recours.
    const tryTier = (tier, { allowOverCap }) => {
      for (const entry of rankedFor(tier, { pmrBoost: isPmr })) {
        if (!allowOverCap && entry.c.level === "HORS_BAREME") continue;
        if (isPmr && pmrCfg.require_accessible && !entry.h.accessible) {
          // l'hôtel aurait pu loger le dossier : c'est l'accessibilité qui bloque, pas la capacité
          if (couldFit(entry.h, d, tier, entry.c.level === "HORS_BAREME")) accessBlocked = true;
          continue;
        }
        if (entry.h.reglement.escalade) {
          // paiement impossible et carte désactivée : hôtel écarté (EX-ALL-6)
          if (couldFit(entry.h, d, tier, entry.c.level === "HORS_BAREME")) paymentBlocked = true;
          continue;
        }
        const taken = takeRooms(entry, d, tier);
        if (taken) {
          tierUsed = tier;
          return taken;
        }
      }
      return null;
    };
    if (!horsPlan) {
      placed = tryTier(d.cabin, { allowOverCap: !isPmr });
      if (!placed && isPmr && pmrCfg.allow_tier_upgrade) {
        for (let tier = TIER_UP[d.cabin]; tier && !placed; tier = TIER_UP[tier]) {
          placed = tryTier(tier, { allowOverCap: false });
        }
      }
      if (!placed && isPmr) placed = tryTier(d.cabin, { allowOverCap: true });
    }

    const notes = [];
    if (horsPlan === "droit d'entrée") {
      notes.push("droit d'entrée refusé : hébergement en ville impossible, traitement nominatif GHA (zone de transit)");
    } else if (horsPlan) {
      notes.push(`${horsPlan} : prise en charge nominative par le desk, hors plan hôtel`);
    }
    if (droitAVerifier) notes.push("SOUS RÉSERVE : droit d'entrée à vérifier au comptoir — chambre provisionnée, à annuler si l'entrée est refusée");
    if (isPmr) notes.push("PMR : chambre accessible + transfert adapté à confirmer par l'hôtel");
    for (const n of d.ssrNotes ?? []) notes.push(n);
    if (d.overlays.animal) notes.push("animal en cabine/soute : hôtel acceptant les animaux à confirmer (critère non relevé)");
    if (d.overlays.groupe) notes.push(`groupe ${d.groupe} : chambrage de l'organisateur${d.roomsSource === "liste" ? "" : " NON fourni — appariement deviné"}`);
    if (placed?.note) notes.push(placed.note);
    if (d.infants) notes.push("berceau à demander");
    if (placed && tierUsed !== d.cabin) notes.push(`surclassement de tier ${d.cabin} → ${tierUsed} (accessibilité)`);
    if (placed) {
      const couchages = placed.rooms.reduce((s2, r) => s2 + r.count * ((r.occupancy_adults ?? 2) + (r.occupancy_children ?? 0)), 0);
      const personnes = d.adults + d.children; // les nourrissons ne consomment pas de capacité
      if (couchages && couchages < personnes) {
        notes.push(`COUCHAGES : ${couchages} place(s) déclarée(s) pour ${personnes} personnes — lit d'appoint ou chambre supplémentaire à confirmer avec l'hôtel`);
      }
    }
    if (placed?.rooms.some((r) => r.assumed)) notes.push("quantité non affichée par le site — stock supposé, à confirmer");
    if (placed?.rooms.some((r) => r.capReached)) notes.push("quantité plafonnée par l'affichage (borne basse, sonde possible)");

    const motif = horsPlan ?? (accessBlocked ? "accessibilité" : paymentBlocked ? "règlement" : "capacité");
    const sousReserve = droitAVerifier && placed ? "droit d'entrée à vérifier" : "";
    const chambres = placed ? placed.rooms.reduce((s, r) => s + r.count, 0) : d.rooms;
    plan.push({
      pnr: d.pnr,
      occupants: d.occupants,
      pax: d.adults + d.children + d.infants,
      cabine: d.cabin,
      overlays: [
        d.overlays.pmr ? "PMR" : null,
        d.overlays.famille ? "FAMILLE" : null,
        d.overlays.groupe ? "GROUPE" : null,
        d.overlays.animal ? "ANIMAL" : null,
      ].filter(Boolean).join("+"),
      categorie: d.file,
      hotel: placed ? placed.hotel.name : "",
      hotel_url: placed ? placed.hotel.url : "",
      room_type: placed ? placed.rooms[0].type : "",
      chambres,
      prix_total: placed ? placed.rooms.reduce((s, r) => s + r.count * r.price, 0) * nights : "",
      devise: placed ? placed.hotel.currency : "",
      conformite: placed ? conformityLabel(placed.conf) : "",
      mode_reglement: placed ? placed.hotel.reglement.mode : "",
      hotel_source: placed ? placed.hotel.source : "",
      provisoire,
      session_ref: placed ? placed.hotel.sessionId : "",
      transfert,
      escalade: placed ? "" : `DESK (${motif})`,
      statut: placed ? "OK" : "ESCALADE DESK",
      hors_plan: horsPlan ?? "",
      sous_reserve: sousReserve,
      notes: notes.join(" ; "),
    });
  }

  // synthèse et manques (les manques par tier nourrissent l'extension, phase 3).
  // Un dossier HORS PLAN (nominatif, droit d'entrée) est escaladé mais ne crée PAS de
  // manque : il ne faut pas dépenser des sessions d'agents à chercher des chambres
  // qu'il ne prendra pas.
  const summary = { parTier: {}, coutParDevise: {}, ok: 0, escalade: 0, horsPlan: 0, motifs: {}, paxLoges: 0, paxNonLoges: 0 };
  const gaps = { chambresManquantes: {} };
  for (const row of plan) {
    const t = row.cabine;
    summary.parTier[t] ??= { ok: 0, escalade: 0, chambres: 0 };
    if (row.statut === "OK") {
      summary.ok += 1;
      summary.paxLoges += Number(row.pax) || 0;
      summary.parTier[t].ok += 1;
      summary.parTier[t].chambres += row.chambres;
      if (row.prix_total !== "") {
        summary.coutParDevise[row.devise] = (summary.coutParDevise[row.devise] ?? 0) + Number(row.prix_total);
      }
    } else {
      summary.escalade += 1;
      summary.paxNonLoges += Number(row.pax) || 0;
      summary.parTier[t].escalade += 1;
      const motifRow = row.escalade.replace(/^DESK \(|\)$/g, "");
      summary.motifs[motifRow] = (summary.motifs[motifRow] ?? 0) + 1;
      if (row.hors_plan) summary.horsPlan += 1;
      else gaps.chambresManquantes[t] = (gaps.chambresManquantes[t] ?? 0) + row.chambres;
    }
  }
  return { plan, summary, gaps };
}
