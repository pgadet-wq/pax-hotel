/**
 * Tests events (CDC §5.8) : traduction SessionEvent → événements plats, émetteur.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateSessionEvent, mkEmitter, EVENT_TYPES } from "../lib/events.mjs";

test("events : policy_event → agent_thought (reasoningContent ou content JSON)", () => {
  const out = translateSessionEvent({ type: "AgentEvent", data: { kind: "policy_event", reasoningContent: "Je règle les dates.", toolReqs: [{ toolName: "click" }] } });
  assert.deepEqual(out, [{ type: "agent_thought", data: { text: "Je règle les dates.", action: "click" } }]);
  const json = translateSessionEvent({ type: "AgentEvent", data: { kind: "policy_event", content: '{"thought":"ok"}' } });
  assert.equal(json[0].data.text, "ok");
  assert.deepEqual(translateSessionEvent({ type: "AgentEvent", data: { kind: "policy_event", content: "" } }), []);
});

test("events : observation_event → screenshot ; LiveViewUrl et statut → agent_status", () => {
  const shot = translateSessionEvent({ type: "AgentEvent", data: { kind: "observation_event", image: { source: "abc", type: "base64", mediaType: "image/png" }, metadata: { url: "https://x" } } });
  assert.equal(shot[0].type, "screenshot");
  assert.equal(shot[0].data.source, "abc");
  const live = translateSessionEvent({ type: "LiveViewUrlEvent", data: { liveViewUrl: "https://live" } });
  assert.deepEqual(live, [{ type: "agent_status", data: { live_view_url: "https://live" } }]);
  const st = translateSessionEvent({ type: "AgentRunStatusChangeEvent", data: { status: "running" } });
  assert.deepEqual(st, [{ type: "agent_status", data: { status: "running" } }]);
});

test("events : MetricsUpdateEvent → metrics (pas, coût, tokens agrégés)", () => {
  const out = translateSessionEvent({
    type: "MetricsUpdateEvent",
    data: { metrics: { steps: 12, totalCost: 0.07, costPerModel: [{ inputTokens: 100, outputTokens: 50, reasoningTokens: 25 }, { inputTokens: 10, outputTokens: 5 }] } },
  });
  assert.deepEqual(out, [{ type: "metrics", data: { steps: 12, cost_usd: 0.07, tokens: 190 } }]);
  assert.ok(EVENT_TYPES.includes("metrics"));
});

test("events : erreur non fatale, complétion, événement inconnu ignoré", () => {
  const err = translateSessionEvent({ type: "AgentErrorEvent", data: { message: "boom" } });
  assert.deepEqual(err, [{ type: "error", data: { message: "boom", fatal: false } }]);
  const done = translateSessionEvent({ type: "AgentCompletionEvent", data: { reason: "answered" } });
  assert.equal(done[0].data.status, "completed");
  assert.deepEqual(translateSessionEvent({ type: "MachinTruc", data: {} }), []);
  assert.deepEqual(translateSessionEvent(null), []);
});

test("events : mkEmitter numérote, horodate et fige la base", () => {
  const seen = [];
  const emit = mkEmitter({ run_id: "r1" }, (ev) => seen.push(ev));
  emit("log", { message: "a" });
  emit("warning", { message: "b" }, { hotel_key: "h1" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].seq, 1);
  assert.equal(seen[1].seq, 2);
  assert.equal(seen[0].run_id, "r1");
  assert.equal(seen[1].hotel_key, "h1");
  assert.ok(seen[0].ts.includes("T"));
});
