/**
 * Démo v2 — client vanilla (CDC §10). Règle stricte INV-9 : aucune écriture
 * de HTML depuis des chaînes ; tout texte dynamique (pensées, noms d'hôtels,
 * notes… issus des agents) passe par textContent / nœuds texte construits
 * avec el(). Un test statique le vérifie (demo-invariants.test.mjs).
 */
"use strict";

/* ----------------------------------------------------------- utilitaires */

const $ = (id) => document.getElementById(id);

/** Crée un élément ; les chaînes deviennent des nœuds TEXTE (jamais du HTML). */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const fmtEur = (v) => (v === null || v === undefined || v === "" ? "—" : `${Number(v).toLocaleString("fr-FR")} €`);

/**
 * MÊMES règles d'affichage que `rapport.mjs` (fmtMontant) : un montant absent rend
 * « indéterminé », JAMAIS 0 — un zéro affiché se lit comme « gratuit ». Une devise
 * non relevée est nommée comme telle, jamais remplacée par « € ».
 */
function montantTexte(v, devise) {
  if (v === null || v === undefined || v === "") return "indéterminé";
  const n = Number(v);
  if (!Number.isFinite(n)) return "indéterminé";
  const d = devise && devise !== "?" ? String(devise) : "";
  return d ? `${n.toLocaleString("fr-FR")} ${d}` : `${n.toLocaleString("fr-FR")} (devise non affichée)`;
}

/** Créneau de présentation (C6) — aucun horaire n'est inventé quand il n'y en a pas. */
function creneauTexte(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.debut) return v.fin ? `${v.debut}–${v.fin}` : `à partir de ${v.debut}`;
  return "illisible";
}

/**
 * Niveau de stock derrière la ligne (C2), à DEUX NIVEAUX : « FERME » = chambre adossée
 * à une mesure sûre ; « À CONFIRMER » = chambre adossée à un sélecteur plafonné, donc à
 * une borne basse — elle est bien planifiée, mais elle se confirme au téléphone.
 * Une ligne mixte affiche le détail chiffré. Les couchages manquants suivent.
 */
function stockTexte(row) {
  if (row.statut !== "OK") return "—";
  const parts = [];
  const f = Number(row.chambres_fermes);
  const a = Number(row.chambres_a_confirmer);
  if (Number.isFinite(f) && Number.isFinite(a) && f > 0 && a > 0) parts.push(`${fmtInt(f)} ferme(s) + ${fmtInt(a)} À CONFIRMER`);
  else if (row.stock_mesure === true) parts.push("FERME");
  else if (row.stock_mesure === false) parts.push("À CONFIRMER");
  else parts.push("inconnu");
  if (row.couchages_insuffisants) parts.push(`${fmtInt(row.couchages_manquants)} couchage(s) manquant(s)`);
  return parts.join(" · ");
}

/**
 * Ventilation FERME / À CONFIRMER d'un ensemble de lignes (C2). Les compteurs de ligne
 * font foi ; une ligne d'un plan antérieur qui ne les porte pas est classée sur
 * `stock_mesure`, jamais devinée.
 * @returns {{fermes: number, aConfirmer: number}}
 */
function niveauxLignes(lignes) {
  const r = { fermes: 0, aConfirmer: 0 };
  for (const row of lignes ?? []) {
    const ch = Number(row.chambres) || 0;
    const f = Number(row.chambres_fermes);
    const a = Number(row.chambres_a_confirmer);
    if (Number.isFinite(f) || Number.isFinite(a)) {
      r.fermes += Number.isFinite(f) ? f : 0;
      r.aConfirmer += Number.isFinite(a) ? a : 0;
    } else if (row.stock_mesure === true) r.fermes += ch;
    else r.aConfirmer += ch;
  }
  return r;
}

/** Carte prépayée de la ligne (C7), reprise de `cost.cartes_prepayees.lignes`. */
function carteTexte(row) {
  const c = S.cartes.get(row.pnr);
  if (!c) return row.mode_reglement === "carte_prepayee" ? "à chiffrer" : "—";
  if (c.montant_par_carte === null || c.montant_par_carte === undefined) return "indéterminé";
  const d = c.devise && c.devise !== "?" ? c.devise : "(devise non affichée)";
  return `${c.montant_par_carte} ${d} × ${c.cartes}${c.incomplet ? " — PARTIEL" : ""}`;
}
// MEMES regles que `fmtEur` : une valeur absente rend un tiret, JAMAIS 0. Un « 0,00 $ »
// affiche pendant qu'une session facture est le chiffre rassurant le plus couteux de l'ecran.
const fmtUsd = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
    ? "non mesuré"
    : `${Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const fmtInt = (v) =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("fr-FR");
const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR") : "jamais");

async function api(method, path, body, { raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined && !raw ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------------ état */

const S = {
  config: null, // GET /api/config
  stations: [],
  run: null, // dernier snapshot / agrégat courant
  agentsEls: new Map(), // hotel_key → carte
  planRows: new Map(), // pnr → tr
  messages: null, // messages du run affiché
  messagesRunId: null,
  msgLang: "fr",
  msgTier: "",
  passengersMode: "generated", // "uploaded" | "generated" | null (liste refusée : lancement verrouillé)
  uploaded: null, // rapport d'ingestion de la liste téléversée
  elapsedTimer: null,
  prioritesChargees: null, // `global.priorities` de la politique chargée (DÉPRÉCIÉ, jamais réécrit)
  exclusions: new Map(), // C6 — pnr → motif des lignes écartées de la validation
  cartes: new Map(), // C7 — pnr → ligne de carte prépayée (cost.cartes_prepayees.lignes)
};

const PHASE_STEPS = [
  ["preparation", "préparation"],
  ["generation", "génération"],
  ["besoins", "besoins"],
  ["inventaire", "inventaire"],
  ["discovery", "découverte"],
  ["releves", "relevés"],
  ["allocation", "allocation"],
  ["extension", "extension"],
  ["sorties", "sorties"],
  ["done", "terminé"],
];
const phaseIndex = (phase) => {
  const key = phase === "discovery_skipped" ? "discovery" : phase;
  return PHASE_STEPS.findIndex(([p]) => p === key);
};

/* ------------------------------------------------------------ formulaire */

function cabinBlock(tier, cab, labels) {
  const stars = (id, value, allowNull) => {
    const sel = el("select", { id });
    if (allowNull) sel.append(el("option", { value: "", text: "—" }));
    for (let s = 0; s <= 5; s += 1) sel.append(el("option", { value: s, text: `${s}★` }));
    sel.value = value === null ? "" : String(value);
    return sel;
  };
  const amenities = el("div", { class: "amenity-grid" });
  for (const key of S.config.amenities.keys) {
    const cb = el("input", { type: "checkbox", id: `amen-${tier}-${key}` });
    cb.checked = cab.required_amenities.includes(key);
    amenities.append(el("label", { class: "checkline" }, cb, ` ${labels[key] ?? key}`));
  }
  const cap = el("input", { id: `cap-${tier}`, type: "number", min: "10", step: "5" });
  cap.value = cab.price_cap_eur;
  cap.addEventListener("input", updateEffectiveCaps);
  return el(
    "div",
    { class: "cabin-block" },
    el("h4", { text: `Cabine ${tier}` }),
    el("div", { class: "cabin-inline" },
      el("label", { text: "Étoiles min " }, stars(`stars-min-${tier}`, cab.min_stars, false)),
      el("label", { text: "Étoiles max " }, stars(`stars-max-${tier}`, cab.max_stars, true)),
    ),
    el("label", { text: "Plafond €/nuit " }, cap, el("span", { id: `cap-eff-${tier}`, class: "cap-effective" })),
    amenities,
  );
}

/* ------------------------------------- politique de prise en charge (cases) */

/**
 * Les trois réglages de PROXIMITÉ, nommés comme le contrat de `lib/policy.mjs`.
 * La proximité N'EST PAS le rang : elle ne dit pas qui passe devant, elle dit qui a
 * le droit d'être envoyé loin. Confondre les deux, c'est régler l'outil à l'envers.
 */
const PROXIMITES = [
  ["stricte", "stricte (escalade plutôt qu'éloigner)"],
  ["preferee", "préférée (éloigner en dernier recours)"],
  ["aucune", "aucune (seul le budget limite)"],
];

/** Libellé court d'un réglage de proximité (les clés du contrat sont sans accent). */
const PROXIMITE_LABELS = { stricte: "stricte", preferee: "préférée", aucune: "aucune" };
const proximiteTexte = (v) => PROXIMITE_LABELS[v] ?? (v || "indéterminée");

/**
 * Un nombre RÉELLEMENT fourni. `Number.isFinite(Number(v))` ne suffit pas : `Number(null)`
 * et `Number("")` valent 0, et une couronne sans temps de trajet s'afficherait alors
 * « 0 min » — exactement le chiffre rassurant non mérité que ce projet interdit.
 */
const estNombre = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
/** Temps de trajet d'une couronne — DÉCLARÉ par l'exploitation, jamais mesuré. */
const trajetDeclareTexte = (v) => (estNombre(v) ? `${fmtInt(v)} min déclarées` : "trajet déclaré indéterminé");
/** Rayon d'une couronne, en km, ou « indéterminé » — jamais 0 km. */
const rayonTexte = (v) => (estNombre(v) ? `${Math.round(Number(v) / 100) / 10} km` : "rayon indéterminé");

/** Sources de découverte servies par le serveur ; repli sur la politique par défaut. */
function sourcesDefaut() {
  return S.config?.defaults?.policy?.global?.discovery?.sources ?? [];
}

const SOURCE_TEXTE = {
  booking: ["Booking.com", "plateforme — prix public, entre au plan"],
  agoda: ["Agoda", "plateforme — fort en Asie du Sud-Est, référence des hôtels absents de Booking"],
  tripcom: ["Trip.com", "plateforme — prix public"],
  expedia: ["Expedia", "plateforme — prix public"],
  maps: ["Google Maps", "ANNUAIRE — nom, adresse et téléphone, AUCUN prix : vivier à appeler"],
};

/** Une case à cocher par source, avec son plafond d'établissements. */
function renderSources(policy) {
  const wrap = $("src-liste");
  if (!wrap) return;
  clear(wrap);
  const parCle = new Map((policy.global?.discovery?.sources ?? []).map((x) => [x.cle, x]));
  const defauts = sourcesDefaut();
  const liste = (defauts.length ? defauts : [...parCle.values()]).slice().sort((a, b) => a.rang - b.rang);
  let actives = 0;
  for (const d of liste) {
    const cur = parCle.get(d.cle) ?? d;
    if (cur.actif) actives++;
    const [nom, quoi] = SOURCE_TEXTE[d.cle] ?? [d.cle, ""];
    const ligne = el("div", { class: "pec-ligne" });
    const lab = el("label", { class: "checkline" });
    const cb = el("input");
    cb.type = "checkbox";
    cb.id = `src-actif-${d.cle}`;
    cb.checked = cur.actif === true;
    lab.append(cb, document.createTextNode(` ${nom}`));
    const note = el("span", { class: "hint" });
    note.textContent = ` — ${quoi}`;
    lab.append(note);
    const max = el("label");
    max.textContent = "max établissements ";
    const inp = el("input");
    inp.type = "number";
    inp.min = "1";
    inp.max = "60";
    inp.step = "1";
    inp.id = `src-max-${d.cle}`;
    inp.value = cur.max_candidats ?? d.max_candidats ?? 10;
    max.append(inp);
    ligne.append(lab, max);
    wrap.append(ligne);
  }
  const bilan = $("src-bilan");
  if (bilan) {
    bilan.textContent = actives
      ? `${actives} source(s) cochée(s) — au moins ${actives} session(s) d'agent payante(s) à la découverte.`
      : "Aucune source cochée : le vivier se limitera à l'inventaire déjà fiché.";
  }
}

/** Relit les cases de sources dans la politique soumise. */
function lireSources(base) {
  const defauts = sourcesDefaut();
  if (!defauts.length || !$("src-actif-booking")) return; // écran non rendu : on ne touche à rien
  const disc = (base.global.discovery ??= {});
  disc.sources = defauts.map((d) => {
    const max = Number($(`src-max-${d.cle}`)?.value);
    return {
      cle: d.cle,
      actif: $(`src-actif-${d.cle}`)?.checked ?? d.actif,
      rang: d.rang,
      max_candidats: Number.isFinite(max) && max > 0 ? max : d.max_candidats,
    };
  });
}

/** Vocabulaire des critères servi par le serveur ; repli sur la politique par défaut. */
function vocabulairePec() {
  const v = S.config?.prise_en_charge;
  if (v?.keys?.length) return v;
  const defaut = S.config?.defaults?.policy?.global?.prise_en_charge?.criteres ?? [];
  return { keys: defaut.map((c) => c.cle), labels: {}, defaut };
}

/** Réglage par défaut d'un critère, pour un formulaire dont un champ manquerait. */
function critereDefaut(cle) {
  const v = vocabulairePec();
  return (v.defaut ?? []).find((c) => c.cle === cle) ?? { cle, actif: false, rang: 50, proximite: "aucune", departage: false };
}

/** Une ligne de la politique : la case à cocher, son RANG, sa PROXIMITÉ, son départage. */
function critereLigne(cle, c) {
  const v = vocabulairePec();
  const actif = el("input", { type: "checkbox", id: `pec-actif-${cle}` });
  actif.checked = c.actif !== false;
  const rang = el("input", { type: "number", id: `pec-rang-${cle}`, min: "1", max: "99", step: "1", class: "pec-rang" });
  rang.value = c.rang;
  const prox = el("select", { id: `pec-prox-${cle}`, class: "pec-prox" });
  for (const [val, txt] of PROXIMITES) prox.append(el("option", { value: val, text: txt }));
  prox.value = c.proximite ?? "aucune";
  const dep = el("input", { type: "checkbox", id: `pec-dep-${cle}` });
  dep.checked = c.departage === true;

  const reglages = el("div", { class: "pec-reglages" },
    el("label", { class: "pec-champ", text: "rang " }, rang),
    el("label", { class: "pec-champ", text: "proximité " }, prox),
    el("label", { class: "checkline" }, dep, " départage seulement (ne crée pas de file)"),
  );
  const majDisponibilite = () => {
    rang.disabled = !actif.checked;
    prox.disabled = !actif.checked;
    dep.disabled = !actif.checked;
    reglages.classList.toggle("off", !actif.checked);
  };
  actif.addEventListener("change", () => {
    majDisponibilite();
    verifierPriseEnCharge();
  });
  rang.addEventListener("input", verifierPriseEnCharge);
  majDisponibilite();

  return el("div", { class: "pec-critere" },
    el("label", { class: "checkline" }, actif, ` ${v.labels?.[cle] ?? cle}`),
    reglages,
  );
}

