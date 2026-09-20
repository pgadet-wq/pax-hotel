/**
 * Coût du plan d'hébergement (CDC §8.1) — fonctions PURES.
 *
 * EX-COU-1 : aucun montant n'est estimé. Un poste dont la politique ne renseigne
 * pas le montant (H-7 : repas, transport) est listé dans `not_determinable` et
 * affiché « non renseigné » — jamais un zéro qui ressemblerait à une gratuité.
 *
 * DEVISE (C7, correctif) : les prix viennent des relevés et peuvent être libellés dans la
 * devise de l'escale (BKK facture en THB) alors que plafonds et indemnités sont en EUR.
 * Additionner des devises différentes produit un total faux. Règle retenue ici : **on
 * n'additionne qu'à devise unique**. Les montants sont donc toujours ventilés dans
 * `par_devise` ; `per_night`/`projection_total` ne sont chiffrés que si une seule devise
 * apparaît, sinon ils valent `null` avec un avertissement BLOQUANT. Aucun taux de change
 * n'est appliqué nulle part : le convertisseur n'existe pas et l'inventer serait un chiffre
 * inventé (INV-3, EX-COU-1). Une ligne sans devise affichée est rangée sous `"?"`, la même
 * convention que `allocate` — mais `"?"` n'est pas une devise CONCURRENTE : c'est une devise
 * NON AFFICHÉE, rattachée à la devise de référence, comme le fait déjà `carteLigne` et en le
 * disant. Sans ce rattachement, un unique relevé muet suffirait à annuler le total d'un plan
 * dont le même objet chiffre par ailleurs les cartes en EUR : deux réponses contradictoires
 * dans une seule sortie. Le blocage reste entier dès que deux devises NOMMÉES coexistent.
 * Conséquence d'affichage : `devise_unique` ne vaut JAMAIS `"?"` — un rapport écrirait
 * « 430 ? ». Quand aucune devise n'a été affichée, `devise_unique` est la devise de
 * référence et `devise_unique_supposee` vaut true, pour que l'étiquette soit présentée
 * comme une hypothèse et non comme un relevé.
 */
import { effectiveCaps } from "./policy.mjs";
import { DEFAULT_AVION } from "./scenario.mjs";

const round2 = (v) => Math.round(v * 100) / 100;

/** Arrondi au multiple supérieur (`pas = 0` → pas d'arrondi). */
const arrondiSup = (v, pas) => (pas > 0 ? Math.ceil(v / pas) * pas : round2(v));

/** Devise d'une ligne de plan ; `"?"` quand le relevé n'en affichait pas. */
const deviseDe = (row) => {
  const d = row?.devise;
  return d === "" || d === null || d === undefined ? "?" : String(d);
};

/** Montant numérique d'une ligne, ou `null` si la case est vide (escalade, prix absent). */
const montantDe = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const tiersVides = () => ({ J: 0, W: 0, Y: 0, total: 0 });

/**
 * Montant à charger sur la ou les cartes prépayées d'UNE ligne de plan (C7).
 *
 * Postes retenus : `policy.payment.prepaid_card.load_includes`.
 *  - `nuit` : `row.prix_total` (déjà multiplié par le nombre de nuits par `allocate`) ;
 *  - `repas` : `allowances.meal_eur_per_pax_per_day × pax × nights` ;
 *  - `transport` : `allowances.transport_eur_per_pax × pax`.
 * Une indemnité à `null` (H-7, non tranchée) n'est PAS estimée : le poste sort « non
 * renseigné » et la carte est marquée `incomplet`. Si aucun poste n'est chiffrable, les
 * montants valent `null` — jamais 0, qui se lirait « rien à charger ».
 *
 * Devise : les indemnités sont en EUR, le prix de chambre dans la devise du relevé. Quand
 * les deux coexistent et diffèrent, le poste `nuit` part en `postes_non_convertibles` et la
 * carte est incomplète (aucun taux de change n'est appliqué). Quand la nuit est le seul
 * poste chiffré, la carte est simplement libellée dans la devise du relevé.
 *
 * `per = "personne"` émet une carte par personne du dossier et répartit le montant ;
 * `marge_eur` s'ajoute à CHAQUE carte (c'est une marge de sécurité au comptoir), puis
 * `arrondi_eur` arrondit au multiple supérieur. Un dépassement de `plafond_eur` n'est pas
 * corrigé en silence : il sort en escalade « carte insuffisante ».
 *
 * @param {object} row ligne du plan (pnr, pax, prix_total, devise, mode_reglement, statut)
 * @param {object} policy politique validée (payment.prepaid_card, allowances, global.currency)
 * @param {object} [opts] {nights} entier ≥ 1 ; un `nights` absent vaut 1, un `nights` fourni
 *                 mais illisible (`null`, 0, chaîne) est refusé — la tolérer donnerait une
 *                 indemnité repas à 0, c'est-à-dire une carte sous-chargée en silence.
 * @returns {object|null} `null` si la ligne n'appelle aucune carte ; sinon la ligne de carte
 *   décrite au contrat, plus `motifs` (codes normalisés des défauts de cette carte).
 *   `incomplet` vaut true dès qu'un poste manque OU qu'aucun poste n'est chiffrable :
 *   une carte sans montant n'est pas une carte prête à commander.
 */
