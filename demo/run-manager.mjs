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
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "../hai-admin-mcp/lib/pipeline.mjs";
import { newRunId, resolveDates } from "../hai-admin-mcp/lib/scenario.mjs";
import { mkEmitter } from "../hai-admin-mcp/lib/events.mjs";

const MAX_LOGS = 200;
const MAX_RESULTS = 5;

/** Erreur transportant un statut HTTP (le serveur la traduit telle quelle). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** État vierge d'un run (agrégat re-rendable). */
function freshState() {
  return {
    state: "idle", // idle | running | done | cancelled | error
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
    inventoryStatus: null,
    extension: null,
    probes: {},
    metricsTotals: { steps: 0, cost_usd: 0, tokens: 0 },
    cost: null,
    messagesReady: null,
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
 */
export function createRunManager({ hub, outDir }) {
  let st = freshState();
  let controller = null; // annulation totale
  let extController = null; // annulation d'extension seule
  let runPromise = null;
  const captureSources = new Map(); // "hotel_key" → [{source, mediaType}] — jamais exposé
  const results = new Map(); // runId → {messages, cost, outputs, summary}

  const agent = (key) =>
    (st.agents[key] ??= {
      hotel_key: key,
      name: key,
      status: null,
      session_id: null,
      live_view_url: null,
      last_thought: null,
      thoughts: 0,
      steps: 0,
      cost_usd: 0,
      tokens: 0,
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
        break;
      case "agent_status": {
        const a = agent(key);
        if (d.status) a.status = d.status;
        if (d.hotel) a.name = d.hotel;
        if (d.live_view_url) a.live_view_url = d.live_view_url;
        if (ev.session_id) a.session_id = ev.session_id;
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
          st.metricsTotals = Object.values(st.agents).reduce(
            (t, x) => ({ steps: t.steps + x.steps, cost_usd: t.cost_usd + x.cost_usd, tokens: t.tokens + x.tokens }),
            { steps: 0, cost_usd: 0, tokens: 0 },
          );
        }
        break;
      case "inventory_status":
        st.inventoryStatus = d;
        break;
      case "extension":
        st.extension = { ...d, stopped: Boolean(d.reason && d.reason !== "gaps"), ts: ev.ts };
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
      outputsKnown: [...results.values()].flatMap((r) => r.outputs),
    };
  }

  /** Écrit les livrables §8 dans `out/` et référence le résultat pour l'API. */
  function persistResult(result) {
    const files = [];
    fs.mkdirSync(outDir, { recursive: true });
    const w = (name, content) => {
      fs.writeFileSync(path.join(outDir, name), content, "utf8");
      files.push(name);
    };
    w(`plan-${result.runId}.csv`, result.outputs.planCsv);
    w(`rapport-${result.runId}.md`, result.outputs.rapportMd);
    w(`messages-${result.runId}.csv`, result.outputs.messagesCsv);
    w(`cout-${result.runId}.json`, JSON.stringify(result.cost, null, 2) + "\n");
    w(`candidats-${result.runId}.json`, JSON.stringify(result.candidates, null, 2) + "\n");
    w(`releves-${result.runId}.json`, JSON.stringify(result.inventories, null, 2) + "\n");
    results.set(result.runId, {
      messages: result.messages,
      cost: result.cost,
      outputs: files,
      summary: result.alloc.summary,
    });
    while (results.size > MAX_RESULTS) {
      const oldest = results.keys().next().value;
      results.delete(oldest);
    }
    return files;
  }

  return {
    /**
     * Démarre un run (409 si un run est en cours — INV-10).
     * @param {object} args {policy, avion, scenario, station, rows?, inventaire?, collectFactory, simulate}
     * @returns {{runId: string}} — le run continue en tâche de fond dans le process
     */
    start({ policy, avion, scenario, station, rows = null, inventaire = undefined, collectFactory, simulate = false }) {
      if (st.state === "running") throw new HttpError(409, "un run est déjà en cours (INV-10)");
      const now = new Date();
      const runId = newRunId(now);
      const { checkin, checkout } = resolveDates(scenario, now);

      st = freshState();
      captureSources.clear();
      st.state = "running";
      st.runId = runId;
      st.simulate = simulate;
      st.station = station.code;
      st.checkin = checkin;
      st.checkout = checkout;
      st.startedAt = now.toISOString();

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
          } else {
            st.outputs = persistResult(result);
            st.state = "done";
          }
          st.finishedAt = new Date().toISOString();
          hub.publish("log", { ts: st.finishedAt, run_id: runId, type: "log", data: { message: `run ${runId} terminé (${st.state})`, outputs: st.outputs } });
        })
        .catch((err) => {
          st.state = "error";
          st.finishedAt = new Date().toISOString();
          const ev = { ts: st.finishedAt, run_id: runId, type: "error", data: { message: String(err?.message ?? err), fatal: true } };
          absorb(ev);
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
      return [...results.values()].some((r) => r.outputs.includes(name));
    },

    /** Attente de la fin du run (tests). */
    wait: () => runPromise ?? Promise.resolve(),
  };
}