/** Reconstruit les cases à cocher depuis une politique (défauts, preset, ou rechargement). */
function buildPriseEnChargeForm(policy) {
  const v = vocabulairePec();
  const pec = policy.global?.prise_en_charge ?? { criteres: v.defaut, age_bas_max: 6, elargir_si_insuffisant: true };
  const parCle = new Map((pec.criteres ?? []).map((c) => [c.cle, c]));
  const wrap = $("pec-criteres");
  clear(wrap);
  // ordre d'affichage = ordre de SERVICE : l'écran doit se lire comme la file
  const ordre = [...v.keys].sort((a, b) => {
    const ca = parCle.get(a) ?? critereDefaut(a);
    const cb = parCle.get(b) ?? critereDefaut(b);
    return ca.rang - cb.rang || String(a).localeCompare(String(b));
  });
  for (const cle of ordre) wrap.append(critereLigne(cle, parCle.get(cle) ?? critereDefaut(cle)));

  renderSources(policy);

  $("f-pec-age").value = pec.age_bas_max ?? 6;
  $("f-pec-elargir").checked = pec.elargir_si_insuffisant !== false;
  const corr = policy.global?.correspondance ?? {};
  $("f-corr-avance").value = corr.avance_avant_vol_min ?? 120;
  $("f-corr-repos").value = corr.repos_minimal_min ?? 240;
  $("f-corr-marge").value = corr.marge_min ?? 30;
  $("f-corr-seuil").value = corr.seuil_serree_min ?? 480;

  renderPrioritesDepreciees(policy);
  verifierPriseEnCharge();
}

/**
 * `global.priorities` est DÉPRÉCIÉ (politiques enregistrées avant le 21/09/2026).
 * Un preset ancien doit se charger sans erreur — et l'écran doit dire que ce réglage ne
 * pilote plus rien, et ce qui l'a remplacé. Les mots qui ne correspondent à aucun critère
 * n'ont JAMAIS eu d'effet : c'est le point que l'exploitant doit lire.
 */
function renderPrioritesDepreciees(policy) {
  const box = $("pec-deprecie");
  clear(box);
  const prio = policy.global?.priorities ?? [];
  if (!prio.length) return;
  const connus = new Set(vocabulairePec().keys);
  const inconnus = prio.filter((p) => !connus.has(p));
  box.append(el("strong", { text: "Réglage « priorités » (déprécié) : " }));
  box.append(el("span", { text: `${prio.join(", ")} — conservé tel quel dans la politique, mais il ne pilote plus rien. ` +
    "Il est remplacé par les cases ci-dessus : rang (ordre de service) et proximité (droit aux hôtels proches)." }));
  if (inconnus.length) {
    box.append(el("br"));
    box.append(el("span", { class: "avert", text:
      `Sans effet, et sans l'avoir jamais dit : ${inconnus.join(", ")} — seules trois files existaient ` +
      "(PMR, famille, cabine), tout autre mot saisi était ignoré en silence." }));
  }
}

/** Incohérences que l'exploitant doit voir AVANT de lancer : rangs en double, aucune case. */
function verifierPriseEnCharge() {
  const box = $("pec-incoherence");
  if (!box) return;
  const v = vocabulairePec();
  const actifs = v.keys.filter((cle) => $(`pec-actif-${cle}`)?.checked);
  const messages = [];
  if (!actifs.length) {
    messages.push("aucun critère coché : tous les dossiers passeront par la file de repli, servis dans l'ordre de la liste.");
  }
  const rangs = new Map();
  for (const cle of actifs) {
    const r = Number($(`pec-rang-${cle}`)?.value);
    if (!Number.isFinite(r)) continue;
    rangs.set(r, [...(rangs.get(r) ?? []), v.labels?.[cle] ?? cle]);
  }
  for (const [r, cles] of rangs) {
    if (cles.length > 1) messages.push(`rang ${r} partagé par ${cles.join(", ")} : l'ordre entre eux n'est pas réglé.`);
  }
  box.textContent = messages.join(" ");
}

/** Couronnes de l'escale sélectionnée — DÉCLARÉES par l'exploitation, jamais mesurées. */
function renderCouronnesEscale() {
  const box = $("pec-couronnes");
  if (!box) return;
  clear(box);
  const st = currentStation();
  const bloc = st?.couronnes;
  const liste = bloc?.couronnes ?? [];
  if (!liste.length) {
    box.append(el("p", { class: "avert", text:
      "couronnes INDÉTERMINÉES pour cette escale — aucune répartition par distance ne peut être décrite ici" }));
    return;
  }
  box.append(el("p", { class: bloc.source === "derivee" ? "avert" : "hint", text:
    bloc.source === "derivee"
      ? "Aucune couronne déclarée dans la fiche escale : couronne unique DÉRIVÉE du rayon. Ce n'est pas une " +
        "déclaration d'exploitation — tous les hôtels partagent alors le même temps de trajet, et les budgets " +
        "de trajet ne départagent rien."
      : "Temps de trajet DÉCLARÉS par l'exploitation, non mesurés : l'outil n'a aucun service de routage et " +
        "ne convertit pas une distance en durée." }));
  const ul = el("ul", { class: "pec-couronnes-liste" });
  for (const c of liste) {
    ul.append(el("li", { text:
      `couronne ${c.rang} — ${rayonTexte(c.rayon_m)} · ${trajetDeclareTexte(c.trajet_min)} · ` +
      `${c.mode || "mode indéterminé"}${c.note ? ` — ${c.note}` : ""}` }));
  }
  box.append(ul);
}

function buildPolicyForm(policy) {
  const wrap = $("policy-cabins");
  clear(wrap);
  for (const tier of ["J", "W", "Y"]) wrap.append(cabinBlock(tier, policy.cabins[tier], S.config.amenities.labels));
  $("f-fam-adults").value = policy.global.rooming.family_unit_max.adults;
  $("f-fam-children").value = policy.global.rooming.family_unit_max.children;
  // `priorities` est déprécié : il est conservé tel quel, jamais réécrit par l'écran
  S.prioritesChargees = Array.isArray(policy.global?.priorities) ? [...policy.global.priorities] : null;
  buildPriseEnChargeForm(policy);
  $("f-pay-mode").value = policy.payment.default_mode;
  $("f-pay-card").checked = policy.payment.prepaid_card.enabled;
  $("f-ext-enabled").checked = policy.extension.enabled;
  $("f-ext-probe").checked = policy.extension.probe_same_hotel_first;
  $("f-ext-waves").value = policy.extension.max_waves;
  $("f-ext-sessions").value = policy.extension.max_sessions_per_run;
  $("f-ext-cost").value = policy.extension.max_cost_usd_per_run;
  updateEffectiveCaps();
}

function currentStation() {
  return S.stations.find((s) => s.code === $("f-station").value) ?? S.stations[0];
}

function updateEffectiveCaps() {
  const station = currentStation();
  const factor = station?.pricing?.price_cap_factor ?? 1;
  for (const tier of ["J", "W", "Y"]) {
    const cap = Number($(`cap-${tier}`)?.value || 0);
    const span = $(`cap-eff-${tier}`);
    if (span) span.textContent = ` effectif : ${Math.round(cap * factor)} € (facteur ${factor})`;
  }
}

function renderStationInfo() {
  const st = currentStation();
  if (!st) return;
  const nb = st.couronnes?.couronnes?.length ?? 0;
  const source = st.couronnes?.source === "declaree" ? "déclarée(s)" : "dérivée(s) du rayon";
  $("station-info").textContent =
    `${st.name} — zone « ${st.search.zone_query} », rayon ${st.search.radius_km} km, ` +
    `transfert ${st.transfer.default_mode} (max ${st.transfer.max_transfer_min} min), facteur prix ×${st.pricing.price_cap_factor}` +
    (nb ? ` · ${nb} couronne(s) ${source}` : " · couronnes indéterminées");
  updateEffectiveCaps();
  renderCouronnesEscale();
}

/** Politique complète assemblée depuis le formulaire (validée côté serveur). */
function policyFromForm() {
  const base = JSON.parse(JSON.stringify(S.config.defaults.policy));
  for (const tier of ["J", "W", "Y"]) {
    const cab = base.cabins[tier];
    cab.min_stars = Number($(`stars-min-${tier}`).value);
    const rawMax = $(`stars-max-${tier}`).value;
    cab.max_stars = rawMax === "" ? null : Number(rawMax);
    cab.price_cap_eur = Number($(`cap-${tier}`).value);
    cab.required_amenities = S.config.amenities.keys.filter((k) => $(`amen-${tier}-${k}`).checked);
  }
  base.global.rooming.family_unit_max = {
    adults: Number($("f-fam-adults").value),
    children: Number($("f-fam-children").value),
  };
  // POLITIQUE DE PRISE EN CHARGE : une case par critère, avec son rang et sa proximité.
  // `actif: false` est conservé (et non retiré) pour que décocher reste réversible et
  // visible dans le preset enregistré.
  const v = vocabulairePec();
  const pec = (base.global.prise_en_charge ??= { criteres: [], age_bas_max: 6, elargir_si_insuffisant: true });
  pec.criteres = v.keys.map((cle) => {
    const d = critereDefaut(cle);
    const rang = Number($(`pec-rang-${cle}`)?.value);
    return {
      cle,
      actif: $(`pec-actif-${cle}`)?.checked ?? d.actif,
      rang: Number.isFinite(rang) ? rang : d.rang,
      proximite: $(`pec-prox-${cle}`)?.value || d.proximite,
      departage: $(`pec-dep-${cle}`)?.checked ?? d.departage,
    };
  });
  lireSources(base);
  pec.age_bas_max = Number($("f-pec-age").value);
  pec.elargir_si_insuffisant = $("f-pec-elargir").checked;
  base.global.correspondance = {
    avance_avant_vol_min: Number($("f-corr-avance").value),
    repos_minimal_min: Number($("f-corr-repos").value),
    marge_min: Number($("f-corr-marge").value),
    seuil_serree_min: Number($("f-corr-seuil").value),
  };
  // `priorities` est DÉPRÉCIÉ : repris tel quel de la politique chargée, jamais réécrit
  // par l'écran — un preset ancien garde sa trace, sans qu'elle pilote quoi que ce soit.
  if (S.prioritesChargees) base.global.priorities = [...S.prioritesChargees];
  base.payment.default_mode = $("f-pay-mode").value;
  base.payment.prepaid_card.enabled = $("f-pay-card").checked;
  base.extension.enabled = $("f-ext-enabled").checked;
  base.extension.probe_same_hotel_first = $("f-ext-probe").checked;
  base.extension.max_waves = Number($("f-ext-waves").value);
  base.extension.max_sessions_per_run = Number($("f-ext-sessions").value);
  base.extension.max_cost_usd_per_run = Number($("f-ext-cost").value);
  return base;
}

function runPayload({ dryRun = false } = {}) {
  return {
    policy: policyFromForm(),
    avion: {
      nom: $("f-avion-nom").value || "A350-900",
      seats: { J: Number($("f-seats-J").value), W: Number($("f-seats-W").value), Y: Number($("f-seats-Y").value) },
    },
    scenario: {
      station: $("f-station").value,
      checkin: $("f-checkin").value || null,
      nights: Number($("f-nights").value),
      seed: Number($("f-seed").value),
      simulate: $("f-simulate").checked,
      force_discovery: $("f-force-discovery").checked,
    },
    sim_speed: Number($("f-sim-speed").value),
    // vivier par API hôtelière : ni agent, ni simulation. Le serveur construit le vivier,
    // l'écrit dans l'inventaire de l'escale, puis rejoue — aucune session payante.
    source: $("f-source-api")?.checked ? "api" : undefined,
    passengers: S.passengersMode,
    dry_run: dryRun || undefined,
  };
}

/* -------------------------------------------------------------- rendu run */

function renderStatus() {
  const r = S.run;
  const chip = $("status-chip");
  const states = {
    idle: "prêt", running: "run en cours", done: "terminé — à valider",
    valide: "répartition validée", refuse: "répartition refusée",
    cancelled: "annulé", error: "erreur", interrupted: "interrompu (serveur redémarré)",
  };
  const st = r?.state ?? "idle";
  chip.className = `chip ${st}`;
  chip.textContent = states[st] ?? st;
  $("run-id").textContent = r?.runId ? `run ${r.runId} · ${r.station ?? ""}${r.simulate ? " · simulation" : ""}` : "";
  $("btn-cancel").classList.toggle("hidden", st !== "running");
  $("btn-cancel-ext").classList.toggle("hidden", !(st === "running" && r?.phase === "extension"));
  $("btn-run").disabled = st === "running" || S.passengersMode === null;
  renderSourceListe();
  if (st === "running" && !S.elapsedTimer) {
    S.elapsedTimer = setInterval(renderElapsed, 1000);
  } else if (st !== "running" && S.elapsedTimer) {
    clearInterval(S.elapsedTimer);
    S.elapsedTimer = null;
    renderElapsed();
  }
}