export function carteLigne(row, policy, { nights = 1 } = {}) {
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`carteLigne : nights invalide (${nights})`);
  const cfg = policy.payment?.prepaid_card ?? {};
  // pas de carte : carte désactivée, ligne réglée autrement, ou ligne sans hôtel (rien à charger)
  if (cfg.enabled !== true || row?.mode_reglement !== "carte_prepayee" || row?.statut !== "OK") return null;

  const reference = policy.global?.currency ?? "EUR";
  const includes = cfg.load_includes ?? [];
  const per = cfg.per ?? "dossier";
  const marge = Number(cfg.marge_eur) || 0;
  const arrondi = Number(cfg.arrondi_eur) || 0;
  const plafond = cfg.plafond_eur ?? null;
  const pax = Number(row.pax) || 0;

  const postes = { nuit: null, repas: null, transport: null };
  const postes_non_renseignes = [];
  const postes_non_convertibles = [];
  const avertissements = [];
  // motifs NORMALISÉS du défaut : le texte porte les montants et les PNR, il ne se
  // regroupe pas ; l'agrégat en a besoin pour compter sans recopier 300 phrases.
  const motifs = [];
  const pnr = row.pnr ?? "";
  const dire = (code, message) => { motifs.push(code); avertissements.push(`${pnr} : ${message}`); };

  // postes calculés PAR PERSONNE : seuls ceux-là dépendent de l'effectif. Sans eux,
  // un effectif illisible n'a aucune conséquence sur le montant et l'avertir est du bruit.
  const postesParPersonne = ["repas", "transport"].filter((p) => includes.includes(p));
  if (pax < 1 && (postesParPersonne.length > 0 || per === "personne")) {
    const consequences = [];
    if (postesParPersonne.length) consequences.push(`poste(s) ${postesParPersonne.join(", ")} non chiffrable(s)`);
    if (per === "personne") consequences.push("une seule carte émise au lieu d'une par personne");
    dire("effectif_illisible", `effectif nul ou illisible — ${consequences.join(" ; ")}`);
  }
  if (includes.length === 0) {
    // aucun poste à charger : le montant n'est pas « 0 », il n'est pas calculable. Sans
    // ce marquage, la carte sortait « complète » à montant null et l'agrégat annonçait
    // des cartes prêtes à émettre qu'aucun montant n'accompagnait.
    dire("aucun_poste", "aucun poste à charger dans la politique (payment.prepaid_card.load_includes vide) — montant de carte non calculable");
  }

  // indemnités d'abord : elles fixent la devise de référence de la carte
  if (includes.includes("repas")) {
    const taux = policy.allowances?.meal_eur_per_pax_per_day ?? null;
    if (taux === null) {
      postes_non_renseignes.push("repas");
      dire("repas_non_renseigne", "indemnité repas non renseignée dans la politique (H-7) — poste « repas » non chiffré");
    } else if (pax < 1) postes_non_renseignes.push("repas");
    else postes.repas = round2(taux * pax * nights);
  }
  if (includes.includes("transport")) {
    const taux = policy.allowances?.transport_eur_per_pax ?? null;
    if (taux === null) {
      postes_non_renseignes.push("transport");
      dire("transport_non_renseigne", "indemnité transport non renseignée dans la politique (H-7) — poste « transport » non chiffré");
    } else if (pax < 1) postes_non_renseignes.push("transport");
    else postes.transport = round2(taux * pax);
  }

  let devise = reference;
  if (includes.includes("nuit")) {
    const prix = montantDe(row.prix_total);
    const deviseLigne = deviseDe(row);
    const indemnitesChiffrees = postes.repas !== null || postes.transport !== null;
    if (prix === null) {
      postes_non_renseignes.push("nuit");
      dire("prix_absent", `prix de chambre absent ou illisible (${String(row.prix_total)}) — poste « nuit » non chiffré`);
    } else if (deviseLigne === reference || deviseLigne === "?") {
      postes.nuit = round2(prix);
      if (deviseLigne === "?") {
        dire("devise_non_affichee", `devise non affichée par le relevé — montant supposé en ${reference}, à confirmer`);
      }
    } else if (!indemnitesChiffrees) {
      postes.nuit = round2(prix);
      devise = deviseLigne; // carte libellée dans la devise de l'escale, sans conversion
      dire("carte_en_devise_relevee", `carte libellée en ${deviseLigne}, devise du relevé — aucune conversion appliquée`);
    } else {
      postes_non_convertibles.push("nuit");
      dire(
        "poste_non_convertible",
        `chambre en ${deviseLigne} et indemnités en ${reference} — aucun taux de change n'est appliqué, ` +
          `poste « nuit » à charger séparément (${round2(prix)} ${deviseLigne})`,
      );
    }
  }

  const chiffres = ["nuit", "repas", "transport"].filter((p) => postes[p] !== null);
  const base = chiffres.length ? round2(chiffres.reduce((s, p) => s + postes[p], 0)) : null;
  // `base === null` : aucun poste chiffrable. Une carte sans montant n'est pas une carte
  // complète — elle ne peut pas être commandée à l'émetteur.
  const incomplet = postes_non_renseignes.length > 0 || postes_non_convertibles.length > 0 || base === null;

  let cartes = 1;
  if (per === "personne" && pax >= 1) cartes = pax;

  const montant_par_carte = base === null ? null : arrondiSup(round2(base / cartes) + marge, arrondi);
  const montant_total = montant_par_carte === null ? null : round2(montant_par_carte * cartes);
  // le plafond est libellé en EUR : le comparer à une carte en THB reviendrait à inventer
  // un taux. Devise différente → contrôle non exécuté, et dit comme tel.
  const plafondComparable = plafond !== null && devise === reference;
  if (plafond !== null && !plafondComparable) {
    dire("plafond_non_verifiable", `plafond de carte exprimé en ${reference}, carte libellée en ${devise} — dépassement non vérifiable sans conversion`);
  }
  const plafond_depasse = plafondComparable && montant_par_carte !== null && montant_par_carte > plafond;
  if (plafond_depasse) {
    dire("plafond_depasse", `${montant_par_carte} ${devise} par carte pour un plafond de ${plafond} EUR — carte insuffisante`);
  }

  return {
    pnr,
    cabine: row.cabine ?? "",
    hotel: row.hotel ?? "",
    pax,
    per,
    cartes,
    devise,
    postes,
    postes_non_renseignes,
    postes_non_convertibles,
    base,
    marge_eur: marge,
    arrondi_eur: arrondi,
    plafond_eur: plafond,
    montant_par_carte,
    montant_total,
    incomplet,
    plafond_depasse,
    escalade: plafond_depasse ? "carte insuffisante" : "",
    avertissements,
    /** Codes normalisés des avertissements de cette ligne (additif) : ce qui permet à
     *  `agregerCartes` de compter les défauts par motif au lieu de les recopier. */
    motifs,
  };
}

