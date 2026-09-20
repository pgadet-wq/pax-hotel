/**
 * Gestionnaire de run singleton (CDC §9, INV-10) : UN SEUL run à la fois (409
 * sinon), état agrégé re-rendable (snapshot pour `GET /api/state` et le flux
 * SSE), annulation totale et annulation d'extension seule (EX-EXT-4),
 * `collect` injectable (simulation phase 4, sessions réelles phase 5).
 *
 * Le run vit dans le process serveur : l'onglet peut être fermé et rouvert,
 * le snapshot restitue tout (EX-UI-2). Les sources des captures d'écran
 * restent PRIVÉES au serveur : les événements SSE et le snapshot n'exposent
 * que des clés d'état `{hotel_key, seq}` servies par le proxy (§11).
 *
 * Vague 2 — trois ajouts :
 *
 * 1. PERSISTANCE DE L'INCRÉMENT (C4/C5). L'état ne vit plus seulement en
 *    mémoire : il est écrit en continu dans `out/run-<runId>.state.json`
 *    (tmp + rename). Un redémarrage du serveur ne détruit plus 25 minutes et
 *    2,50 $ de relevés payés : le dernier état est relu au démarrage, les runs
 *    connus sont réindexés depuis le disque, et les livrables restent
 *    téléchargeables. Un run coupé en vol est rendu à l'écran comme
 *    `interrupted` — jamais comme `done`.
 *
 * 2. POINT DE VALIDATION HUMAINE (C6). `valider()` enregistre la décision, son
 *    horodatage, l'EMPREINTE SHA-256 du plan réellement affiché et les lignes
 *    écartées, dans un journal append-only `out/validation-<runId>.json`.
 *    L'empreinte soumise est recomparée au plan courant : un plan qui a bougé
 *    entre l'affichage et le clic fait échouer la validation (409).
 *    INV-1 : valider N'EST PAS réserver. Rien ici ne contacte un hôtel.
 *    L'identité du validateur est celle que le proxy fournit, ou rien — et le
 *    journal écrit alors « identité non authentifiée » en toutes lettres.
 *
 * 3. RÉTENTION RGPD. Les sorties NOMINATIVES périmées (plan, rooming,
 *    messages, fiches, état de run) sont purgées selon
 *    `policy.retention.{nominative_hours, purge_on_start}`, sur critère d'ÂGE
 *    explicite, avec journal de ce qui est supprimé (`out/retention.log`).
 *    Les sorties non nominatives (candidats, relevés, coût, empreinte de
 *    liste, journal de validation) ne sont JAMAIS touchées.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runPipeline } from "../hai-admin-mcp/lib/pipeline.mjs";
import { newRunId, resolveDates } from "../hai-admin-mcp/lib/scenario.mjs";
import { mkEmitter } from "../hai-admin-mcp/lib/events.mjs";
import { buildPlanCsv, buildFichesOutputs } from "../hai-admin-mcp/lib/rapport.mjs";
import { fichesFileNames } from "../hai-admin-mcp/lib/fiches.mjs";
import { generatePassengers } from "../hai-admin-mcp/lib/passagers.mjs";

const MAX_LOGS = 200;
const MAX_RESULTS = 5;
/** Période d'écriture de l'état incrémental : assez court pour ne rien perdre,
 * assez long pour ne pas écrire à chaque pensée d'agent. */
const PERSIST_MS = 1500;

/** Nom du fichier d'état incrémental d'un run (NOMINATIF : il porte les occupants). */
export const stateFileName = (runId) => `run-${runId}.state.json`;
/** Nom du journal de validation d'un run (append-only, non purgé). */
export const validationFileName = (runId) => `validation-${runId}.json`;

/**
 * Sorties NOMINATIVES, seules concernées par la purge de rétention.
 * Tout ce qui n'est pas listé ici est hors de portée de la purge, par
 * construction : candidats-*, releves-*, cout-*, pax-*, validation-*, rapport-*.
 */
const NOMINATIF_RE = [
  /^plan-[A-Za-z0-9._-]+\.csv$/,
  /^rooming-[A-Za-z0-9._-]+\.csv$/,
  /^messages-[A-Za-z0-9._-]+\.csv$/,
  /^fiches-[A-Za-z0-9._-]+\.(csv|html)$/,
  /^run-[A-Za-z0-9._-]+\.state\.json$/,
];

/** `rapport-*.md` porte la liste d'appel NOMINATIVE (noms, composition des chambres,
 * mentions PMR) mais n'est PAS dans la liste client des sorties purgeables : il est
 * laissé en place, et on le DIT à chaque purge. Il n'apparaît volontairement pas dans
 * `NOMINATIF_RE` : une seule liste doit dire ce qui est purgé, et ce n'est pas celle-ci.
 * L'arbitrage client reste à rendre. */
const NOMINATIF_NON_PURGE = /^rapport-[A-Za-z0-9._-]+\.md$/;

/** Erreur transportant un statut HTTP (le serveur la traduit telle quelle). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Empreinte SHA-256 du plan tel qu'il est rendu au validateur (C6).
 * Le CSV canonique §5.7 est la forme signée : mêmes colonnes, même ordre de
 * lignes que ce que le validateur a sous les yeux.
 * @param {Array<object>} plan lignes de plan
 * @returns {string} empreinte hexadécimale (64 caractères), "" si plan vide
 */
export function empreintePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return "";
  return createHash("sha256").update(buildPlanCsv(plan), "utf8").digest("hex");
}

