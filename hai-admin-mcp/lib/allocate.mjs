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
 *
 * C2 — le stock est à DEUX NIVEAUX, et il le DIT. Niveau 1 « ferme » : chambres
 * adossées à une mesure sûre (sélecteur non plafonné, ou sonde non plafonnée).
 * Niveau 2 « à confirmer » : chambres adossées à un sélecteur plafonné, donc à une
 * BORNE BASSE. Le niveau 2 reste ALLOUABLE — le plafond de prudence ne supprime plus
 * de chambres du plan, il ne fait que basculer en niveau 2 ce qui n'est pas mesuré —
 * mais chaque ligne qui en consomme porte `stock_mesure: false`, le décompte
 * `chambres_fermes` / `chambres_a_confirmer`, et une note explicite. Seule une vraie
 * mesure d'hôtel (sonde non plafonnée) borne encore
 * le total ; la vraisemblance reste bornée par `room_qty_sane_max`. Chaque ligne dit
 * aussi si les couchages suffisent (`couchages_insuffisants`).
 * C3 — la cabine pilote le FORMAT de chambre (`policy.cabins[tier].room_type_patterns`).
 * COURONNES (politique de prise en charge) — la DISTANCE joue désormais dans l'affectation,
 * et pas seulement dans un score. Chaque hôtel est rangé dans une couronne de la fiche
 * escale (`couronnesDe()`), et le `trajet_min` DÉCLARÉ de cette couronne est opposé au
 * budget de trajet du dossier (`dossier.trajet_max_min`, calculé sur l'heure du vol
 * suivant) comme une CONTRAINTE DURE : aucun rang de service ne permet de l'outrepasser.
 * Le réglage `proximite` du critère de la file n'est qu'une PRÉFÉRENCE, qui cède toujours
 * devant le budget d'un autre dossier (voir `reserveProcheBloque`). Un temps de trajet est
 * DÉCLARÉ par l'exploitation, jamais mesuré : l'outil n'a aucun service de routage et ne
 * convertit pas une distance en durée. Chaque ligne porte sa couronne, son temps déclaré
 * et le budget du dossier ; le résumé les ventile par couronne.
 * C6 — la ligne porte aussi le CRÉNEAU de passage au comptoir (`creneau_presentation`) et
 * la justification du mode de règlement (`reglement_source`) : sans eux, le validateur
 * signe une répartition qui convoque tous les dossiers à la même minute et qui ne dit pas
 * pourquoi telle chambre se règle par carte.
 */
import { conformityOf, conformityLabel, effectiveCaps } from "./policy.mjs";
import { couronnesDe } from "./stations.mjs";
import { modeReglement } from "./reglement.mjs";

const LEVEL_RANK = { CONFORME: 0, PARTIELLE: 1, HORS_BAREME: 2 };
const TIER_UP = { Y: "W", W: "J", J: null };

/* ------------------------------------------ Couronnes et budget de trajet (C1/C7) */

/**
 * RÈGLE DE PRUDENCE pour un hôtel dont la couronne n'a pas pu être déterminée.
 *
 * Un hôtel sans couronne n'est PAS proche par défaut : le supposer proche reviendrait à
 * envoyer un passager qui repart dans 6 h vers un hôtel dont personne ne sait s'il est à
 * 4 ou à 40 km. Il est donc rattaché à la couronne la plus LOINTAINE déclarée par la
 * fiche escale — la borne la moins favorable, jamais un chiffre rassurant — et chaque
 * ligne de plan qui en consomme le dit en toutes lettres.
 */
export const PRUDENCE_COURONNE_INCONNUE =
  "couronne non déterminée — rattachée PAR PRUDENCE à la couronne la plus lointaine déclarée";

/**
 * Distance à l'aéroport RÉELLEMENT MESURÉE d'une entrée d'inventaire, en km, ou `null`.
 *
 * Trois pièges, tous rencontrés sur l'inventaire BKK réel :
 *  - `-1` (relevé) et `null` (fiche) signifient « non affichée », pas « à l'aéroport » ;
 *  - un `0` sans référence de distance signifie « non mesuré » : sur 9 hôtels BKK, 2
 *    portent ce `0`. Or `toReleveAnswer()` (hai.mjs) remplit `answer.distance_ref` par
 *    DÉFAUT à « airport » quand le candidat n'en porte pas — la référence du relevé ne
 *    peut donc pas servir à valider un `0`. Seule une référence portée par l'ENTRÉE
 *    elle-même (`inv.distance_ref`) rend un `0` crédible ; sinon il est écarté ;
 *  - une distance relevée depuis le centre de zone n'est pas une distance à l'aéroport :
 *    quand les deux références sont connues et diffèrent, elle n'est pas comparable aux
 *    couronnes de la fiche et n'est donc pas retenue.
 *
 * @param {object} inv entrée d'inventaire {answer, distance_ref?, candidate?}
 * @param {string|null} refStation `station.search.distance_ref`
 * @returns {number|null} distance en km, ou null si rien n'a été mesuré
 */
function distanceMesuree(inv, refStation) {
  const a = inv?.answer ?? {};
  const brute = a.distance_km ?? a.distance_to_airport_km ?? inv?.distance_km ?? null;
  // `Number(null)` vaut 0 : sans ce test, un hôtel SANS distance relevée (5 des 9 hôtels
  // de l'inventaire BKK) passerait pour un hôtel à 0 km, c'est-à-dire le plus proche.
  if (brute === null || brute === undefined || brute === "") return null;
  const d = Number(brute);
  if (!Number.isFinite(d) || d < 0) return null;
  // référence PORTÉE PAR L'ENTRÉE : la seule qui n'ait pas pu être remplie par défaut
  const refEntree = inv?.distance_ref ?? inv?.candidate?.distance_ref ?? null;
  if (d === 0 && !refEntree) return null; // « 0 sans distance_ref » = non mesuré
  const ref = refEntree ?? a.distance_ref ?? null;
  if (ref && refStation && ref !== refStation) return null; // origines différentes : non comparable
  return d;
}

/**
 * Couronne d'un hôtel, par ordre de FIABILITÉ DÉCROISSANTE (lot « distance à
 * l'allocation ») :
 *  a. la couronne de la passe de recherche qui l'a trouvé, quand l'entrée la porte
 *     (champ `couronne`, alimenté par le lot découverte — son absence est le cas normal
 *     aujourd'hui et ne doit rien casser) ;
 *  b. sa distance, quand c'est une vraie mesure (voir `distanceMesuree`) ;
 *  c. sinon la RÈGLE DE PRUDENCE (`PRUDENCE_COURONNE_INCONNUE`).
 *
 * Cas distinct : un hôtel dont la distance MESURÉE dépasse la dernière couronne déclarée.
 * Aucun temps de trajet déclaré ne le couvre — il n'est donc admissible pour AUCUN budget
 * de trajet, seulement pour les dossiers qui n'en ont pas.
 *
 * @returns {{couronne: object, source: "passe"|"distance"|"inconnue"|"hors_couronnes", distance_km: number|null}}
 */
function couronneDeHotel(inv, couronnes, refStation) {
  const derniere = couronnes[couronnes.length - 1];
  const portee = inv?.couronne ?? inv?.answer?.couronne ?? null;
  const rangPorte = Number(portee?.rang ?? portee);
  if (Number.isFinite(rangPorte)) {
    const c = couronnes.find((x) => x.rang === rangPorte);
    if (c) return { couronne: c, source: "passe", distance_km: distanceMesuree(inv, refStation) };
    // rang annoncé qui ne correspond à aucune couronne de la fiche : on ne l'invente pas
  }
  const d = distanceMesuree(inv, refStation);
  if (d !== null) {
    const c = couronnes.find((x) => d * 1000 <= x.rayon_m);
    if (c) return { couronne: c, source: "distance", distance_km: d };
    return { couronne: derniere, source: "hors_couronnes", distance_km: d };
  }
  return { couronne: derniere, source: "inconnue", distance_km: null };
}

/**
 * Budget de trajet d'un dossier, en minutes — CONTRAINTE DURE de l'allocation.
 * Produit par `buildDossiers()` à partir de l'heure du vol suivant. Absent ou illisible
 * = `null` = aucune contrainte (comportement d'avant les couronnes, préservé).
 * @returns {number|null}
 */
