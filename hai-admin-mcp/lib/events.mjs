/**
 * Forme d'événement partagée (CDC §5.8) entre pipeline, CLI et serveur de démo,
 * et traduction des SessionEvent H vers cette forme. Module pur (pas de SDK).
 *
 * Événement plat, sérialisable SSE tel quel :
 *   { ts, seq, run_id?, phase?, type, session_id?, hotel_key?, data }
 * Types §5.8 : phase, agent_status, agent_thought, screenshot, candidate, plan_row,
 * metrics, warning, log, done, error, inventory_status, extension, probe, cost,
 * messages_ready.
 */

export const EVENT_TYPES = [
  "phase", "agent_status", "agent_thought", "screenshot", "candidate", "plan_row",
  "metrics", "warning", "log", "done", "error",
  "inventory_status", "extension", "probe", "cost", "messages_ready",
];

/** Fabrique un émetteur : fige la base (run_id…), numérote, horodate. */
export function mkEmitter(base, sink) {
  let seq = 0;
  return (type, data = {}, extra = {}) =>
    sink({ ts: new Date().toISOString(), seq: (seq += 1), ...base, ...extra, type, data });
}

const short = (text, max = 400) => {
  const t = String(text ?? "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** Le content d'un policy_event est parfois un JSON {note, thought, tool_call}. */
function extractThought(content) {
  if (!content) return "";
  try {
    const obj = JSON.parse(content);
    return obj.thought || obj.note || "";
  } catch {
    return String(content);
  }
}

/**
 * Traduit un SessionEvent H en zéro, un ou plusieurs événements plats (§5.8).
 * Relevé v2 des probes du 11-13/09 : AgentEvent {kind: policy_event|observation_event},
 * MetricsUpdateEvent {metrics}, LiveViewUrlEvent, AgentRunStatusChangeEvent,
 * AgentErrorEvent, AgentCompletionEvent.
 * @param {object} ev SessionEvent {type, timestamp, data}
 * @returns {Array<{type: string, data: object}>}
 */
export function translateSessionEvent(ev) {
  const out = [];
  const d = ev?.data ?? {};
  switch (ev?.type) {
    case "LiveViewUrlEvent":
      if (d.liveViewUrl) out.push({ type: "agent_status", data: { live_view_url: d.liveViewUrl } });
      break;
    case "AgentRunStatusChangeEvent":
      out.push({ type: "agent_status", data: { status: d.status ?? d.state ?? "?" } });
      break;
    case "MetricsUpdateEvent": {
      const m = d.metrics ?? {};
      // `totalCost`, `steps` et `costPerModel` sont OPTIONNELS sur le flux. Une absence
      // n'est PAS une dépense nulle : `?? 0` affichait « 0,00 $ » pendant que des sessions
      // facturaient, et neutralisait la borne `max_cost_usd_per_run`, qui s'appuie sur ce
      // même chiffre. `null` traverse maintenant jusqu'au bandeau (« non mesuré ») et
      // jusqu'au budget, qui refuse de poursuivre ce qu'il ne peut pas contrôler.
      const cpm = Array.isArray(m.costPerModel) ? m.costPerModel : null;
      out.push({
        type: "metrics",
        data: {
          steps: m.steps ?? null,
          cost_usd: m.totalCost ?? null,
          tokens: cpm
            ? cpm.reduce((s, c) => s + (c.inputTokens ?? 0) + (c.outputTokens ?? 0) + (c.reasoningTokens ?? 0), 0)
            : null,
        },
      });
      break;
    }
    case "AgentErrorEvent":
      out.push({ type: "error", data: { message: short(d.message ?? d.error ?? "erreur agent"), fatal: false } });
      break;
    case "AgentCompletionEvent":
      out.push({ type: "agent_status", data: { status: "completed", reason: d.reason } });
      break;
    case "AgentEvent": {
      switch (d.kind) {
        case "policy_event": {
          const text = short(d.reasoningContent || extractThought(d.content));
          if (text) out.push({ type: "agent_thought", data: { text, action: d.toolReqs?.[0]?.toolName ?? null } });
          break;
        }
        case "observation_event":
          if (d.image?.source) {
            out.push({
              type: "screenshot",
              data: { source: d.image.source, imageType: d.image.type, mediaType: d.image.mediaType, url: d.metadata?.url ?? null },
            });
          }
          break;
        default:
          break;
      }
      break;
    }
    default:
      break;
  }
  return out;
}
