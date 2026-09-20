/**
 * Mode simulation BKK (phase 4) — un run complet d'environ 90 s à ZÉRO coût,
 * sans aucune session d'agent (INV-8) : `collect` simulé injecté dans
 * `runPipeline`, rejouant les fixtures `data/simulate/{releves,inventaire}-demo.json`
 * avec pensées scriptées en français, captures PNG locales (`demo/sim-assets/`)
 * et une extension en vague 1 : une sonde de capacité puis un relevé.
 *
 * Les fixtures du 31/08 ne couvrent que 4 relevés (dont deux `found=false`) ;
 * pour dérouler la vague « sonde + 1 relevé » sans que la cascade de
 * substitution de l'étage B (§6.6) ne consomme tous les candidats, trois
 * réponses scriptées complètent les fixtures : Novotel et Méridien (relevés
 * exploitables) et Amaranth (relevé de la vague d'extension). Aucune donnée
 * passager n'apparaît dans les pensées ni les événements (INV-5).
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { normalizeInventaire, slugify } from "../hai-admin-mcp/lib/inventaire.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_RELEVES = path.join(ROOT, "data", "simulate", "releves-demo.json");
const FIXTURES_INVENTAIRE = path.join(ROOT, "data", "simulate", "inventaire-demo.json");

/** Escales disposant de fixtures de simulation (EX-UI-1). */
export const SIM_STATIONS = ["BKK"];
export const simAvailable = (code) => SIM_STATIONS.includes(String(code ?? "").toUpperCase());

/** Inventaire de simulation (EX-INV-9 sur fixtures) — validé et recalculé (EX-INV-4). */
export function loadSimInventaire() {
  return normalizeInventaire(JSON.parse(fs.readFileSync(FIXTURES_INVENTAIRE, "utf8")), "data/simulate/inventaire-demo.json");
}

/* ------------------------------------------------- réponses scriptées (sim) */

const mkRoom = (room_type, price, qty, { bkfst = false, fam = false, cap = false } = {}) => ({
  room_type,
  occupancy_adults: 2,
  occupancy_children: fam ? 2 : 0,
  quantity_available: qty,
  quantity_displayed_max: qty,
  cap_reached: cap,
  price_per_night: price,
  free_cancellation: true,
  breakfast_included: bkfst,
  family_capable: fam,
});

/** Relevés complémentaires aux fixtures, par id de candidat. */
export const SIM_ANSWERS = {
  "novotel-bkk-airport": {
    hotel: "Novotel Bangkok Suvarnabhumi Airport",
    url: "https://www.booking.com/hotel/th/novotel-bangkok-suvarnabhumi-airport.html",
    found: true,
    currency: "EUR",
    source: "platform",
    stars: 4,
    review_score: 8.0,
    review_count: 2101,
    distance_km: 2.9,
    distance_ref: "airport",
    amenities: { wifi_free: true, room_service: "oui", workspace: "non_precise", airport_shuttle: "gratuite", restaurant_late: true, accessible: true },
    payment: { prepayment_online: "non_precise", pay_at_property_only: null },
    rooms: [mkRoom("Superior Twin", 96, 6), mkRoom("Deluxe King", 112, 6)],
    notes: "Relevé simulé (aucune session d'agent).",
  },
  "le-meridien-suvarnabhumi-golf-resort-spa": {
    hotel: "Le Méridien Suvarnabhumi Golf Resort & Spa",
    url: "https://www.booking.com/hotel/th/le-meridien-suvarnabhumi.html",
    found: true,
    currency: "EUR",
    source: "platform",
    stars: 5,
    review_score: 8.7,
    review_count: 1452,
    distance_km: 4.2,
    distance_ref: "airport",
    amenities: { wifi_free: true, room_service: "24h", workspace: "oui", airport_shuttle: "payante", restaurant_late: true, accessible: true },
    payment: { prepayment_online: "oui", pay_at_property_only: false },
    rooms: [mkRoom("Deluxe Garden King", 189, 3), mkRoom("Club Suite", 249, 2, { bkfst: true })],
    notes: "Relevé simulé (aucune session d'agent).",
  },
  "amaranth-suvarnabhumi-hotel": {
    hotel: "Amaranth Suvarnabhumi Hotel",
    url: "https://www.booking.com/hotel/th/amaranth-suvarnabhumi.html",
    found: true,
    currency: "EUR",
    source: "platform",
    stars: 3,
    review_score: 8.1,
    review_count: 3204,
    distance_km: 1.2,
    distance_ref: "airport",
    amenities: { wifi_free: true, room_service: "non", workspace: "non_precise", airport_shuttle: "gratuite", restaurant_late: false, accessible: false },
    payment: { prepayment_online: "non", pay_at_property_only: true },
    rooms: [mkRoom("Superior Double", 82, 10, { bkfst: true }), mkRoom("Family Room", 118, 5, { bkfst: true, fam: true })],
    notes: "Relevé simulé (aucune session d'agent).",
  },
};