function budgetTrajet(dossier) {
  const brut = dossier?.trajet_max_min;
  // `Number(null)` vaut 0 : sans ce test, un dossier SANS budget (le cas de tous les
  // dossiers tant qu'aucune heure de correspondance n'est fournie) se retrouverait avec
  // un budget de 0 minute et le plan entier sortirait en escalade.
  if (brut === null || brut === undefined || brut === "") return null;
  const v = Number(brut);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Réglage `proximite` du critère de la file du dossier (politique de prise en charge).
 * Le dossier peut le porter directement ; sinon il est lu sur le critère homonyme de sa
 * file. Politique sans `prise_en_charge` (enregistrée avant le 21/09/2026) = « aucune »,
 * c'est-à-dire aucune préférence de proximité : seul le budget de trajet limite.
 * @returns {"stricte"|"preferee"|"aucune"}
 */
function proximiteDe(dossier, criteres) {
  const direct = dossier?.proximite;
  if (direct === "stricte" || direct === "preferee" || direct === "aucune") return direct;
  const c = criteres.find((x) => x?.cle === dossier?.file && x?.actif !== false);
  const p = c?.proximite;
  return p === "stricte" || p === "preferee" ? p : "aucune";
}

/** Motifs de format de chambre d'une cabine (C3), normalisés une fois par tier. */
const patternsOf = (tierPolicy) =>
  (tierPolicy?.room_type_patterns ?? []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);

/** Le libellé relevé correspond-il au format attendu par la cabine ? */
const matchFormat = (label, patterns) => {
  const l = String(label ?? "").toLowerCase();
  return patterns.some((p) => l.includes(p));
};

/**
 * Bornes de stock (C2), lues sur `policy.extension`. Une politique incomplète
 * (appelant qui construit sa politique à la main) ne fait pas tomber l'allocation,
 * mais le repli est DIT : il part dans `summary.avertissements`.
 *
 * `hotel_cap_without_probe` n'est PLUS un couperet : il ne retranche plus de chambres
 * du plan (une chambre non mesurée se planifie et se confirme par téléphone, elle ne
 * se supprime pas). Il devient le SEUIL DE VIGILANCE au-delà duquel le volume « à
 * confirmer » engagé chez un même hôtel est signalé au validateur et l'hôtel désigné
 * comme prioritaire à sonder. `room_qty_sane_max` reste, lui, un vrai garde-fou de
 * vraisemblance par type de chambre.
 */
function stockLimits(policy, warn = () => {}) {
  const ext = policy?.extension ?? {};
  const num = (cle, defaut) => {
    const v = Number(ext[cle]);
    if (Number.isFinite(v) && v > 0) return v;
    warn(`politique sans « extension.${cle} » : repli sur ${defaut} (valeur par défaut du schéma) pour borner le stock`);
    return defaut;
  };
  return { hotelCapSansSonde: num("hotel_cap_without_probe", 20), qtySaneMax: num("room_qty_sane_max", 60) };
}

/* La fiche d'inventaire ne borne RIEN ici, et c'est délibéré.
 * `capacity_hint.rooms_displayed_max` est défini par le prompt d'inventaire comme « la plus
 * grande quantité sélectionnable vue dans le tableau » (hai.mjs, recherche à `no_rooms=1`) :
 * c'est un maximum PAR TYPE de chambre, relevé hôtel par hôtel comme BORNE BASSE
 * (inventaire.mjs, « Borne basse assumée ») — jamais un total d'établissement.
 * Le lire comme un plafond d'hôtel divisait le plan par deux sur l'inventaire BKK réel
 * (20 dossiers logés → 9) et présentait l'écart au validateur comme une « capacité MESURÉE ».
 * Si un vrai total d'hôtel doit un jour borner sans sonde, il lui faut un champ distinct,
 * relevé à `no_rooms = n` comme la sonde — pas ce champ-ci.
 */

/**
 * Stock d'un hôtel : une ligne par type PHYSIQUE — les variantes tarifaires d'un même
 * type partagent le même stock (dédup : annulation gratuite prioritaire si la politique
 * la préfère, puis la moins chère). La quantité allouable est bornée par
 * `rooms_available_max` (sonde) sinon par la quantité affichée (EX-ALL-5) ;
 * `cap_reached` sans sonde = borne basse, signalée dans le plan. Une quantité non
 * affichée (-1) vaut `assumedStock` et la prise est marquée « à confirmer ».
 *
 * C2 : une quantité au-dessus de `room_qty_sane_max` n'est pas une bonne nouvelle,
 * c'est un relevé faux (un agent qui lit un prix ou un numéro de chambre) — elle est
 * ramenée au plafond de prudence AVEC avertissement. Chaque ligne porte la qualité de
 * sa mesure (`mesure`), seul moyen pour le validateur de distinguer un stock compté
 * d'un stock supposé.
 */
function buildStock(answer, preferFreeCancel, assumedStock = 6, limits = { hotelCapSansSonde: 20, qtySaneMax: 60 }, warn = () => {}) {
  const byType = new Map();
  for (const r of answer.rooms ?? []) {
    const prev = byType.get(r.room_type);
    const better =
      !prev ||
      (preferFreeCancel && r.free_cancellation && !prev.free_cancellation) ||
      ((!preferFreeCancel || r.free_cancellation === prev.free_cancellation) && r.price_per_night < prev.price_per_night);
    if (better) byType.set(r.room_type, r);
  }
  const hotelName = answer.hotel ?? "";
  return [...byType.values()].map((r) => {
    let displayed = r.quantity_available ?? r.quantity_displayed_max ?? 0;
    if (displayed > limits.qtySaneMax) {
      warn(`« ${hotelName} » / ${r.room_type} : ${displayed} chambres annoncées pour UN type — relevé jugé aberrant (> ${limits.qtySaneMax}), quantité ramenée à ${limits.hotelCapSansSonde} (plafond de prudence)`);
      displayed = limits.hotelCapSansSonde;
    }
    let probed = r.rooms_available_max ?? null;
    if (probed !== null && probed > limits.qtySaneMax) {
      warn(`« ${hotelName} » / ${r.room_type} : sonde à ${probed} chambres — au-dessus du seuil de vraisemblance (${limits.qtySaneMax}), valeur ramenée à ${limits.hotelCapSansSonde}`);
      probed = limits.hotelCapSansSonde;
    }
    const assumed = displayed < 0 && probed === null;
    const capReached = r.cap_reached === true && probed === null;
    // type dont l'affichage était plafonné et qu'une sonde a débloqué : il peut
    // puiser dans le supplément PARTAGÉ de l'hôtel (voir `liftBudget`)
    const liftable = r.rooms_max_is_hotel_cap === true;
    return {
      room_type: r.room_type,
      occupancy_adults: r.occupancy_adults,
      occupancy_children: r.occupancy_children ?? 0,
      family_capable: Boolean(r.family_capable),
      price: r.price_per_night,
      free_cancellation: Boolean(r.free_cancellation),
      breakfast_included: Boolean(r.breakfast_included),
      assumed,
      capReached,
      liftable,
      // qualité de la MESURE (C2) : « ferme » = compté ; « borne_basse » = affichage
      // plafonné, ou sonde elle-même encore plafonnée ; « supposee » = rien d'affiché.
      mesure: assumed ? "supposee" : capReached || liftable ? "borne_basse" : "ferme",
      left:
        r.rooms_max_is_hotel_cap === true
          ? (displayed < 0 ? 0 : Math.max(0, displayed)) // la quantité affichée reste acquise
          : probed !== null
            ? Math.max(0, probed)
            : displayed < 0
              ? assumedStock
              : Math.max(0, displayed),
    };
  });
}

/**
 * Etat de stock d'un hotel : plafond du TOTAL prenable chez lui, supplement partage par
 * les types dont l'affichage etait plafonne, et VENTILATION du stock en deux niveaux.
 *
 * Deux niveaux, et un seul principe : on ne borne QUE sur une mesure.
 *  - niveau 1 « ferme » : le selecteur n'etait pas plafonne (affichage complet), ou une
 *    sonde non plafonnee a compte l'hotel. Ces chambres sont acquises ET bornantes.
 *  - niveau 2 « a confirmer » : le selecteur plafonnait (Booking s'arrete a ~9 par type),
 *    l'affichage n'est qu'une BORNE BASSE. Ces chambres restent ALLOUABLES : refuser de
 *    les planifier parce qu'un robot n'a pas su les compter transformait un coup de
 *    telephone a l'hotel en escalade au comptoir (mesure : 128 escalades « capacite »).
 *    Elles sont marquees ligne par ligne, et comptees a part dans tous les livrables.
 *
 * Ce qui borne encore le total d'un hotel : une sonde NON plafonnee (`rooms_probe_ferme`).
 * Rien d'autre — la fiche d'inventaire ne borne pas (voir la note ci-dessus), et `hotel_cap_without_probe` ne
 * retranche plus rien, il ne sert qu'a signaler le volume non mesure (voir `stockLimits`).
 * La vraisemblance, elle, reste bornee par type dans `buildStock` (`room_qty_sane_max`).
 */
function sondeDe(answer, stock, limits = { hotelCapSansSonde: 20 }) {
  const M = Number(answer.rooms_available_max_hotel);
  const affiche = stock.reduce((n, o) => n + o.left, 0);
  const ferme = answer.rooms_probe_ferme === true;
  const sonde = Number.isFinite(M) && M >= 0;
  // sonde non plafonnee : le total de l'hotel est MESURE, les types qui n'etaient
  // qu'une borne basse le sont sous ce total
  if (sonde && ferme) for (const o of stock) if (o.mesure === "borne_basse") o.mesure = "ferme";
  const mesure = stock.reduce((n, o) => n + (o.mesure === "ferme" ? o.left : 0), 0);
  const ventilation = { fermeMax: mesure, aConfirmerMax: Math.max(0, affiche - mesure), afficheMax: affiche };
  if (!sonde) {
    // Sans sonde, le total vaut l'affichage cumule : la part non mesuree part en niveau 2,
    // elle ne disparait pas. Rien d'autre ne borne — voir la note sur la fiche d'inventaire.
    const hotelCap = affiche;
    return {
      hotelCap,
      capSource: mesure >= affiche ? "affichage_ferme" : "affichage_borne_basse",
      capBride: false,
      probeMax: null, probeFerme: false, liftBudget: 0, liftUsed: 0, stock, ...ventilation,
    };
  }
  const plafond = ferme ? M : Math.max(affiche, M);
  return {
    hotelCap: plafond,
    capSource: ferme ? "sonde_ferme" : "sonde_borne_basse",
    capBride: plafond < affiche,
    probeMax: M, probeFerme: ferme, liftBudget: Math.max(0, plafond - affiche), liftUsed: 0, stock,
    ...ventilation,
    // supplement de sonde encore plafonnee : des chambres de plus, mais toujours non mesurees
    aConfirmerMax: ventilation.aConfirmerMax + (ferme ? 0 : Math.max(0, plafond - affiche)),
  };
}

/* ------------------------------------------------- C6 : créneaux de présentation */

/** Minutes depuis minuit → « HH:MM », replié sur 24 h (une convocation peut passer minuit). */
function hhmm(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Heure locale escale d'un instant, en minutes depuis minuit. Aucune heure n'est
 * inventée : un fuseau absent est DIT (repli UTC signalé), une valeur illisible rend
 * `null` et le run repart sans créneau.
 * @returns {number|null}
 */
function minutesLocales(valeur, timezone, warn) {
  if (typeof valeur === "string" && /^\d{1,2}:\d{2}$/.test(valeur.trim())) {
    const [h, m] = valeur.trim().split(":").map(Number);
    if (h > 23 || m > 59) return null;
    return h * 60 + m; // déjà exprimée en heure locale escale par l'appelant
  }
  const d = valeur instanceof Date ? valeur : typeof valeur === "number" || typeof valeur === "string" ? new Date(valeur) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  let tz = timezone;
  if (!tz) {
    warn("créneaux de présentation : fuseau de l'escale inconnu — horaires exprimés en UTC, à vérifier avant diffusion aux passagers");
    tz = "UTC";
  }
  try {
    const parts = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    warn(`créneaux de présentation : fuseau « ${tz} » inconnu du système — aucun créneau produit`);
    return null;
  }
}

/**
 * Étale les convocations au comptoir (C6). Sans créneau, 62 dossiers sont priés de se
 * présenter « immédiatement » : la file se forme, le comptoir sature, et le message
 * passager ment sur ce qui l'attend. On répartit donc les dossiers par blocs :
 *
 *  - un hôtel = un bloc CONTIGU, dans l'ordre d'appel (le plus gros bloc d'abord) —
 *    c'est aussi l'ordre des bus ;
 *  - à l'intérieur d'un bloc, l'ordre du plan, qui est l'ordre de PRIORITÉ (PMR,
 *    familles, puis cabines) : les dossiers prioritaires partent dans les premiers créneaux ;
 *  - les dossiers escaladés (sans hôtel) ferment la marche : leur solution se cherche
 *    au comptoir, les convoquer en premier occuperait la file pour rien ;
 *  - les dossiers HORS PLAN (civière, médical, mineur non accompagné, droit d'entrée)
 *    ne reçoivent AUCUN créneau : ils sont pris en charge nominativement, pas convoqués.
 *
 * Fonction pure : elle écrit `creneau_presentation` sur les lignes fournies et rend le
 * récapitulatif. Aucun horaire n'est produit quand l'option n'est pas fournie.
 *
 * @param {Array<object>} plan lignes du plan (mutées : champ `creneau_presentation`)
 * @param {object|null} presentation {debut, pas_minutes?, par_creneau?, fenetre_minutes?, timezone?}
 * @param {string|null} timezoneEscale fuseau de la fiche escale (repli du champ `timezone`)
 * @param {(m: string) => void} warn
 * @returns {object|null} {dossiers, debut, fin, pas_minutes, par_creneau, creneaux} ou null
 */
function planifierCreneaux(plan, presentation, timezoneEscale, warn) {
  for (const row of plan) row.creneau_presentation = "";
  if (!presentation) return null;
  const tz = presentation.timezone ?? timezoneEscale ?? null;
  const base = minutesLocales(presentation.debut, tz, warn);
  if (base === null) {
    warn(
      `créneaux de présentation : heure de début illisible (${String(presentation.debut)}) — aucun créneau produit, ` +
        "tous les dossiers restent convoqués sans horaire",
    );
    return null;
  }
  const pas = Number(presentation.pas_minutes);
  const pasMin = Number.isFinite(pas) && pas > 0 ? Math.round(pas) : 15;
  if (presentation.pas_minutes !== undefined && pasMin !== presentation.pas_minutes) {
    warn(`créneaux de présentation : pas_minutes illisible (${String(presentation.pas_minutes)}) — repli sur ${pasMin} minutes`);
  }

  // blocs : un par hôtel (ordre d'appel), puis un bloc « comptoir » pour les escalades
  const parHotel = new Map();
  const comptoir = [];
  for (const row of plan) {
    if (row.hors_plan) continue; // prise en charge nominative : jamais convoqué
    if (row.statut === "OK" && row.hotel) {
      if (!parHotel.has(row.hotel)) parHotel.set(row.hotel, []);
      parHotel.get(row.hotel).push(row);
    } else comptoir.push(row);
  }
  const blocs = [...parHotel.values()].sort(
    (a, b) => b.reduce((s, r) => s + (Number(r.chambres) || 0), 0) - a.reduce((s, r) => s + (Number(r.chambres) || 0), 0),
  );
  if (comptoir.length) blocs.push(comptoir);
  const total = blocs.reduce((s, b) => s + b.length, 0);
  if (!total) return null;

  // Capacité d'un créneau : soit imposée, soit déduite de la fenêtre acceptée par
  // l'exploitation. Un bloc commence toujours sur un créneau neuf (un bus par hôtel).
  // une consigne FOURNIE mais illisible n'est jamais ignorée en silence (règle projet) :
  // sans ce mot, le validateur croit que l'étalement suit la capacité qu'il a demandée,
  // et dimensionne son comptoir sur un chiffre que le moteur n'a pas retenu.
  const fourni = (v) => v !== undefined && v !== null && v !== "";
  let parCreneau = Number(presentation.par_creneau);
  const fenetre = Number(presentation.fenetre_minutes);
  if (!Number.isFinite(parCreneau) || parCreneau < 1) {
    if (fourni(presentation.par_creneau)) {
      warn(`créneaux de présentation : par_creneau illisible (${String(presentation.par_creneau)}) — consigne ignorée, capacité de créneau recalculée`);
    }
    if (Number.isFinite(fenetre) && fenetre >= pasMin) {
      const creneauxDispo = Math.max(1, Math.floor(fenetre / pasMin) - (blocs.length - 1));
      parCreneau = Math.max(1, Math.ceil(total / creneauxDispo));
    } else {
      if (fourni(presentation.fenetre_minutes)) {
        warn(`créneaux de présentation : fenetre_minutes inexploitable (${String(presentation.fenetre_minutes)} pour un pas de ${pasMin} min) — repli sur 6 dossiers par créneau`);
      }
      parCreneau = 6;
    }
  } else parCreneau = Math.round(parCreneau);

  let creneau = 0;
  // OCCUPATION RÉELLE, créneau par créneau. `par_creneau` est une CAPACITÉ (le plafond
  // d'un créneau), pas une répartition : chaque bloc commence sur un créneau neuf, donc
  // le dernier créneau d'un bloc est partiel. Annoncer la seule capacité invitait à
  // multiplier (8 × 32 = 256 pour 157 dossiers convoqués) et à armer un comptoir pour un
  // flux constant que le plan ne produit jamais.
  const occupation = [];
  for (const bloc of blocs) {
    for (const [i, row] of bloc.entries()) {
      const rang = creneau + Math.floor(i / parCreneau);
      occupation[rang] = (occupation[rang] ?? 0) + 1;
      row.creneau_presentation = { debut: hhmm(base + rang * pasMin), fin: hhmm(base + (rang + 1) * pasMin) };
    }
    creneau += Math.ceil(bloc.length / parCreneau);
  }
  const serie = Array.from({ length: creneau }, (_, i) => occupation[i] ?? 0);
  return {
    dossiers: total,
    creneaux: creneau,
    debut: hhmm(base),
    fin: hhmm(base + creneau * pasMin),
    pas_minutes: pasMin,
    par_creneau: parCreneau,
    // ce qui dimensionne réellement le comptoir : le pic, le creux, la série
    occupation: serie,
    occupation_min: serie.length ? Math.min(...serie) : 0,
    occupation_max: serie.length ? Math.max(...serie) : 0,
    fuseau: tz ?? "UTC",
  };
}

/**
 * @param {object} args
 * @param {Array} args.dossiers sortie de buildDossiers (ordre de priorité respecté)
 * @param {Array} args.inventories relevés, même partiels : [{hotel|hotelKey, sessionId?, contracted?, preferred?, fallback?, payment?, answer}]
 * @param {object} args.policy politique validée
 * @param {object} [args.station] fiche escale (plafond effectif, rayon, transfert) ; null accepté
 * @param {number} [args.nights]
 * @param {boolean} [args.provisoire] true tant qu'un relevé ou une extension est en cours (§5.7)
 * @param {object|null} [args.presentation] C6 — étalement des convocations au comptoir.
 *   `{debut, pas_minutes = 15, par_creneau = 6, fenetre_minutes?, timezone?}`. `debut` est
 *   soit « HH:MM » DÉJÀ en heure locale escale, soit un instant (Date, epoch ms ou ISO)
 *   converti dans le fuseau de la fiche escale. OPTION ABSENTE = aucun créneau : le champ
 *   `creneau_presentation` reste vide sur toutes les lignes et aucun horaire n'est inventé
 *   (les messages passagers restent corrects, le paragraphe disparaît).
 * @returns {{plan: Array, summary: object, gaps: object}} `summary` porte en plus (C2)
 *   `paxTotal/paxHorsPlan/chambres`, `couchagesInsuffisants/paxSansCouchage`,
 *   `chambresFermes/chambresAConfirmer/partAConfirmer`,
 *   `stockNonMesure/chambresNonMesurees`, `parHotel`, `concentration`,
 *   `avertissements`, `reserves` et `complet` ; (C6) `creneaux` et `sansCreneau` ;
 *   (couronnes) `couronnes` {source, liste}, `parCouronne`, `dossiersAvecBudget`,
 *   `dossiersCouronneIndeterminee`, `escaladesTempsTrajet`, `escaladesProximite` ;
 *   `gaps.couchagesManquants` complète `gaps.chambresManquantes` sans s'y ajouter.
 */
export function allocate({ dossiers, inventories, policy, station = null, nights = 1, provisoire = false, assumedStock = 6, presentation = null }) {
  const preferFC = policy.global.free_cancellation_preferred;
  const pmrCfg = policy.global.overlays.pmr;
  const caps = effectiveCaps(policy, station);
  const radiusKm = station?.search?.radius_km ?? 5;
  // transfert de la fiche escale : reste le libellé des lignes SANS hôtel (rien n'est
  // promis à un dossier qui n'a pas de chambre) et sert de repli quand aucune escale
  // n'est fournie.
  const transfertBase = station ? `${station.transfer.default_mode}, max ${station.transfer.max_transfer_min} min` : "";
  // COURONNES : le temps de trajet est DÉCLARÉ par l'exploitation, jamais mesuré —
  // l'outil n'a aucun service de routage et ne convertit pas une distance en durée.
  const { couronnes, source: couronnesSource } = couronnesDe(station);
  const refStation = station?.search?.distance_ref ?? null;
  const dernierRang = couronnes[couronnes.length - 1]?.rang ?? 1;
  const criteres = policy.global?.prise_en_charge?.criteres ?? [];
  // « ouvrir une couronne plus lointaine quand la précédente ne suffit plus » (défaut : oui)
  const elargir = policy.global?.prise_en_charge?.elargir_si_insuffisant !== false;
  // avertissements de stock : allocate reste PURE, les alertes remontent par le résumé
  const avertissements = [];
  const warn = (message) => {
    if (!avertissements.includes(message)) avertissements.push(message);
  };
  const limits = stockLimits(policy, warn);
  // C3 : formats de chambre attendus par cabine, normalisés une fois
  const patterns = { J: patternsOf(policy.cabins?.J), W: patternsOf(policy.cabins?.W), Y: patternsOf(policy.cabins?.Y) };

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
        // Sonde (EX-ALL-5). `rooms_selectable_max` est un maximum observe POUR
        // L'HOTEL, jamais par type. Deux lectures selon `cap_reached` :
        //  - selecteur NON plafonne  -> mesure FERME : le total pris chez cet hotel ne
        //    peut pas depasser M, meme si l'affichage par type promet davantage ;
        //  - selecteur encore plafonne -> borne BASSE : l'hotel en a au moins M, on
        //    retient le plus favorable entre l'affichage cumule et M.
        // Dans les deux cas c'est un PLAFOND DE TOTAL : additionner M aux quantites
        // affichees ferait appeler un hotel pour 139 chambres la ou la sonde — une
        // session payante — en a mesure 40.
        // Sans sonde, le total n'est PAS rabote (C2) : le stock affiché d'un hôtel jamais
        // mesuré n'est pas une promesse tenable, mais c'est un stock à CONFIRMER par
        // téléphone, pas un stock inexistant. Il part en niveau 2 et se dit comme tel.
        ...sondeDe(inv.answer, buildStock(inv.answer, preferFC, assumedStock, limits, warn), limits),
        taken: 0,
        // COURONNE de l'hôtel : c'est elle, et elle seule, qui porte le temps de trajet
        // opposable au budget du dossier. `trajetDeclare = null` = aucun temps déclaré ne
        // couvre cet hôtel (mesuré au-delà de la dernière couronne) : il n'est admissible
        // que pour un dossier SANS budget de trajet.
        ...(() => {
          const cr = couronneDeHotel(inv, couronnes, refStation);
          return {
            couronne: cr.couronne,
            couronneSource: cr.source,
            couronneRang: cr.source === "hors_couronnes" ? null : cr.couronne.rang,
            trajetDeclare: cr.source === "hors_couronnes" ? null : cr.couronne.trajet_min,
            distanceRetenue: cr.distance_km,
          };
        })(),
      };
    });

  for (const h of hotels) {
    // une MESURE qui borne le total est une bonne nouvelle, mais elle se dit : sans ce mot,
    // le validateur croit disposer de l'affichage cumulé alors que le moteur a retenu moins
    // C7 : incohérence de politique de règlement — remontée UNE fois (warn déduplique),
    // jamais par ligne de plan, où elle se répéterait 300 fois sans être lue.
    if (h.reglement.avertissement) warn(`règlement : ${h.reglement.avertissement}`);
  }

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

  /** Solde du supplement de sonde, partage par les types que l'affichage plafonnait. */
  const liftLeft = (h) => Math.max(0, h.liftBudget - h.liftUsed);
  /** Chambres encore prenables chez cet hotel, plafond d'hotel compris (sonde ou prudence). */
  const hotelLeft = (h) => (Number.isFinite(h.hotelCap) ? Math.max(0, h.hotelCap - h.taken) : Infinity);

  /* ----------------------------------------- CONTRAINTE DURE : le budget de trajet */

  /**
   * L'hôtel tient-il dans le budget de trajet du dossier ? Le temps comparé est celui,
   * DÉCLARÉ, de la couronne retenue pour cet hôtel. Budget `null` = aucune contrainte.
   * Aucun rang de service ne permet d'outrepasser ce test : un passager qui repart à
   * 05h40 ne part pas à 40 km parce qu'il est passé après les PMR.
   */
  const hotelAdmissible = (h, budget) =>
    budget === null || (h.trajetDeclare !== null && h.trajetDeclare <= budget);

  /**
   * Rang de la couronne la plus lointaine que le budget autorise.
   * `Infinity` = aucun budget (dossier le MOINS contraint) ; `0` = même la première
   * couronne est hors budget (dossier que l'hébergement ne peut pas servir).
   */
  function plafondCouronne(budget) {
    if (budget === null) return Infinity;
    let rang = 0;
    for (const c of couronnes) if (c.trajet_min <= budget) rang = Math.max(rang, c.rang);
    return rang;
  }

  /** Chambres encore prenables dans les couronnes retenues (plafond d'hôtel compris). */
  function stockCouronnes(garde) {
    let n = 0;
    for (const h of hotels) {
      if (h.couronneRang === null || !garde(h.couronneRang)) continue;
      const affiche = h.stock.reduce((s, o) => s + o.left, 0) + liftLeft(h);
      n += Math.min(affiche, hotelLeft(h));
    }
    return n;
  }
  /** Stock d'une couronne précise. */
  const stockCouronne = (rang) => stockCouronnes((r) => r === rang);
  /** Stock cumulé des couronnes de rang ≤ `rang` — l'ensemble accessible à un budget. */
  const stockCumule = (rang) => stockCouronnes((r) => r <= rang);

  /**
   * Dossiers ENCORE À SERVIR : un dossier en sort dès qu'il passe devant l'allocation,
   * qu'il soit logé ou non. Sert à réserver le proche à ceux qui n'ont pas le choix.
   */
  const enAttente = new Set();
  /** Au moins un dossier porte un budget de trajet ? Sinon aucune réservation n'a lieu d'être. */
  const budgetsPresents = dossiers.some((d) => budgetTrajet(d) !== null);

  /**
   * Chambres demandées par les dossiers encore à servir qui sont CAPTIFS des couronnes
   * de rang ≤ `rang` — c'est-à-dire dont le budget de trajet ne leur permet pas d'aller
   * plus loin. Un dossier sans budget n'est captif de rien ; un dossier dont même la
   * première couronne dépasse le budget (plafond 0) ne peut être servi par aucune, sa
   * demande ne réserve donc rien à personne.
   */
  function demandeCaptive(rang) {
    let n = 0;
    for (const d2 of enAttente) {
      const p = plafondCouronne(budgetTrajet(d2));
      if (p === 0 || p === Infinity || p > rang) continue;
      n += Number(d2.rooms) || 0;
    }
    return n;
  }

  /**
   * L'EFFET PERVERS, traité explicitement : servir d'abord les dossiers « proximité
   * stricte » ET leur laisser la couronne 1 prive de couronne 1 un dossier au budget de
   * trajet très court servi plus tard — qui, lui, n'a nulle part ailleurs où aller.
   * LE BUDGET DE TRAJET PRIME SUR LA PRÉFÉRENCE DE PROXIMITÉ : un dossier qui PEUT aller
   * plus loin ne prend une chambre proche que s'il en reste assez pour ceux qui ne le
   * peuvent pas.
   *
   * Le test ne porte que sur les niveaux où le dossier est STRICTEMENT moins contraint
   * que ceux qu'il faut protéger :
   *  - au-delà de son propre plafond, il est aussi captif que les autres et c'est le RANG
   *    de service (la politique de prise en charge) qui tranche, pas la distance ;
   *  - au dernier rang, l'ensemble des couronnes est accessible à tout le monde : ce qui
   *    manque alors est du stock, pas de la proximité — réserver n'y protégerait personne
   *    et laisserait des chambres vides en face de dossiers escaladés.
   */
  function reserveProcheBloque(h, dossier, count) {
    if (!budgetsPresents) return false; // aucun budget de trajet : rien à réserver, rien à calculer
    const rHotel = h.couronneRang;
    if (rHotel === null) return false; // hors couronnes : ne prend rien au vivier proche
    const plafondD = plafondCouronne(budgetTrajet(dossier));
    for (const c of couronnes) {
      if (c.rang < rHotel) continue;
      if (c.rang >= dernierRang || c.rang >= plafondD) break;
      if (stockCumule(c.rang) - count < demandeCaptive(c.rang)) return true;
    }
    return false;
  }

  /**
   * Libellé de transfert d'une ligne LOGÉE : la couronne réellement retenue, et son temps
   * de trajet nommé comme DÉCLARÉ — jamais comme mesuré, l'outil ne mesure aucun trajet.
   */
  function transfertDe(h) {
    if (!station) return "";
    const c = h.couronne;
    if (h.couronneSource === "hors_couronnes") {
      return `${c.mode} — au-delà de la dernière couronne déclarée, aucun temps de trajet déclaré`;
    }
    const base =
      couronnesSource === "declaree"
        ? `${c.mode}, ${c.trajet_min} min déclarées (couronne ${c.rang}/${couronnes.length})`
        : `${c.mode}, max ${c.trajet_min} min déclarées (couronne unique dérivée de la fiche escale)`;
    return h.couronneSource === "inconnue" ? `${base} — ${PRUDENCE_COURONNE_INCONNUE}` : base;
  }

  /**
   * Ordre des PASSES de couronnes pour un dossier : chaque passe est une liste de rangs
   * examinés ensemble (le rang `null` désigne les hôtels hors couronnes, réservés aux
   * dossiers sans budget). La contrainte dure est appliquée ici, par construction : une
   * couronne hors budget n'entre dans aucune passe.
   *
   *  - « aucune »   : toutes les couronnes admissibles en UNE passe — le score décide,
   *                   la distance ne préfère rien (comportement d'avant les couronnes) ;
   *  - « preferee » : la plus proche d'abord, puis les suivantes en dernier recours ;
   *  - « stricte »  : la plus proche seule (l'appelant décide s'il élargit ou escalade).
   */
  function passesCouronnes(prox, budget) {
    const rangs = couronnes.filter((c) => budget === null || c.trajet_min <= budget).map((c) => c.rang);
    const hors = budget === null ? [null] : []; // aucun temps déclaré : jamais sous contrainte
    if (!rangs.length) return hors.length ? [hors] : [];
    if (prox === "aucune") return [[...rangs, ...hors]];
    const suite = rangs.slice(1).map((r) => [r]);
    if (hors.length) suite.push(hors);
    return elargir ? [[rangs[0]], ...suite] : [[rangs[0]]];
  }

  /**
   * Offres utilisables d'un hotel pour un tier. C3 : a disponibilite egale et SOUS
   * LE PLAFOND, le format attendu par la cabine passe avant le prix — sans quoi un
   * passager business recoit la chambre la moins chere, exactement comme un eco.
   * Liste de motifs vide (cas de Y) : rang constant, le tri reste celui du prix.
   */
  function usableOffers(h, tier, overCapAllowed) {
    const cap = caps[tier];
    const pats = patterns[tier] ?? [];
    const bonus = liftLeft(h);
    const resteHotel = hotelLeft(h);
    if (resteHotel <= 0) return [];
    const rangFormat = (o) => (o.formatTier && o.price <= cap ? 0 : 1);
    return h.stock
      .map((o) => ({
        ...o,
        left: Math.min(o.liftable ? o.left + bonus : o.left, resteHotel),
        _src: o,
        formatTier: pats.length > 0 && matchFormat(o.room_type, pats),
      }))
      .filter((o) => o.left > 0 && (overCapAllowed || o.price <= cap))
      .sort((a, b) => rangFormat(a) - rangFormat(b) || a.price - b.price);
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

  /**
   * Tente de loger un dossier chez un hôtel ; retourne la prise (stock décrémenté) ou null.
   * `trace` recueille ce qui a empêché la prise sans être un manque de chambres — aujourd'hui
   * la réservation du vivier proche aux dossiers au budget de trajet plus court.
   */
  function takeRooms(entry, dossier, tier, forceOverCap = false, trace = null) {
    const { h, c } = entry;
    const overCapAllowed = forceOverCap || c.level === "HORS_BAREME";
    const sorted = usableOffers(h, tier, overCapAllowed);

    const take = (offer, count, note = null) => {
      if (reserveProcheBloque(h, dossier, count)) {
        if (trace) trace.reserveProche = true;
        return null;
      }
      const src = offer._src ?? offer;
      const surStock = Math.min(src.left, count); // d'abord la quantite affichee
      src.left -= surStock;
      if (count > surStock) h.liftUsed += count - surStock; // puis le supplement partage
      h.taken += count; // plafond de sonde : total pris chez cet hotel
      return {
        rooms: [{
          type: offer.room_type, count, price: offer.price,
          assumed: offer.assumed, capReached: offer.capReached,
          mesure: offer.mesure, niveau: offer.mesure === "ferme" ? "ferme" : "a_confirmer",
          formatTier: offer.formatTier === true,
          occupancy_adults: offer.occupancy_adults, occupancy_children: offer.occupancy_children,
        }],
        hotel: h, conf: c, note,
      };
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

  /**
   * Tentative de placement d'un dossier. `forceOverCap` autorise les chambres
   * au-dessus du plafond même chez un hôtel jugé CONFORME (dérogation).
   */
  function tenterPlacement(d, forceOverCap) {
    const isPmr = d.overlays.pmr;
    let placed = null;
    let tierUsed = d.cabin;
    let paymentBlocked = false;
    let accessBlocked = false;
    // couronnes : budget du dossier, préférence de proximité, et ce qui a bloqué
    const budget = budgetTrajet(d);
    const prox = proximiteDe(d, criteres);
    const trace = { reserveProche: false };
    let proximiteBloquee = false;
    let eloigne = false;

    // Dossiers HORS PLAN HÔTEL : traitement nominatif au desk (civière, médical, mineur
    // non accompagné) ou droit d'entrée REFUSÉ sur le territoire de l'escale (fiche
    // escale `constraints.entry_visa_check` — CDC §5.2 « traitement nominatif GHA »).
    // Ils ne consomment aucun stock et ne nourrissent PAS l'extension : relever plus
    // d'hôtels ne les logera pas. « INCONNU » n'est PAS un refus : le dossier reste
    // dans le plan, sa capacité reste provisionnée, et la ligne porte la réserve.
    const horsPlan = d.escaladeNominative ?? (d.droitEntree === "NON" ? "droit d'entrée" : null);
    const droitAVerifier = d.droitEntree === "INCONNU";

    // Parcours du tier du dossier ; pour un PMR sans solution accessible, on préfère un
    // SURCLASSEMENT de tier (jugé contre la politique du tier supérieur) à une dérogation
    // de prix dans son tier — la dérogation HORS_BAREME reste le dernier recours.
    const tryPasse = (tier, groupe, { allowOverCap }) => {
      for (const entry of rankedFor(tier, { pmrBoost: isPmr })) {
        // CONTRAINTE DURE : seules les couronnes de la passe en cours, toutes dans le budget
        if (!groupe.includes(entry.h.couronneRang)) continue;
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
        const taken = takeRooms(entry, d, tier, forceOverCap, trace);
        if (taken) {
          tierUsed = tier;
          return taken;
        }
      }
      return null;
    };

    /**
     * Parcours des couronnes, dans l'ordre imposé par la préférence de proximité.
     * « stricte » : on ne sort pas de la couronne la plus proche tant qu'elle a du stock —
     * si elle en a encore mais qu'aucune de ses chambres ne convient, on ESCALADE plutôt
     * que d'éloigner. Elle ne s'ouvre au reste que lorsqu'elle est vraiment épuisée, et
     * seulement si la politique autorise l'élargissement.
     */
    const tryTier = (tier, { allowOverCap }) => {
      const passes = passesCouronnes(prox, budget);
      for (const [i, groupe] of passes.entries()) {
        const taken = tryPasse(tier, groupe, { allowOverCap });
        if (taken) {
          if (i > 0) eloigne = true;
          return taken;
        }
        if (i === 0 && prox === "stricte" && groupe[0] !== null && stockCouronne(groupe[0]) > 0) {
          proximiteBloquee = true;
          return null;
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

    // POURQUOI le dossier n'a pas de chambre, quand le budget de trajet y est pour
    // quelque chose : « capacité » serait faux, et enverrait des agents relever des
    // hôtels de plus alors que des chambres existent — hors d'atteinte.
    let tempsTrajet = null;
    if (!placed && !horsPlan && budget !== null && hotels.length) {
      if (!hotels.some((h) => hotelAdmissible(h, budget))) tempsTrajet = "aucun_hotel";
      else if (hotels.some((h) => !hotelAdmissible(h, budget) && couldFit(h, d, d.cabin, true))) tempsTrajet = "hors_budget";
    }
    return {
      placed, tierUsed, paymentBlocked, accessBlocked, horsPlan, droitAVerifier, derogationPrix: false,
      budget, prox, tempsTrajet, proximiteBloquee, eloigne, reserveProche: trace.reserveProche,
    };
  }

  // DEUX PASSES (EX-ALL-4). Passe 1 : tout le monde DANS LE BARÈME, dans l'ordre de
  // priorité. Passe 2 : seulement pour les dossiers restés sans chambre, on rouvre les
  // chambres au-dessus du plafond, y compris chez les hôtels jugés CONFORMES — ils les
  // refusaient, alors qu'un hôtel HORS BARÈME les offrait toutes, si bien que MONTER le
  // plafond faisait PERDRE des dossiers en masse (mesuré : 157 logés à 80 EUR, 62 à 150 EUR).
  // Les deux passes suppriment cette FALAISE. Elles ne rendent PAS le levier monotone,
  // et il ne faut pas l'écrire : mesuré sur la liste seed 42 et un vivier de 8 hôtels,
  // monter le plafond Y de 50 à 70 EUR fait passer de 87 à 83 dossiers logés, à nombre
  // de chambres CONSTANT. Cause : `rankedFor()` trie par niveau de conformité, et ce
  // niveau dépend du plafond — monter le plafond réordonne les hôtels et redéplace les
  // prises. Rendre l'ordre indépendant du plafond est un chantier ouvert
  // (test de caractérisation : test/allocate-monotonie.test.mjs).
  //
  // `enAttente` suit, passe par passe, les dossiers qui restent À SERVIR : c'est lui qui
  // permet de réserver le vivier proche aux budgets de trajet les plus courts. Un dossier
  // en sort JUSTE AVANT son propre essai — il ne se réserve pas des chambres à lui-même,
  // et un dossier déjà passé ne réserve plus rien (sa demande ne serait jamais servie et
  // bloquerait des chambres pour personne).
  const etats = new Map();
  const horsPlanDe = (d) => d.escaladeNominative ?? (d.droitEntree === "NON" ? "droit d'entrée" : null);
  for (const d of dossiers) if (!horsPlanDe(d)) enAttente.add(d);
  for (const d of dossiers) {
    enAttente.delete(d);
    etats.set(d, tenterPlacement(d, false));
  }
  const repasse = dossiers.filter((d) => {
    const e = etats.get(d);
    return !e.placed && !e.horsPlan && policy.cabins[d.cabin]?.allow_above_cap_if_no_alternative;
  });
  for (const d of repasse) enAttente.add(d);
  for (const d of repasse) {
    enAttente.delete(d);
    const retry = tenterPlacement(d, true);
    if (retry.placed) etats.set(d, { ...retry, derogationPrix: true });
  }

  const plan = [];
  for (const d of dossiers) {
    const isPmr = d.overlays.pmr;
    const {
      placed, tierUsed, paymentBlocked, accessBlocked, horsPlan, droitAVerifier, derogationPrix,
      budget, prox, tempsTrajet, proximiteBloquee, eloigne, reserveProche,
    } = etats.get(d);

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
    // C2 : un dossier logé dans une chambre qui n'a pas assez de couchages n'est PAS
    // un dossier couvert. Le statut reste OK — la chambre existe, elle est réservable,
    // la dégrader enverrait des agents chercher un stock dont le dossier n'a pas besoin
    // — mais le manque est compté et remonte au validateur (`summary.couchagesInsuffisants`)
    // pour que le plan ne se déclare jamais complet alors qu'il ne l'est pas.
    let couchagesManquants = 0;
    if (placed) {
      const couchages = placed.rooms.reduce((s2, r) => s2 + r.count * ((r.occupancy_adults ?? 2) + (r.occupancy_children ?? 0)), 0);
      const personnes = d.adults + d.children; // les nourrissons ne consomment pas de capacité
      if (couchages && couchages < personnes) {
        couchagesManquants = personnes - couchages;
        notes.push(`COUCHAGES : ${couchages} place(s) déclarée(s) pour ${personnes} personnes — lit d'appoint ou chambre supplémentaire à confirmer avec l'hôtel`);
      }
    }
    // C3 : le format attendu par la cabine n'était pas disponible sous le plafond
    if (placed && (patterns[tierUsed] ?? []).length && !placed.rooms.some((r) => r.formatTier)) {
      notes.push(`format ${tierUsed} (${patterns[tierUsed].join(", ")}) indisponible sous le plafond : chambre standard retenue`);
    }
    // C2 — niveau 2 : la chambre est PLANIFIÉE (elle n'est plus supprimée), mais la ligne
    // dit en toutes lettres qu'elle repose sur une borne basse. C'est cette phrase que
    // l'agent d'escale a sous les yeux quand il appelle l'hôtel.
    if (placed?.rooms.some((r) => r.mesure !== "ferme")) {
      const cause = placed.rooms.some((r) => r.assumed)
        ? "quantité non affichée par le site"
        : "affichage plafonné par le sélecteur — borne basse";
      notes.push(`CHAMBRE À CONFIRMER auprès de l'hôtel : stock non mesuré (${cause})`);
    }
    // La seconde passe se déclenche désormais AUSSI pour une raison de distance (une
    // couronne proche libérée d'une réservation). Annoncer « HORS BARÈME » sur une chambre
    // qui est SOUS le plafond serait faux : le prix retenu tranche, pas la passe.
    if (derogationPrix && placed) {
      const prixMax = Math.max(...placed.rooms.map((r) => r.price));
      if (prixMax > caps[tierUsed]) {
        notes.push(`HORS BARÈME : ${Math.round(prixMax)} EUR pour un plafond de ${caps[tierUsed]} EUR — aucune chambre dans le barème, dérogation appliquée`);
      }
    }

    // COURONNE RETENUE : ce que la ligne doit dire au validateur et à l'agent d'escale —
    // quelle couronne, quel temps de trajet DÉCLARÉ, et quel budget avait le dossier.
    const hc = placed ? placed.hotel : null;
    const horsCouronnes = hc?.couronneSource === "hors_couronnes";
    const couronneCle = hc ? (horsCouronnes ? "hors_couronnes" : String(hc.couronneRang)) : "";
    if (hc) {
      if (hc.couronneSource === "inconnue") {
        notes.push(
          `COURONNE À CONFIRMER : ${PRUDENCE_COURONNE_INCONNUE} (${hc.couronne.trajet_min} min DÉCLARÉES, ` +
            "aucune distance mesurée pour cet hôtel)",
        );
      } else if (horsCouronnes) {
        notes.push(
          `TRAJET NON DÉCLARÉ : hôtel mesuré à ${hc.distanceRetenue} km, au-delà de la dernière couronne déclarée — ` +
            "temps de transfert à établir par l'exploitation",
        );
      }
      if (eloigne) {
        notes.push(
          `ÉLOIGNEMENT EN DERNIER RECOURS : couronne ${couronneCle} retenue (${hc.couronne.trajet_min} min déclarées) — ` +
            "la couronne la plus proche n'avait plus de chambre adaptée",
        );
      }
    }
    if (reserveProche) {
      notes.push(
        "couronne proche RÉSERVÉE aux dossiers dont le budget de trajet est plus court : " +
          "le budget de trajet prime sur la préférence de proximité",
      );
    }
    if (!placed && !horsPlan) {
      if (tempsTrajet === "aucun_hotel") {
        const hors = hotels.filter((h) => h.couronneRang === null).length;
        const indet = hotels.filter((h) => h.couronneSource === "inconnue").length;
        notes.push(
          `AUCUNE CHAMBRE DANS LE TEMPS DE TRAJET DISPONIBLE : budget de trajet ${budget} min, ` +
            `couronnes déclarées ${couronnes.map((c) => `${c.rang}: ${c.trajet_min} min`).join(" · ")}` +
            (hors ? ` ; ${hors} hôtel(s) au-delà de la dernière couronne, sans temps de trajet déclaré` : "") +
            (indet ? ` ; ${indet} hôtel(s) de couronne non déterminée, tenus pour les plus lointains (prudence)` : ""),
        );
      } else if (tempsTrajet === "hors_budget") {
        notes.push(
          `AUCUNE CHAMBRE DANS LE TEMPS DE TRAJET DISPONIBLE : des chambres existent au-delà de ${budget} min ` +
            "de trajet déclaré, hors d'atteinte pour ce dossier",
        );
      }
      if (proximiteBloquee) {
        notes.push(
          "PROXIMITÉ STRICTE : la couronne la plus proche a encore du stock mais aucune chambre adaptée — " +
            "la politique de prise en charge refuse d'éloigner ce dossier",
        );
      }
    }

    const motif = horsPlan ??
      (tempsTrajet === "aucun_hotel"
        ? "temps de trajet"
        : accessBlocked
          ? "accessibilité"
          : paymentBlocked
            ? "règlement"
            : tempsTrajet === "hors_budget"
              ? "temps de trajet"
              : proximiteBloquee
                ? "proximité stricte"
                : "capacité");
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
      // le depassement doit porter sur la chambre REELLEMENT prise, pas sur la moins
      // chere de l'hotel : l'ecart masque atteignait 6 700 EUR/nuit sur la vraie liste
      conformite: placed ? conformityLabel(placed.conf, { prixPris: Math.max(...placed.rooms.map((r) => r.price)), capEur: caps[tierUsed] }) : "",
      mode_reglement: placed ? placed.hotel.reglement.mode : "",
      hotel_source: placed ? placed.hotel.source : "",
      provisoire,
      session_ref: placed ? placed.hotel.sessionId : "",
      // le transfert affiché est celui de la COURONNE RÉELLEMENT RETENUE, et il dit que
      // le temps est déclaré. Une ligne sans hôtel garde le transfert de la fiche escale :
      // rien n'est promis à un dossier qui n'a pas de chambre.
      transfert: hc ? transfertDe(hc) : transfertBase,
      // couronne retenue, temps de trajet DÉCLARÉ, budget de trajet du dossier
      couronne: hc && !horsCouronnes ? hc.couronneRang : "",
      couronne_cle: couronneCle,
      couronne_source: hc ? hc.couronneSource : "",
      couronne_trajet_min_declare: hc && !horsCouronnes ? hc.couronne.trajet_min : "",
      couronne_mode: hc ? hc.couronne.mode : "",
      trajet_max_min: budget ?? "",
      proximite: prox ?? "",
      escalade: placed ? "" : `DESK (${motif})`,
      statut: placed ? "OK" : "ESCALADE DESK",
      hors_plan: horsPlan ?? "",
      sous_reserve: sousReserve,
      // C7 — POURQUOI ce mode de règlement : « carte prépayée » parce que la compagnie
      // l'a choisi (`mode_nominal`) ou parce que l'hôtel refuse de facturer la compagnie
      // (`repli_carte`) n'engage pas les mêmes suites au comptoir.
      reglement_source: placed ? placed.hotel.reglement.source : "",
      reglement_paiement_compagnie: placed ? placed.hotel.reglement.company_payment_possible : "",
      // champs additifs C2/C3 — ce que le validateur humain doit voir avant de signer
      stock_mesure: placed ? placed.rooms.every((r) => r.mesure === "ferme") : "",
      // C2 — ventilation à DEUX NIVEAUX de la ligne : ce qui est mesuré, ce qui est à
      // confirmer par téléphone. Somme = `chambres`.
      chambres_fermes: placed ? placed.rooms.reduce((s2, r) => s2 + (r.mesure === "ferme" ? r.count : 0), 0) : "",
      chambres_a_confirmer: placed ? placed.rooms.reduce((s2, r) => s2 + (r.mesure === "ferme" ? 0 : r.count), 0) : "",
      couchages_insuffisants: couchagesManquants > 0,
      couchages_manquants: couchagesManquants,
      format_cabine: placed && (patterns[tierUsed] ?? []).length ? (placed.rooms.some((r) => r.formatTier) ? "conforme" : "defaut") : "",
      // C6 — rempli par planifierCreneaux() quand l'appelant fournit `presentation`
      creneau_presentation: "",
      notes: notes.join(" ; "),
    });
  }

  // C6 : convocations étalées (avant la synthèse, qui compte les dossiers sans créneau)
  const creneaux = planifierCreneaux(plan, presentation, station?.timezone ?? null, warn);

  // synthèse et manques (les manques par tier nourrissent l'extension, phase 3).
  // Un dossier HORS PLAN (nominatif, droit d'entrée) est escaladé mais ne crée PAS de
  // manque : il ne faut pas dépenser des sessions d'agents à chercher des chambres
  // qu'il ne prendra pas.
  const summary = {
    parTier: {}, coutParDevise: {}, ok: 0, escalade: 0, horsPlan: 0, motifs: {}, paxLoges: 0, paxNonLoges: 0,
    // C2 (additifs) : le chiffre décisif est le nombre de PERSONNES, pas de dossiers ;
    // et le validateur doit voir la concentration, le stock non mesuré et les réserves.
    paxTotal: 0, paxHorsPlan: 0, chambres: 0,
    couchagesInsuffisants: 0, paxSansCouchage: 0,
    // C2 — les DEUX NIVEAUX, le chiffre que le validateur lit en premier et que l'agent
    // d'escale annonce au téléphone : n chambres fermes / m chambres à confirmer.
    chambresFermes: 0, chambresAConfirmer: 0, partAConfirmer: 0,
    stockNonMesure: 0, chambresNonMesurees: 0,
    parHotel: {}, concentration: null,
    // COURONNES : ce que le validateur doit voir avant de signer une répartition qui
    // envoie des passagers à 40 km — combien de dossiers et de chambres dans chaque
    // couronne, et combien de dossiers sont sortis faute de temps de trajet.
    couronnes: {
      source: couronnesSource,
      liste: couronnes.map((c) => ({ rang: c.rang, rayon_m: c.rayon_m, trajet_min_declare: c.trajet_min, mode: c.mode, note: c.note })),
    },
    parCouronne: {}, dossiersAvecBudget: 0, dossiersCouronneIndeterminee: 0,
    escaladesTempsTrajet: 0, escaladesProximite: 0,
    // C6 : récapitulatif des convocations (null = aucun créneau calculé) et nombre de
    // dossiers qui se présenteront sans horaire — ce que le comptoir absorbera d'un coup.
    creneaux, sansCreneau: 0,
    avertissements, reserves: [], complet: false,
  };
  const gaps = { chambresManquantes: {}, couchagesManquants: {} };
  for (const row of plan) {
    const t = row.cabine;
    const pax = Number(row.pax) || 0;
    summary.parTier[t] ??= { ok: 0, escalade: 0, chambres: 0 };
    summary.paxTotal += pax;
    if (row.trajet_max_min !== "") summary.dossiersAvecBudget += 1;
    if (row.couronne_source === "inconnue") summary.dossiersCouronneIndeterminee += 1;
    // un dossier hors plan n'est pas convoqué : son absence de créneau n'est pas un manque
    if (!row.hors_plan && !row.creneau_presentation) summary.sansCreneau += 1;
    if (row.statut === "OK") {
      summary.ok += 1;
      summary.paxLoges += pax;
      summary.chambres += row.chambres;
      summary.parTier[t].ok += 1;
      summary.parTier[t].chambres += row.chambres;
      const fermes = Number(row.chambres_fermes) || 0;
      const aConfirmer = Number(row.chambres_a_confirmer) || 0;
      summary.chambresFermes += fermes;
      summary.chambresAConfirmer += aConfirmer;
      const h = (summary.parHotel[row.hotel] ??= {
        chambres: 0, chambres_fermes: 0, chambres_a_confirmer: 0, dossiers: 0, pax: 0, stock_mesure: true,
      });
      h.chambres += row.chambres;
      h.chambres_fermes += fermes;
      h.chambres_a_confirmer += aConfirmer;
      h.dossiers += 1;
      h.pax += pax;
      // ventilation par COURONNE : dossiers, chambres et personnes, avec le temps de
      // trajet DÉCLARÉ de la couronne — c'est la lecture que le client a demandée
      const cle = row.couronne_cle || "inconnue";
      const pc = (summary.parCouronne[cle] ??= {
        rang: row.couronne === "" ? null : row.couronne,
        trajet_min_declare: row.couronne_trajet_min_declare === "" ? null : row.couronne_trajet_min_declare,
        mode: row.couronne_mode || "",
        dossiers: 0, chambres: 0, pax: 0, chambres_fermes: 0, chambres_a_confirmer: 0, couronne_indeterminee: 0,
      });
      pc.dossiers += 1;
      pc.chambres += row.chambres;
      pc.pax += pax;
      pc.chambres_fermes += fermes;
      pc.chambres_a_confirmer += aConfirmer;
      if (row.couronne_source === "inconnue") pc.couronne_indeterminee += 1;
      if (row.stock_mesure !== true) {
        h.stock_mesure = false;
        summary.stockNonMesure += 1;
        summary.chambresNonMesurees += row.chambres;
      }
      if (row.couchages_insuffisants) {
        summary.couchagesInsuffisants += 1;
        summary.paxSansCouchage += row.couchages_manquants;
        // manque exprimé en chambres (2 couchages par chambre standard) : le pipeline
        // peut le verser à l'extension, il ne s'ajoute PAS à `chambresManquantes`
        gaps.couchagesManquants[t] = (gaps.couchagesManquants[t] ?? 0) + Math.max(1, Math.ceil(row.couchages_manquants / 2));
      }
      if (row.prix_total !== "") {
        summary.coutParDevise[row.devise] = (summary.coutParDevise[row.devise] ?? 0) + Number(row.prix_total);
      }
    } else {
      summary.escalade += 1;
      summary.paxNonLoges += pax;
      summary.parTier[t].escalade += 1;
      const motifRow = row.escalade.replace(/^DESK \(|\)$/g, "");
      summary.motifs[motifRow] = (summary.motifs[motifRow] ?? 0) + 1;
      if (row.hors_plan) {
        summary.horsPlan += 1;
        summary.paxHorsPlan += pax;
      } else gaps.chambresManquantes[t] = (gaps.chambresManquantes[t] ?? 0) + row.chambres;
    }
  }

  // COURONNES — escalades dont le budget de trajet est la vraie cause. Elles ne doivent
  // PAS être lues comme un manque de capacité : relever des hôtels de plus ne les logera
  // pas si les chambres relevées sont hors d'atteinte.
  summary.escaladesTempsTrajet = summary.motifs["temps de trajet"] ?? 0;
  summary.escaladesProximite = summary.motifs["proximité stricte"] ?? 0;
  // Les avertissements ci-dessous ne se déclenchent QUE si des budgets de trajet existent :
  // sans budget, la couronne d'un hôtel n'a aucune conséquence sur le plan, et avertir
  // serait du bruit (une réserve fait basculer `complet`).
  if (summary.dossiersAvecBudget) {
    if (couronnesSource === "derivee") {
      warn(
        "aucune couronne déclarée dans la fiche escale : couronne unique dérivée du rayon " +
          `(${couronnes[0]?.trajet_min} min déclarées) — tous les hôtels partagent le même temps de trajet, ` +
          "les budgets de trajet ne départagent donc rien",
      );
    }
    if (summary.dossiersCouronneIndeterminee) {
      warn(
        `${summary.dossiersCouronneIndeterminee} dossier(s) logés dans un hôtel dont la couronne n'a pas pu être ` +
          `déterminée (${PRUDENCE_COURONNE_INCONNUE}) — distance à relever avant diffusion`,
      );
    }
  }

  // C2 — part du plan qui repose sur du NON MESURÉ. Un plan dont l'essentiel est de
  // niveau 2 doit le dire en tête, pas en note de bas de page.
  summary.partAConfirmer = summary.chambres ? Math.round((summary.chambresAConfirmer / summary.chambres) * 1000) / 1000 : 0;

  // C2 — le seuil `hotel_cap_without_probe` ne retranche plus rien : il SIGNALE. Au-delà,
  // l'hôtel concentre assez de chambres non mesurées pour qu'une sonde (ou un appel
  // préalable) soit le meilleur usage du temps restant.
  for (const [nom, h] of Object.entries(summary.parHotel)) {
    if (h.chambres_a_confirmer > limits.hotelCapSansSonde) {
      warn(
        `« ${nom} » : ${h.chambres_a_confirmer} chambre(s) engagées sur un stock NON MESURÉ, au-delà du seuil de vigilance ` +
          `(${limits.hotelCapSansSonde}, \`extension.hotel_cap_without_probe\`) — hôtel à SONDER ou à appeler en priorité ` +
          `(${h.chambres_fermes} chambre(s) fermes chez lui)`,
      );
    }
  }

  // concentration : un plan qui pose 99 chambres sur un seul hôtel est un plan fragile
  const parHotelTrie = Object.entries(summary.parHotel).sort((a, b) => b[1].chambres - a[1].chambres);
  if (parHotelTrie.length) {
    const [nom, top] = parHotelTrie[0];
    summary.concentration = {
      hotels: parHotelTrie.length,
      hotel: nom,
      chambres: top.chambres,
      dossiers: top.dossiers,
      pax: top.pax,
      part: summary.chambres ? Math.round((top.chambres / summary.chambres) * 1000) / 1000 : 0,
    };
  }

  // réserves : tout ce qui interdit de lire ce plan comme « couvert »
  // `paxNonLoges` compte AUSSI les hors-plan (nominatifs, droit d'entrée) : la réserve
  // ne parle que des dossiers qu'il reste à loger, dossiers et personnes du même ensemble.
  const paxSansChambre = Math.max(0, summary.paxNonLoges - summary.paxHorsPlan);
  if (summary.escalade > summary.horsPlan) summary.reserves.push(`${summary.escalade - summary.horsPlan} dossier(s) sans chambre (${paxSansChambre} personne(s))`);
  // Un dossier HORS PLAN HÔTEL (civière, médical, mineur non accompagné, droit d'entrée
  // refusé) n'a PAS de chambre : il ne crée pas de manque à combler par des agents, mais
  // il interdit de lire le plan comme couvert. Sans cette réserve, un plan dont tous les
  // non-logés sont hors plan se déclarait « complet » et l'écran de validation écrivait
  // « tous les dossiers sont logés » alors que personne n'avait de chambre.
  if (summary.horsPlan) {
    summary.reserves.push(
      `${summary.horsPlan} dossier(s) HORS PLAN HÔTEL, ${summary.paxHorsPlan} personne(s) — ` +
        `prise en charge nominative au comptoir, aucune chambre`,
    );
  }
  if (summary.couchagesInsuffisants) summary.reserves.push(`${summary.couchagesInsuffisants} dossier(s) logés sans couchage suffisant (${summary.paxSansCouchage} personne(s))`);
  // COURONNES : dire la vraie cause, pour que personne ne lise « capacité » et ne lance
  // des relevés supplémentaires qui ne changeront rien.
  if (summary.escaladesTempsTrajet) {
    summary.reserves.push(
      `${summary.escaladesTempsTrajet} dossier(s) escaladés faute de TEMPS DE TRAJET : aucune chambre dans le ` +
        "temps de trajet disponible (ce n'est pas un manque de chambres)",
    );
  }
  if (summary.escaladesProximite) {
    summary.reserves.push(
      `${summary.escaladesProximite} dossier(s) escaladés par PROXIMITÉ STRICTE : la politique de prise en charge ` +
        "refuse de les éloigner de la couronne la plus proche",
    );
  }
  if (summary.chambresAConfirmer) {
    summary.reserves.push(
      `${summary.chambresAConfirmer} chambre(s) À CONFIRMER sur ${summary.chambres} (stock non mesuré, ` +
        `${Math.round(summary.partAConfirmer * 100)} % du plan) — ${summary.chambresFermes} chambre(s) fermes`,
    );
  }
  if (avertissements.length) summary.reserves.push(`${avertissements.length} avertissement(s) de stock`);
  // « complet » ne se prononce que si TOUTES les personnes de la liste ont une chambre.
  summary.complet =
    summary.reserves.length === 0 && summary.horsPlan === 0 && summary.paxHorsPlan === 0 && summary.paxNonLoges === 0;

  return { plan, summary, gaps };
}