/** Libellés de regroupement des motifs de ligne, pour l'agrégat et le rapport. */
const MOTIF_LIBELLES = {
  aucun_poste: "aucun poste à charger dans la politique (load_includes vide) — montant non calculable",
  effectif_illisible: "effectif du dossier nul ou illisible",
  repas_non_renseigne: "indemnité repas non renseignée (H-7)",
  transport_non_renseigne: "indemnité transport non renseignée (H-7)",
  prix_absent: "prix de chambre absent ou illisible",
  devise_non_affichee: "devise non affichée par le relevé (montant supposé en devise de référence)",
  carte_en_devise_relevee: "carte libellée dans la devise du relevé, sans conversion",
  poste_non_convertible: "chambre et indemnités dans deux devises — poste « nuit » à charger séparément",
  plafond_non_verifiable: "plafond non vérifiable (carte dans une autre devise)",
  plafond_depasse: "montant par carte au-dessus du plafond",
};

/**
 * Agrégat des cartes prépayées : ce que la compagnie commande à son émetteur (C7).
 * Les montants restent ventilés par devise — une carte libellée en THB ne s'additionne
 * pas à une carte en EUR. `montant_total_a_charger` n'est chiffré que si toutes les
 * cartes complètes partagent une devise unique.
 *
 * @param {Array<object>} lignes sorties de carteLigne (les `null` sont ignorés)
 * @param {object} policy politique validée
 * @returns {object} agrégat §8.1 (forme décrite dans le contrat de sortie)
 */