/** Source de la liste, affichée EN PERMANENCE à côté du bouton de lancement. */
function renderSourceListe() {
  const box = $("source-liste");
  if (!box) return;
  clear(box);
  if (S.passengersMode === null) {
    box.className = "source-liste refus";
    box.append(el("strong", { text: "Liste refusée — corrigez le fichier, ou cliquez « Générer la liste » pour partir sur une liste fictive" }));
    return;
  }
  if (S.passengersMode === "uploaded") {
    const u = S.uploaded;
    box.className = "source-liste reelle";
    box.append(el("strong", { text: "LISTE : téléversée" }), el("span", {
      text: u ? ` — ${fmtInt(u.passagers)} passagers à loger, ${fmtInt(u.dossiers)} dossiers` +
        (u.lignes ? ` (${fmtInt(u.lignes.lues)} lignes lues)` : "") : "",
    }));
    return;
  }
  box.className = "source-liste generee";
  box.append(el("strong", { text: "LISTE : GÉNÉRÉE" }), el("span", { text: " — passagers fictifs, aucun passager réel" }));
}

function renderElapsed() {
  const r = S.run;
  const from = r?.startedAt ? new Date(r.startedAt).getTime() : null;
  if (!from) return void ($("b-elapsed").textContent = "—");
  const to = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((to - from) / 1000));
  $("b-elapsed").textContent = `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function renderPhases() {
  const wrap = $("phases-frise");
  clear(wrap);
  const r = S.run;
  const seen = new Map((r?.phases ?? []).map((p) => [p.phase === "discovery_skipped" ? "discovery" : p.phase, p]));
  const currentIdx = r?.phase ? phaseIndex(r.phase) : -1;
  const doneState = r?.state === "done" || r?.state === "cancelled" || r?.state === "error";
  PHASE_STEPS.forEach(([key, label], i) => {
    let cls = "step";
    let text = label;
    if (key === "discovery" && seen.has("discovery")) {
      const p = seen.get("discovery");
      if ((r.phases ?? []).some((x) => x.phase === "discovery_skipped")) {
        cls += " skipped";
        text = `découverte sautée${p.reason ? ` (${p.reason})` : ""}`;
      }
    }
    if (key === "extension" && seen.has("extension")) {
      const waves = Math.max(...(r.phases ?? []).filter((x) => x.phase === "extension").map((x) => x.wave ?? 1));
      text = `extension (vague ${waves})`;
    }
    if (key === "done" && r?.done) text = r.state === "cancelled" ? "annulé" : "terminé";
    if (i < currentIdx || (doneState && seen.has(key)) || (key === "done" && r?.done)) cls += " past";
    if (!doneState && i === currentIdx) cls += " current";
    if (!cls.includes("past") && !cls.includes("current") && cls.includes("skipped")) {
      /* sautée : style pointillé conservé */
    }
    wrap.append(el("span", { class: cls, text }));
  });
}

/** Personnes logées / total, comptées sur les lignes de plan déjà reçues (C2). */
function paxDuPlan(plan) {
  let total = 0;
  let loges = 0;
  for (const row of plan ?? []) {
    const n = Number(row.pax) || 0;
    total += n;
    if (row.statut === "OK") loges += n;
  }
  return { total, loges };
}

function renderBanner() {
  const r = S.run;
  // Aucune mesure recue = « non mesure », pas zero : tant que la plateforme n'a rien
  // rapporte, l'ecran ne doit pas affirmer que le run n'a rien coute.
  const t = r?.metricsTotals ?? { steps: null, cost_usd: null, tokens: null };
  $("b-cost").textContent = fmtUsd(t.cost_usd);
  $("b-tokens").textContent = fmtInt(t.tokens);
  $("b-steps").textContent = fmtInt(t.steps);
  const lim = r?.extension?.limits;
  const extPolicy = S.config?.defaults?.policy?.extension;
  const sMax = lim?.sessions_max ?? extPolicy?.max_sessions_per_run ?? "—";
  const cMax = lim?.cost_max ?? extPolicy?.max_cost_usd_per_run ?? "—";
  const wMax = lim?.max_waves ?? extPolicy?.max_waves ?? "—";
  $("b-ext-sessions").textContent = `${lim?.sessions_used ?? 0} / ${sMax}`;
  $("b-ext-cost").textContent = `${lim ? fmtUsd(lim.cost_usd) : "—"} / ${cMax} $`;
  $("b-ext-wave").textContent = lim ? `${Math.min(lim.wave, lim.max_waves)} / ${wMax}` : `0 / ${wMax}`;
  // C2 — le chiffre décisif : des PERSONNES, pas des dossiers. En cours de run la
  // synthèse d'allocation n'existe pas encore : on compte sur les lignes de plan
  // déjà reçues, et le bandeau dit que le chiffre est PROVISOIRE.
  const sum = r?.summary;
  const paxEl = $("b-pax");
  if (paxEl) {
    if (sum) {
      paxEl.textContent = `${fmtInt(sum.paxLoges)} / ${fmtInt(sum.paxTotal)}`;
      paxEl.classList.toggle("alert", sum.paxNonLoges > 0);
    } else {
      const p = paxDuPlan(r?.plan);
      paxEl.textContent = p.total ? `${fmtInt(p.loges)} / ${fmtInt(p.total)} (provisoire)` : "—";
      paxEl.classList.toggle("alert", p.total > 0 && p.loges < p.total);
    }
  }
  // C5 — arrêté par le TEMPS, ou pas : ce n'est pas la même panne
  const dl = $("b-deadline");
  if (dl) {
    const done = r?.done;
    if (r?.deadline) {
      dl.textContent = `ATTEINTE à ${r.deadline.minutes_used} / ${r.deadline.minutes_max} min`;
      dl.classList.add("alert");
    } else if (done && done.minutes_max) {
      dl.textContent = `${done.minutes_used ?? "?"} / ${done.minutes_max} min`;
      dl.classList.remove("alert");
    } else {
      dl.textContent = "—";
      dl.classList.remove("alert");
    }
  }
  renderElapsed();
}

function agentCard(key) {
  if (S.agentsEls.has(key)) return S.agentsEls.get(key);
  const card = {
    root: null, name: el("span", { class: "a-name" }), status: el("span", { class: "a-status" }),
    thought: el("p", { class: "a-thought" }), meta: el("span", { class: "a-meta-text" }),
    thumb: null, thumbWrap: el("div"), probeTag: el("span", { class: "a-probe-tag" }), live: el("span", { class: "a-live" }),
  };
  card.root = el(
    "div",
    { class: "agent-card" },
    el("div", { class: "a-head" }, card.name, card.status),
    card.probeTag,
    card.thought,
    card.thumbWrap,
    el("div", { class: "a-meta" }, card.meta, card.live),
  );
  S.agentsEls.set(key, card);
  $("agents").append(card.root);
  return card;
}

function renderAgent(key, a) {
  const card = agentCard(key);
  card.name.textContent = a.name ?? key;
  card.name.title = a.name ?? key;
  card.status.textContent = a.status ?? "…";
  card.status.className = `a-status ${a.status ?? ""}`;
  card.thought.textContent = a.last_thought ?? "";
  card.probeTag.textContent = a.probe ? "sonde de capacité" : "";
  card.meta.textContent = `${a.steps ?? 0} pas · ${fmtInt(a.tokens ?? 0)} tokens · ${fmtUsd(a.cost_usd ?? 0)}`;
  if (a.live_view_url) {
    clear(card.live);
    card.live.append(el("a", { href: a.live_view_url, target: "_blank", rel: "noopener noreferrer", text: "Vue live H ↗" }));
  }
  const captures = Number(a.captures ?? 0);
  if (captures > 0) {
    const seq = captures - 1;
    const src = `/api/screenshot?hotel=${encodeURIComponent(key)}&seq=${seq}`;
    if (!card.thumb) {
      card.thumb = el("img", { class: "a-thumb", alt: `Capture ${a.name ?? key}`, onclick: () => openLightbox(src) });
      card.thumbWrap.append(card.thumb);
    }
    if (card.thumb.getAttribute("src") !== src) {
      card.thumb.src = src;
      card.thumb.onclick = () => openLightbox(src);
    }
  }
  $("agents-count").textContent = `(${S.agentsEls.size})`;
}

function renderAgents() {
  for (const [key, a] of Object.entries(S.run?.agents ?? {})) renderAgent(key, a);
}

function openLightbox(src) {
  $("lightbox-img").src = src;
  $("lightbox").classList.remove("hidden");
}

/**
 * Budget de trajet OPPOSÉ à l'hôtel pour ce dossier, et la proximité de sa file.
 *
 * Trois silences à ne PAS confondre : la colonne absente (plan d'une version antérieure)
 * se dit « indéterminé » ; `""` veut dire « aucune contrainte de distance », jamais
 * « zéro minute » ; `<= 0` veut dire que l'hôtel n'a plus de sens pour ce dossier.
 */
function budgetTexte(row) {
  const prox = row.proximite && row.proximite !== "aucune" ? ` · proximité ${proximiteTexte(row.proximite)}` : "";
  if (!Object.prototype.hasOwnProperty.call(row, "trajet_max_min")) return "indéterminé";
  const brut = row.trajet_max_min;
  if (brut === "" || brut === null || brut === undefined) return `sans contrainte${prox}`;
  const n = Number(brut);
  if (!Number.isFinite(n)) return "indéterminé";
  if (n <= 0) return `≤ 0 min — l'hôtel n'a plus de sens${prox}`;
  return `${fmtInt(n)} min max${prox}`;
}

/**
 * Couronne RETENUE pour la ligne, avec son temps de trajet DÉCLARÉ (jamais mesuré) et
 * d'où vient le rangement. Une couronne « inconnue » se dit, elle ne se comble pas.
 */
function couronneTexte(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "couronne_cle")) return "indéterminé";
  const cle = row.couronne_cle;
  if (cle === "" || cle === null || cle === undefined) return "—";
  const trajet = trajetDeclareTexte(row.couronne_trajet_min_declare);
  const nom = cle === "hors_couronnes" ? "hors couronnes" : `couronne ${cle}`;
  const mode = row.couronne_mode ? ` · ${row.couronne_mode}` : "";
  const reserve = row.couronne_source === "inconnue" ? " · À CONFIRMER (distance non relevée)" : "";
  return `${nom} · ${trajet}${mode}${reserve}`;
}

/**
 * Cellules de la liste de répartition soumise au validateur (C2/C3/C6/C7).
 * L'ordre suit l'en-tête de `index.html`, case « Écarter » exclue (colonne 0).
 */
function planCells(row) {
  return [
    row.pnr, row.cabine, row.overlays || "", row.categorie || "",
    budgetTexte(row),
    row.hotel || "—", couronneTexte(row), row.room_type || "—", String(row.chambres ?? ""),
    String(row.pax ?? ""),
    montantTexte(row.prix_total, row.devise),
    stockTexte(row),
    creneauTexte(row.creneau_presentation),
    carteTexte(row),
    row.conformite || "—", row.mode_reglement || "—",
    row.statut ?? "", row.notes || "",
  ];
}

/** Colonnes numériques (alignement à droite) — indices dans `planCells`. */
const PLAN_NUM = new Set([8, 9, 10]);

function planRow(row) {
  const cells = planCells(row);
  let tr = S.planRows.get(row.pnr);
  if (!tr) {
    // C6 — case d'exclusion : écarter UNE ligne sans rejeter tout le plan
    const box = el("input", { type: "checkbox", class: "ecarter" });
    box.setAttribute("aria-label", `Écarter le dossier ${row.pnr} de la validation`);
    box.addEventListener("change", () => {
      if (box.checked) S.exclusions.set(row.pnr, S.exclusions.get(row.pnr) ?? "");
      else S.exclusions.delete(row.pnr);
      renderValidation();
    });
    tr = el(
      "tr",
      {},
      el("td", { class: "col-ecarter" }, box),
      ...cells.map((c, i) => el("td", { class: PLAN_NUM.has(i) ? "num" : null, text: c })),
    );
    S.planRows.set(row.pnr, tr);
    $("plan-body").append(tr);
  } else {
    [...tr.children].forEach((td, i) => {
      if (i === 0) return; // cellule de la case à cocher : jamais écrasée
      td.textContent = cells[i - 1];
    });
  }
  const esc = row.statut === "ESCALADE DESK";
  const prov = row.provisoire === true || row.provisoire === "true";
  const ecartee = S.exclusions.has(row.pnr);
  tr.className = [ecartee ? "row-ecartee" : "", esc ? "row-esc" : prov ? "row-prov" : ""].filter(Boolean).join(" ");
}

/** Index des cartes prépayées par PNR (C7), source unique : `cost.cartes_prepayees`. */
function rebuildCartes() {
  S.cartes = new Map();
  for (const l of S.run?.cost?.cartes_prepayees?.lignes ?? []) {
    if (l?.pnr) S.cartes.set(l.pnr, l);
  }
}

function renderPlan() {
  rebuildCartes();
  for (const row of S.run?.plan ?? []) planRow(row);
  renderPlanSummary();
}

function renderPlanSummary() {
  const s = S.run?.planSummary;
  const sum = S.run?.summary;
  if (!s) return void ($("plan-summary").textContent = "");
  // C2 : le chiffre décisif est le nombre de PERSONNES, pas de dossiers
  const p = paxDuPlan(S.run?.plan);
  const pax = sum
    ? ` · ${fmtInt(sum.paxLoges)} personne(s) logée(s) / ${fmtInt(sum.paxTotal)} · ${fmtInt(sum.paxNonLoges)} non logée(s)`
    : ` · ${fmtInt(p.loges)} / ${fmtInt(p.total)} personne(s) logée(s) — chiffre PROVISOIRE, l'allocation n'est pas close`;
  $("plan-summary").textContent = `— ${fmtInt(s.ok)} dossiers logés · ${fmtInt(s.escalade)} en escalade${pax}`;
}

function renderExtension() {
  const ext = S.run?.extension;
  const panel = $("extension-panel");
  if (!ext) return void panel.classList.add("hidden");
  panel.classList.remove("hidden");
  const p = $("extension-info");
  clear(p);
  const gaps = (ext.gaps ?? []).map((g) => `${g.tier} : ${g.rooms_missing} ch.`).join(", ") || "aucun manque";
  p.append(
    el("strong", { text: `Vague ${ext.wave}` }),
    ` — ${ext.reason === "gaps" ? "manques à couvrir" : ext.reason} · manques : ${gaps} · ` +
      `prévu : ${ext.planned?.probes ?? 0} sonde(s), ${ext.planned?.surveys ?? 0} relevé(s)`,
    el("br"),
    el("span", { class: "ext-limits", text:
      `bornes : sessions ${ext.limits.sessions_used}/${ext.limits.sessions_max} · ` +
      `coût ${fmtUsd(ext.limits.cost_usd)}/${ext.limits.cost_max} $ · vague ${Math.min(ext.limits.wave, ext.limits.max_waves)}/${ext.limits.max_waves}` }),
  );
}

/* ---------------------------------------- validation humaine (C6) */

/** Cellule « titre + liste » du bandeau de validation. */
function c6Cell(titre, lignes) {
  return el("div", { class: "cell" }, el("h3", { text: titre }), el("ul", {}, ...lignes.map((t) => el("li", { text: t }))));
}

/**
 * Ventilation des BUDGETS de trajet sur les lignes du plan affiché.
 * Compté ici plutôt que repris d'une synthèse : ce qui est montré doit correspondre aux
 * lignes que le validateur a sous les yeux. Un plan qui ne porte pas la colonne est dit
 * INDÉTERMINÉ, jamais ramené à zéro.
 * @returns {{indetermines: number, sans: number, contraints: number, impossibles: number, paliers: Array<[number, number]>}}
 */
function budgetsDuPlan(plan) {
  const paliers = new Map();
  const r = { indetermines: 0, sans: 0, contraints: 0, impossibles: 0, paliers: [] };
  for (const row of plan ?? []) {
    if (!Object.prototype.hasOwnProperty.call(row, "trajet_max_min")) {
      r.indetermines += 1;
      continue;
    }
    const brut = row.trajet_max_min;
    if (brut === "" || brut === null || brut === undefined) {
      r.sans += 1;
      continue;
    }
    const n = Number(brut);
    if (!Number.isFinite(n)) {
      r.indetermines += 1;
      continue;
    }
    if (n <= 0) {
      r.impossibles += 1;
      continue;
    }
    r.contraints += 1;
    paliers.set(n, (paliers.get(n) ?? 0) + 1);
  }
  r.paliers = [...paliers].sort((a, b) => a[0] - b[0]);
  return r;
}

/** Ordre de lecture des couronnes : les plus proches d'abord, l'indéterminé en dernier. */
function ordreCouronnes(a, b) {
  const rang = (k) => (/^\d+$/.test(k) ? Number(k) : 900);
  return rang(a) - rang(b) || String(a).localeCompare(String(b));
}

/** Libellé d'une clé de couronne, telle que `allocate.mjs` la pose sur la ligne. */
function nomCouronne(cle) {
  if (cle === "hors_couronnes") return "hors couronnes";
  if (cle === "inconnue") return "couronne indéterminée";
  return `couronne ${cle}`;
}

/**
 * RÉPARTITION GÉOGRAPHIQUE soumise au validateur : combien de dossiers, de chambres et de
 * personnes par couronne, ce que chaque couronne coûte en temps de trajet DÉCLARÉ, et
 * combien de dossiers sont sortis faute de temps de trajet — un manque qui n'est PAS un
 * manque de chambres : relever plus d'hôtels ne les logera pas.
 */
function renderCouronnesValidation(r, sum) {
  const box = $("c6-couronnes");
  if (!box) return;
  clear(box);
  if (!sum) {
    box.append(el("p", { class: "avert", text:
      "répartition par couronne INDÉTERMINÉE pour ce run — la synthèse d'allocation n'est pas disponible" }));
    return;
  }
  const grid = el("div", { class: "c6-grid" });
  const parCouronne = Object.entries(sum.parCouronne ?? {}).sort((a, b) => ordreCouronnes(a[0], b[0]));
  const budgets = budgetsDuPlan(r.plan);

  grid.append(
    c6Cell(`Dossiers logés par couronne (${parCouronne.length})`,
      parCouronne.length
        ? parCouronne.map(([cle, c]) => {
            const t = trajetDeclareTexte(c.trajet_min_declare);
            const ind = c.couronne_indeterminee
              ? ` · dont ${fmtInt(c.couronne_indeterminee)} dossier(s) à couronne À CONFIRMER`
              : "";
            return `${nomCouronne(cle)} — ${t}${c.mode ? ` · ${c.mode}` : ""} : ` +
              `${fmtInt(c.dossiers)} doss. · ${fmtInt(c.chambres)} ch. · ${fmtInt(c.pax)} pers.${ind}`;
          })
        : ["aucun dossier logé"]),
    c6Cell("Couronnes de l'escale", [
      sum.couronnes?.source === "declaree"
        ? "DÉCLARÉES par l'exploitation — temps de trajet déclarés, non mesurés"
        : sum.couronnes?.source === "derivee"
          ? "DÉRIVÉE du rayon de la fiche : ce n'est pas une déclaration d'exploitation, et tous les hôtels " +
            "partagent alors le même temps de trajet"
          : "provenance des couronnes INDÉTERMINÉE pour ce run",
      ...((sum.couronnes?.liste ?? []).map((c) =>
        `couronne ${c.rang} — ${rayonTexte(c.rayon_m)} · ${trajetDeclareTexte(c.trajet_min_declare)} · ${c.mode || "mode indéterminé"}`)),
    ]),
    c6Cell("Contrainte de distance (budgets de trajet)", [
      Number.isFinite(sum.dossiersAvecBudget)
        ? `${fmtInt(sum.dossiersAvecBudget)} dossier(s) portent un budget de trajet`
        : "nombre de dossiers sous budget INDÉTERMINÉ pour ce run",
      budgets.indetermines
        ? `${fmtInt(budgets.indetermines)} ligne(s) sans colonne de budget : contrainte INDÉTERMINÉE, ne pas la lire comme « aucune »`
        : `${fmtInt(budgets.contraints)} ligne(s) contrainte(s) · ${fmtInt(budgets.sans)} sans contrainte de distance`,
      budgets.impossibles
        ? `${fmtInt(budgets.impossibles)} ligne(s) à budget ≤ 0 : l'hôtel n'a plus de sens, repos côté piste à organiser`
        : "aucune ligne à budget nul ou négatif",
      ...budgets.paliers.slice(0, 6).map(([min, n]) => `${fmtInt(min)} min max : ${fmtInt(n)} ligne(s)`),
      budgets.paliers.length > 6 ? `… et ${budgets.paliers.length - 6} autre(s) palier(s)` : null,
    ].filter(Boolean)),
    c6Cell("Sorties liées à la distance", [
      Number.isFinite(sum.escaladesTempsTrajet)
        ? `${fmtInt(sum.escaladesTempsTrajet)} dossier(s) escaladés faute de TEMPS DE TRAJET — ce n'est PAS un manque ` +
          "de chambres : relever plus d'hôtels ne les logera pas"
        : "escalades « temps de trajet » INDÉTERMINÉES pour ce run",
      Number.isFinite(sum.escaladesProximite)
        ? `${fmtInt(sum.escaladesProximite)} dossier(s) escaladés par refus d'éloignement (proximité stricte)`
        : "escalades « proximité stricte » INDÉTERMINÉES pour ce run",
      Number.isFinite(sum.dossiersCouronneIndeterminee)
        ? `${fmtInt(sum.dossiersCouronneIndeterminee)} dossier(s) logés dans un hôtel dont la couronne n'a pas pu être déterminée`
        : "dossiers à couronne indéterminée INDÉTERMINÉS pour ce run",
    ]),
  );
  box.append(grid);
}