/** Résultat de la sonde de capacité simulée (vague 1, EX-EXT-1). */
// Maximum sélectionnable rendu par la sonde simulée. Le pipeline réel demande au plus
// `probe_no_rooms_max` (30) : une sonde ne peut pas rendre davantage, la fixture s'y tient.
// `cap_reached: true` va avec : sur un hôtel à 29 types, le sélecteur reste plafonné, donc
// 30 est une borne BASSE (l'hôtel en a au moins 30) et non une mesure ferme.
export const SIM_PROBE_MAX = 30;

/* ------------------------------------------------------ pensées scriptées */

const THOUGHTS_RELEVE = [
  "Ouverture de la fiche hôtel avec les dates du séjour et la devise EUR.",
  "La disponibilité s'affiche : lecture des types de chambres et des tarifs par nuit.",
  "Relevé des équipements déclarés : wifi, room service, espace de travail, navette aéroport.",
  "Lecture des conditions : annulation, petit-déjeuner inclus, modalités de paiement.",
  "Vérification du plafond d'affichage des quantités par type de chambre.",
  "Réponse structurée transmise — aucune réservation effectuée (lecture seule).",
];
const THOUGHTS_RELEVE_NOT_FOUND = [
  "Ouverture de la page avec les dates du séjour.",
  "La fiche ne correspond pas à l'hôtel demandé — nouvelle vérification du nom exact.",
  "Hôtel introuvable sur la plateforme pour ces dates : signalement sans substitution (interdite à l'agent).",
];
const THOUGHTS_PROBE = [
  "Ouverture de la fiche avec la quantité demandée dans le sélecteur de chambres.",
  "Lecture du nombre maximal de chambres réellement sélectionnables pour cette demande.",
  "Sonde terminée — lecture seule, aucune réservation.",
];

/** Captures locales servies par le proxy (§9) — clés d'état, jamais d'URL cliente. */
const CAPTURES_RELEVE = ["capture-fiche.png", "capture-chambres.png", "capture-paiement.png"];
const CAPTURE_PROBE = "capture-recherche.png";

/* ------------------------------------------------------------- mécanique */

/** Pause abortable : résout sans erreur (plus tôt) si le signal tombe. */
async function sleep(ms, signal) {
  if (ms <= 0 || signal?.aborted) return;
  try {
    await delay(ms, undefined, { signal });
  } catch {
    /* AbortError : on rend la main immédiatement */
  }
}

const cleanUrl = (u) => String(u ?? "").toLowerCase().split("?")[0].replace(/\/+$/, "");

/**
 * Fabrique le `collect` simulé injectable dans `runPipeline`.
 *
 * @param {object} [opts]
 * @param {number} [opts.speed] accélérateur (1 = ~90 s ; 100 = ~1 s, tests)
 * @param {AbortSignal} [opts.signal] annulation totale du run
 * @param {AbortSignal} [opts.extensionSignal] arrêt de l'extension seule (EX-EXT-4)
 * @param {Array} [opts.records] relevés de fixtures (défaut : releves-demo.json)
 */