/** État vierge d'un run (agrégat re-rendable). */
function freshState() {
  return {
    // idle | running | done | valide | refuse | cancelled | error | interrupted
    state: "idle",
    runId: null,
    simulate: null,
    station: null,
    checkin: null,
    checkout: null,
    nights: null,
    startedAt: null,
    finishedAt: null,
    phase: null,
    phases: [],
    agents: {}, // hotel_key → carte agent
    planOrder: [],
    plan: {}, // pnr → dernière ligne (réémise à chaque réallocation)
    planSummary: null,
    summary: null, // synthèse COMPLÈTE d'allocate (personnes, hôtels, réserves — C2/C6)
    planEmpreinte: null, // SHA-256 du plan final, ce que le validateur signe
    inventoryStatus: null,
    extension: null,
    deadline: null, // événement `deadline` du pipeline (C5) : arrêté par le TEMPS
    couverture: null, // événement `couverture` du pipeline (C2) : vivier avant de payer
    probes: {},
    metricsTotals: { steps: null, cost_usd: null, tokens: null }, // null = aucune mesure recue
    cost: null,
    messagesReady: null,
    fiches: null, // {resume, avertissements, fichiers} — C3
    validation: null, // dernière décision humaine (C6)
    capturesPerdues: false, // captures non rejouables après redémarrage
    warnings: [],
    logs: [],
    done: null,
    error: null,
    outputs: [],
  };
}

/**
 * @param {object} deps
 * @param {{publish: Function}} deps.hub bus SSE
 * @param {string} deps.outDir répertoire des sorties (`out/`)
 * @param {object} [deps.policy] politique de référence, pour `retention.purge_on_start`
 */
/**
 * Portée exacte de l'identité du validateur, écrite dans le journal (C6).
 *
 * Trois cas, jamais confondus :
 *  - authentifiée : l'en-tête vient d'un proxy DÉCLARÉ de confiance par l'exploitant ;
 *  - déclarée seulement : un en-tête a été reçu, mais aucun proxy de confiance n'est
 *    déclaré — n'importe quel client joignant le serveur peut poser cet en-tête, la
 *    valeur est indicative et n'a aucune force probante ;
 *  - absente : aucun en-tête, et on le dit.
 *
 * @param {{identite?: string|null, source?: string, authentifiee?: boolean}|null} validateur
 * @param {boolean} declaree un en-tête d'identité a été reçu
 * @returns {string} la mention à consigner
 */
function mentionValidateur(validateur, declaree) {
  const source = validateur?.source ?? "aucune";
  if (validateur?.authentifiee) {
    return (
      `identité reprise de ${source}, posée par un reverse proxy DÉCLARÉ de confiance ` +
      `(DEMO_TRUSTED_PROXY) : elle ne vaut que si ce serveur n'est joignable QUE par ce proxy — ` +
      `le serveur lui-même n'authentifie personne`
    );
  }
  if (declaree) {
    return (
      `identité DÉCLARÉE par ${source} mais NON authentifiée : aucun reverse proxy de confiance ` +
      `n'est déclaré (DEMO_TRUSTED_PROXY) et le serveur n'a aucune authentification — n'importe quel ` +
      `client joignant ce serveur peut poser cet en-tête. Valeur indicative, sans force probante.`
    );
  }
  return "identité non authentifiée — le serveur n'a aucune authentification, aucun en-tête d'identité n'a été transmis";
}