/**
 * Identité du signataire telle qu'elle peut être AFFICHÉE (C6).
 * Une identité seulement déclarée par un en-tête, sans proxy de confiance déclaré,
 * n'est pas une signature : l'écrire nue laisserait croire à une traçabilité nominative
 * que le serveur ne garantit pas. Elle est donc toujours affichée avec sa réserve.
 * @param {{identite?: string|null, authentifiee?: boolean}|null} v bloc `validateur` du journal
 * @returns {string} texte à poser en `textContent` — INV-9 : aucune écriture HTML
 */
function identiteAffichee(v) {
  if (!v?.identite) return "identité non authentifiée";
  return v.authentifiee ? v.identite : `${v.identite} (déclarée, NON authentifiée)`;
}

/**
 * Bandeau de décision : ce que le validateur doit voir AVANT de signer.
 * Tout y est compté en PERSONNES autant qu'en dossiers (C2), et ce qui n'est
 * pas mesuré est nommé « non mesuré » — jamais présenté comme acquis.
 */
function renderValidation() {
  const r = S.run;
  const panel = $("validation-panel");
  const affichable = r && (r.plan?.length ?? 0) > 0 &&
    ["done", "valide", "refuse", "cancelled", "interrupted", "error"].includes(r.state);
  if (!affichable) return void panel.classList.add("hidden");
  panel.classList.remove("hidden");

  const sum = r.summary;
  const fiches = r.fiches?.resume ?? null;
  const cartes = r.cost?.cartes_prepayees ?? null;
  const validable = r.validable === true;

  const etat = $("c6-state");
  if (r.validation) {
    const v = r.validation;
    etat.textContent = `— ${v.decision === "valide" ? "VALIDÉE" : "REFUSÉE"} le ` +
      `${new Date(v.at).toLocaleString("fr-FR")} · ${identiteAffichee(v.validateur)}`;
  } else if (validable) {
    etat.textContent = "— en attente de décision";
  } else {
    etat.textContent = `— décision impossible : run « ${r.state} », le plan n'est pas définitif`;
  }

  const grid = $("c6-repartition");
  clear(grid);
  if (!sum) {
    grid.append(el("p", { class: "avert", text:
      "synthèse complète indisponible pour ce run (run interrompu, ou état restitué d'une version antérieure) — " +
      "les compteurs en personnes ne peuvent pas être affichés, ne validez pas sur cette base" }));
  } else {
    const parMotif = Object.entries(sum.motifs ?? {}).sort((a, b) => b[1] - a[1]);
    const parHotel = Object.entries(sum.parHotel ?? {}).sort((a, b) => b[1].chambres - a[1].chambres);
    grid.append(
      c6Cell("Personnes (C2)", [
        `${fmtInt(sum.paxTotal)} personne(s) sur la liste`,
        `${fmtInt(sum.paxLoges)} logée(s)`,
        `${fmtInt(sum.paxNonLoges)} NON logée(s), dont ${fmtInt(sum.paxHorsPlan)} hors plan hôtel (traitées au comptoir)`,
        `${fmtInt(sum.paxSansCouchage)} personne(s) sans couchage déclaré dans leur chambre`,
      ]),
      c6Cell("Dossiers et chambres", [
        `${fmtInt(sum.ok)} dossier(s) logés · ${fmtInt(sum.escalade)} en escalade`,
        `${fmtInt(sum.chambres)} chambre(s) engagées`,
        // C2 — les DEUX NIVEAUX en clair. Un résumé antérieur sans ces compteurs ne se
        // devine pas : on le dit indéterminé plutôt que d'écrire « 0 à confirmer ».
        Number.isFinite(sum.chambresFermes) && Number.isFinite(sum.chambresAConfirmer)
          ? `dont ${fmtInt(sum.chambresFermes)} FERME(S) (mesurées) et ${fmtInt(sum.chambresAConfirmer)} À CONFIRMER ` +
            `auprès des hôtels (${Math.round((sum.partAConfirmer ?? 0) * 100)} % du plan, ${fmtInt(sum.stockNonMesure)} ligne(s))`
          : "ventilation ferme / à confirmer INDÉTERMINÉE pour ce run — ne pas lire ces chambres comme acquises",
        `${fmtInt(sum.couchagesInsuffisants)} dossier(s) logés sans couchage suffisant`,
      ]),
      c6Cell(`Concentration par hôtel (${parHotel.length})`, [
        ...(sum.concentration
          ? [`le plus chargé : ${sum.concentration.hotel} — ${fmtInt(sum.concentration.chambres)} ch., ` +
             `${fmtInt(sum.concentration.pax)} pers., ${Math.round(sum.concentration.part * 100)} % du plan`]
          : ["aucun hôtel engagé"]),
        // c'est ce que l'agent d'escale annonce au téléphone, établissement par établissement
        // MÊME garde que la cellule « Dossiers et chambres » ci-dessus : un résumé restitué
        // d'un état antérieur ne porte pas ces compteurs. Écrire « 0 ferme(s) / 0 À CONFIRMER »
        // dirait « rien à confirmer chez cet hôtel » — la ligne la plus lisible de l'écran
        // contredirait alors la cellule voisine qui dit « ventilation INDÉTERMINÉE ».
        ...parHotel.map(([nom, h]) => {
          const ventile = Number.isFinite(h.chambres_fermes) && Number.isFinite(h.chambres_a_confirmer);
          const detail = ventile
            ? `${fmtInt(h.chambres_fermes)} ferme(s) / ${fmtInt(h.chambres_a_confirmer)} À CONFIRMER`
            : "ventilation indéterminée — ne pas lire ces chambres comme acquises";
          return `${nom} : ${fmtInt(h.chambres)} ch. (${detail}) · ${fmtInt(h.dossiers)} doss. · ${fmtInt(h.pax)} pers.`;
        }),
      ]),
      c6Cell(`Escalades par motif (${fmtInt(sum.escalade)})`,
        parMotif.length ? parMotif.map(([m, n]) => `${m} : ${fmtInt(n)} dossier(s)`) : ["aucune escalade"]),
      c6Cell("Fiches d'enregistrement (C3)", fiches
        ? [
            `${fmtInt(fiches.fiches)} fiche(s) — ${fmtInt(fiches.logees)} logée(s), ${fmtInt(fiches.non_logees)} au comptoir`,
            `${fmtInt(fiches.incompletes)} fiche(s) INCOMPLÈTES (identité à compléter passeport en main)`,
            ...Object.entries(fiches.manques ?? {}).filter(([, n]) => n > 0).slice(0, 4)
              .map(([col, n]) => `${col} : ${fmtInt(n)} manque(s)`),
          ]
        : ["fiches non produites pour ce run — C3 incomplet"]),
      c6Cell("Cartes prépayées (C7)", cartes && cartes.actives
        ? [
            `${fmtInt(cartes.nombre_cartes)} carte(s) à commander (par ${cartes.per})`,
            `${fmtInt(cartes.cartes_completes)} complète(s) · ${fmtInt(cartes.cartes_incompletes)} incomplète(s)`,
            `montant total à charger : ${cartes.montant_total_a_charger === null
              ? "INDÉTERMINÉ (devises multiples ou postes manquants)"
              : montantTexte(cartes.montant_total_a_charger, cartes.devises?.[0])}`,
            ...(cartes.motifs ?? []).map((m) => `${m.code} : ${fmtInt(m.dossiers)} dossier(s)`),
          ]
        : ["carte prépayée non activée par la politique de ce run"]),
      c6Cell("Travail humain restant", [
        `${parHotel.length} hôtel(s) à appeler pour DEMANDER ces chambres (l'outil ne réserve pas)`,
        Number.isFinite(sum.chambresAConfirmer) && sum.chambresAConfirmer
          ? `${fmtInt(sum.chambresAConfirmer)} chambre(s) À CONFIRMER en priorité : ce sont celles qui peuvent manquer`
          : "aucune chambre à confirmer : tout le stock engagé est mesuré",
        `${fmtInt(sum.escalade)} dossier(s) à traiter au comptoir`,
        fiches ? `${fmtInt(fiches.incompletes)} fiche(s) à compléter à l'enregistrement` : "fiches non produites",
        sum.creneaux
          ? `${fmtInt(sum.sansCreneau)} dossier(s) convocables sans créneau de présentation`
          : "aucun créneau de présentation calculé pour ce run : tous les dossiers se présenteront sans horaire",
      ]),
    );
  }

  // le validateur signe aussi une RÉPARTITION GÉOGRAPHIQUE : elle s'affiche avant les réserves
  renderCouronnesValidation(r, sum);

  const box = $("c6-reserves");
  clear(box);
  // C2 — un plan dont l'essentiel repose sur du non-mesuré le dit EN TÊTE de l'écran de
  // décision, avant la liste des réserves : c'est ce qui change la nature des appels.
  if (sum && Number.isFinite(sum.chambresAConfirmer) && sum.chambres && sum.chambresAConfirmer / sum.chambres > 0.5) {
    box.append(el("p", { class: "avert", text:
      `L'ESSENTIEL DE CE PLAN REPOSE SUR DU STOCK NON MESURÉ : ${fmtInt(sum.chambresAConfirmer)} chambre(s) ` +
      `sur ${fmtInt(sum.chambres)} (${Math.round((sum.partAConfirmer ?? 0) * 100)} %) sont À CONFIRMER — ` +
      `le sélecteur du site plafonne, il donne une borne basse et non un compte. Ces chambres sont planifiées ` +
      `et figurent dans la liste d'appel ; elles ne sont acquises qu'une fois confirmées par l'établissement.` }));
  }
  if (sum?.complet) {
    // `complet` exige désormais qu'AUCUNE personne ne reste sans chambre, hors plan hôtel
    // compris : la phrase peut donc être affirmative sans mentir.
    box.append(el("p", { class: "c6-ok", text:
      `Aucune réserve : les ${fmtInt(sum.paxTotal)} personne(s) de la liste ont une chambre et les ` +
      `${fmtInt(sum.chambresFermes ?? sum.chambres)} chambre(s) du plan reposent sur un stock MESURÉ (niveau ferme).` }));
  } else if (sum) {
    const ul = el("ul", { class: "c6-reserves" });
    for (const t of sum.reserves ?? []) ul.append(el("li", { text: t }));
    for (const t of sum.avertissements ?? []) ul.append(el("li", { text: t }));
    box.append(el("strong", { text: "Réserves — ce plan ne peut PAS être lu comme couvert :" }), ul);
  }
  if (r.deadline) {
    box.append(el("p", { class: "avert", text:
      `Run arrêté par le TEMPS pendant « ${r.deadline.phase} » (${r.deadline.minutes_used} min sur ` +
      `${r.deadline.minutes_max} autorisées) — pas par l'inventaire : il restait des hôtels à interroger.` }));
  }
  if (r.couverture && r.couverture.suffisante === false) {
    box.append(el("p", { class: "avert", text:
      `Couverture du vivier avant relevé : ${fmtInt(r.couverture.indicatives)} chambre(s) indicative(s) ` +
      `(${fmtInt(r.couverture.relevees)} relevée(s), ${fmtInt(r.couverture.supposees)} supposée(s)) pour ` +
      `${fmtInt(r.couverture.demandees)} demandée(s).` }));
  }
  if (r.capturesPerdues) {
    box.append(el("p", { class: "avert", text:
      "État restitué après un redémarrage du serveur : les captures d'écran des agents ne sont plus rejouables." }));
  }

  const exc = $("c6-exclusions");
  clear(exc);
  if (S.exclusions.size === 0) {
    exc.append(el("p", { class: "hint", text: "aucune ligne écartée — la validation porte sur tout le plan" }));
  } else {
    for (const [pnr, motif] of S.exclusions) {
      const input = el("input", { type: "text", value: motif, placeholder: "motif de l'exclusion (obligatoire)" });
      input.addEventListener("input", () => S.exclusions.set(pnr, input.value));
      const retirer = el("button", { type: "button", text: "Remettre au plan" });
      retirer.addEventListener("click", () => {
        S.exclusions.delete(pnr);
        const tr = S.planRows.get(pnr);
        const cb = tr?.querySelector("input.ecarter");
        if (cb) cb.checked = false;
        renderValidation();
      });
      exc.append(el("div", { class: "c6-exclusion" }, el("strong", { text: pnr }), input, retirer));
    }
  }

  for (const [pnr, tr] of S.planRows) {
    const cb = tr.querySelector("input.ecarter");
    if (!cb) continue;
    cb.disabled = !validable;
    cb.checked = S.exclusions.has(pnr);
    tr.classList.toggle("row-ecartee", S.exclusions.has(pnr));
  }

  $("c6-empreinte").textContent = r.planEmpreinte
    ? `empreinte SHA-256 du plan signé : ${r.planEmpreinte}`
    : "empreinte du plan indisponible : la décision ne pourrait pas être rattachée à une version précise du plan";
  $("c6-identite").textContent = r.validation?.validateur?.mention
    ?? "Identité du validateur : celle que transmet le reverse proxy, s'il en pose une. " +
       "Ce serveur n'authentifie personne ; sans en-tête d'identité, le journal inscrira « identité non authentifiée ».";

  $("btn-valider").disabled = !validable;
  $("btn-refuser").disabled = !validable;
  $("c6-commentaire").disabled = !validable;
  renderJournal(r.validationJournal ?? null);
}

