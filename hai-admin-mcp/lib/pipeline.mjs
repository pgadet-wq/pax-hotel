/**
 * Orchestrateur du run v2 (CDC §5.8, §6) : phases `preparation → generation →
 * besoins → inventaire → discovery|discovery_skipped → releves → allocation →
 * extension (0..n) → sorties → done`, allocation incrémentale (EX-ALL-1) et
 * boucle d'extension bornée (§6.4).
 *
 * `collect` est injectable : `realCollect(client)` lance les vraies sessions
 * (phases 5-6), `fixturesCollect(records)` rejoue des fixtures (offline, tests,
 * simulation phase 4). Le pipeline lui-même n'importe pas le SDK.
 */
import { generatePassengers } from "./passagers.mjs";
import { buildDossiers, computeNeeds, avertissementsDe } from "./dossiers.mjs";
import { normalizePaxRows, splitPaxRows } from "./paxlist.mjs";
import { allocate } from "./allocate.mjs";
import { computeCost } from "./cout.mjs";
import { buildMessages } from "./messages.mjs";
import { buildPlanCsv, buildRapportMd, buildMessagesCsv, buildRoomingCsv, buildFichesOutputs } from "./rapport.mjs";
import { loadInventaire, mergeInventaire, isStale, candidatesFrom, reconcileIds, slugify } from "./inventaire.mjs";
import { discoveryNeeded, candidateToEntry, couronnePlusProche } from "./discovery.mjs";
import { couronnesRecherche } from "./hai-urls.mjs";
import { planExtension, applyProbeResult } from "./capacite.mjs";
import { resolveConcurrency, MIN_DEMARRAGE_MS } from "./releve.mjs";
import { resolveDates, newRunId, DEFAULT_AVION, stationClock } from "./scenario.mjs";

/** Collecteurs réels (sessions payantes — phases 5-6, INV-8 gardé par les CLI). */
export function realCollect(client) {
  return {
    // `options` (additif) porte ce qui varie d'une découverte à l'autre : besoins par
    // cabine (plafond de prix et passe PMR, C1/C3) et élargissement d'une redécouverte (C2)
    async discovery(ctx, options = {}) {
      const { runDiscovery } = await import("./discovery.mjs");
      return runDiscovery({ client, ...ctx, ...options });
    },
    async releves(ctx, selection, substitutes, onInventory) {
      const { runReleves } = await import("./releve.mjs");
      return runReleves({ client, ...ctx, selection, substitutes, onInventory });
    },
    async probe(ctx, probe) {
      const { runProbe } = await import("./capacite.mjs");
      return runProbe({ client, ...ctx, probe });
    },
  };
}

const cleanUrl = (u) => String(u ?? "").toLowerCase().split("?")[0].replace(/\/+$/, "");

/** Exécute `fn` sur chaque élément avec au plus `n` en vol, en conservant l'ordre. */
async function runPool(items, fn, n = 3) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Collecteur de fixtures (0 €) : sert les relevés depuis un tableau
 * `[{hotel, sessionId, status, answer}]` (format `data/simulate/releves-demo.json`).
 * Un candidat hors fixtures reçoit `found=false` (la substitution du pipeline joue).
 * La sonde est indisponible hors ligne (retourne null, la vague passe aux candidats).
 */
export function fixturesCollect(records) {
  const findRecord = (candidate) =>
    records.find((r) => r.hotel === candidate.id) ??
    records.find((r) => cleanUrl(r.answer?.url) && cleanUrl(r.answer.url) === cleanUrl(candidate.url)) ??
    records.find((r) => (r.answer?.hotel ?? "").toLowerCase() === candidate.name.toLowerCase());

  return {
    discovery: null, // hors ligne : pas de découverte possible
    async releves(ctx, selection, substitutes, onInventory) {
      const out = [];
      const queue = selection.map((s) => ({ candidate: s.candidate ?? s, tiers: s.tiers ?? (s.candidate ?? s).tiers ?? [] }));
      const usedNames = new Set(queue.map((q) => q.candidate.name));
      while (queue.length) {
        const { candidate, tiers } = queue.shift();
        const rec = findRecord(candidate);
        const hotelKey = candidate.id ?? slugify(candidate.name);
        const inv = rec
          ? { hotel: hotelKey, hotelKey, name: candidate.name, url: candidate.url ?? "", tiers, sessionId: rec.sessionId ?? null, status: rec.status ?? "completed", outcome: rec.outcome ?? null, error: rec.error ?? null, answer: rec.answer, costUsd: 0 }
          : {
              hotel: hotelKey, hotelKey, name: candidate.name, url: candidate.url ?? "", tiers, sessionId: null, status: "completed", outcome: null, error: null, costUsd: 0,
              answer: { hotel: candidate.name, url: candidate.url ?? "", found: false, checkin: ctx.checkin, checkout: ctx.checkout, currency: "EUR", rooms: [], notes: "hors fixtures (mode hors ligne)", observed_at: new Date().toISOString() },
            };
        out.push(inv);
        if (onInventory) onInventory(inv, out);
        const usable = inv.answer?.found && (inv.answer.rooms ?? []).some((r) => r.price_per_night > 0);
        if (!usable) {
          ctx.emit("warning", { message: `« ${candidate.name} » sans inventaire exploitable (fixtures) → substitution si possible` });
          for (const tier of tiers) {
            const next = (substitutes?.[tier] ?? []).find((c) => !usedNames.has(c.name));
            if (next) {
              usedNames.add(next.name);
              queue.push({ candidate: next, tiers: [tier] });
              break;
            }
          }
        }
      }
      return out;
    },
    probe: null, // pas de sonde hors ligne : l'extension passe directement aux candidats
  };
}

/**
 * Exécute le pipeline complet.
 * @param {object} args
 * @param {object} args.policy politique validée ; args.station fiche escale ; args.scenario scénario validé
 * @param {object} [args.avion] défaut A350-900
 * @param {Array} [args.rows] passagers (sinon générés : avion plein exact, seed du scénario)
 * @param {object|null} [args.inventaire] inventaire injecté (défaut : data/inventaire/{code}.json)
 * @param {Function} [args.emit] (type, data, extra) → void
 * @param {AbortSignal} [args.signal] annulation totale ; [args.extensionSignal] arrêt de l'extension seule (EX-EXT-4)
 * @param {object} [args.collect] collecteurs injectés (défaut : realCollect(client))
 */
/**
 * C4/C6 - consigne d'etalement des convocations au comptoir, calculee une fois par run.
 * Une heure `debut` saisie prime ; sinon l'heure de l'escale au moment du run, decalee de
 * `delai_min` (le temps que le plan soit valide et les bus commandes). Rend `null` quand
 * l'option est coupee ou que le fuseau ne donne pas d'heure : le plan sort alors sans
 * horaire, comme avant - aucun horaire n'est invente.
 *
 * @param {object} policy politique validee
 * @param {object|null} station fiche escale (pour le fuseau)
 * @param {Date} now horloge du run (injectee : testable)
 * @returns {object|null} consigne acceptee par allocate({presentation})
 */