export function createRunManager({ hub, outDir, policy: policyRef = null }) {
  let st = freshState();
  let controller = null; // annulation totale
  let extController = null; // annulation d'extension seule
  let runPromise = null;
  let empreintePaxCourante = null; // empreinte non nominative de la liste du run en cours
  let ctxCourant = null; // {policy, avion, scenario, station, rows} du run en cours — jamais persisté
  // Politique de RÉTENTION courante : celle du dernier run lancé, à défaut celle du serveur.
  // Trois purges opèrent sur le même répertoire `out/` (démarrage, fin de run, bouton manuel) :
  // elles doivent toutes obéir au même seuil, celui que l'exploitant a choisi.
  let retentionCourante = policyRef ?? null;
  let retentionSource = policyRef
    ? "politique par défaut du serveur (aucun run lancé depuis le démarrage)"
    : "aucune politique de rétention connue";
  const captureSources = new Map(); // "hotel_key" → [{source, mediaType}] — jamais exposé
  const results = new Map(); // runId → {messages, cost, outputs, summary, validation}
  let persistTimer = null;

  /* ------------------------------------------------------------ disque */

  const outPath = (name) => path.join(outDir, path.basename(name));

  /** Écriture atomique (tmp + rename) : un arrêt en plein vol ne laisse jamais
   * un fichier d'état tronqué à la place d'un fichier d'état valide. */
  function writeAtomic(name, content) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = outPath(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
    return file;
  }

  function readJson(name) {
    try {
      return JSON.parse(fs.readFileSync(outPath(name), "utf8"));
    } catch {
      return null;
    }
  }

  /** Écrit l'état courant sur disque. Aucun effet si aucun run n'a démarré. */
  function persistNow() {
    if (!st.runId) return null;
    try {
      return writeAtomic(stateFileName(st.runId), JSON.stringify(serialisable(), null, 2) + "\n");
    } catch (err) {
      // la persistance est un filet, pas une condition du run : on le dit, on continue
      pousserAvertissement(`état du run non persisté (${String(err?.message ?? err)}) — un redémarrage perdrait l'avancement`);
      return null;
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_MS);
    persistTimer.unref?.();
  }

  /** Forme persistée : l'état complet, moins ce qui n'a de sens que dans le process. */
  function serialisable() {
    return { ...st, planOrder: st.planOrder, persiste_le: new Date().toISOString() };
  }

  function pousserAvertissement(message) {
    st.warnings.push({ ts: new Date().toISOString(), message });
    if (st.warnings.length > MAX_LOGS) st.warnings.shift();
  }

  /* --------------------------------------------- reprise après redémarrage */

  /** Réindexe les runs connus depuis `out/` et restitue le plus récent. */
  function restaurer() {
    if (!fs.existsSync(outDir)) return;
    const fichiers = fs
      .readdirSync(outDir)
      .filter((f) => /^run-[A-Za-z0-9._-]+\.state\.json$/.test(f))
      .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const { f } of fichiers) {
      const snap = readJson(f);
      if (!snap?.runId) continue;
      results.set(snap.runId, {
        messages: null, // les messages ne sont pas persistés : le CSV du run fait foi
        cost: snap.cost ?? null,
        outputs: Array.isArray(snap.outputs) ? snap.outputs : [],
        summary: snap.summary ?? null,
        validation: snap.validation ?? null,
        restaure: true,
      });
    }
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);

    const dernier = fichiers.at(-1);
    if (!dernier) return;
    const snap = readJson(dernier.f);
    if (!snap?.runId) return;
    st = { ...freshState(), ...snap };
    delete st.persiste_le;
    // les captures ne survivent pas au process : les vignettes pointeraient dans le vide
    for (const a of Object.values(st.agents ?? {})) a.captures = 0;
    st.capturesPerdues = true;
    if (st.state === "running") {
      st.state = "interrupted";
      st.finishedAt ??= new Date().toISOString();
      pousserAvertissement(
        `run ${st.runId} INTERROMPU par un arrêt du serveur : l'état a été restitué depuis ` +
          `out/${stateFileName(st.runId)}, mais les sessions d'agents en vol sont perdues — ` +
          `les relevés déjà obtenus sont dans le plan ci-dessous, aucun livrable final n'a été écrit`,
      );
    }
  }

  /* -------------------------------------------------------- rétention RGPD */

  /**
   * Purge des sorties NOMINATIVES périmées (RGPD). Critère d'âge EXPLICITE :
   * un fichier n'est supprimé que si sa date de modification est antérieure à
   * `now - nominative_hours`. Une suppression est irréversible : elle est
   * journalisée (`out/retention.log`) et annoncée sur le bus.
   * @param {object} pol politique validée (lue : `policy.retention`)
   * @param {{raison?: string, now?: Date}} [opts]
   * @returns {{supprimes: string[], conserves: number, heures: number|null, raison: string}}
   */
  function purgerNominatives(pol = null, { raison = "manuelle", now = new Date() } = {}) {
    // Sans politique explicite, c'est celle du DERNIER run lancé qui fait foi. Le bouton
    // manuel et la purge au démarrage utilisaient `DEFAULT_POLICY` (72 h) : une politique
    // à 8760 h, respectée en fin de run, était contredite au redémarrage suivant et au
    // premier clic — suppression irréversible sur un seuil que personne n'avait demandé.
    const effective = pol ?? retentionCourante;
    const provenance = pol ? "politique fournie à l'appel" : retentionSource;
    const heures = effective?.retention?.nominative_hours;
    const bilan = { supprimes: [], conserves: 0, heures: null, raison, provenance, erreurs: [] };
    if (!Number.isFinite(heures) || heures <= 0) {
      pousserAvertissement(
        `purge de rétention NON exécutée : policy.retention.nominative_hours absent ou non numérique ` +
          `(${provenance}) — aucune suppression sur une borne inventée`,
      );
      return bilan;
    }
    bilan.heures = heures;
    if (!fs.existsSync(outDir)) return bilan;
    const limite = now.getTime() - heures * 3_600_000;
    let rapportNominatifRestant = 0;
    for (const f of fs.readdirSync(outDir)) {
      if (NOMINATIF_NON_PURGE.test(f)) {
        rapportNominatifRestant += 1;
        continue;
      }
      if (!NOMINATIF_RE.some((re) => re.test(f))) continue;
      // jamais le run courant — mais il est COMPTÉ comme conservé : un bilan
      // « 0 supprimé, 0 conservé » alors que out/ est plein serait un faux rapport RGPD
      if (st.runId && f.includes(st.runId)) {
        bilan.conserves += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(path.join(outDir, f));
      } catch (err) {
        // même règle que le run courant : un fichier qui disparaît des DEUX compteurs
        // fabrique un faux rapport RGPD. Il est compté conservé ET nommé en erreur.
        bilan.erreurs.push(`${f} : statut illisible (${String(err?.message ?? err)}) — non purgé`);
        bilan.conserves += 1;
        continue;
      }
      if (stat.mtimeMs >= limite) {
        bilan.conserves += 1;
        continue;
      }
      try {
        fs.unlinkSync(path.join(outDir, f));
        bilan.supprimes.push(f);
      } catch (err) {
        bilan.erreurs.push(`${f} : ${String(err?.message ?? err)}`);
      }
    }
    if (bilan.supprimes.length) {
      // le seuil ET sa provenance : un « de plus de 72 h » sans provenance ne permet pas
      // de savoir quelle politique a commandé la suppression
      const ligne = JSON.stringify({ ts: now.toISOString(), raison, heures, provenance, supprimes: bilan.supprimes }) + "\n";
      try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.appendFileSync(outPath("retention.log"), ligne, "utf8");
      } catch (err) {
        // Le bus SSE est éphémère et personne n'y est branché au démarrage du serveur —
        // l'un des deux moments où la purge s'exécute. Sans ce relais, la seule trace
        // durable d'une suppression irréversible pouvait disparaître en silence.
        const dit = `journal de rétention NON écrit (${String(err?.message ?? err)}) — ` +
          `${bilan.supprimes.length} suppression(s) irréversible(s) sans trace durable`;
        bilan.erreurs.push(dit);
        pousserAvertissement(dit);
      }
      hub.publish("log", {
        ts: now.toISOString(),
        type: "log",
        data: {
          message:
            `rétention RGPD (${raison}) : ${bilan.supprimes.length} sortie(s) nominative(s) de plus de ${heures} h ` +
            `(seuil : ${provenance}) supprimée(s) — ${bilan.supprimes.join(", ")}`,
        },
      });
    }
    if (rapportNominatifRestant) {
      hub.publish("log", {
        ts: now.toISOString(),
        type: "log",
        data: {
          message:
            `rétention : ${rapportNominatifRestant} rapport(s) « rapport-*.md » conservé(s) bien qu'ils portent ` +
            `la liste d'appel NOMINATIVE — ils ne figurent pas dans la liste des sorties purgeables ; ` +
            `leur sort est un arbitrage client non rendu`,
        },
      });
    }
    return bilan;
  }

  const agent = (key) =>
    (st.agents[key] ??= {
      hotel_key: key,
      name: key,
      status: null,
      session_id: null,
      live_view_url: null,
      last_thought: null,
      thoughts: 0,
      // `null` = rien n'a encore ete mesure pour cet agent. Zero se lirait « n'a rien
      // coute », alors que la session peut tourner et facturer.
      steps: null,
      cost_usd: null,
      tokens: null,
      captures: 0,
      probe: false,
    });

  /** Agrège un événement plat §5.8 dans l'état, retourne l'événement à publier. */
  function absorb(ev) {
    const d = ev.data ?? {};
    const key = ev.hotel_key ?? null;
    switch (ev.type) {
      case "phase":
        st.phase = d.phase;
        st.phases.push({ phase: d.phase, ts: ev.ts, reason: d.reason ?? null, wave: d.wave ?? null });
        if (d.phase === "preparation") {
          st.checkin = d.checkin;
          st.checkout = d.checkout;
          st.nights = d.nights;
        }
        persistNow();
        break;
      case "agent_status": {
        const a = agent(key);
        if (d.status) a.status = d.status;
        if (d.hotel) a.name = d.hotel;
        if (d.live_view_url) a.live_view_url = d.live_view_url;
        if (ev.session_id) a.session_id = ev.session_id;
        schedulePersist();
        break;
      }
      case "agent_thought": {
        const a = agent(key);
        a.last_thought = d.text ?? null;
        a.thoughts += 1;
        break;
      }
      case "screenshot": {
        // interception : la source reste côté serveur, l'événement publié ne
        // porte que la clé d'état (hotel_key, seq) que le proxy sait résoudre
        const a = agent(key);
        const list = captureSources.get(key) ?? [];
        list.push({ source: d.source, imageType: d.imageType ?? null, mediaType: d.mediaType ?? "image/png" });
        captureSources.set(key, list);
        a.captures = list.length;
        return { ...ev, data: { seq: list.length - 1, mediaType: d.mediaType ?? "image/png" } };
      }
      case "plan_row":
        if (d.pnr) {
          if (!(d.pnr in st.plan)) st.planOrder.push(d.pnr);
          st.plan[d.pnr] = d;
          schedulePersist();
        }
        break;
      case "metrics":
        if (d.ok !== undefined || d.escalade !== undefined) {
          st.planSummary = { ok: d.ok ?? 0, escalade: d.escalade ?? 0 };
        } else if (key) {
          const a = agent(key);
          a.steps = d.steps ?? a.steps;
          a.cost_usd = d.cost_usd ?? a.cost_usd;
          a.tokens = d.tokens ?? a.tokens;
          // Un seul agent dont la plateforme n'a pas rapporte le cout rend le TOTAL non
          // mesure : additionner les autres donnerait un total plus bas que la realite.
          const somme = (cle) => {
            let t = 0;
            for (const x of Object.values(st.agents)) {
              if (x[cle] === null || x[cle] === undefined) return null;
              t += x[cle];
            }
            return t;
          };
          st.metricsTotals = { steps: somme("steps"), cost_usd: somme("cost_usd"), tokens: somme("tokens") };
          schedulePersist();
        }
        break;
      case "inventory_status":
        st.inventoryStatus = d;
        break;
      case "extension":
        st.extension = { ...d, stopped: Boolean(d.reason && d.reason !== "gaps"), ts: ev.ts };
        persistNow();
        break;
      // C5 — le run a été arrêté par le TEMPS, pas par l'inventaire : deux pannes
      // opposées, deux décisions opposées. L'écran doit pouvoir les distinguer.
      case "deadline":
        st.deadline = { ...d, ts: ev.ts };
        persistNow();
        break;
      // C2 — couverture indicative du vivier AVANT toute session payante.
      case "couverture":
        st.couverture = { ...d, ts: ev.ts };
        break;
      case "probe":
        if (key) {
          st.probes[key] = d;
          agent(key).probe = true;
        }
        break;
      case "cost":
        st.cost = d;
        break;
      case "messages_ready":
        st.messagesReady = d;
        break;
      case "warning":
        st.warnings.push({ ts: ev.ts, message: d.message });
        if (st.warnings.length > MAX_LOGS) st.warnings.shift();
        break;
      case "log":
        st.logs.push({ ts: ev.ts, message: d.message ?? JSON.stringify(d) });
        if (st.logs.length > MAX_LOGS) st.logs.shift();
        break;
      case "error":
        st.error = { ts: ev.ts, message: d.message, fatal: d.fatal ?? false };
        persistNow();
        break;
      case "done":
        st.done = d;
        break;
      default:
        break;
    }
    return ev;
  }

  /** Snapshot complet re-rendable (EX-UI-2) — sans aucune source de capture. */
  function snapshot() {
    return {
      ...st,
      plan: st.planOrder.map((pnr) => st.plan[pnr]),
      planOrder: undefined,
      runInProgress: st.state === "running",
      // C6 : ce que le validateur peut signer, et ce qui l'en empêche
      validable: st.state === "done" && st.validation === null && st.planOrder.length > 0,
      outputsKnown: [...results.values()].flatMap((r) => r.outputs),
    };
  }

  /* ------------------------------------------------ fiches et livrables §8 */

  /**
   * Lignes passagers canoniques du run, pour des fiches PAR PERSONNE (C3).
   * Liste téléversée : celle du run, telle qu'ingérée. Liste générée : refaite
   * avec les MÊMES arguments que le pipeline, puis VÉRIFIÉE dossier par dossier
   * — au moindre écart on renonce, et les fiches redeviennent par dossier avec
   * l'avertissement de `buildFiches`. Jamais des fiches sur d'autres personnes.
   */
  function rowsPourFiches(result) {
    if (ctxCourant?.rows?.length) return ctxCourant.rows;
    const avion = ctxCourant?.avion;
    const scenario = ctxCourant?.scenario;
    if (!avion?.seats || !Number.isInteger(scenario?.seed)) return null;
    let rows;
    try {
      rows = generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
    } catch {
      return null;
    }
    const attendus = new Set((result.dossiers ?? []).map((d) => d.pnr));
    const obtenus = new Set(rows.map((r) => r.pnr));
    const concordent = attendus.size > 0 && attendus.size === obtenus.size && [...attendus].every((p) => obtenus.has(p));
    if (!concordent) {
      pousserAvertissement(
        "fiches d'enregistrement : la liste générée reconstruite ne correspond pas aux dossiers du run — " +
          "fiches établies PAR DOSSIER, l'identité individuelle reste en blanc",
      );
      return null;
    }
    return rows;
  }

  /**
   * Fiches d'enregistrement par passager (C3), 7e et 8e livrables.
   * Utilise `result.outputs.fichesCsv` / `fichesHtml` dès que le pipeline les
   * exposera sous ces noms exacts ; les construit ici sinon.
   * @returns {Array<[string, string]>} paires (nom de fichier, contenu)
   */
  function livrablesFiches(result) {
    const noms = fichesFileNames(result.runId);
    if (result.outputs?.fichesCsv && result.outputs?.fichesHtml) {
      // Chemin normal depuis que `runPipeline` construit les fiches avant le rapport :
      // on reprend AUSSI son résumé et ses avertissements, sinon l'écran afficherait
      // « fiches produites » sans jamais dire combien partent à identité incomplète.
      st.fiches = {
        resume: result.fiches?.resume ?? null,
        avertissements: result.fiches?.avertissements ?? [],
        fichiers: result.fiches?.fichiers ?? noms,
        source: "pipeline",
      };
      return [[noms.csv, result.outputs.fichesCsv], [noms.html, result.outputs.fichesHtml]];
    }
    try {
      const built = buildFichesOutputs(result.alloc, {
        rows: rowsPourFiches(result),
        dossiers: result.dossiers ?? null,
        policy: ctxCourant?.policy ?? null,
        station: ctxCourant?.station ?? null,
        checkin: result.checkin ?? st.checkin ?? "",
        checkout: result.checkout ?? st.checkout ?? "",
        nights: ctxCourant?.scenario?.nights ?? st.nights ?? 1,
        runId: result.runId,
        vol: "", // aucun numéro de vol n'est saisi dans la démo : rien n'est inventé
        cost: result.cost ?? null,
      });
      st.fiches = {
        resume: built.resume,
        avertissements: built.avertissements,
        fichiers: built.fichiers,
        source: "serveur",
      };
      for (const a of built.avertissements) pousserAvertissement(`fiches : ${a}`);
      return [[built.fichiers.csv, built.csv], [built.fichiers.html, built.html]];
    } catch (err) {
      pousserAvertissement(`fiches d'enregistrement NON produites (${String(err?.message ?? err)}) — C3 incomplet pour ce run`);
      st.fiches = null;
      return [];
    }
  }

  /** Écrit les livrables §8 dans `out/` et référence le résultat pour l'API. */
  function persistResult(result) {
    const files = [];
    fs.mkdirSync(outDir, { recursive: true });
    const w = (name, content) => {
      fs.writeFileSync(outPath(name), content, "utf8");
      files.push(name);
    };
    w(`plan-${result.runId}.csv`, result.outputs.planCsv);
    w(`rapport-${result.runId}.md`, result.outputs.rapportMd);
    w(`messages-${result.runId}.csv`, result.outputs.messagesCsv);
    w(`rooming-${result.runId}.csv`, result.outputs.roomingCsv);
    w(`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n");
    w(`candidats-${result.runId}.json`, JSON.stringify(result.candidates, null, 2) + "\n");
    w(`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n");
    for (const [nom, contenu] of livrablesFiches(result)) w(nom, contenu);
    // empreinte NON nominative de la liste jouee : le rejeu doit comparer ce qui est comparable
    if (empreintePaxCourante) w(`pax-${result.runId}.json`, JSON.stringify(empreintePaxCourante, null, 2) + "\n");
    results.set(result.runId, {
      messages: result.messages,
      cost: result.cost,
      outputs: files,
      summary: result.alloc.summary,
      validation: null,
    });
    while (results.size > MAX_RESULTS) {
      const oldest = results.keys().next().value;
      results.delete(oldest);
    }
    return files;
  }

  /**
   * Sauvetage d'un run annulé ou interrompu (C4/C5) : l'annulation n'est plus
   * destructrice. Le plan PROVISOIRE construit sur les relevés déjà PAYÉS est
   * écrit sur disque sous un nom qui dit ce qu'il est. Aucun message, aucune
   * fiche, aucun coût consolidé : ce n'est pas un run terminé et le nom le dit.
   * @returns {string[]} fichiers écrits
   */
  function persistPartiel(motif) {
    const plan = st.planOrder.map((pnr) => st.plan[pnr]).filter(Boolean);
    if (!st.runId || plan.length === 0) return [];
    const files = [];
    try {
      const nom = `plan-${st.runId}-partiel.csv`;
      writeAtomic(nom, buildPlanCsv(plan));
      files.push(nom);
      pousserAvertissement(
        `run ${motif} : le plan PROVISOIRE issu des relevés déjà payés est conservé dans out/${nom} ` +
          `(${plan.length} ligne(s)) — ce n'est pas un plan validable, il n'a pas été réalloué en fin de run`,
      );
    } catch (err) {
      pousserAvertissement(`plan partiel non écrit (${String(err?.message ?? err)}) — le travail payé n'est pas sauvegardé`);
    }
    return files;
  }

  /* ------------------------------------------- validation humaine (C6) */

  /** Plan d'un run : celui en mémoire, sinon celui persisté sur disque. */
  function planDe(runId) {
    if (runId === st.runId) return st.planOrder.map((pnr) => st.plan[pnr]).filter(Boolean);
    const snap = readJson(stateFileName(runId));
    if (!snap?.plan) return null;
    const ordre = Array.isArray(snap.planOrder) ? snap.planOrder : Object.keys(snap.plan);
    return ordre.map((pnr) => snap.plan[pnr]).filter(Boolean);
  }

  /** État d'un run : celui en mémoire, sinon celui persisté sur disque. */
  function etatDe(runId) {
    if (runId === st.runId) return st.state;
    return readJson(stateFileName(runId))?.state ?? null;
  }

  /** États dans lesquels un plan est DÉFINITIF, donc signable. */
  const ETATS_SIGNABLES = new Set(["done", "valide", "refuse"]);

  /** Ce qui reste engagé une fois les lignes écartées retirées (C2, en PERSONNES). */
  function resumeValide(plan, exclus) {
    const retenues = plan.filter((r) => !exclus.has(r.pnr) && r.statut === "OK");
    const hotels = new Map();
    let chambres = 0;
    let personnes = 0;
    let nonMesurees = 0;
    for (const r of retenues) {
      const n = Number(r.chambres) || 0;
      chambres += n;
      personnes += Number(r.pax) || 0;
      if (r.stock_mesure !== true) nonMesurees += n;
      const h = hotels.get(r.hotel) ?? { chambres: 0, dossiers: 0, pax: 0 };
      h.chambres += n;
      h.dossiers += 1;
      h.pax += Number(r.pax) || 0;
      hotels.set(r.hotel, h);
    }
    const ecartes = plan.filter((r) => exclus.has(r.pnr));
    return {
      dossiers_valides: retenues.length,
      personnes_valides: personnes,
      chambres_valides: chambres,
      chambres_sur_stock_non_mesure: nonMesurees,
      hotels: [...hotels.entries()].map(([hotel, v]) => ({ hotel, ...v })).sort((a, b) => b.chambres - a.chambres),
      dossiers_ecartes: ecartes.length,
      personnes_ecartees: ecartes.reduce((n, r) => n + (Number(r.pax) || 0), 0),
      dossiers_deja_escalades: plan.filter((r) => r.statut !== "OK" && !exclus.has(r.pnr)).length,
    };
  }

  /**
   * Enregistre une décision de validation humaine (C6).
   *
   * INV-1 : cette fonction ne réserve rien et ne contacte aucun hôtel. Elle
   * consigne une décision. La « poursuite vers la confirmation de réservation »
   * demandée au CDC est un arbitrage client NON RENDU : elle n'est pas ici.
   *
   * @param {object} args
   * @param {string} args.runId run concerné
   * @param {"valide"|"refuse"} args.decision
   * @param {string|null} [args.empreinte] empreinte SHA-256 du plan AFFICHÉ ; recomparée au plan courant
   * @param {Array<{pnr: string, motif?: string}>} [args.exclusions] lignes écartées (validation PARTIELLE)
   * @param {{identite: string|null, source: string, authentifiee: boolean, remote?: string|null}} args.validateur
   * @param {string} [args.commentaire]
   * @param {Date} [args.now]
   * @returns {object} l'entrée de journal enregistrée
   */
  function valider({ runId, decision, empreinte = null, exclusions = [], validateur, commentaire = "", now = new Date() }) {
    if (st.state === "running") throw new HttpError(409, "un run est en cours : le plan n'est pas définitif, validation refusée (INV-10)");
    if (decision !== "valide" && decision !== "refuse") {
      throw new HttpError(400, `décision inconnue « ${decision} » (attendu : valide | refuse)`);
    }
    const plan = planDe(runId);
    if (!plan || plan.length === 0) throw new HttpError(404, `aucun plan connu pour le run ${runId}`);

    // Un plan PROVISOIRE (run annulé, interrompu, en erreur) n'est pas signable : il
    // n'a pas été réalloué en fin de run, et le valider ferait croire à un engagement
    // qui repose sur des relevés partiels.
    const etat = etatDe(runId);
    if (!ETATS_SIGNABLES.has(etat)) {
      throw new HttpError(409, `le run ${runId} est « ${etat ?? "inconnu"} » : son plan est PROVISOIRE et ne peut pas être validé`);
    }
    if (plan.some((r) => r.provisoire === true || r.provisoire === "true")) {
      throw new HttpError(409, `le plan du run ${runId} porte encore des lignes provisoires : il n'a pas été réalloué en fin de run`);
    }

    const courante = empreintePlan(plan);
    // C6 - on ne VALIDE que ce qu'on a vu. Sans empreinte, rien ne prouve que le plan
    // signe est celui qui etait a l'ecran : un appel direct court-circuiterait le seul
    // controle anti-derive du dispositif. Un REFUS, lui, n'exige pas d'avoir tout lu.
    if (decision === "valide" && !empreinte) {
      throw new HttpError(
        400,
        "validation refusée : l'empreinte du plan affiché est obligatoire pour valider " +
          `(empreinte courante ${courante.slice(0, 12)}…) — un plan ne se signe pas sans avoir été vu`,
      );
    }
    if (empreinte && empreinte !== courante) {
      throw new HttpError(
        409,
        `le plan a changé depuis son affichage : empreinte signée ${String(empreinte).slice(0, 12)}…, ` +
          `plan courant ${courante.slice(0, 12)}… — rechargez la répartition avant de valider`,
      );
    }

    const connus = new Set(plan.map((r) => r.pnr));
    const propres = [];
    for (const ex of exclusions ?? []) {
      const pnr = String(ex?.pnr ?? "").trim();
      if (!pnr) throw new HttpError(400, "ligne écartée sans PNR");
      if (!connus.has(pnr)) throw new HttpError(400, `ligne écartée inconnue du plan : ${pnr}`);
      const motif = String(ex?.motif ?? "").trim();
      if (!motif) throw new HttpError(400, `ligne ${pnr} écartée sans motif : une exclusion sans raison n'est pas traçable`);
      propres.push({ pnr, motif: motif.slice(0, 300) });
    }
    if (decision === "refuse" && propres.length) {
      throw new HttpError(400, "un refus global ne se combine pas avec des exclusions de lignes : refusez, ou validez partiellement");
    }

    const exclus = new Set(propres.map((e) => e.pnr));
    // un appelant d'avant la distinction ne renseigne pas `declaree` : une identité
    // présente vaut alors identité déclarée. Jamais l'inverse — rien n'est supposé authentifié.
    const declaree = validateur?.declaree ?? Boolean(validateur?.identite);
    const entree = {
      seq: 0, // renseigné à l'écriture du journal
      runId,
      decision,
      // INV-1, écrit dans le journal lui-même : ce qui est signé n'est pas une réservation
      portee: "plan d'hébergement à demander aux hôtels — AUCUNE réservation n'est effectuée par l'outil (INV-1)",
      at: now.toISOString(),
      empreinte_plan: courante,
      empreinte_soumise: empreinte ?? null,
      lignes_plan: plan.length,
      exclusions: propres,
      validateur: {
        identite: validateur?.identite ?? null,
        source: validateur?.source ?? "aucune",
        // DEUX niveaux, jamais confondus : `declaree` = un en-tête d'identité a été reçu ;
        // `authentifiee` = il vient d'un proxy déclaré de confiance. Un en-tête reçu en
        // direct n'authentifie RIEN — n'importe quel client peut le poser — et le compter
        // comme une authentification donnerait au journal une valeur probante qu'il n'a pas.
        declaree: declaree,
        authentifiee: Boolean(validateur?.authentifiee),
        // dans les trois cas, la portée exacte de cette identité est écrite en toutes
        // lettres : une traçabilité inventée serait pire que pas de traçabilité du tout
        mention: mentionValidateur(validateur, declaree),
        remote: validateur?.remote ?? null,
      },
      commentaire: String(commentaire ?? "").slice(0, 2000),
      resume: decision === "valide" ? resumeValide(plan, exclus) : null,
    };

    // journal APPEND-ONLY : les entrées précédentes sont relues et jamais réécrites.
    // Un fichier ABSENT donne un journal neuf ; un fichier PRÉSENT mais illisible (JSON
    // tronqué, droits refusés, verrou) n'en donne PAS : l'écriture qui suit est un
    // remplacement complet, elle effacerait les décisions antérieures et ferait repartir
    // `seq` à 1 — un journal dont la numérotation peut redémarrer ne vaut plus comme preuve.
    const nom = validationFileName(runId);
    const journal = readJson(nom) ?? { runId, entrees: [] };
    if (fs.existsSync(outPath(nom)) && readJson(nom) === null) {
      throw new HttpError(
        500,
        `journal de validation « ${nom} » présent mais ILLISIBLE : la décision n'est pas enregistrée. ` +
          `Écrire dessus effacerait les décisions antérieures. Mettre le fichier de côté avant de rejouer la validation.`,
      );
    }
    if (!Array.isArray(journal.entrees)) journal.entrees = [];
    entree.seq = journal.entrees.length + 1;
    journal.entrees.push(entree);
    journal.derniere_decision = decision;
    journal.mis_a_jour_le = entree.at;
    writeAtomic(nom, JSON.stringify(journal, null, 2) + "\n");

    const connu = results.get(runId);
    if (connu) {
      connu.validation = entree;
      if (!connu.outputs.includes(nom)) connu.outputs.push(nom);
    }
    if (runId === st.runId) {
      st.validation = entree;
      st.state = decision === "valide" ? "valide" : "refuse";
      if (!st.outputs.includes(nom)) st.outputs.push(nom);
      st.planEmpreinte = courante;
      persistNow();
    }
    hub.publish("validation", { ts: entree.at, run_id: runId, type: "validation", data: entree });
    return entree;
  }

  /* ------------------------------------------------------------ démarrage */

  restaurer();
  if (retentionCourante?.retention?.purge_on_start) {
    purgerNominatives(null, { raison: "démarrage du serveur (policy.retention.purge_on_start)" });
  }

  return {
    /**
     * Démarre un run (409 si un run est en cours — INV-10).
     * @param {object} args {policy, avion, scenario, station, rows?, inventaire?, collectFactory, simulate}
     * @returns {{runId: string}} — le run continue en tâche de fond dans le process
     */
    start({ policy, avion, scenario, station, rows = null, ingestion = null, preflight = null, empreintePax = null, inventaire = undefined, collectFactory, simulate = false }) {
      if (st.state === "running") throw new HttpError(409, "un run est déjà en cours (INV-10)");
      const now = new Date();
      const runId = newRunId(now);
      // la politique du run devient la politique de rétention de référence du serveur
      retentionCourante = policy;
      retentionSource = `politique du run ${runId}`;
      const { checkin, checkout } = resolveDates(scenario, now, station?.timezone ?? null);

      st = freshState();
      captureSources.clear();
      empreintePaxCourante = empreintePax;
      // contexte du run : sert aux fiches (C3). `rows` est NOMINATIF et ne quitte
      // jamais le process (INV-5) : il n'entre ni dans l'état persisté ni dans le bus.
      ctxCourant = { policy, avion, scenario, station, rows };
      st.state = "running";
      st.runId = runId;
      st.simulate = simulate;
      st.station = station.code;
      st.checkin = checkin;
      st.checkout = checkout;
      st.startedAt = now.toISOString();
      persistNow();

      controller = new AbortController();
      extController = new AbortController();
      const collect = collectFactory({ signal: controller.signal, extensionSignal: extController.signal });

      const emit = mkEmitter({ run_id: runId }, (ev) => {
        const publishable = absorb(ev);
        hub.publish(publishable.type, publishable);
      });

      runPromise = runPipeline({
        policy,
        station,
        scenario,
        avion,
        rows,
        ingestion,
        preflight,
        inventaire,
        emit,
        signal: controller.signal,
        extensionSignal: extController.signal,
        collect,
        now,
      })
        .then((result) => {
          if (result.cancelled) {
            st.state = "cancelled";
            // C4/C5 — l'annulation n'efface plus ce qui a été payé
            st.outputs = persistPartiel("annulé");
          } else {
            st.summary = result.alloc?.summary ?? null;
            st.planEmpreinte = empreintePlan(st.planOrder.map((pnr) => st.plan[pnr]).filter(Boolean));
            st.outputs = persistResult(result);
            st.state = "done";
          }
          st.finishedAt = new Date().toISOString();
          persistNow();
          if (policy?.retention?.purge_on_start) {
            purgerNominatives(null, { raison: `fin du run ${runId}` });
          }
          hub.publish("log", { ts: st.finishedAt, run_id: runId, type: "log", data: { message: `run ${runId} terminé (${st.state})`, outputs: st.outputs } });
        })
        .catch((err) => {
          st.state = "error";
          st.finishedAt = new Date().toISOString();
          st.outputs = persistPartiel("en erreur");
          const ev = { ts: st.finishedAt, run_id: runId, type: "error", data: { message: String(err?.message ?? err), fatal: true } };
          absorb(ev);
          persistNow();
          hub.publish("error", ev);
        });

      return { runId };
    },

    /** Annulation totale du run en cours. */
    cancel() {
      if (st.state !== "running") throw new HttpError(409, "aucun run en cours");
      controller.abort();
      return { cancelling: true, runId: st.runId };
    },

    /** Arrêt de l'extension seule : le plan reste en l'état, escalade chiffrée (EX-EXT-4). */
    cancelExtension() {
      if (st.state !== "running") throw new HttpError(409, "aucun run en cours");
      extController.abort();
      return { extension_cancelling: true, runId: st.runId };
    },

    snapshot,
    isRunning: () => st.state === "running",
    valider,
    purgerNominatives,

    /** Journal de validation d'un run (append-only) — null si aucune décision. */
    journalValidation(runId) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(runId ?? ""))) return null;
      return readJson(validationFileName(runId));
    },

    /** Empreinte SHA-256 du plan d'un run (ce que le validateur signe). */
    empreinteDe(runId) {
      const plan = planDe(runId);
      return plan ? empreintePlan(plan) : null;
    },

    /** Source interne d'une capture — réservé au proxy `/api/screenshot` (§11). */
    captureSource(hotelKey, seq) {
      const list = captureSources.get(hotelKey);
      const n = Number(seq);
      if (!list || !Number.isInteger(n) || n < 0 || n >= list.length) return null;
      return list[n];
    },

    /** Résultat d'un run terminé (messages, coût, fichiers) — pour l'API. */
    result(runId) {
      return results.get(runId) ?? null;
    },

    /** Un nom de fichier est-il téléchargeable ? (liste blanche stricte, §9) */
    isOutputAllowed(name) {
      return [...results.values()].some((r) => r.outputs.includes(name)) || st.outputs.includes(name);
    },

    /** Attente de la fin du run (tests). */
    wait: () => runPromise ?? Promise.resolve(),
  };
}
