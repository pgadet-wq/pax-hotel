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
const fmtUsd = (v) => `${Number(v ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const fmtInt = (v) => Number(v ?? 0).toLocaleString("fr-FR");
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
  passengersMode: "generated",
  elapsedTimer: null,
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

function buildPolicyForm(policy) {
  const wrap = $("policy-cabins");
  clear(wrap);
  for (const tier of ["J", "W", "Y"]) wrap.append(cabinBlock(tier, policy.cabins[tier], S.config.amenities.labels));
  $("f-fam-adults").value = policy.global.rooming.family_unit_max.adults;
  $("f-fam-children").value = policy.global.rooming.family_unit_max.children;
  $("f-priorities").value = policy.global.priorities.join(", ");
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
  $("station-info").textContent =
    `${st.name} — zone « ${st.search.zone_query} », rayon ${st.search.radius_km} km, ` +
    `transfert ${st.transfer.default_mode} (max ${st.transfer.max_transfer_min} min), facteur prix ×${st.pricing.price_cap_factor}`;
  updateEffectiveCaps();
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
  const prio = $("f-priorities").value.split(",").map((s) => s.trim()).filter(Boolean);
  if (prio.length) base.global.priorities = prio;
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
    passengers: S.passengersMode,
    dry_run: dryRun || undefined,
  };
}

/* -------------------------------------------------------------- rendu run */

function renderStatus() {
  const r = S.run;
  const chip = $("status-chip");
  const states = { idle: "prêt", running: "run en cours", done: "terminé", cancelled: "annulé", error: "erreur" };
  const st = r?.state ?? "idle";
  chip.className = `chip ${st}`;
  chip.textContent = states[st] ?? st;
  $("run-id").textContent = r?.runId ? `run ${r.runId} · ${r.station ?? ""}${r.simulate ? " · simulation" : ""}` : "";
  $("btn-cancel").classList.toggle("hidden", st !== "running");
  $("btn-cancel-ext").classList.toggle("hidden", !(st === "running" && r?.phase === "extension"));
  $("btn-run").disabled = st === "running";
  if (st === "running" && !S.elapsedTimer) {
    S.elapsedTimer = setInterval(renderElapsed, 1000);
  } else if (st !== "running" && S.elapsedTimer) {
    clearInterval(S.elapsedTimer);
    S.elapsedTimer = null;
    renderElapsed();
  }
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

function renderBanner() {
  const r = S.run;
  const t = r?.metricsTotals ?? { steps: 0, cost_usd: 0, tokens: 0 };
  $("b-cost").textContent = fmtUsd(t.cost_usd);
  $("b-tokens").textContent = fmtInt(t.tokens);
  $("b-steps").textContent = fmtInt(t.steps);
  const lim = r?.extension?.limits;
  const extPolicy = S.config?.defaults?.policy?.extension;
  const sMax = lim?.sessions_max ?? extPolicy?.max_sessions_per_run ?? "—";
  const cMax = lim?.cost_max ?? extPolicy?.max_cost_usd_per_run ?? "—";
  const wMax = lim?.max_waves ?? extPolicy?.max_waves ?? "—";
  $("b-ext-sessions").textContent = `${lim?.sessions_used ?? 0} / ${sMax}`;
  $("b-ext-cost").textContent = `${fmtUsd(lim?.cost_usd ?? 0)} / ${cMax} $`;
  $("b-ext-wave").textContent = lim ? `${Math.min(lim.wave, lim.max_waves)} / ${wMax}` : `0 / ${wMax}`;
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

function planRow(row) {
  const cells = [
    row.pnr, row.cabine, row.overlays || "", row.categorie || "",
    row.hotel || "—", row.room_type || "—", String(row.chambres ?? ""),
    row.prix_total === "" || row.prix_total === undefined ? "—" : fmtEur(row.prix_total),
    row.conformite || "—", row.mode_reglement || "—",
    row.statut ?? "", row.notes || "",
  ];
  let tr = S.planRows.get(row.pnr);
  if (!tr) {
    tr = el("tr", {}, ...cells.map((c, i) => el("td", { class: i === 6 || i === 7 ? "num" : null, text: c })));
    S.planRows.set(row.pnr, tr);
    $("plan-body").append(tr);
  } else {
    [...tr.children].forEach((td, i) => {
      td.textContent = cells[i];
    });
  }
  const esc = row.statut === "ESCALADE DESK";
  const prov = row.provisoire === true || row.provisoire === "true";
  tr.className = esc ? "row-esc" : prov ? "row-prov" : "";
}

function renderPlan() {
  for (const row of S.run?.plan ?? []) planRow(row);
  renderPlanSummary();
}

function renderPlanSummary() {
  const s = S.run?.planSummary;
  $("plan-summary").textContent = s ? `— ${fmtInt(s.ok)} dossiers logés · ${fmtInt(s.escalade)} en escalade` : "";
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
        ...["J", "W", "Y"].map((t) => el("li", { text: `${t} : ${fmtEur(cost.per_night?.[t] ?? 0)}` })),
        el("li", {}, el("strong", { text: `Total : ${fmtEur(cost.per_night?.total ?? 0)}` })),
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
      el("ul", {}, ...["J", "W", "Y"].map((t) => el("li", { text: `${t} : ${cost.escalated_rooms?.[t] ?? 0}` }))),
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
    S.run = snap;
    resetRunView();
    renderAll();
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
    "warning", "log", "done", "error", "inventory_status", "extension", "probe", "cost", "messages_ready"];
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
      el("h3", { text: "Extension théorique (vague 1)" }),
      el("ul", {},
        el("li", { text: `bornes : ${rep.extension.limits.sessions_max} sessions · ${rep.extension.limits.max_waves} vagues · ${rep.extension.limits.cost_max} $` }),
        el("li", { text: rep.extension.stop ? `→ ${rep.extension.reason}` : `→ sondes : ${rep.extension.probes} · relevés : ${rep.extension.surveys.join(", ") || "aucun"}` }),
      ),
    ),
  );
  body.append(grid);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    $("pax-stats").textContent =
      `${fmtInt(s.passagers)} passagers · ${fmtInt(s.dossiers)} dossiers — J ${s.parCabine.J} / W ${s.parCabine.W} / Y ${s.parCabine.Y} · ` +
      `${s.parType.ADT} ADT, ${s.parType.CHD} CHD, ${s.parType.INF} INF · ${s.pmr} PMR (seed ${s.seed})`;
  } catch (err) {
    $("pax-stats").textContent = `erreur : ${err.message}`;
  }
}

async function uploadPax(file) {
  try {
    const text = await file.text();
    const res = await api("POST", "/api/passengers", text, { raw: true });
    S.passengersMode = "uploaded";
    $("pax-stats").textContent =
      `liste téléversée : ${fmtInt(res.stats.passagers)} passagers · ${fmtInt(res.stats.dossiers)} dossiers — ` +
      `J ${res.stats.parCabine.J ?? 0} / W ${res.stats.parCabine.W ?? 0} / Y ${res.stats.parCabine.Y ?? 0} (utilisée au prochain run)`;
  } catch (err) {
    $("pax-stats").textContent = `CSV refusé : ${err.message}`;
  }
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
