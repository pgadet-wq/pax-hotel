/** Pompe de session (phase 4) — flux PUIS waitForCompletion, jamais en parallèle. */
import test from "node:test";
import assert from "node:assert/strict";
import { pumpSession } from "../../demo/session-pump.mjs";

/** Handle factice : journalise l'ordre des appels. */
function fakeHandle({ events = [], result = { status: "completed", answer: { ok: true } }, failWait = null } = {}) {
  const calls = [];
  return {
    id: "sess-1",
    calls,
    cancelled: false,
    async *stream() {
      calls.push("stream:start");
      for (const ev of events) {
        yield ev;
      }
      calls.push("stream:end");
    },
    async waitForCompletion() {
      calls.push("wait");
      if (failWait) throw failWait;
      return result;
    },
    async cancel() {
      calls.push("cancel");
      this.cancelled = true;
    },
  };
}

test("ordre strict : flux consommé entièrement AVANT waitForCompletion", async () => {
  const handle = fakeHandle({
    events: [
      { type: "AgentRunStatusChangeEvent", data: { status: "running" } },
      { type: "AgentEvent", data: { kind: "policy_event", reasoningContent: "je lis la page" } },
    ],
  });
  const seen = [];
  const result = await pumpSession(handle, (type, data) => seen.push({ type, data }));
  assert.deepEqual(handle.calls, ["stream:start", "stream:end", "wait"]);
  assert.deepEqual(seen.map((e) => e.type), ["agent_status", "agent_thought"]);
  assert.equal(seen[1].data.text, "je lis la page");
  assert.deepEqual(result.answer, { ok: true });
});

test("MetricsUpdateEvent traduit en metrics agrégées", async () => {
  const handle = fakeHandle({
    events: [{ type: "MetricsUpdateEvent", data: { metrics: { steps: 12, totalCost: 0.34, costPerModel: [{ inputTokens: 100, outputTokens: 50, reasoningTokens: 8 }] } } }],
  });
  const seen = [];
  await pumpSession(handle, (t, d) => seen.push({ t, d }));
  assert.deepEqual(seen[0], { t: "metrics", d: { steps: 12, cost_usd: 0.34, tokens: 158 } });
});

test("flux coupé : warning puis résultat quand même attendu", async () => {
  const handle = fakeHandle();
  handle.stream = async function* () {
    handle.calls.push("stream:start");
    yield { type: "AgentRunStatusChangeEvent", data: { status: "running" } };
    throw new Error("WebDriver disparu");
  };
  const seen = [];
  const result = await pumpSession(handle, (t, d) => seen.push({ t, d }));
  assert.ok(seen.some((e) => e.t === "warning" && /flux d'événements interrompu/.test(e.d.message)));
  assert.equal(result.status, "completed");
});

test("réponse non conforme (AnswerValidationError) : échec de réponse, pas d'exception", async () => {
  const err = new Error("schéma non respecté");
  err.name = "AnswerValidationError";
  const handle = fakeHandle({ failWait: err });
  const seen = [];
  const result = await pumpSession(handle, (t, d) => seen.push({ t, d }));
  assert.equal(result.answer, null);
  assert.equal(result.status, "completed");
  assert.ok(seen.some((e) => e.t === "warning" && /non conforme/.test(e.d.message)));
});

test("autre erreur de waitForCompletion : propagée", async () => {
  const handle = fakeHandle({ failWait: new Error("panne réseau") });
  await assert.rejects(() => pumpSession(handle, () => {}), /panne réseau/);
});

test("session non terminale après réponse : cancel pour libérer le slot", async () => {
  const handle = fakeHandle({ result: { status: "running", answer: { ok: 1 } } });
  await pumpSession(handle, () => {});
  await new Promise((r) => setImmediate(r));
  assert.ok(handle.cancelled, "cancel() attendu sur une session encore ouverte");
});

test("signal aborté : le flux s'arrête, le résultat est quand même lu", async () => {
  const ac = new AbortController();
  const handle = fakeHandle();
  handle.stream = async function* () {
    yield { type: "AgentRunStatusChangeEvent", data: { status: "running" } };
    ac.abort();
    yield { type: "AgentRunStatusChangeEvent", data: { status: "jamais-vu" } };
  };
  const seen = [];
  await pumpSession(handle, (t, d) => seen.push(d.status), { signal: ac.signal });
  assert.deepEqual(seen, ["running"]);
});