export function consignePresentation(policy, station = null, now = new Date()) {
  const cfg = policy?.global?.presentation;
  if (!cfg?.enabled) return null;
  const tz = station?.timezone ?? null;
  let debut = cfg.debut;
  if (!debut) {
    const { heure } = stationClock(new Date(now.getTime() + cfg.delai_min * 60000), tz);
    if (!heure) return null; // fuseau inexploitable : pas d'horaire invente
    debut = heure;
  }
  return { debut, pas_minutes: cfg.pas_minutes, par_creneau: cfg.par_creneau, fenetre_minutes: cfg.fenetre_minutes, timezone: tz };
}

export async function runPipeline({
  client = null, policy, station, scenario, avion = DEFAULT_AVION,
  rows = null, dossiers = null, inventaire = undefined, ingestion: ingestionIn = null, preflight = null,
  emit = () => {}, signal = null, extensionSignal = null, collect = null, now = new Date(),
}) {
  // C4/C6 - consigne d'etalement des convocations, calculee UNE fois pour tout le run
  const presentation = consignePresentation(policy, station, now);
  // les avertissements émis pendant le run alimentent la section « Avertissements » du rapport
  const runWarnings = [];
  const emitRaw = emit;
  emit = (type, data, extra) => {
    if (type === "warning" && data?.message) runWarnings.push(data.message);
    return emitRaw(type, data, extra);
  };

  const runId = newRunId(now);
  const { checkin, checkout } = resolveDates(scenario, now, station?.timezone ?? null);
  const nights = scenario.nights;
  const groupId = `${station.code.toLowerCase()}-v2-${checkin}-${runId}`;

  /* C5 — BUDGET D'HORLOGE DU RUN.
   * Le moteur ne connaissait pas l'heure : ses seules bornes étaient les vagues, les
   * sessions et les dollars. L'échéance est calculée UNE seule fois, ici, sur l'horloge
   * MURALE (`now` peut être une date logique injectée par un test ou un rejeu), puis
   * propagée par `ctx` à la découverte, aux relevés et aux sondes — qui refusent tous de
   * lancer une session qui ne pourrait plus finir (`skipped_budget`). */
  const t0 = Date.now();
  const minutesMax = Number.isFinite(policy.extension?.max_minutes_per_run) ? policy.extension.max_minutes_per_run : null;
  const deadlineAt = minutesMax === null ? null : t0 + minutesMax * 60_000;
  const minutesUsed = () => (Date.now() - t0) / 60_000;
  const restantMs = () => (deadlineAt === null ? null : deadlineAt - Date.now());
  let echeanceAtteinte = false;
  /** L'opérateur doit lire « arrêté par l'échéance », jamais « épuisé » : ce sont deux
   * pannes opposées (manque de temps / manque d'hôtels) et deux décisions opposées. */
  const direEcheance = (ou) => {
    if (deadlineAt === null) return;
    const premier = !echeanceAtteinte;
    echeanceAtteinte = true;
    if (!premier) return;
    emit("deadline", {
      phase: ou,
      minutes_max: minutesMax,
      minutes_used: Math.round(minutesUsed() * 10) / 10,
      deadline_at: new Date(deadlineAt).toISOString(),
    });
    emit("warning", {
      message:
        `échéance du run atteinte pendant « ${ou} » (${minutesMax} min, policy.extension.max_minutes_per_run) — ` +
        `le run est arrêté par le TEMPS, pas par l'inventaire : ce qui manque au plan n'a pas été interrogé, ` +
        `c'est l'horloge qui a tranché. Ce qu'il restait d'hôtels et de budget n'est PAS affirmé ici : ` +
        `les bornes réelles (sessions, coût, vagues) sont au rapport.`,
    });
  };

  const ctx = { policy, station, scenario, checkin, checkout, groupId, emit, signal, deadlineAt };
  collect ??= realCollect(client);
  const aborted = () => signal?.aborted === true;

  emit("phase", {
    phase: "preparation", runId, station: station.code, checkin, checkout, nights,
    minutes_max: minutesMax, deadline_at: deadlineAt === null ? null : new Date(deadlineAt).toISOString(),
  });

  /* generation */
  emit("phase", { phase: "generation" });
  if (!dossiers && !rows) {
    const gen = generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" });
    rows = gen.rows;
    emit("log", { message: `liste générée : ${gen.stats.passagers} passagers (seed ${scenario.seed})` });
  }

  // Normalisation de la liste QUELLE QUE SOIT SA SOURCE (téléversée ou générée) :
  // les valeurs sont traduites, l'équipage et les non-embarqués sortent du plan
  // passagers. Idempotent sur une liste déjà canonique.
  let ingestion = ingestionIn;
  if (!dossiers && rows) {
    // l'appelant a déjà ingéré (CLI --in, téléversement UI) : on garde SON rapport,
    // qui porte les vraies traductions de valeurs ; sinon on normalise ici
    let normalized = rows;
    if (!ingestion) {
      const res = normalizePaxRows(rows);
      normalized = res.rows;
      ingestion = res.rapport;
    }
    const rapport = ingestion;
    const split = splitPaxRows(normalized);
    rows = split.pax;
    emit("log", {
      message: `liste passagers : ${rows.length} à loger sur ${rapport.lignes.lues} ligne(s)`,
      // compteurs seulement : aucun nom de groupe ni valeur nominative dans le flux
      ingestion: { ...rapport.compteurs, groupes: rapport.compteurs.groupes.length },
    });
    if (rapport.refus.length) emit("warning", { message: `${rapport.refus.length} ligne(s) passager illisibles écartées — voir le rapport d'ingestion` });
    if (split.equipage.length) emit("warning", { message: `${split.equipage.length} membre(s) d'équipage hors plan passagers : une chambre individuelle par personne, à traiter au desk` });
    if (split.exclus.length) emit("warning", { message: `${split.exclus.length} passager(s) non à loger (non embarqués, autonomes, déjà logés) : écartés du plan` });
  }

  /* besoins */
  emit("phase", { phase: "besoins" });
  /* HEURE DE L'ESCALE — sans elle, AUCUN budget de trajet n'est calculé et aucune
   * correspondance n'est protégée : `buildDossiers` partait sans ce troisième argument, et
   * la contrainte dure de distance n'existait donc pas au run. `maintenantLocal` est
   * l'horloge MURALE de l'escale (cadre de `heure_correspondance`), `maintenant` l'instant
   * absolu (cadre de `correspondance_utc`) : les deux sont passés, aucun repli ne joue. */
  const horlogeEscale = stationClock(now, station?.timezone ?? null);
  const maintenantLocal = horlogeEscale.heure ? `${horlogeEscale.date}T${horlogeEscale.heure}` : null;
  if (!maintenantLocal) {
    emit("warning", {
      message:
        `fuseau de l'escale ${station.code} inexploitable (${station?.timezone ?? "absent"}) — l'heure murale de ` +
        `l'escale n'a pas pu être établie : les budgets de trajet sont calculés sur l'instant seul`,
    });
  }
  dossiers ??= buildDossiers(rows, policy, { maintenant: now, maintenantLocal });
  // avertissements du calcul des budgets (politique incohérente, horaires illisibles,
  // horloge absente, refus de présumer l'âge d'un CHD) : ils s'affichent, ils ne se taisent pas
  for (const a of avertissementsDe(dossiers)) emit("warning", { message: `prise en charge : ${a.message}` });
  const needs = computeNeeds(dossiers);
  emit("log", { message: `${dossiers.length} dossiers`, needs });
  if (needs.total.contraints > 0) {
    emit("log", {
      message:
        `${needs.total.contraints} dossier(s) sous CONTRAINTE de temps de trajet (vol suivant connu)` +
        (needs.total.trajetMinContraint === null ? "" : `, le plus serré à ${needs.total.trajetMinContraint} min aller simple`) +
        ` — ${needs.parTrajet.contraint.chambres} chambre(s) concernée(s), ${needs.parTrajet.libre.chambres} sans contrainte`,
      trajet: {
        contraint: needs.parTrajet.contraint, libre: needs.parTrajet.libre, impossible: needs.parTrajet.impossible,
        paliers: needs.parTrajet.paliers.map((p) => ({ trajet_max_min: p.trajet_max_min, chambres: p.chambres, cumul: p.cumul.chambres })),
      },
    });
  }

  /* inventaire */
  emit("phase", { phase: "inventaire" });
  let inv = inventaire !== undefined ? inventaire : loadInventaire(station.code);
  const stale = isStale(inv, policy, now);
  emit("inventory_status", {
    station: station.code,
    updated_at: inv?.updated_at ?? null,
    hotels_count: inv?.hotels?.length ?? 0,
    stale,
    used: Boolean(inv?.hotels?.length),
  });

  /* discovery */
  /* COURONNES DU RUN — la fiche escale déclare des couronnes ; on n'en ouvre une que
   * lorsqu'elle sert. `couronnesOuvertes` retient celles qu'une session a réellement
   * fouillées, `couronneParHotel` retient, POUR TOUT LE RUN et en mémoire, le rang de la
   * passe qui a trouvé chaque hôtel — le schéma d'inventaire (`lib/inventaire.mjs`, hors
   * de ce lot) ne connaît pas encore le champ et le retire à la fusion. */
  const dispoCouronnes = couronnesRecherche(policy, station);
  const couronnesOuvertes = new Set();
  const couronneParHotel = new Map();
  if (!dispoCouronnes.exploitables && dispoCouronnes.declarees.length > 1) {
    emit("warning", { message: `couronnes de recherche : ${dispoCouronnes.raison}` });
  }
  /** Première couronne à ouvrir : la plus proche déclarée, quand elles sont exploitables. */
  const premiereCouronne = dispoCouronnes.exploitables ? (dispoCouronnes.couronnes[0] ?? null) : null;

  const decision = discoveryNeeded({
    inv, policy, station, needs: needs.parTier,
    // ADDITIF : la ventilation par couronne n'existe que si des budgets de trajet existent
    besoins: needs, couronnesOuvertes,
    force: scenario.force_discovery, now,
  });
  // C2 : la couverture indicative du vivier, dite en CHAMBRES, avant toute session payante
  if (decision.couverture) {
    emit("couverture", decision.couverture);
    if (!decision.couverture.suffisante) {
      emit("warning", {
        message:
          `vivier insuffisant AVANT le run : ${decision.couverture.indicatives} chambre(s) indicative(s) ` +
          `(${decision.couverture.relevees} relevée(s), ${decision.couverture.supposees} supposée(s)) sur ` +
          `${decision.couverture.hotels} hôtel(s), pour ${decision.couverture.demandees} demandée(s)`,
      });
    } else if (decision.couverture.suffisante_mesuree === false) {
      // « rien n'est estimé » : le vivier ne PARAÎT suffisant que parce que les hôtels sans
      // indice de capacité sont comptés à 9 chambres. Sauter la découverte sur ce compte-là
      // est une décision prise sur une hypothèse : elle doit être dite, pas supposée lue.
      emit("warning", {
        message:
          `suffisance du vivier NON MESURÉE : ${decision.couverture.relevees} chambre(s) réellement relevée(s) ` +
          `pour ${decision.couverture.demandees} demandée(s) — le compte ne tient que par les ` +
          `${decision.couverture.supposees} chambre(s) SUPPOSÉE(S) (9 par hôtel sans indice de capacité : hypothèse ` +
          `de cadrage, jamais une mesure). Aucune découverte n'est lancée ; cocher « Forcer la découverte » pour ` +
          `chercher au-delà de l'inventaire.`,
      });
    }
  }
  // COURONNES — la ventilation qui dit s'il faut chercher PLUS PRÈS ou PLUS LOIN
  if (decision.couverture?.parCouronne) {
    emit("couronnes", {
      source: decision.couverture.couronnes_source,
      exploitables: decision.couverture.couronnes_exploitables,
      lignes: decision.couverture.parCouronne,
      a_ouvrir: decision.couronneAOuvrir?.rang ?? null,
    });
    // la DERNIÈRE couronne est exclue : un manque qui n'apparaît que là est la fin du
    // vivier, déjà dite par l'avertissement de volume — pas un manque de proximité
    const captif = decision.couverture.parCouronne.find((l) => l.manque_captif > 0 && !l.derniere);
    if (captif) {
      emit("warning", {
        message:
          `il manque ${captif.manque_captif} chambre(s) PROCHES : ${captif.captives} chambre(s) ne peuvent pas ` +
          `dépasser ${captif.trajet_min_declare} min de trajet DÉCLARÉES (couronne ${captif.rang}), et les hôtels ` +
          `connus à cette portée n'en offrent que ${captif.cumul_indicatives} — élargir la recherche ne comblera ` +
          `PAS ce manque-là, seuls des hôtels plus proches le peuvent`,
      });
    }
  }
  // C1/C3 : la passe PMR n'a de sens que s'il y a des dossiers PMR ; quand il y en a,
  // c'est l'overlay de politique qui tranche (`pmr: null`), jamais ce code.
  // `parCritere.pmr` et non `parFile.pmr` : un PMR servi en file « correspondance serrée »
  // reste un PMR, et il lui faut toujours une chambre accessible. La lecture par file en
  // perdait autant que la politique de prise en charge range de PMR ailleurs.
  const pmrDossiers = needs.parCritere?.pmr?.dossiers ?? needs.parFile?.pmr?.dossiers ?? 0;
  const discoveryOptions = { needs: needs.parTier, pmr: pmrDossiers > 0 ? null : false };
  /** Fusion EN MÉMOIRE des candidats d'une découverte (EX-DIS-2) : les ids sont d'abord
   * alignés sur l'inventaire existant, sinon un hôtel déjà connu sous un autre slug est
   * dupliqué et relevé deux fois. @returns {number} entrées fusionnées */
  const fusionnerCandidats = (candidats, couronne = null) => {
    const brutes = (candidats ?? []).map((c) => candidateToEntry(c, { couronne }));
    if (!brutes.length) return 0;
    const entries = reconcileIds(inv, brutes, {
      onDrop: (e) => emit("log", { message: `découverte : « ${e.name} » déjà présent dans le lot sous un autre nom — doublon écarté` }),
    });
    if (!entries.length) return 0;
    /* COURONNE D'ORIGINE — un hôtel déjà connu qui reparaît dans une couronne PLUS
     * LOINTAINE garde la plus PROCHE : ce n'est pas l'hôtel qui s'est éloigné, c'est le
     * rayon de la recherche qui a grandi. Conservée en mémoire pour tout le run parce que
     * la fusion d'inventaire, elle, ne sait pas encore garder ce champ. */
    for (const e of entries) {
      if (!e.couronne) continue;
      couronneParHotel.set(e.id, couronnePlusProche(couronneParHotel.get(e.id) ?? null, e.couronne));
    }
    inv = mergeInventaire(inv, { station: station.code, updated_at: null, reference: null, hotels: entries });
    return entries.length;
  };
  let discoveryResult = null;
  if (aborted()) return finishCancelled();
  if (decision.run && collect.discovery) {
    // la découverte initiale ouvre la couronne la PLUS PROCHE : élargir est un dernier
    // recours, décidé vague par vague sur le besoin réel, pas un réflexe de départ
    const couronneInitiale = decision.couronneAOuvrir
      ? dispoCouronnes.couronnes.find((c) => c.rang === decision.couronneAOuvrir.rang) ?? premiereCouronne
      : premiereCouronne;
    emit("phase", { phase: "discovery", reason: decision.reason, couronne: couronneInitiale?.rang ?? null });
    discoveryResult = await collect.discovery(ctx, { ...discoveryOptions, couronne: couronneInitiale });
    if (discoveryResult?.status === "skipped_budget") direEcheance("découverte");
    /* Une couronne est OUVERTE dès qu'une session l'a fouillée, même si elle n'a rien
     * rapporté : « rien trouvé ici » est un résultat, et le relancer coûterait une seconde
     * session pour la même réponse. Seule une couronne qui a RÉELLEMENT filtré est marquée
     * (`discoveryResult.couronne`) : une couronne demandée mais non appliquée ne l'est pas. */
    if (discoveryResult?.couronne) couronnesOuvertes.add(discoveryResult.couronne.rang);
    fusionnerCandidats(discoveryResult?.candidates, discoveryResult?.couronne ?? null);
  } else {
    if (decision.run) emit("warning", { message: `découverte requise (${decision.reason}) mais indisponible dans ce mode — repli inventaire + hôtels de secours` });
    emit("phase", { phase: "discovery_skipped", reason: decision.reason });
  }

  /* candidats et sélection étage B (ordre EX-REL-3) */
  let candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });

  // Pré-vol HTTP GRATUIT (aucun agent, hors INV-8) : une fiche morte coûterait une
  // session payante puis une substitution en cascade. Seuls 404/410 et une
  // redirection vers un autre établissement écartent un candidat ; un blocage
  // anti-robot reste « indéterminé » et la fiche est conservée.
  if (typeof preflight === "function" && candidates.length) {
    emit("phase", { phase: "prevol", candidats: candidates.length });
    try {
      const res = (await preflight(candidates.map((c) => ({ id: c.id, name: c.name, url: c.url })))) ?? [];
      // Seul 404/410 est un verdict ferme. Une « redirection » peut etre une fusion de
      // fiches, un mur de consentement ou une page traduite : on retrograde, on n'ecarte pas.
      const ecartes = new Map();
      for (const r of res) if (r.verdict === "morte") ecartes.set(r.id ?? r.url, r);
      const redirigees = res.filter((r) => r.verdict === "redirigee");
      // PLANCHER : un filet qui vide l'inventaire est en panne, pas efficace. Au-dela du
      // tiers des candidats, on ne filtre rien et on laisse l'operateur trancher.
      const tropNombreux = ecartes.size > Math.floor(candidates.length / 3);
      emit("preflight", {
        verifies: res.length,
        ecartes: [...ecartes.values()].map((r) => ({ name: r.name, verdict: r.verdict, detail: r.detail })),
        redirigees: redirigees.map((r) => ({ name: r.name, detail: r.detail })),
        indeterminees: res.filter((r) => r.verdict === "indeterminee").length,
        applique: !tropNombreux,
      });
      for (const r of redirigees) {
        emit("warning", { message: `fiche a verifier : « ${r.name} » — ${r.detail} (conservee, relevee en dernier)` });
      }
      if (tropNombreux) {
        emit("warning", {
          message: `pre-vol ignore : ${ecartes.size} fiches sur ${candidates.length} declarees mortes — au-dela du tiers, c'est le controle qui est suspect, pas l'inventaire. Aucun candidat n'est ecarte.`,
        });
      } else {
        for (const r of ecartes.values()) {
          emit("warning", { message: `fiche ecartee avant tout agent : « ${r.name} » — ${r.detail}` });
        }
        if (ecartes.size) candidates = candidates.filter((c) => !ecartes.has(c.id ?? c.url));
        if (redirigees.length) {
          const suspects = new Set(redirigees.map((r) => r.id ?? r.url));
          candidates = [...candidates.filter((c) => !suspects.has(c.id ?? c.url)), ...candidates.filter((c) => suspects.has(c.id ?? c.url))];
        }
      }
    } catch (err) {
      emit("warning", { message: `pré-vol des fiches impossible (${String(err?.message ?? err)}) — les relevés partent sans ce filet` });
    }
  }
  const maxB = policy.global.discovery.max_hotels_stage_b;
  const selection = candidates.slice(0, maxB).map((c) => ({ candidate: c, tiers: c.tiers }));
  const rest = candidates.slice(maxB);
  const substitutes = { J: [], W: [], Y: [] };
  for (const c of rest) for (const tier of c.tiers) substitutes[tier].push(c);

  /* relevés (allocation incrémentale à chaque relevé, EX-ALL-1) */
  emit("phase", { phase: "releves", selection: selection.map((s) => s.candidate.name) });
  const inventories = [];
  const surveyedKeys = new Set();
  let alloc = allocate({ dossiers, inventories, policy, station, nights, presentation, provisoire: true });
  const emitPlan = (a, provisoire) => {
    for (const row of a.plan) emit("plan_row", { ...row, provisoire });
    emit("metrics", { ok: a.summary.ok, escalade: a.summary.escalade });
  };
  const onInventory = (rec) => {
    /* COURONNE D'ORIGINE — reposée ICI sur l'enregistrement de relevé, parce que c'est lui
     * que `allocate()` lit (`inv.couronne`). Elle vient de la passe de recherche qui a
     * trouvé l'hôtel : c'est la source la plus fiable dont dispose l'allocation, devant
     * `distance_km` — nulle ou fausse sur 6 des 9 hôtels de l'inventaire BKK. Un hôtel
     * jamais vu par une passe n'en reçoit AUCUNE : l'allocation le rangera sur sa distance,
     * ou par sa règle de prudence. Rien n'est marqué qui n'ait été filtré. */
    const key = rec.hotelKey ?? rec.hotel;
    const anneau = couronnePlusProche(couronneParHotel.get(key) ?? null, rec.couronne ?? null);
    if (anneau) rec.couronne = anneau;
    /* DISTANCE DÉJÀ MESURÉE — l'entrée d'inventaire porte parfois une distance relevée un
     * autre jour, avec sa référence (`distance_ref`) ; le relevé du jour, lui, n'affiche
     * pas toujours de distance. Sans ce report, tout hôtel du fichier d'inventaire
     * ressortait « couronne indéterminée » et retombait sur la règle de prudence, alors que
     * sa distance était connue. On ne recopie QUE la mesure et SA référence : `allocate`
     * garde ensuite tous ses garde-fous (un 0 sans référence reste « non mesuré », une
     * référence différente de celle de la fiche reste non comparable). Rien n'est inventé. */
    if (rec.distance_km === undefined || rec.distance_km === null) {
      const entree = (inv?.hotels ?? []).find((h) => h.id === key) ?? null;
      if (entree && entree.distance_km !== null && entree.distance_km !== undefined && entree.distance_ref) {
        rec.distance_km = entree.distance_km;
        rec.distance_ref = entree.distance_ref;
      }
    }
    inventories.push(rec);
    // C5 : un relevé `skipped_budget` n'a jamais été lancé — ce n'est pas un hôtel
    // « déjà relevé », et le marquer ainsi le retirerait des vagues suivantes pour rien
    if (rec.status !== "skipped_budget") surveyedKeys.add(key);
    alloc = allocate({ dossiers, inventories, policy, station, nights, presentation, provisoire: true });
    emitPlan(alloc, true);
  };
  if (aborted()) return finishCancelled();
  await collect.releves(ctx, selection, substitutes, onInventory);
  const nonLances = new Set(inventories.filter((r) => r.status === "skipped_budget").map((r) => r.hotelKey ?? r.hotel));
  if (nonLances.size) direEcheance("relevés étage B");
  for (const s of selection) {
    const key = s.candidate.id ?? slugify(s.candidate.name);
    if (!nonLances.has(key)) surveyedKeys.add(key);
  }

  /* allocation (avant extension) */
  emit("phase", { phase: "allocation" });
  alloc = allocate({ dossiers, inventories, policy, station, nights, presentation, provisoire: true });

  /* extension (CDC §6.4) */
  let wave = 1;
  let sessionsUsed = 0;
  // le coût des sessions HORS RELEVÉS (sondes, redécouvertes) est suivi à part : il était
  // écrasé à chaque vague par le total des relevés, donc la borne `max_cost_usd_per_run`
  // ne le voyait jamais et le bandeau affichait deux chiffres contradictoires
  // `null` = au moins une session dont le coût n'a jamais été rapporté : le total du run
  // devient « non mesuré » et le reste (on ne ré-additionne pas un budget déjà inconnu).
  let horsRelevesCostUsd = 0;
  const ajouterHorsReleve = (c) => {
    horsRelevesCostUsd = horsRelevesCostUsd === null || c === null ? null : horsRelevesCostUsd + (c ?? 0);
  };
  const concurrence = resolveConcurrency(policy);
  // la découverte INITIALE est une session payante comme une autre : son coût était exclu
  // du total, donc de la borne `max_cost_usd_per_run` et du bandeau de coût du run.
  // (`tenterRedecouverte` n'écrase pas `discoveryResult` : aucun double comptage.)
  // Un seul coût non rapporté rend le total du run INDÉTERMINÉ : `null` remonte jusqu'au
  // bandeau, au rapport et aux bornes, au lieu d'un « 0 $ » rassurant qui n'est pas mesuré.
  // `undefined` (session jamais lancée, chemin gratuit) vaut bien 0 : rien n'a été facturé.
  const totalCost = () => {
    let somme = horsRelevesCostUsd;
    if (somme === null) return null;
    for (const c of [discoveryResult?.costUsd, ...inventories.map((r) => r.costUsd)]) {
      if (c === null) return null;
      somme += c ?? 0;
    }
    return somme;
  };
  let costUsd = totalCost();
  /** Motif d'arrêt budgétaire, ou null : un coût non mesuré n'est pas un budget disponible. */
  const budgetHorsControle = () =>
    costUsd === null ? "coût des sessions NON MESURÉ par la plateforme — budget non contrôlable" : null;
  const probedKeys = new Set();
  /** Tentatives de sonde RÉELLEMENT lancées par hôtel (le retry est borné). */
  const probeAttempts = new Map();
  const PROBE_TENTATIVES_MAX = 2;
  /** C2 — nombre de redécouvertes élargies autorisées dans un run (borne anti-boucle). */
  const REDECOUVERTES_MAX = 2;
  let redecouvertes = 0;
  let extensionStopReason = null;

  /**
   * COURONNES — la ventilation du moment : elle est refaite à chaque vague, sur le vivier
   * et l'allocation COURANTS, parce que chaque relevé la change. `elargir` respecte
   * `prise_en_charge.elargir_si_insuffisant` : coupé, aucune couronne nouvelle ne s'ouvre.
   */
  const elargirAutorise = policy.global?.prise_en_charge?.elargir_si_insuffisant !== false;
  const ventilationCourante = () =>
    discoveryNeeded({
      inv, policy, station, needs: needs.parTier, besoins: needs,
      couronnesOuvertes, force: false, now,
    });

  /**
   * C2 — avant de sortir « épuisé » avec des passagers non logés et du budget intact :
   * relancer UNE découverte élargie et reprendre les vagues. Sous réserve des quatre
   * bornes — sessions, coût, vagues et ÉCHÉANCE — et d'un plafond de redécouvertes.
   *
   * COURONNES — on n'élargit plus « ×2 puis ×3 le rayon », un facteur dont personne ne
   * sait ce qu'il vaut en minutes : on ouvre la COURONNE SUIVANTE déclarée par
   * l'exploitation, et seulement si elle apporte quelque chose à quelqu'un. Une couronne
   * lointaine n'aide PAS un dossier au budget de trajet court : dépenser une session pour
   * des chambres que personne ne pourra prendre est un gaspillage, et le dire vaut mieux
   * que le faire.
   * @returns {Promise<boolean>} true si le vivier s'est élargi et que la boucle reprend
   */
  async function tenterRedecouverte(plan) {
    const manques = plan.manques ?? {};
    const refus = (pourquoi) => {
      emit("warning", { message: `redécouverte non lancée (${pourquoi}) — le run sort « épuisé » avec des manques : ${Object.entries(manques).map(([t, n]) => `${t}: ${n} ch.`).join(", ")}` });
      return false;
    };
    if (typeof collect.discovery !== "function") return refus("découverte indisponible dans ce mode");
    if (redecouvertes >= REDECOUVERTES_MAX) return refus(`plafond de redécouvertes atteint (${REDECOUVERTES_MAX})`);
    const ext = policy.extension;
    if (sessionsUsed >= ext.max_sessions_per_run) return refus(`borne max_sessions_per_run (${ext.max_sessions_per_run})`);
    if (budgetHorsControle()) return refus(budgetHorsControle());
    if (costUsd >= ext.max_cost_usd_per_run) return refus(`borne max_cost_usd_per_run (${ext.max_cost_usd_per_run} $)`);
    if (wave > ext.max_waves) return refus(`borne max_waves (${ext.max_waves})`);
    const reste = restantMs();
    if (reste !== null && reste < MIN_DEMARRAGE_MS) {
      direEcheance("redécouverte");
      return refus("échéance du run atteinte");
    }

    /* QUELLE COURONNE OUVRIR, ET FAUT-IL EN OUVRIR UNE ? */
    let couronneAOuvrir = null;
    if (dispoCouronnes.exploitables && dispoCouronnes.couronnes.length > 1) {
      if (!elargirAutorise) {
        return refus("« élargir si insuffisant » est coupé dans la politique de prise en charge : aucune couronne plus lointaine n'est ouverte");
      }
      const v = ventilationCourante();
      const cible = v.couronneAOuvrir;
      if (v.couverture.parCouronne && !cible) {
        // le manque existe, mais AUCUNE couronne ne peut le combler : ce n'est pas un
        // manque de chambres, c'est un manque de TEMPS DE TRAJET. Payer une session de
        // plus ne logerait personne — et l'opérateur doit lire la vraie cause.
        const captif = v.couverture.parCouronne.find((l) => l.manque_captif > 0 && !l.derniere);
        return refus(
          captif
            ? `aucune couronne à ouvrir : il manque ${captif.manque_captif} chambre(s) à MOINS de ` +
              `${captif.trajet_min_declare} min de trajet déclarées (couronne ${captif.rang}) — une couronne plus ` +
              `lointaine ne logerait aucun de ces dossiers`
            : "aucune couronne à ouvrir : élargir n'apporterait de chambre à aucun dossier encore non logé",
        );
      }
      couronneAOuvrir = cible ? dispoCouronnes.couronnes.find((c) => c.rang === cible.rang) ?? null : null;
      if (couronneAOuvrir && couronnesOuvertes.has(couronneAOuvrir.rang)) couronneAOuvrir = null;
      if (!couronneAOuvrir) {
        const suivante = dispoCouronnes.couronnes.find((c) => !couronnesOuvertes.has(c.rang)) ?? null;
        if (!suivante) return refus(`toutes les couronnes déclarées (${dispoCouronnes.couronnes.map((c) => c.rang).join(", ")}) ont déjà été ouvertes`);
        couronneAOuvrir = suivante;
      }
    }

    redecouvertes += 1;
    /* Sans couronnes exploitables (EX-STA-2, escale à couronne unique), on retombe sur le
     * levier d'avant : un facteur de rayon. Il est moins bon — personne ne sait ce qu'il
     * vaut en minutes — mais c'est le seul qui reste, et `elargirRecherche` le nomme. */
    const elargissement = couronneAOuvrir
      ? { couronne: couronneAOuvrir, sansFiltrePrix: true, candidatsMax: true }
      : { rayonFacteur: 1 + redecouvertes, sansFiltrePrix: true, candidatsMax: true };
    const avant = candidates.length;
    emit("phase", {
      phase: "rediscovery", tentative: redecouvertes, manques, elargissement,
      couronne: couronneAOuvrir?.rang ?? null,
      couronne_trajet_min_declare: couronneAOuvrir?.trajet_min ?? null,
    });
    if (couronneAOuvrir) {
      emit("log", {
        message:
          `ouverture de la couronne ${couronneAOuvrir.rang} : recherche ≤ ${couronneAOuvrir.rayon_m} m, ` +
          `${couronneAOuvrir.trajet_min} min de trajet DÉCLARÉES en ${couronneAOuvrir.mode} ` +
          `(déclaration d'exploitation, jamais mesurée)`,
      });
    }
    let res = null;
    try {
      res = await collect.discovery(ctx, { ...discoveryOptions, elargissement });
    } catch (err) {
      emit("warning", { message: `redécouverte ${redecouvertes} en échec (${err?.message ?? err}) — le run sort avec les manques en escalade` });
      return false;
    }
    if (res?.status === "skipped_budget") {
      direEcheance("redécouverte");
      return false;
    }
    sessionsUsed += 1;
    ajouterHorsReleve(res?.costUsd);
    costUsd = totalCost();
    const ouverte = res?.couronne ?? null;
    if (ouverte) couronnesOuvertes.add(ouverte.rang);
    else if (couronneAOuvrir) {
      // la couronne était demandée mais n'a pas filtré : ne pas la marquer ouverte, sinon
      // le run croirait avoir fouillé une zone qu'il n'a pas fouillée
      emit("warning", {
        message: `couronne ${couronneAOuvrir.rang} demandée mais NON appliquée à la recherche — les candidats rendus ne portent aucun rang de couronne, leur distance sera jugée au relevé`,
      });
    }
    const fusionnees = fusionnerCandidats(res?.candidates, ouverte);
    candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });
    const neufs = candidates.filter((c) => !surveyedKeys.has(c.id)).length;
    emit("log", {
      message:
        `redécouverte ${redecouvertes}${ouverte ? ` (couronne ${ouverte.rang}, ${ouverte.trajet_min} min déclarées)` : ""} : ` +
        `${res?.candidates?.length ?? 0} candidat(s) rendus, ${fusionnees} fiche(s) fusionnée(s), ` +
        `vivier ${avant} → ${candidates.length} candidat(s) dont ${neufs} non encore relevé(s)`,
      rediscovery: {
        tentative: redecouvertes, candidats: res?.candidates?.length ?? 0, fusionnees,
        vivier_avant: avant, vivier_apres: candidates.length, neufs,
        // CE QUE LA COURONNE A RAPPORTÉ : le chiffre qui justifie la session dépensée
        couronne: ouverte?.rang ?? null, couronne_trajet_min_declare: ouverte?.trajet_min ?? null,
      },
    });
    if (!neufs) {
      emit("warning", {
        message:
          `redécouverte ${redecouvertes}${ouverte ? ` (couronne ${ouverte.rang})` : ""} sans apport : aucun hôtel ` +
          `nouveau à relever — le run sort « épuisé »`,
      });
      return false;
    }
    return true;
  }

  /** Dit UNE fois que le manque n'est pas un manque de chambres, mais de temps de trajet. */
  let trajetDit = false;
  for (;;) {
    if (aborted()) return finishCancelled();
    // COURONNES — la ventilation du moment pilote l'ordre des sondes et des relevés :
    // une sonde sur un hôtel PROCHE débloque des dossiers que personne d'autre ne peut
    // servir. Recalculée à chaque vague : chaque relevé la change.
    const ventilation = needs.total.contraints > 0 ? ventilationCourante() : null;
    const plan = planExtension({
      gaps: alloc.gaps, inventories, candidates, surveyedKeys, probedKeys,
      policy, station, wave, sessionsUsed, costUsd,
      // C5 : l'horloge est la QUATRIÈME borne, testée au même rang que les trois autres
      minutesUsed: minutesUsed(),
      allowProbes: typeof collect.probe === "function", // hors ligne : pas de sonde possible
      parCouronne: ventilation?.couverture?.parCouronne ?? null,
    });
    const gapsList = Object.entries(alloc.gaps.chambresManquantes ?? {}).map(([tier, n]) => ({ tier, rooms_missing: n }));
    /* Un manque « temps de trajet » N'EST PAS un manque de chambres : relever d'autres
     * hôtels ne logera pas ces dossiers si les chambres relevées sont hors d'atteinte.
     * L'extension continue (les autres manques sont réels), mais l'opérateur doit lire la
     * vraie cause AVANT de voir des sessions se dépenser. */
    if (!trajetDit && alloc.summary?.escaladesTempsTrajet > 0) {
      trajetDit = true;
      emit("warning", {
        message:
          `${alloc.summary.escaladesTempsTrajet} dossier(s) escaladés faute de TEMPS DE TRAJET, et non de chambres : ` +
          `aucune chambre du vivier n'est assez PROCHE pour leur vol suivant. Relever d'autres hôtels, ou ouvrir une ` +
          `couronne plus lointaine, ne les logera pas — il faut des hôtels plus proches, ou un repos côté piste.`,
      });
    }
    emit("extension", {
      wave, reason: plan.reason, gaps: gapsList,
      planned: { probes: plan.probes.length, surveys: plan.surveys.length },
      limits: plan.limits,
      // ce que cette vague va chercher, et OÙ : la couronne de chaque session engagée
      couronnes: {
        ouvertes: [...couronnesOuvertes],
        sondes: plan.probes.map((p) => ({ hotel: p.hotelKey, couronne: p.couronne ?? null, chambres_captives_liberables: p.valeur_captive ?? 0 })),
        releves: plan.surveys.map((s) => ({ hotel: s.id, couronne: s.couronne_jugee ?? null, chambres_captives_manquantes: s.valeur_captive ?? 0 })),
      },
    });
    if (plan.stop) {
      // C2 : « épuisé » avec des manques et du budget intact n'est pas une conclusion,
      // c'est un signal — on va chercher des hôtels plus loin avant de rendre les armes.
      // Un arrêt demandé par l'opérateur reste prioritaire : on ne paie rien après un stop.
      if (
        plan.exhausted && plan.rediscover && gapsList.length &&
        !extensionSignal?.aborted && !aborted() &&
        (await tenterRedecouverte(plan))
      ) continue;
      extensionStopReason = plan.reason;
      if (/max_minutes_per_run/.test(plan.reason)) direEcheance("extension");
      if (gapsList.length) {
        emit("warning", { message: `extension arrêtée (${plan.reason}) — escalade DESK : ${gapsList.map((g) => `${g.tier}: ${g.rooms_missing} ch.`).join(", ")}` });
      }
      break;
    }
    if (extensionSignal?.aborted) {
      extensionStopReason = "interrompue par l'utilisateur";
      emit("warning", { message: "extension interrompue par l'utilisateur — le plan reste en l'état (escalade chiffrée)" });
      break;
    }
    emit("phase", { phase: "extension", wave });

    // Sondes EN PARALLÈLE (elles étaient strictement séquentielles : 5 sondes en file
    // indienne pendant que les créneaux de concurrence dormaient, ~7 min de séance).
    const probesAJouer = plan.probes.filter(() => !aborted() && !extensionSignal?.aborted);
    if (probesAJouer.length) {
      const answers = await runPool(probesAJouer, (probe) => collect.probe(ctx, probe), concurrence);
      let applique = false;
      answers.forEach((answer, i) => {
        const probe = probesAJouer[i];
        const key = probe.hotelKey;
        const nom = probe.name ?? key;
        // une sonde NON LANCÉE (pas d'URL, budget d'horloge, lancement refusé) ne consomme
        // ni session ni dollar : `started === false` est la seule marque qui vaille
        const lancee = !(answer && answer.started === false);
        if (lancee) sessionsUsed += 1;
        ajouterHorsReleve(answer?.costUsd);
        const tentatives = (probeAttempts.get(key) ?? 0) + (lancee ? 1 : 0);
        probeAttempts.set(key, tentatives);

        if (answer?.found) {
          // mesure obtenue : l'hôtel est sondé, et il l'est définitivement
          probedKeys.add(key);
          const updated = applyProbeResult(inventories, key, answer, { emit, policy });
          inventories.length = 0;
          inventories.push(...updated);
          applique = true;
          return;
        }
        // ÉCHEC — `probedKeys` était alimenté AVANT de connaître le résultat : un hôtel
        // dont la sonde échouait était retiré des vagues suivantes sans avoir rien mesuré,
        // et son stock plafonné restait inaccessible pour tout le reste du run.
        if (answer?.status === "skipped_budget") {
          direEcheance("sonde");
          return; // ni sondé, ni banni : c'est le temps qui manque, pas l'hôtel
        }
        if (answer?.definitif === true || tentatives >= PROBE_TENTATIVES_MAX) {
          probedKeys.add(key);
          emit("warning", {
            message:
              `sonde de « ${nom} » sans résultat après ${tentatives} tentative(s)` +
              `${answer?.status ? ` (${answer.status})` : ""} — écarté des sondes suivantes, son stock reste plafonné à l'affichage`,
          });
          return;
        }
        emit("warning", {
          message: `sonde de « ${nom} » sans résultat${answer?.status ? ` (${answer.status})` : ""} — nouvelle tentative prévue à la vague suivante`,
        });
      });
      costUsd = totalCost();
      if (applique) {
        alloc = allocate({ dossiers, inventories, policy, station, nights, presentation, provisoire: true });
        emitPlan(alloc, true);
      }
    }
    if (plan.surveys.length && !extensionSignal?.aborted) {
      const before = inventories.length;
      await collect.releves(ctx, plan.surveys.map((c) => ({ candidate: c, tiers: c.tiers })), {}, onInventory);
      // C5 : un relevé `skipped_budget` est un relevé JAMAIS lancé — aucune session, aucun
      // coût, et l'hôtel reste à relever ; le compter aurait consommé une borne pour rien
      const nouveaux = inventories.slice(before);
      const nonLancesN = nouveaux.filter((r) => r.status === "skipped_budget");
      const jamaisLances = new Set(nonLancesN.map((r) => r.hotelKey ?? r.hotel));
      for (const c of plan.surveys) if (!jamaisLances.has(c.id)) surveyedKeys.add(c.id);
      sessionsUsed += nouveaux.length - nonLancesN.length;
      if (nonLancesN.length) direEcheance("relevés d'extension");
      costUsd = totalCost();
    }
    wave += 1;
  }

  /* sorties */
  emit("phase", { phase: "sorties" });
  alloc = allocate({ dossiers, inventories, policy, station, nights, presentation, provisoire: false });
  emitPlan(alloc, false);
  const cost = computeCost(alloc.plan, policy, scenario, { avion, station });
  emit("cost", cost);
  // `dossiers` porte la correspondance (aucune ligne de plan ne la porte) : sans lui,
  // `{{retour_texte}}` reste vide et le message passager NE DIT PAS son heure limite de
  // retour à l'aéroport, alors que la fiche papier remise au même passager l'imprime.
  // Deux documents d'un même run doivent dire la même chose. INV-5 n'est pas en cause :
  // les messages sont des fichiers écrits sur le poste, aucun agent ne les voit.
  const messages = buildMessages(alloc.plan, station, scenario, policy, { now, dossiers });
  emit("messages_ready", {
    count_fr: messages.filter((m) => m.lang === "fr").length,
    count_en: messages.filter((m) => m.lang === "en").length,
    sample: messages.slice(0, 3).map((m) => ({ pnr: m.pnr, lang: m.lang, subject: m.subject })),
  });
  /* C3 — les fiches d'enregistrement par passager, construites ICI, avant le rapport.
     Elles étaient jusqu'ici refaites par chaque appelant APRÈS `buildRapportMd` : le
     rapport ne les voyait jamais et imprimait « aucune fiche n'est jointe » alors que
     le run venait d'écrire `fiches-<runId>.csv` et `.html`. Le rapport mentait sur le
     seul livrable qui porte C3. Les construire dans le pipeline est le point unique :
     le rapport les compte, et les deux appelants (CLI, serveur) les reprennent telles
     quelles via `outputs.fichesCsv` / `outputs.fichesHtml`, contrat qu'ils attendaient déjà.

     `rows` est NOMINATIF : il ne sort pas d'ici vers un agent (INV-5), il n'alimente que
     des fichiers écrits sur le disque du poste et purgés selon `policy.retention`.

     L'échec est tenu : une exception ici ferait perdre les six autres livrables d'un run
     PAYANT déjà consommé. On renonce aux fiches en le DISANT — le rapport dira alors, à
     juste titre, qu'il n'en a pas reçu. */
  let fiches = null;
  try {
    fiches = buildFichesOutputs(alloc, {
      rows, dossiers, policy, station, checkin, checkout, nights, runId,
      vol: "", // aucun numéro de vol n'entre dans le pipeline : rien n'est inventé
      cost,
    });
  } catch (err) {
    fiches = null;
    emit("warning", {
      message:
        `fiches d'enregistrement (C3) NON produites (${String(err?.message ?? err)}) — ` +
        `les autres livrables du run sont intacts, les formulaires restent à établir au comptoir`,
    });
  }
  const outputs = {
    // `cost` renseigne les quatre colonnes C7 (carte prépayée). Sans lui elles restaient
    // VIDES sur 100 % des lignes, y compris celles à `mode_reglement=carte_prepayee` : une
    // cellule vide se lit « pas de carte à émettre », et `carte_incomplet` ne valait jamais « oui ».
    planCsv: buildPlanCsv(alloc.plan, { cost }),
    rapportMd: buildRapportMd(alloc, inventories, {
      station, policy, checkin, checkout, nights, runId, cost, warnings: runWarnings, ingestion, fiches,
      extension: {
        waves: wave - 1, probes: probedKeys.size, surveys: Math.max(0, surveyedKeys.size - selection.length),
        rediscoveries: redecouvertes, stop: extensionStopReason, deadline_hit: echeanceAtteinte,
        limits: {
          sessions_used: sessionsUsed, sessions_max: policy.extension.max_sessions_per_run,
          cost_usd: costUsd, cost_max: policy.extension.max_cost_usd_per_run,
          // C5 : l'horloge du run, quatrième borne, visible au rapport comme les autres
          minutes_used: Math.round(minutesUsed() * 10) / 10, minutes_max: minutesMax,
        },
      },
    }),
    messagesCsv: buildMessagesCsv(messages),
    // idem pour la liste d'appel, plus les coordonnées d'hôtel que portent les relevés
    roomingCsv: buildRoomingCsv(alloc.plan, { inventories, entrees: inv?.hotels ?? [], cost }),
    // C3 — vides seulement si la construction a échoué ci-dessus, et l'avertissement le dit
    fichesCsv: fiches?.csv ?? null,
    fichesHtml: fiches?.html ?? null,
  };
  /* Émis APRÈS le rapport, volontairement : le rapport rend déjà ces avertissements dans
     sa section C3, à côté du chiffre qu'ils expliquent. Les verser aussi dans
     `runWarnings` les imprimerait deux fois. Ici, ils atteignent l'écran et l'UI. */
  for (const a of fiches?.avertissements ?? []) emit("warning", { message: `fiches : ${a}` });
  emit("done", {
    runId, ok: alloc.summary.ok, escalade: alloc.summary.escalade,
    sessions_used: sessionsUsed, cost_usd: costUsd, extension_stop: extensionStopReason,
    minutes_used: Math.round(minutesUsed() * 10) / 10, minutes_max: minutesMax,
    deadline_hit: echeanceAtteinte, rediscoveries: redecouvertes,
  });

  return {
    runId, checkin, checkout, groupId, dossiers, needs, decision, discoveryResult,
    candidates, selection, inventories, alloc, cost, messages, outputs, fiches,
    sessionsUsed, costUsd, extensionWaves: wave - 1, extensionStopReason, cancelled: false,
    // C5/C2 — additifs : ce que l'horloge et la redécouverte ont fait de ce run
    deadlineAt, minutesUsed: Math.round(minutesUsed() * 10) / 10, minutesMax, deadlineHit: echeanceAtteinte,
    rediscoveries: redecouvertes,
  };

  function finishCancelled() {
    emit("done", { runId, cancelled: true });
    return { runId, checkin, checkout, groupId, cancelled: true, dossiers, inventories: [], alloc: null };
  }
}