/** Journal append-only des décisions, tel que le serveur le rend. */
function renderJournal(journal) {
  const box = $("validation-journal");
  clear(box);
  const entrees = journal?.entrees ?? (S.run?.validation ? [S.run.validation] : []);
  if (!entrees.length) return;
  box.append(el("h3", { class: "c6-h3", text: `Journal de validation (${entrees.length} entrée(s))` }));
  for (const e of entrees) {
    const li = el("div", { class: "c6-journal" });
    li.append(el("strong", { text: `#${e.seq ?? "?"} ${e.decision === "valide" ? "VALIDÉ" : "REFUSÉ"}` }));
    li.append(el("span", { text: ` · ${new Date(e.at).toLocaleString("fr-FR")} · ${identiteAffichee(e.validateur)}` }));
    li.append(el("br"));
    li.append(el("span", { class: "mono", text: `plan ${String(e.empreinte_plan ?? "").slice(0, 16)}… · ${fmtInt(e.lignes_plan)} ligne(s)` }));
    if (e.resume) {
      li.append(el("br"));
      li.append(el("span", { text:
        `retenu : ${fmtInt(e.resume.dossiers_valides)} dossier(s), ${fmtInt(e.resume.personnes_valides)} personne(s), ` +
        `${fmtInt(e.resume.chambres_valides)} chambre(s) — écarté : ${fmtInt(e.resume.dossiers_ecartes)} dossier(s), ` +
        `${fmtInt(e.resume.personnes_ecartees)} personne(s)` }));
    }
    for (const x of e.exclusions ?? []) {
      li.append(el("br"));
      li.append(el("span", { class: "muted", text: `écartée ${x.pnr} : ${x.motif}` }));
    }
    if (e.commentaire) {
      li.append(el("br"));
      li.append(el("span", { class: "muted", text: `commentaire : ${e.commentaire}` }));
    }
    box.append(li);
  }
}

/**
 * Ce qui reste engagé une fois les lignes écartées retirées — MÊMES règles que
 * `resumeValide()` de run-manager.mjs (lignes `OK`, hors exclusions) : le chiffre
 * présenté au validateur doit être celui que le journal enregistrera.
 */
function retenuApresExclusions(plan, exclusions) {
  const retenues = (plan ?? []).filter((row) => row.statut === "OK" && !exclusions.has(row.pnr));
  const niveaux = niveauxLignes(retenues); // C2 — ventilation ferme / à confirmer du SIGNÉ
  const r = {
    dossiers: retenues.length, personnes: 0, chambres: 0,
    chambresFermes: niveaux.fermes, chambresAConfirmer: niveaux.aConfirmer,
    chambresNonMesurees: niveaux.aConfirmer,
    // la RÉPARTITION GÉOGRAPHIQUE de ce qui est signé, comptée sur les mêmes lignes
    couronnes: repartitionRetenue(retenues),
  };
  for (const row of retenues) {
    r.personnes += Number(row.pax) || 0;
    r.chambres += Number(row.chambres) || 0;
  }
  return r;
}

/**
 * Répartition par couronne des lignes RETENUES (exclusions déjà retirées) : ce que le
 * validateur envoie réellement à 15, 35 ou 60 minutes déclarées de l'aéroport.
 * @returns {{parCle: Map<string, object>, indetermines: number}}
 */
function repartitionRetenue(retenues) {
  const parCle = new Map();
  let indetermines = 0;
  for (const row of retenues ?? []) {
    if (!Object.prototype.hasOwnProperty.call(row, "couronne_cle")) {
      indetermines += 1;
      continue;
    }
    const cle = row.couronne_cle || "inconnue";
    const e = parCle.get(cle) ?? { dossiers: 0, chambres: 0, pax: 0, trajet: row.couronne_trajet_min_declare };
    e.dossiers += 1;
    e.chambres += Number(row.chambres) || 0;
    e.pax += Number(row.pax) || 0;
    parCle.set(cle, e);
  }
  return { parCle, indetermines };
}

/** Les lignes de répartition géographique lues dans la fenêtre de confirmation. */
function texteRepartition(rep) {
  if (!rep) return "Répartition par couronne INDÉTERMINÉE.";
  if (rep.indetermines && rep.parCle.size === 0) {
    return `Répartition par couronne INDÉTERMINÉE : ${fmtInt(rep.indetermines)} ligne(s) ne portent pas la couronne.`;
  }
  const lignes = [...rep.parCle]
    .sort((a, b) => ordreCouronnes(a[0], b[0]))
    .map(([cle, c]) =>
      `  · ${nomCouronne(cle)} (${trajetDeclareTexte(c.trajet)}) : ` +
      `${fmtInt(c.dossiers)} doss., ${fmtInt(c.chambres)} ch., ${fmtInt(c.pax)} pers.`);
  const reste = rep.indetermines ? [`  · ${fmtInt(rep.indetermines)} ligne(s) sans couronne : INDÉTERMINÉE`] : [];
  return ["Répartition géographique signée (temps de trajet DÉCLARÉS, non mesurés) :", ...lignes, ...reste].join("\n");
}

/** Envoi de la décision. INV-1 : rien n'est réservé, une décision est consignée. */
async function envoyerDecision(decision) {
  const r = S.run;
  const msg = $("validation-msg");
  msg.className = "hint";
  if (!r?.runId) return void (msg.textContent = "aucun run à valider");
  const exclusions = [...S.exclusions].map(([pnr, motif]) => ({ pnr, motif: String(motif ?? "").trim() }));
  if (decision === "valide" && exclusions.some((e) => !e.motif)) {
    msg.className = "error";
    msg.textContent = "chaque ligne écartée demande un motif — sans motif, la décision n'est pas traçable";
    return;
  }
  if (decision === "refuse" && exclusions.length) {
    msg.className = "error";
    msg.textContent = "un refus global ne se combine pas avec des exclusions : remettez les lignes au plan, ou validez partiellement";
    return;
  }
  const sum = r.summary;
  const retenu = retenuApresExclusions(r.plan, S.exclusions);
  // Ce qui est annoncé au validateur est ce qui sera SIGNÉ : les lignes écartées sont
  // déjà retirées du décompte (mêmes règles que `resumeValide` côté serveur). Annoncer
  // le total du plan alors que le journal enregistrera un total inférieur ferait signer
  // un chiffre qui n'est pas celui de la décision.
  // « rien n'est estimé » : sans synthèse d'allocation, le total de la liste est INCONNU
  // — l'écrire « 0 » ferait signer une répartition annoncée comme n'engageant personne.
  const portee =
    `Valider ${fmtInt(retenu.dossiers)} dossier(s) / ${fmtInt(retenu.personnes)} personne(s) logée(s) / ` +
    `${fmtInt(retenu.chambres)} chambre(s), après retrait de ${exclusions.length} ligne(s) écartée(s)` +
    // C2 — ce que le validateur signe, à DEUX NIVEAUX : les chambres fermes sont mesurées,
    // les chambres « à confirmer » restent à obtenir de l'hôtel au téléphone.
    (retenu.chambresAConfirmer
      ? `\ndont ${fmtInt(retenu.chambresFermes)} chambre(s) FERME(S) et ${fmtInt(retenu.chambresAConfirmer)} ` +
        `chambre(s) À CONFIRMER auprès des hôtels (stock non mesuré).`
      : `\ntoutes sur un stock MESURÉ (niveau ferme).`) +
    (sum
      ? `\nListe de la compagnie : ${fmtInt(sum.paxTotal)} personne(s), ${fmtInt(sum.paxNonLoges)} NON logée(s).`
      : `\nATTENTION : la synthèse d'allocation est INDÉTERMINÉE pour ce run — le total de la liste et le ` +
        `nombre de personnes non logées ne peuvent pas être confirmés ici.`) +
    // ce qui est signé n'est pas qu'un compte de chambres : c'est aussi une géographie
    `\n\n${texteRepartition(retenu.couronnes)}` +
    (sum && Number.isFinite(sum.escaladesTempsTrajet) && sum.escaladesTempsTrajet
      ? `\n${fmtInt(sum.escaladesTempsTrajet)} dossier(s) sont sortis faute de TEMPS DE TRAJET : ce n'est pas un ` +
        `manque de chambres, relever plus d'hôtels ne les logera pas.`
      : "");
  const resume = decision === "valide"
    ? `${portee}\n\nAUCUNE réservation ne sera faite : ce plan devra être DEMANDÉ aux hôtels.`
    : "Refuser la totalité de la répartition. La décision sera consignée au journal.";
  if (!window.confirm(`${resume}\n\nConfirmer ?`)) return;
  try {
    const res = await api("POST", "/api/validation", {
      runId: r.runId,
      decision,
      empreinte: r.planEmpreinte ?? null,
      exclusions: decision === "valide" ? exclusions : [],
      commentaire: $("c6-commentaire").value,
    });
    msg.className = "hint";
    msg.textContent = `${decision === "valide" ? "Validation" : "Refus"} enregistré dans out/${res.journal} — ${res.suite}`;
    await chargerJournal(r.runId);
    await refreshState();
  } catch (err) {
    msg.className = "error";
    msg.textContent = err.message;
  }
}

