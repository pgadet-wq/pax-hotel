/** Bus SSE (phase 4) — tampon circulaire, Last-Event-ID, snapshot, format. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHub, formatSse } from "../../demo/sse-hub.mjs";

/** Réponse HTTP factice : accumule les écritures. */
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (s) => res.chunks.push(String(s));
  res.end = () => res.emit("close");
  res.text = () => res.chunks.join("");
  return res;
}
const fakeReq = (headers = {}) => Object.assign(new EventEmitter(), { headers });

test("formatSse : id monotone, event, data JSON une ligne", () => {
  const s = formatSse(7, "phase", { phase: "releves" });
  assert.equal(s, 'id: 7\nevent: phase\ndata: {"phase":"releves"}\n\n');
});

test("publish : ids monotones et tampon circulaire borné", () => {
  const hub = createHub({ bufferSize: 3, pingMs: 0 });
  for (let i = 0; i < 5; i += 1) hub.publish("log", { n: i });
  assert.equal(hub.lastId, 5);
  assert.deepEqual(hub.bufferedIds, [3, 4, 5]); // les 2 plus anciens évincés
  hub.close();
});

test("connexion sans Last-Event-ID : snapshot complet puis direct", () => {
  const hub = createHub({ pingMs: 0 });
  hub.publish("phase", { phase: "preparation" });
  const res = fakeRes();
  hub.handle(fakeReq(), res, () => ({ state: "running", plan: [] }));
  assert.match(res.headers["Content-Type"], /text\/event-stream/);
  assert.match(res.text(), /event: snapshot\ndata: \{"state":"running","plan":\[\]\}/);
  hub.publish("warning", { message: "suite" });
  assert.match(res.text(), /event: warning/);
  assert.equal(hub.clientCount, 1);
  hub.close();
});

test("Last-Event-ID dans le tampon : reprise sans snapshot", () => {
  const hub = createHub({ pingMs: 0 });
  hub.publish("log", { n: 1 });
  hub.publish("log", { n: 2 });
  hub.publish("log", { n: 3 });
  const res = fakeRes();
  hub.handle(fakeReq({ "last-event-id": "1" }), res, () => ({ jamais: true }));
  const text = res.text();
  assert.doesNotMatch(text, /snapshot/);
  assert.match(text, /id: 2\n/);
  assert.match(text, /id: 3\n/);
  assert.doesNotMatch(text, /id: 1\n/);
  hub.close();
});

test("Last-Event-ID évincé du tampon : snapshot de rattrapage", () => {
  const hub = createHub({ bufferSize: 2, pingMs: 0 });
  for (let i = 1; i <= 5; i += 1) hub.publish("log", { n: i });
  const res = fakeRes();
  hub.handle(fakeReq({ "last-event-id": "1" }), res, () => ({ rattrapage: true }));
  assert.match(res.text(), /event: snapshot/);
  hub.close();
});

test("déconnexion : le client est détaché", () => {
  const hub = createHub({ pingMs: 0 });
  const req = fakeReq();
  const res = fakeRes();
  hub.handle(req, res, () => ({}));
  assert.equal(hub.clientCount, 1);
  req.emit("close");
  assert.equal(hub.clientCount, 0);
  hub.publish("log", { apres: true }); // n'explose pas
  hub.close();
});

test("ping périodique écrit un commentaire SSE", async () => {
  const hub = createHub({ pingMs: 20 });
  const res = fakeRes();
  hub.handle(fakeReq(), res, () => ({}));
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(res.chunks.filter((c) => c === ": ping\n\n").length >= 2, "au moins deux pings attendus");
  hub.close();
});