export function agregerCartes(lignes, policy) {
  const cfg = policy.payment?.prepaid_card ?? {};
  const utiles = (lignes ?? []).filter(Boolean);
  const montant_total_par_devise = {};
  const montant_partiel_par_devise = {};
  const postes_non_renseignes = new Set();
  const postes_non_convertibles = new Set();
  const escalades = [];
  // défauts remontés par les LIGNES : comptés par motif (le texte porte des PNR et des
  // montants, il ne se dédoublonne pas) et conservés en entier pour qui veut le détail.
  const parMotif = new Map();
  const avertissements_lignes = [];
  let nombre_cartes = 0;
  let cartes_incompletes = 0;
  let cartes_completes = 0;

  for (const l of utiles) {
    nombre_cartes += l.cartes;
    for (const a of l.avertissements ?? []) avertissements_lignes.push(a);
    for (const code of new Set(l.motifs ?? [])) {
      const e = parMotif.get(code) ?? { code, dossiers: 0, exemples: [] };
      e.dossiers += 1;
      if (e.exemples.length < 3 && l.pnr) e.exemples.push(l.pnr);
      parMotif.set(code, e);
    }
    const cible = l.incomplet ? montant_partiel_par_devise : montant_total_par_devise;
    if (l.montant_total !== null) cible[l.devise] = round2((cible[l.devise] ?? 0) + l.montant_total);
    if (l.incomplet) cartes_incompletes += l.cartes;
    else cartes_completes += l.cartes;
    for (const p of l.postes_non_renseignes) postes_non_renseignes.add(p);
    for (const p of l.postes_non_convertibles) postes_non_convertibles.add(p);
    if (l.plafond_depasse) {
      escalades.push({ pnr: l.pnr, motif: "carte insuffisante", montant_par_carte: l.montant_par_carte, devise: l.devise, plafond_eur: l.plafond_eur });
    }
  }

  const devises = [...new Set(utiles.map((l) => l.devise))].sort();
  const devisesCompletes = Object.keys(montant_total_par_devise);
  const montant_total_a_charger = devisesCompletes.length === 1 ? montant_total_par_devise[devisesCompletes[0]] : null;

  const avertissements = [];
  if (cartes_incompletes > 0) {
    const manquants = [...postes_non_renseignes].sort();
    if (manquants.length) {
      avertissements.push(
        `${cartes_incompletes} carte(s) au montant incomplet : poste(s) ${manquants.join(", ")} non renseigné(s) dans la politique (H-7) — montant à compléter avant émission`,
      );
    }
  }
  if (postes_non_convertibles.size) {
    avertissements.push(
      `poste(s) ${[...postes_non_convertibles].sort().join(", ")} dans une devise différente des indemnités — non additionnés, aucun taux de change appliqué`,
    );
  }
  if (devisesCompletes.length > 1) {
    avertissements.push(`cartes libellées en ${devisesCompletes.join(" et ")} — commande à passer devise par devise`);
  }
  if (escalades.length) {
    avertissements.push(`${escalades.length} carte(s) au-dessus du plafond de ${cfg.plafond_eur} EUR — escalade « carte insuffisante »`);
  }
  // Les défauts de ligne remontent ICI : sans eux, l'agrégat déclarait « rien à signaler »
  // pendant que chaque carte portait son propre avertissement que personne ne lisait.
  // `plafond_depasse` est déjà compté ci-dessus, on ne le répète pas.
  const motifs = [...parMotif.values()].sort((a, b) => b.dossiers - a.dossiers || a.code.localeCompare(b.code));
  for (const m of motifs) {
    if (m.code === "plafond_depasse") continue;
    avertissements.push(
      `${m.dossiers} dossier(s) : ${MOTIF_LIBELLES[m.code] ?? m.code} (ex. ${m.exemples.join(", ")}${m.dossiers > m.exemples.length ? ", …" : ""})`,
    );
  }

  return {
    actives: cfg.enabled === true && utiles.length > 0,
    per: cfg.per ?? "dossier",
    load_includes: cfg.load_includes ?? [],
    marge_eur: Number(cfg.marge_eur) || 0,
    arrondi_eur: Number(cfg.arrondi_eur) || 0,
    plafond_eur: cfg.plafond_eur ?? null,
    nombre_lignes: utiles.length,
    nombre_cartes,
    cartes_completes,
    cartes_incompletes,
    devises,
    montant_total_par_devise,
    montant_partiel_par_devise,
    montant_total_a_charger,
    postes_non_renseignes: [...postes_non_renseignes].sort(),
    postes_non_convertibles: [...postes_non_convertibles].sort(),
    escalades,
    avertissements,
    /** Défauts comptés par motif (additif) : {code, dossiers, exemples[]} — de quoi
     *  afficher « 128 dossiers : indemnité repas non renseignée » sans lire 128 phrases. */
    motifs,
    /** Tous les avertissements de ligne, dans l'ordre (additif) : pour l'export et l'UI. */
    avertissements_lignes,
    lignes: utiles,
  };
}