export function createSimulation({ speed = 1, signal = null, extensionSignal = null, records = null } = {}) {
  const recs = records ?? JSON.parse(fs.readFileSync(FIXTURES_RELEVES, "utf8"));
  const ms = (base) => Math.max(1, Math.round(base / speed));
  // étage B d'abord ; les appels suivants de `releves` appartiennent à l'extension
  let stageBDone = false;
  const extSignal = () =>
    extensionSignal ? (signal ? AbortSignal.any([signal, extensionSignal]) : extensionSignal) : signal;

  const findRecord = (candidate) =>
    recs.find((r) => r.hotel === candidate.id) ??
    recs.find((r) => cleanUrl(r.answer?.url) && cleanUrl(r.answer.url) === cleanUrl(candidate.url)) ??
    recs.find((r) => (r.answer?.hotel ?? "").toLowerCase() === candidate.name.toLowerCase());

  /** Relevé simulé d'un candidat : réponse scriptée, sinon fixture, sinon introuvable. */
  function answerFor(candidate, ctx) {
    const key = candidate.id ?? slugify(candidate.name);
    const scripted = SIM_ANSWERS[key];
    const base = scripted ?? findRecord(candidate)?.answer ?? null;
    if (!base) {
      return {
        hotel: candidate.name,
        url: candidate.url ?? "",
        found: false,
        checkin: ctx.checkin,
        checkout: ctx.checkout,
        currency: "EUR",
        rooms: [],
        notes: "hors fixtures (mode simulation)",
        observed_at: new Date().toISOString(),
      };
    }
    // dates du run et horodatage côté code (EX-REL-2)
    return { ...base, checkin: ctx.checkin, checkout: ctx.checkout, observed_at: new Date().toISOString() };
  }

  /** Déroule les pensées d'un agent avec captures et métriques simulées. */
  async function playThoughts(emit, hotelKey, thoughts, { thoughtMs, captures = [], stopSignal }) {
    let steps = 0;
    for (let i = 0; i < thoughts.length; i += 1) {
      if (stopSignal?.aborted) return steps;
      await sleep(thoughtMs, stopSignal);
      if (stopSignal?.aborted) return steps;
      steps += 1;
      emit("agent_thought", { text: thoughts[i], action: null }, { hotel_key: hotelKey });
      const capture = captures[i];
      if (capture) {
        emit("screenshot", { source: `sim-assets/${capture}`, imageType: "file", mediaType: "image/png", url: null }, { hotel_key: hotelKey });
      }
      emit("metrics", { steps, cost_usd: 0, tokens: steps * 830 }, { hotel_key: hotelKey });
    }
    return steps;
  }

  /** Un relevé simulé complet (statuts, pensées, captures, réponse). */
  async function runOne(ctx, candidate, tiers, stopSignal, { thoughtMs }) {
    const key = candidate.id ?? slugify(candidate.name);
    const answer = answerFor(candidate, ctx);
    const sessionId = `sim-${key}`;
    const scoped = { hotel_key: key, session_id: sessionId };
    ctx.emit("agent_status", { status: "starting", hotel: candidate.name }, scoped);
    const thoughts = answer.found ? THOUGHTS_RELEVE : THOUGHTS_RELEVE_NOT_FOUND;
    // captures sur les pensées 1, 2 et 4 (fiche, chambres, paiement)
    const capturePlan = answer.found ? [CAPTURES_RELEVE[0], CAPTURES_RELEVE[1], null, CAPTURES_RELEVE[2], null, null] : [CAPTURES_RELEVE[0]];
    ctx.emit("agent_status", { status: "running" }, scoped);
    await playThoughts(ctx.emit, key, thoughts, { thoughtMs, captures: capturePlan, stopSignal });
    ctx.emit("agent_status", { status: "completed" }, scoped);
    return {
      hotel: key,
      hotelKey: key,
      name: candidate.name,
      url: candidate.url ?? "",
      tiers,
      sessionId,
      status: "completed",
      outcome: null,
      error: null,
      answer,
      costUsd: 0,
    };
  }

  return {
    // hors ligne : pas de découverte (EX-DIS-1 → discovery_skipped sur fixtures fraîches)
    discovery: null,

    /** Étage B puis relevés d'extension : concurrence décalée, substitution §6.6. */
    async releves(ctx, selection, substitutes, onInventory) {
      const isExtension = stageBDone;
      stageBDone = true;
      const stopSignal = isExtension ? extSignal() : signal;
      const staggerMs = ms(2600);
      const thoughtMs = ms(isExtension ? 4400 : 5600);
      // mise en place des agents de l'étage B (cadence cible : run ~90 s)
      if (!isExtension) await sleep(ms(3000), stopSignal);

      const out = [];
      const usedNames = new Set(selection.map((s) => (s.candidate ?? s).name));
      const pending = [];
      let chain = Promise.resolve();

      const launch = (candidate, tiers, index) => {
        const p = (async () => {
          await sleep(index * staggerMs, stopSignal);
          if (stopSignal?.aborted) return;
          const rec = await runOne(ctx, candidate, tiers, stopSignal, { thoughtMs });
          out.push(rec);
          // sérialise réallocation + éventuelle substitution (état partagé)
          chain = chain.then(() => {
            if (onInventory) onInventory(rec, out);
            const usable = rec.answer?.found && (rec.answer.rooms ?? []).some((r) => r.price_per_night > 0);
            if (!usable) {
              ctx.emit("warning", { message: `« ${candidate.name} » sans inventaire exploitable — substitution par le code si possible (§6.6)` });
              for (const tier of tiers) {
                const next = (substitutes?.[tier] ?? []).find((c) => !usedNames.has(c.name));
                if (next) {
                  usedNames.add(next.name);
                  pending.push(launch(next, [tier], out.length));
                  break;
                }
              }
            }
          });
          await chain;
        })();
        return p;
      };

      selection.forEach((s, i) => {
        const candidate = s.candidate ?? s;
        pending.push(launch(candidate, s.tiers ?? candidate.tiers ?? [], i));
      });
      // les substitutions peuvent allonger `pending` pendant l'attente
      for (let i = 0; i < pending.length; i += 1) await pending[i];
      await chain;
      return out;
    },

    /** Sonde de capacité simulée (vague d'extension). */
    async probe(ctx, probe) {
      const stopSignal = extSignal();
      const scoped = { hotel_key: probe.hotelKey, session_id: `sim-probe-${probe.hotelKey}` };
      ctx.emit("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "starting" }, scoped);
      ctx.emit("agent_status", { status: "starting", hotel: `${probe.name} (sonde)` }, scoped);
      const thoughts = [THOUGHTS_PROBE[0], THOUGHTS_PROBE[1].replace("du nombre maximal", `du maximum (${SIM_PROBE_MAX})`), THOUGHTS_PROBE[2]];
      ctx.emit("screenshot", { source: `sim-assets/${CAPTURE_PROBE}`, imageType: "file", mediaType: "image/png", url: null }, { hotel_key: probe.hotelKey });
      await playThoughts(ctx.emit, probe.hotelKey, thoughts, { thoughtMs: ms(4600), stopSignal });
      ctx.emit("agent_status", { status: "completed" }, scoped);
      if (stopSignal?.aborted) {
        ctx.emit("probe", { hotel: probe.hotelKey, requested_rooms: probe.requested_rooms, result: null, status: "cancelled" }, scoped);
        return null;
      }
      const answer = {
        hotel: probe.name,
        found: true,
        requested_rooms: probe.requested_rooms,
        rooms_selectable_max: SIM_PROBE_MAX,
        cap_reached: true,
        notes: "Sonde simulée (aucune session d'agent).",
      };
      ctx.emit("probe", {
        hotel: probe.hotelKey,
        requested_rooms: probe.requested_rooms,
        result: { rooms_available_max: answer.rooms_selectable_max, cap_reached: answer.cap_reached },
        status: "completed",
      }, scoped);
      return answer;
    },
  };
}