/** Charge le journal append-only du serveur (source de vérité de la traçabilité). */
async function chargerJournal(runId) {
  try {
    const res = await api("GET", `/api/validation?runId=${encodeURIComponent(runId)}`);
    if (S.run) S.run.validationJournal = res.journal;
    renderJournal(res.journal);
  } catch {
    /* pas de journal lisible : le bandeau se rabat sur la dernière décision connue */
  }
}

function renderCost() {
  const cost = S.run?.cost;
  const panel = $("cost-panel");
  if (!cost) return void panel.classList.add("hidden");
  panel.classList.remove("hidden");
  const body = $("cost-body");
  clear(body);
  const grid = el("div", { class: "dry-run-grid" });
  grid.append(
    el("div", { class: "cell" },
      el("h3", { text: "Hébergement par nuit" }),
      el("ul", {},
        // pas de `?? 0` : un poste absent n'est pas un poste gratuit. `fmtEur` rend « — ».
        ...["J", "W", "Y"].map((t) => el("li", { text: `${t} : ${fmtEur(cost.per_night?.[t])}` })),
        el("li", {}, el("strong", { text: `Total : ${fmtEur(cost.per_night?.total)}` })),
        // le périmètre du total, à côté du total : les dossiers en escalade n'y sont pas
        el("li", { class: "muted", text: "ne couvre que les dossiers LOGÉS — les escalades ne sont pas chiffrées" }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Projection" }),
      el("ul", {},
        el("li", { text: `${cost.nights} nuit(s) : ${fmtEur(cost.projection_total)}` }),
        el("li", { text: `Borne haute aux plafonds : ${fmtEur(cost.upper_bound_at_caps)}` }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Indemnités" }),
      el("ul", {},
        el("li", { text: `Repas : ${cost.allowances?.meal === null ? "non renseigné" : fmtEur(cost.allowances.meal)}` }),
        el("li", { text: `Transport : ${cost.allowances?.transport === null ? "non renseigné" : fmtEur(cost.allowances.transport)}` }),
        ...(cost.not_determinable?.length ? [el("li", { text: `Non chiffrable : ${cost.not_determinable.join(", ")}` })] : []),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Chambres en escalade" }),
      // sans la ventilation, on écrit « indéterminé » : afficher 0 dirait « personne n'est laissé de côté »
      el("ul", {}, ...["J", "W", "Y"].map((t) => el("li", {
        text: `${t} : ${cost.escalated_rooms ? (cost.escalated_rooms[t] ?? 0) : "indéterminé"}`,
      }))),
    ),
  );
  body.append(grid);
}

async function renderMessages() {
  const r = S.run;
  const panel = $("messages-panel");
  if (!r?.messagesReady || !r?.runId) return void panel.classList.add("hidden");
  panel.classList.remove("hidden");
  if (S.messagesRunId !== r.runId && r.state === "done") {
    try {
      const data = await api("GET", `/api/messages?runId=${encodeURIComponent(r.runId)}`);
      S.messages = data.messages;
      S.messagesRunId = r.runId;
    } catch {
      S.messages = null;
    }
  }
  const list = $("messages-list");
  clear(list);
  const tierOf = new Map((r.plan ?? []).map((row) => [row.pnr, row.cabine]));
  if (!S.messages) {
    const sample = r.messagesReady.sample ?? [];
    $("msg-count").textContent = `${r.messagesReady.count_fr} FR · ${r.messagesReady.count_en} EN (aperçu en attente de la fin du run)`;
    for (const m of sample) {
      list.append(el("div", { class: "message-card" },
        el("div", { class: "m-head" }, el("strong", { text: m.pnr }), el("span", { class: "muted", text: m.lang.toUpperCase() })),
        el("div", { class: "m-subject", text: m.subject }),
      ));
    }
    return;
  }
  const filtered = S.messages.filter((m) => m.lang === S.msgLang && (!S.msgTier || tierOf.get(m.pnr) === S.msgTier));
  $("msg-count").textContent = `${filtered.length} message(s) — aperçu des 3 premiers`;
  for (const m of filtered.slice(0, 3)) {
    const copyBtn = el("button", { class: "m-copy", type: "button", text: "Copier" });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`${m.subject}\n\n${m.body}`);
        copyBtn.textContent = "Copié ✓";
        setTimeout(() => (copyBtn.textContent = "Copier"), 1600);
      } catch {
        copyBtn.textContent = "Copie impossible";
      }
    });
    list.append(el("div", { class: "message-card" },
      el("div", { class: "m-head" },
        el("strong", { text: m.pnr }),
        el("span", { class: "muted", text: `${(tierOf.get(m.pnr) ?? "?")} · ${m.variante} · ${m.lang.toUpperCase()}` }),
        copyBtn,
      ),
      el("div", { class: "m-subject", text: m.subject }),
      el("pre", { text: m.body }),
    ));
  }
}

function renderFinal() {
  const r = S.run;
  const panel = $("final-panel");
  const showable = r && (r.state === "done" || r.state === "cancelled") && r.done;
  if (!showable) return void panel.classList.add("hidden");
  panel.classList.remove("hidden");
  const d = r.done;
  $("final-summary").textContent = d.cancelled
    ? `Run ${r.runId} annulé proprement — aucun fichier produit.`
    : `Run ${r.runId} terminé : ${fmtInt(d.ok)} dossiers logés, ${fmtInt(d.escalade)} en escalade · ` +
      `${d.sessions_used ?? 0} session(s) d'extension · coût agents ${fmtUsd(d.cost_usd ?? 0)}` +
      (d.extension_stop ? ` · extension : ${d.extension_stop}` : "");
  const dl = $("downloads");
  clear(dl);
  for (const name of r.outputs ?? []) {
    dl.append(el("a", { href: `/api/outputs/${encodeURIComponent(name)}`, download: name, text: name }));
  }
}

function renderWarnings() {
  const list = S.run?.warnings ?? [];
  $("warnings-panel").classList.toggle("hidden", list.length === 0);
  const ul = $("warnings");
  clear(ul);
  for (const w of list.slice(-30)) ul.append(el("li", { text: w.message }));
}

function resetRunView() {
  S.agentsEls.clear();
  S.planRows.clear();
  // les lignes écartées appartiennent à UN plan : elles ne survivent pas au suivant
  S.exclusions.clear();
  clear($("agents"));
  clear($("plan-body"));
  S.messages = null;
  S.messagesRunId = null;
  $("dry-run-panel").classList.add("hidden");
}

function renderAll() {
  renderStatus();
  renderPhases();
  renderBanner();
  renderAgents();
  renderPlan();
  renderExtension();
  renderCost();
  renderMessages();
  renderValidation();
  renderFinal();
  renderWarnings();
}

/* --------------------------------------------------------------- SSE */

function applyEvent(type, ev) {
  const r = S.run ?? (S.run = { agents: {}, plan: [], phases: [], warnings: [] });
  const d = ev.data ?? {};
  const key = ev.hotel_key ?? null;
  switch (type) {
    case "phase": {
      if (d.phase === "preparation") {
        // nouveau run : réinitialise la vue
        resetRunView();
        Object.assign(r, {
          state: "running", runId: ev.run_id, phases: [], agents: {}, plan: [], planSummary: null,
          extension: null, cost: null, messagesReady: null, done: null, error: null, warnings: [],
          metricsTotals: { steps: 0, cost_usd: 0, tokens: 0 }, outputs: [],
          station: d.station, checkin: d.checkin, checkout: d.checkout,
          startedAt: ev.ts, finishedAt: null, simulate: r.simulate,
        });
      }
      r.phase = d.phase;
      r.phases.push({ phase: d.phase, reason: d.reason ?? null, wave: d.wave ?? null });
      renderStatus();
      renderPhases();
      break;
    }
    case "agent_status": {
      const a = (r.agents[key] ??= { hotel_key: key, thoughts: 0, steps: 0, cost_usd: 0, tokens: 0, captures: 0 });
      if (d.status) a.status = d.status;
      if (d.hotel) a.name = d.hotel;
      if (d.live_view_url) a.live_view_url = d.live_view_url;
      renderAgent(key, a);
      break;
    }
    case "agent_thought": {
      const a = (r.agents[key] ??= { hotel_key: key, thoughts: 0, steps: 0, cost_usd: 0, tokens: 0, captures: 0 });
      a.last_thought = d.text;
      a.thoughts += 1;
      renderAgent(key, a);
      break;
    }
    case "screenshot": {
      const a = (r.agents[key] ??= { hotel_key: key, thoughts: 0, steps: 0, cost_usd: 0, tokens: 0, captures: 0 });
      a.captures = (d.seq ?? 0) + 1;
      renderAgent(key, a);
      break;
    }
    case "plan_row": {
      const idx = (r.plan ?? []).findIndex((x) => x.pnr === d.pnr);
      if (idx >= 0) r.plan[idx] = d;
      else (r.plan ??= []).push(d);
      planRow(d);
      break;
    }
    case "metrics": {
      if (d.ok !== undefined || d.escalade !== undefined) {
        r.planSummary = { ok: d.ok ?? 0, escalade: d.escalade ?? 0 };
        renderPlanSummary();
      } else if (key) {
        const a = (r.agents[key] ??= { hotel_key: key, thoughts: 0, steps: 0, cost_usd: 0, tokens: 0, captures: 0 });
        a.steps = d.steps ?? a.steps;
        a.cost_usd = d.cost_usd ?? a.cost_usd;
        a.tokens = d.tokens ?? a.tokens;
        r.metricsTotals = Object.values(r.agents).reduce(
          (t, x) => ({ steps: t.steps + (x.steps ?? 0), cost_usd: t.cost_usd + (x.cost_usd ?? 0), tokens: t.tokens + (x.tokens ?? 0) }),
          { steps: 0, cost_usd: 0, tokens: 0 },
        );
        renderAgent(key, a);
        renderBanner();
      }
      break;
    }
    case "inventory_status":
      r.inventoryStatus = d;
      break;
    case "extension":
      r.extension = { ...d };
      renderExtension();
      renderBanner();
      renderStatus();
      break;
    case "probe": {
      if (key && r.agents[key]) {
        r.agents[key].probe = true;
        renderAgent(key, r.agents[key]);
      }
      break;
    }
    case "cost":
      r.cost = d;
      renderCost();
      renderPlan();
      break;
    // C5 — l'échéance d'horloge a empêché quelque chose : à dire, une seule fois
    case "deadline":
      r.deadline = d;
      renderBanner();
      renderValidation();
      break;
    // C2 — couverture indicative du vivier avant toute session payante
    case "couverture":
      r.couverture = d;
      renderValidation();
      break;
    // C6 — une décision humaine a été consignée (par cet onglet ou par un autre)
    case "validation":
      r.validation = d;
      r.state = d.decision === "valide" ? "valide" : "refuse";
      r.validable = false;
      renderStatus();
      chargerJournal(r.runId);
      renderValidation();
      break;
    case "messages_ready":
      r.messagesReady = d;
      renderMessages();
      break;
    case "warning":
      (r.warnings ??= []).push({ message: d.message });
      renderWarnings();
      break;
    case "log":
      if (Array.isArray(d.outputs)) {
        r.outputs = d.outputs;
        renderFinal();
      }
      break;
    case "error":
      r.error = d;
      if (d.fatal) {
        r.state = "error";
        renderStatus();
        $("run-error").textContent = d.message;
      }
      break;
    case "done": {
      r.done = d;
      r.state = d.cancelled ? "cancelled" : "done";
      r.finishedAt = ev.ts;
      renderStatus();
      renderPhases();
      renderFinal();
      renderMessages();
      // les fichiers sont écrits juste après `done` : on resynchronise l'état complet
      setTimeout(refreshState, 600);
      break;
    }
    default:
      break;
  }
}

async function refreshState() {
  try {
    const snap = await api("GET", "/api/state");
    // la sélection du validateur survit au rafraîchissement — mais elle appartient à UN
    // plan : un autre run affiché signifie d'autres PNR, et des exclusions reprises à
    // l'aveugle écarteraient des dossiers que personne n'a choisi d'écarter
    const runPrecedent = S.run?.runId ?? null;
    const exclusions = S.exclusions;
    S.run = snap;
    resetRunView();
    if (runPrecedent !== null && snap.runId === runPrecedent) S.exclusions = exclusions;
    renderAll();
    if (snap.runId && (snap.validation || snap.state === "valide" || snap.state === "refuse")) {
      chargerJournal(snap.runId);
    }
  } catch {
    /* serveur injoignable : l'EventSource retentera */
  }
}

function connectSse() {
  const es = new EventSource("/api/events");
  es.addEventListener("snapshot", (e) => {
    S.run = JSON.parse(e.data);
    resetRunView();
    renderAll();
  });
  const types = ["phase", "agent_status", "agent_thought", "screenshot", "candidate", "plan_row", "metrics",
    "warning", "log", "done", "error", "inventory_status", "extension", "probe", "cost", "messages_ready",
    // types additifs des vagues 2 : horloge (C5), couverture (C2), décision humaine (C6)
    "deadline", "couverture", "validation"];
  for (const t of types) {
    es.addEventListener(t, (e) => {
      const ev = JSON.parse(e.data);
      applyEvent(t, ev);
    });
  }
}

/* ------------------------------------------------------------- actions */

async function launchRun() {
  $("run-error").textContent = "";
  try {
    const payload = runPayload();
    const res = await api("POST", "/api/run", payload);
    S.run = { ...(S.run ?? {}), state: "running", runId: res.runId, simulate: res.simulate };
    renderStatus();
  } catch (err) {
    if (err.status === 409) {
      $("run-error").textContent = "Un run est déjà en cours (INV-10) — attendre la fin ou annuler.";
    } else if (err.data?.dry_run_available) {
      $("run-error").textContent = `${err.message}. Le dry-run reste disponible (bouton ci-contre).`;
    } else {
      $("run-error").textContent = err.message;
    }
  }
}

async function launchDryRun() {
  $("run-error").textContent = "";
  try {
    const report = await api("POST", "/api/run", runPayload({ dryRun: true }));
    renderDryRun(report);
  } catch (err) {
    $("run-error").textContent = err.message;
  }
}

function renderDryRun(rep) {
  const panel = $("dry-run-panel");
  panel.classList.remove("hidden");
  const body = $("dry-run-body");
  clear(body);
  const src = el("p", { class: rep.source_liste === "téléversée" ? "source-liste reelle" : "source-liste generee" });
  src.append(el("strong", { text: rep.source_liste === "téléversée" ? "LISTE : téléversée" : "LISTE : GÉNÉRÉE (aucun passager réel)" }));
  if (rep.uploaded?.recu_le) src.append(el("span", { text: ` — reçue le ${new Date(rep.uploaded.recu_le).toLocaleString("fr-FR")}` }));
  body.append(src);
  const grid = el("div", { class: "dry-run-grid" });
  grid.append(
    el("div", { class: "cell" },
      el("h3", { text: "Scénario" }),
      el("ul", {},
        el("li", { text: `${rep.station.code} — ${rep.station.name}` }),
        el("li", { text: `du ${rep.checkin} au ${rep.checkout} (${rep.nights} nuit(s))` }),
        el("li", { text: `${fmtInt(rep.passagers)} passagers · ${fmtInt(rep.dossiers)} dossiers` }),
        el("li", { text: `plafonds effectifs : J ${rep.caps.J} € · W ${rep.caps.W} € · Y ${rep.caps.Y} €` }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Besoins par tier" }),
      el("ul", {}, ...["J", "W", "Y"].map((t) =>
        el("li", { text: `${t} : ${rep.needs[t]?.dossiers ?? 0} dossiers, ${rep.needs[t]?.chambres ?? 0} chambres` }))),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Inventaire et découverte" }),
      el("ul", {},
        el("li", { text: `${rep.inventaire.hotels} hôtel(s), mis à jour : ${fmtTs(rep.inventaire.updated_at)}` }),
        el("li", { text: `périmé : ${rep.inventaire.stale ? "oui" : "non"}` }),
        el("li", { text: `découverte : ${rep.discovery.run ? "EXÉCUTÉE" : "SAUTÉE"} — ${rep.discovery.reason}` }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: `Relevés prévus (${rep.releves.length})` }),
      el("ul", {}, ...rep.releves.map((c) =>
        el("li", {}, `${c.name}${c.fallback ? " [repli]" : ""} (${c.tiers.join("/")})`,
          el("br"),
          c.url ? el("a", { href: c.url, target: "_blank", rel: "noopener noreferrer", text: "URL Booking ↗" }) : el("span", { class: "muted", text: "recherche par nom" })))),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Couverture (C2) — avant de payer" }),
      el("ul", {},
        el("li", { text: `${fmtInt(rep.couverture?.indicatives ?? 0)} chambre(s) indicative(s) pour ${fmtInt(rep.couverture?.demandees ?? 0)} demandée(s)` }),
        el("li", { text: `dont ${fmtInt(rep.couverture?.relevees ?? 0)} relevée(s) et ${fmtInt(rep.couverture?.supposees ?? 0)} SUPPOSÉE(S) — une supposition de cadrage, pas une mesure` }),
        el("li", { text: `${fmtInt(rep.couverture?.hotels ?? 0)} hôtel(s) au vivier · verdict : ${rep.couverture?.suffisante ? "suffisant en volume" : "INSUFFISANT en volume"}` }),
        ...(rep.couverture?.avertissement ? [el("li", { class: "avert", text: rep.couverture.avertissement })] : []),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Bornes du run (C5)" }),
      el("ul", {},
        el("li", { text: `horloge : ${rep.bornes?.minutes_max ?? "—"} min · sessions : ${rep.bornes?.sessions_max ?? "—"} · coût : ${rep.bornes?.cout_max_usd ?? "—"} $ · vagues : ${rep.bornes?.vagues_max ?? "—"}` }),
        el("li", { class: "muted", text: rep.bornes?.note_duree ?? "" }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Extension théorique (vague 1)" }),
      el("ul", {},
        el("li", { text: `bornes : ${rep.extension.limits.sessions_max} sessions · ${rep.extension.limits.max_waves} vagues · ${rep.extension.limits.cost_max} $` }),
        el("li", { text: rep.extension.stop ? `→ ${rep.extension.reason}` : `→ sondes : ${rep.extension.probes} · relevés : ${rep.extension.surveys.join(", ") || "aucun"}` }),
      ),
    ),
  );
  body.append(grid);
  body.append(priseEnChargeBloc(rep.prise_en_charge));
  body.append(rechercheBloc(rep.recherche));
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * « Politique de prise en charge » au dry-run : ce que les cases cochées attrapent
 * RÉELLEMENT sur cette liste, et ce que chaque couronne déclarée laisse hors de portée.
 * Un exploitant doit pouvoir vérifier ses cases avant de payer la moindre session.
 */
function priseEnChargeBloc(pec) {
  const wrap = el("div", { class: "recherche-bloc" });
  wrap.append(el("h3", { class: "c6-h3", text: "Politique de prise en charge — ce que les cases cochées attrapent" }));
  if (!pec) {
    wrap.append(el("p", { class: "avert", text: "lecture de la politique de prise en charge indisponible pour ce dry-run" }));
    return wrap;
  }
  const actifs = (pec.criteres ?? []).filter((c) => c.actif !== false);
  const grid = el("div", { class: "dry-run-grid" });
  const corr = pec.correspondance ?? {};
  grid.append(
    el("div", { class: "cell" },
      el("h3", { text: `Critères cochés (${actifs.length})` }),
      el("ul", {}, ...(actifs.length
        ? actifs.map((c) => el("li", { text:
            `rang ${c.rang} · proximité ${proximiteTexte(c.proximite)} — ${c.libelle}${c.departage ? " (départage seulement)" : ""} : ` +
            `${fmtInt(c.satisfait?.dossiers ?? 0)} dossier(s) satisfont, ${fmtInt(c.file?.dossiers ?? 0)} servis dans cette file` }))
        : [el("li", { class: "avert", text: "aucun critère coché : tous les dossiers passent par la file de repli" })])),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Budget de trajet (contrainte DURE)" }),
      el("ul", {},
        el("li", { text: `${fmtInt(pec.trajet?.contraint?.dossiers)} dossier(s) contraints — ${fmtInt(pec.trajet?.contraint?.chambres)} chambre(s) qui doivent rester à portée` }),
        el("li", { text: `${fmtInt(pec.trajet?.libre?.dossiers)} dossier(s) sans contrainte de distance (aucun horaire de vol suivant connu)` }),
        el("li", { text: `${fmtInt(pec.trajet?.impossible?.dossiers)} dossier(s) à budget ≤ 0 : repos côté piste à organiser` }),
        el("li", { text: `file de repli « ${pec.repli?.libelle ?? "?"} » : ${fmtInt(pec.repli?.besoins?.dossiers ?? 0)} dossier(s)` }),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Couronnes et portée" }),
      el("ul", {},
        el("li", { class: pec.couronnes?.source === "derivee" ? "avert" : null, text:
          pec.couronnes?.source === "derivee"
            ? "couronne unique DÉRIVÉE du rayon — pas une déclaration d'exploitation"
            : "couronnes DÉCLARÉES par l'exploitation — temps de trajet déclarés, non mesurés" }),
        ...((pec.couronnes?.liste ?? []).map((c) => el("li", { text:
          `couronne ${c.rang} — ${rayonTexte(c.rayon_m)} · ${trajetDeclareTexte(c.trajet_min_declare)} · ` +
          `${c.mode || "mode indéterminé"} : ${fmtInt(c.hors_portee?.chambres ?? 0)} chambre(s) hors de portée` }))),
      ),
    ),
    el("div", { class: "cell" },
      el("h3", { text: "Correspondance (réglages)" }),
      el("ul", {},
        el("li", { text: `avance avant vol : ${fmtInt(corr.avance_avant_vol_min)} min · repos minimal : ${fmtInt(corr.repos_minimal_min)} min` }),
        el("li", { text: `marge d'aléas : ${fmtInt(corr.marge_min)} min · seuil « serrée » : ${fmtInt(corr.seuil_serree_min)} min` }),
        el("li", { text: `âge bas déclencheur : ${fmtInt(pec.age_bas_max)} an(s) · élargissement : ${pec.elargir_si_insuffisant ? "autorisé" : "refusé"}` }),
        el("li", { text: `${fmtInt(pec.total?.serrees)} dossier(s) en correspondance serrée · ${fmtInt(pec.total?.escaladesCorrespondance)} escalade(s) « correspondance trop serrée »` }),
      ),
    ),
  );
  wrap.append(grid);
  for (const a of pec.avertissements ?? []) {
    wrap.append(el("p", { class: "avert", text: a.message ?? String(a) }));
  }
  return wrap;
}

/**
 * « Recherche envoyée (C1) » : l'URL RÉELLEMENT construite, passe par passe, ce
 * qui est filtré, et surtout ce qui ne PEUT PAS l'être. L'opérateur ne doit plus
 * payer à l'aveugle une recherche dont il ignore les filtres.
 */
function rechercheBloc(rech) {
  const wrap = el("div", { class: "recherche-bloc" });
  wrap.append(el("h3", { class: "c6-h3", text: "Recherche envoyée (C1) — ce que les agents vont réellement ouvrir" }));
  if (!rech || rech.erreur) {
    wrap.append(el("p", { class: "avert", text: rech?.erreur ?? "plan de recherche indisponible" }));
    return wrap;
  }
  for (const pass of rech.passes ?? []) {
    const bloc = el("div", { class: "recherche-passe" });
    bloc.append(el("strong", { text: `Passe « ${pass.id} » — ${pass.libelle}` }), el("br"));
    if (pass.url) {
      bloc.append(el("a", { href: pass.url, target: "_blank", rel: "noopener noreferrer", text: "ouvrir l'URL exacte ↗" }));
      bloc.append(el("div", { class: "mono url", text: pass.url }));
    }
    if (pass.url_sans_filtre_prix) {
      bloc.append(el("div", { class: "muted", text: "repli si le filtre de prix se révèle faux : même URL sans filtre de prix" }));
    }
    const ul = el("ul");
    for (const f of pass.filtres ?? []) {
      ul.append(el("li", { text: `${f.libelle} (${f.origine}, ${f.code})${f.exact === false ? " — filtre SUR-ENSEMBLE : il n'exclut aucun conforme, mais il ne garantit rien" : ""}` }));
    }
    bloc.append(ul);
    wrap.append(bloc);
  }
  const nf = rech.non_filtrables ?? [];
  if (nf.length) {
    wrap.append(el("strong", { text: "Exigences NON filtrables — à vérifier au relevé, hôtel par hôtel :" }));
    const ul = el("ul", { class: "c6-reserves" });
    for (const x of nf) ul.append(el("li", { text: `${x.prestation} (cabine ${x.cabine}) : ${x.raison}` }));
    wrap.append(ul);
  }
  if (rech.rayon && rech.rayon.applique === false) {
    wrap.append(el("p", { class: "avert", text: `rayon NON appliqué : ${rech.rayon.avertissement ?? "raison non fournie"}` }));
  }
  for (const a of rech.avertissements ?? []) wrap.append(el("p", { class: "avert", text: a }));
  const hyp = rech.hypothese_prix;
  if (hyp) {
    wrap.append(el("p", { class: "hint", text:
      `hypothèse ${hyp.statut} sur la syntaxe du filtre de prix (${hyp.syntaxe}) — si elle est fausse : ${hyp.effet_si_fausse}. Parade : ${hyp.parade}` }));
  }
  if (rech.codes_releves_le) {
    wrap.append(el("p", { class: "hint", text: `codes de filtres relevés le ${rech.codes_releves_le}, non revérifiés depuis` }));
  }
  return wrap;
}

async function generatePax() {
  $("pax-stats").textContent = "génération…";
  try {
    const res = await api("POST", "/api/generate-passengers", {
      seats: { J: Number($("f-seats-J").value), W: Number($("f-seats-W").value), Y: Number($("f-seats-Y").value) },
      seed: Number($("f-seed").value),
    });
    const s = res.stats;
    S.passengersMode = "generated";
    S.uploaded = null;
    $("f-upload").value = "";
    renderStatus();
    $("pax-stats").className = "hint";
    $("pax-stats").textContent =
      `${fmtInt(s.passagers)} passagers · ${fmtInt(s.dossiers)} dossiers — J ${s.parCabine.J} / W ${s.parCabine.W} / Y ${s.parCabine.Y} · ` +
      `${s.parType.ADT} ADT, ${s.parType.CHD} CHD, ${s.parType.INF} INF · ${s.pmr} PMR (seed ${s.seed})`;
  } catch (err) {
    $("pax-stats").textContent = `erreur : ${err.message}`;
  }
}

async function uploadPax(file) {
  try {
    // octets bruts : `file.text()` décoderait TOUJOURS en UTF-8 et corromprait
    // silencieusement un export Excel FR (windows-1252) — la détection est serveur
    const bytes = await file.arrayBuffer();
    // l'escale selectionnee date les horaires de correspondance donnes en « HH:MM »
    // seul : sans elle, ces dossiers n'ont aucun budget de trajet (PAXLIST v3)
    const escale = encodeURIComponent($("f-station").value || "");
    const res = await api("POST", `/api/passengers?station=${escale}`, bytes, { raw: true });
    S.passengersMode = "uploaded";
    S.uploaded = res.stats;
    renderIngestion(res.stats, file.name);
    renderStatus();
  } catch (err) {
    // liste refusée : plus AUCUNE source valide — le lancement est verrouillé jusqu'à
    // un choix explicite (nouveau fichier, ou « Générer la liste »)
    S.passengersMode = null;
    S.uploaded = null;
    $("f-upload").value = "";
    renderStatus();
    const box = $("pax-stats");
    box.className = "erreur";
    clear(box);
    box.append(el("strong", { text: "Liste passagers REFUSÉE — le run partirait sur la liste générée" }));
    box.append(el("br"));
    box.append(el("span", { text: String(err.message) }));
    if (err.data?.rapport?.refus?.length) {
      const ul = el("ul");
      for (const r of err.data.rapport.refus.slice(0, 10)) ul.append(el("li", { text: r.message }));
      box.append(ul);
    }
  }
}

/** Rapport d'ingestion : le point de contrôle avant tout run (INV-9 : textContent seulement). */
function renderIngestion(stats, fileName) {
  const box = $("pax-stats");
  box.className = "ingestion";
  clear(box);
  if (!stats) return;
  const l = (t, strong = false) => box.append(el(strong ? "strong" : "span", { text: t }), el("br"));
  l(`Liste téléversée${fileName ? ` : ${fileName}` : ""} — ${fmtInt(stats.passagers)} passagers à loger · ${fmtInt(stats.dossiers)} dossiers`, true);
  const lg = stats.lignes ?? {};
  const ecartees = stats.fichier?.lignes_ignorees?.length ?? 0;
  l(`lignes : ${fmtInt(lg.lues ?? 0)} lues · ${fmtInt(lg.retenues ?? 0)} retenues · ${ecartees} écartée(s) · ${fmtInt(lg.refusees ?? 0)} refusée(s)`);
  for (const li of stats.fichier?.lignes_ignorees ?? []) {
    box.append(el("span", { class: "avert", text: `⚠ ligne ${li.ligne} écartée : ${li.motif}` }), el("br"));
  }
  l(`J ${stats.parCabine?.J ?? 0} / W ${stats.parCabine?.W ?? 0} / Y ${stats.parCabine?.Y ?? 0} · ` +
    `${stats.parType?.ADT ?? 0} ADT, ${stats.parType?.CHD ?? 0} CHD, ${stats.parType?.INF ?? 0} INF · ` +
    `${stats.pmr ?? 0} PMR · ${stats.groupes?.length ?? 0} groupe(s) · ${stats.animaux ?? 0} animal/animaux`);
  l(`escalades nominatives ${stats.escalades?.nominative ?? 0} · droit d'entrée ${stats.escalades?.droit_entree ?? 0} · ` +
    `équipage hors plan ${stats.equipage ?? 0} · lignes refusées ${stats.lignes?.refusees ?? 0}`);
  if (stats.fichier) l(`fichier : ${stats.fichier.encodage}, séparateur « ${stats.fichier.separateur} »` +
    (stats.fichier.alias_appliques?.length ? ` · en-têtes traduits : ${stats.fichier.alias_appliques.join(", ")}` : ""));
  if (stats.alias_valeurs?.length) l(`valeurs traduites : ${stats.alias_valeurs.join(" · ")}`);
  for (const a of stats.avertissements ?? []) box.append(el("span", { class: "avert", text: `⚠ ${a}` }), el("br"));
}

/* ----------------------------------------------------------- inventaire */

const INV = { code: "BKK", data: null };

async function loadInventaire(code) {
  INV.code = code;
  $("inv-msg").textContent = "";
  try {
    const res = await api("GET", `/api/inventaire/${code}`);
    INV.data = res.inventaire;
    $("inv-updated").textContent = `mis à jour : ${fmtTs(res.inventaire.updated_at)} · ${res.inventaire.hotels.length} hôtel(s)`;
    $("inv-stale").classList.toggle("hidden", !res.stale);
    renderInventaire();
  } catch (err) {
    $("inv-msg").textContent = `erreur : ${err.message}`;
  }
}

function renderInventaire() {
  const body = $("inv-body");
  clear(body);
  for (const h of INV.data?.hotels ?? []) {
    const mk = (field) => {
      const cb = el("input", { type: "checkbox", "data-id": h.id, "data-field": field });
      cb.checked = Boolean(h[field]);
      return el("td", {}, cb);
    };
    body.append(el("tr", {},
      el("td", {},
        el("div", { text: h.name }),
        h.url ? el("a", { href: h.url, target: "_blank", rel: "noopener noreferrer", class: "muted", text: "fiche Booking ↗" }) : "",
      ),
      el("td", { text: h.source }),
      el("td", { class: "num", text: h.stars === null ? "—" : `${h.stars}★` }),
      el("td", { class: "num", text: h.review_score === null ? "—" : String(h.review_score) }),
      el("td", { class: "num", text: h.distance_km === null ? "—" : String(h.distance_km) }),
      el("td", { class: "num", text: h.indicative_price_from_eur === null ? "—" : fmtInt(h.indicative_price_from_eur) }),
      el("td", { text: h.payment?.company_payment_possible ?? "—" }),
      mk("contracted"), mk("preferred"), mk("excluded"),
    ));
  }
}

async function saveInventaire() {
  const flags = {};
  for (const cb of $("inv-body").querySelectorAll("input[type=checkbox]")) {
    const id = cb.getAttribute("data-id");
    (flags[id] ??= {})[cb.getAttribute("data-field")] = cb.checked;
  }
  try {
    const res = await api("PUT", `/api/inventaire/${INV.code}`, { flags });
    INV.data = res.inventaire;
    $("inv-msg").textContent = "Drapeaux enregistrés.";
    renderInventaire();
  } catch (err) {
    $("inv-msg").textContent = `erreur : ${err.message}`;
  }
}

async function addInventaire() {
  const name = $("inv-add-name").value.trim();
  if (!name) return void ($("inv-msg").textContent = "Nom requis pour l'ajout manuel.");
  try {
    const res = await api("PUT", `/api/inventaire/${INV.code}`, {
      add: [{
        name,
        url: $("inv-add-url").value.trim(),
        phone: $("inv-add-phone").value.trim() || null,
        email: $("inv-add-email").value.trim() || null,
        contracted: $("inv-add-contracted").checked,
      }],
    });
    INV.data = res.inventaire;
    for (const id of ["inv-add-name", "inv-add-url", "inv-add-phone", "inv-add-email"]) $(id).value = "";
    $("inv-add-contracted").checked = false;
    $("inv-msg").textContent = `« ${name} » ajouté (source manuelle).`;
    $("inv-updated").textContent = `mis à jour : ${fmtTs(INV.data.updated_at)} · ${INV.data.hotels.length} hôtel(s)`;
    renderInventaire();
  } catch (err) {
    $("inv-msg").textContent = `erreur : ${err.message}`;
  }
}

async function refreshInventaireByAgents() {
  try {
    await api("POST", `/api/inventaire/${INV.code}/run`, {});
    $("inv-msg").textContent = "Rafraîchissement lancé.";
  } catch (err) {
    $("inv-msg").textContent = err.status === 409
      ? "Un run est déjà en cours (INV-10) — réessayer après la fin."
      : err.message;
  }
}

/* ------------------------------------------------------------ démarrage */

function switchTab(tab) {
  $("view-operation").classList.toggle("hidden", tab !== "operation");
  $("view-inventaire").classList.toggle("hidden", tab !== "inventaire");
  $("tab-operation").classList.toggle("active", tab === "operation");
  $("tab-inventaire").classList.toggle("active", tab === "inventaire");
  if (tab === "inventaire") loadInventaire($("inv-station").value || "BKK");
}

async function init() {
  S.config = await api("GET", "/api/config");
  S.stations = S.config.stations; // déjà triées par demo_priority (BKK d'abord, EX-STA-1)
  S.uploaded = S.config.uploaded ?? null;
  if (S.config.uploaded) {
    // une liste téléversée vit dans le serveur : sans cette restauration, un simple
    // rechargement d'onglet relancerait le run sur la liste GÉNÉRÉE, sans rien dire
    S.passengersMode = "uploaded";
    renderIngestion(S.config.uploaded, null);
  }

  for (const sel of [$("f-station"), $("inv-station")]) {
    clear(sel);
    for (const st of S.stations) sel.append(el("option", { value: st.code, text: `${st.code} — ${st.name}` }));
    sel.value = S.stations[0]?.code ?? "BKK";
  }
  $("f-station").addEventListener("change", renderStationInfo);
  renderStationInfo();

  buildPolicyForm(S.config.defaults.policy);
  $("f-avion-nom").value = S.config.defaults.avion.nom;
  for (const t of ["J", "W", "Y"]) $(`f-seats-${t}`).value = S.config.defaults.avion.seats[t];
  $("f-nights").value = S.config.defaults.scenario.nights;
  $("f-seed").value = S.config.defaults.scenario.seed;

  const presetSel = $("f-preset");
  const renderPresets = (presets) => {
    clear(presetSel);
    presetSel.append(el("option", { value: "", text: "— défauts —" }));
    for (const p of presets) presetSel.append(el("option", { value: p.name, text: p.name }));
  };
  renderPresets(S.config.presets);
  $("btn-preset-load").addEventListener("click", () => {
    const chosen = S.config.presets.find((p) => p.name === presetSel.value);
    buildPolicyForm(chosen ? chosen.policy : S.config.defaults.policy);
    $("preset-msg").textContent = chosen ? `Preset « ${chosen.name} » chargé.` : "Défauts rechargés.";
  });
  $("btn-preset-save").addEventListener("click", async () => {
    const name = $("f-preset-name").value.trim();
    try {
      await api("POST", "/api/presets", { name, policy: policyFromForm() });
      const cfg = await api("GET", "/api/config");
      S.config.presets = cfg.presets;
      renderPresets(cfg.presets);
      presetSel.value = name;
      $("preset-msg").textContent = `Preset « ${name} » sauvegardé.`;
    } catch (err) {
      $("preset-msg").textContent = `refusé : ${err.message}`;
    }
  });

  $("btn-run").addEventListener("click", launchRun);
  $("btn-dry-run").addEventListener("click", launchDryRun);
  $("btn-cancel").addEventListener("click", async () => {
    try {
      await api("POST", "/api/cancel", {});
    } catch (err) {
      $("run-error").textContent = err.message;
    }
  });
  $("btn-cancel-ext").addEventListener("click", async () => {
    try {
      await api("POST", "/api/cancel-extension", {});
    } catch (err) {
      $("run-error").textContent = err.message;
    }
  });
  $("btn-valider").addEventListener("click", () => envoyerDecision("valide"));
  $("btn-refuser").addEventListener("click", () => envoyerDecision("refuse"));
  $("btn-generate").addEventListener("click", generatePax);
  $("f-upload").addEventListener("change", (e) => {
    if (e.target.files?.[0]) uploadPax(e.target.files[0]);
  });

  $("tab-operation").addEventListener("click", () => switchTab("operation"));
  $("tab-inventaire").addEventListener("click", () => switchTab("inventaire"));
  $("link-inventaire").addEventListener("click", () => {
    $("inv-station").value = $("f-station").value;
    switchTab("inventaire");
  });
  $("inv-station").addEventListener("change", () => loadInventaire($("inv-station").value));
  $("inv-save").addEventListener("click", saveInventaire);
  $("inv-add-btn").addEventListener("click", addInventaire);
  $("inv-refresh").addEventListener("click", refreshInventaireByAgents);

  $("form-toggle").addEventListener("click", () => {
    const col = $("form-col");
    col.classList.toggle("collapsed");
    $("form-toggle").textContent = col.classList.contains("collapsed") ? "▶" : "◀";
  });
  $("msg-fr").addEventListener("click", () => {
    S.msgLang = "fr";
    $("msg-fr").classList.add("active");
    $("msg-en").classList.remove("active");
    renderMessages();
  });
  $("msg-en").addEventListener("click", () => {
    S.msgLang = "en";
    $("msg-en").classList.add("active");
    $("msg-fr").classList.remove("active");
    renderMessages();
  });
  $("msg-tier").addEventListener("change", () => {
    S.msgTier = $("msg-tier").value;
    renderMessages();
  });
  $("lightbox-close").addEventListener("click", () => $("lightbox").classList.add("hidden"));
  $("lightbox").addEventListener("click", (e) => {
    if (e.target === $("lightbox")) $("lightbox").classList.add("hidden");
  });

  connectSse();
}

init().catch((err) => {
  $("run-error").textContent = `initialisation impossible : ${err.message}`;
});