/**
 * @param {Array} plan lignes du plan (sortie d'allocate)
 * @param {object} policy politique validée (plafonds, allowances, payment)
 * @param {object} scenario scénario validé (nights)
 * @param {object} [opts] {avion (défaut A350-900 34/24/266), station (facteur de plafond)}
 * @returns {object} forme §8.1, enrichie C7 (`par_devise`, `devise_unique`,
 *                   `devise_unique_supposee`, `prix_illisibles`, `avertissements`,
 *                   `bloquant`, `cartes_prepayees`)
 */
export function computeCost(plan, policy, scenario, { avion = DEFAULT_AVION, station = null } = {}) {
  const nights = scenario?.nights ?? 1;
  if (!Number.isInteger(nights) || nights < 1) throw new Error(`computeCost : nights invalide (${nights})`);

  const par_devise = {}; // { EUR: {J,W,Y,total}, THB: {...} } — par nuit, jamais fusionnés
  const escalated_rooms = { J: 0, W: 0, Y: 0 };
  const cartes = [];
  // lignes dont le prix affiché n'est pas un nombre : elles injectaient un NaN muet dans
  // le total (`Number("n/a")`), qui contaminait ensuite per_night et la projection.
  const prixIllisibles = [];
  let pax = 0;
  for (const row of plan) {
    const tier = row.cabine;
    if (!(tier in escalated_rooms)) throw new Error(`computeCost : cabine inconnue sur la ligne ${row.pnr} (${tier})`);
    pax += Number(row.pax) || 0;
    if (row.statut === "OK" && row.prix_total !== "") {
      const prix = montantDe(row.prix_total);
      if (prix === null) prixIllisibles.push(row.pnr ?? "(sans pnr)");
      else {
        const devise = deviseDe(row);
        par_devise[devise] ??= tiersVides();
        par_devise[devise][tier] += prix / nights;
      }
    } else if (row.statut !== "OK") {
      escalated_rooms[tier] += Number(row.chambres) || 0;
    }
    const carte = carteLigne(row, policy, { nights });
    if (carte) cartes.push(carte);
  }
  for (const bloc of Object.values(par_devise)) {
    for (const t of ["J", "W", "Y"]) bloc[t] = round2(bloc[t]);
    bloc.total = round2(bloc.J + bloc.W + bloc.Y);
  }

  const reference = policy.global?.currency ?? "EUR";
  const devises = Object.keys(par_devise).sort();
  const nommees = devises.filter((d) => d !== "?");
  // devises RÉELLEMENT en présence : `"?"` compte pour la référence (voir l'entête).
  const effectives = new Set(devises.map((d) => (d === "?" ? reference : d)));
  const bloquant = effectives.size > 1;
  // `"?"` n'est pas une devise imprimable : « 430 ? » n'est pas un montant. Quand aucune
  // devise n'a été affichée, le total est libellé dans la devise de RÉFÉRENCE — c'est déjà
  // la convention de rattachement du module — et `devise_unique_supposee` dit que le
  // libellé est une hypothèse, reprise par l'avertissement `devise_absente`.
  const devise_unique = bloquant ? null : (nommees[0] ?? (devises.length ? reference : null));
  const devise_unique_supposee = !bloquant && nommees.length === 0 && devises.length > 0;
  const avertissements = [];
  // une seule devise effective → total exploitable (comportement historique) ; deux devises
  // nommées → pas de total, la somme serait fausse. Les chiffres restent lisibles dans
  // `par_devise`, qui garde ses postes séparés et reste la source de vérité.
  const per_night = { J: null, W: null, Y: null, total: null };
  // AUCUNE devise retenue = aucun prix lisible sur tout le plan : la réduction sur zéro
  // devise rendait 0, soit « l'hébergement ne coûte rien » pour un montant totalement
  // inconnu. `null` fait écrire « indéterminé » par `fmtMontant`, comme pour les devises
  // mélangées. C'est la même règle, appliquée au même endroit.
  if (!bloquant && devises.length) {
    for (const t of ["J", "W", "Y"]) per_night[t] = round2(devises.reduce((s, d) => s + par_devise[d][t], 0));
    per_night.total = round2(per_night.J + per_night.W + per_night.Y);
  }
  if (bloquant) {
    avertissements.push({
      code: "devises_multiples",
      bloquant: true,
      message: `le plan mélange ${[...effectives].sort().join(", ")} — aucun total consolidé n'est calculé, aucun taux de change n'est appliqué ; voir par_devise`,
    });
  }
  if (prixIllisibles.length) {
    avertissements.push({
      code: "prix_illisible",
      bloquant: false,
      message:
        `${prixIllisibles.length} ligne(s) de plan au prix illisible (${prixIllisibles.slice(0, 5).join(", ")}` +
        `${prixIllisibles.length > 5 ? ", …" : ""}) — NON comptées dans le coût : le total affiché est incomplet`,
    });
  }
  if (devise_unique && devise_unique !== reference) {
    avertissements.push({
      code: "devise_non_reference",
      bloquant: false,
      message: `montants exprimés en ${devise_unique} alors que les plafonds et indemnités sont en ${reference} — non comparables sans conversion`,
    });
  }
  if (par_devise["?"]) {
    avertissements.push({
      code: "devise_absente",
      bloquant: false,
      message: nommees.length
        ? `des montants sans devise affichée sont comptés en ${reference}, comme sur les cartes — à confirmer avant engagement`
        : `aucune devise affichée sur les relevés — montants supposés en ${reference}, à confirmer avant engagement`,
    });
  }

  // borne haute : Σ sièges × plafond effectif, une chambre par passager
  const caps = effectiveCaps(policy, station);
  const seats = avion.seats ?? avion;
  const upper_bound_at_caps = ["J", "W", "Y"].reduce((s, t) => s + (Number(seats[t]) || 0) * caps[t], 0);

  const mealRate = policy.allowances.meal_eur_per_pax_per_day;
  const transportRate = policy.allowances.transport_eur_per_pax;
  const not_determinable = [];
  const allowances = { meal: null, transport: null };
  if (mealRate === null) not_determinable.push("repas");
  else allowances.meal = round2(mealRate * pax * nights);
  if (transportRate === null) not_determinable.push("transport");
  else allowances.transport = round2(transportRate * pax);

  const cartes_prepayees = agregerCartes(cartes, policy);
  for (const a of cartes_prepayees.avertissements) {
    avertissements.push({ code: "carte_prepayee", bloquant: false, message: a });
  }

  return {
    per_night,
    nights,
    projection_total: per_night.total === null ? null : round2(per_night.total * nights),
    upper_bound_at_caps,
    allowances,
    not_determinable,
    escalated_rooms,
    // C7 — additifs
    devise_reference: reference,
    devises,
    devise_unique,
    /** true : aucune devise n'était affichée, `devise_unique` est la devise de référence
     *  SUPPOSÉE — à afficher comme telle, jamais comme une devise relevée. */
    devise_unique_supposee,
    /** PNR dont le prix n'a pas pu être lu : exclus du total (additif). */
    prix_illisibles: prixIllisibles,
    par_devise,
    bloquant,
    avertissements,
    cartes_prepayees,
  };
}
