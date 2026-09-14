/**
 * Tests CLI phase 3 (CDC §12.1) : rebooking-v2 --dry-run / --offline, garde INV-8
 * sur toutes les commandes payantes (DEMO_ALLOW_PAID jamais posé par les tests).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

const CLI = path.join(ROOT, "hai-admin-mcp", "tools", "rebooking-v2.mjs");
const CLI_INV = path.join(ROOT, "hai-admin-mcp", "tools", "inventaire.mjs");
const run = (cli, ...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEMO_ALLOW_PAID: "" }, // jamais 1 dans les tests (INV-8)
  });

test("CLI rebooking-v2 : --dry-run BKK — besoins, inventaire, décision découverte, URLs, extension théorique, aucun agent", () => {
  const r = run(CLI, "--dry-run", "--station", "BKK");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Besoins par tier/);
  assert.match(r.stdout, /J : \d+ dossiers/);
  assert.match(r.stdout, /Inventaire BKK : 3 hôtel\(s\)/);
  assert.match(r.stdout, /Découverte : (SAUTÉE|EXÉCUTÉE) — /);
  assert.match(r.stdout, /booking\.com\/hotel\/th\/hyatt-regency-bangkok-suvarnabhumi-airport\.html\?checkin=/);
  assert.match(r.stdout, /Plan d'extension théorique/);
  assert.match(r.stdout, /18 sessions · 4 vagues · 10 \$/);
  assert.match(r.stdout, /aucun agent, aucun réseau/);
});

test("CLI rebooking-v2 : --offline rejoue les fixtures — plan, rapport, messages, coût, 0 €", () => {
  const r = run(CLI, "--offline", path.join(ROOT, "data", "simulate", "releves-demo.json"), "--station", "BKK", "--checkin", "2026-10-04");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[done \]/);
  assert.match(r.stdout, /0 € \(aucune session\)/);
  for (const kind of ["plan-", "rapport-", "messages-", "cout-", "releves-"]) {
    const m = r.stdout.match(new RegExp(`écrit out[\\\\/](${kind}[a-z0-9]+\\.(csv|md|json))`));
    assert.ok(m, `sortie ${kind}* absente de la sortie CLI`);
    assert.ok(fs.existsSync(path.join(ROOT, "out", m[1])), `${m[1]} non écrit`);
  }
  assert.match(r.stdout, /dossiers logés/);
});

test("CLI rebooking-v2 : commandes payantes refusées sans DEMO_ALLOW_PAID=1 (INV-8)", () => {
  for (const args of [[], ["--probe-discovery"], ["--probe-releve", "2"], ["--probe-capacity", "https://x", "--rooms", "12"], ["--probe-inventaire", "--max", "5"]]) {
    const r = run(CLI, "--station", "BKK", ...args);
    assert.equal(r.status, 1, `attendu refus pour « ${args.join(" ") || "(run complet)"} »`);
    assert.match(r.stderr, /refusé \(INV-8\)/);
    assert.match(r.stderr, /DEMO_ALLOW_PAID=1/);
  }
});

test("CLI inventaire : --refresh/--max refusés sans DEMO_ALLOW_PAID=1 ; modes gratuits inchangés", () => {
  for (const args of [["--refresh"], ["--max", "5"]]) {
    const r = run(CLI_INV, "--station", "BKK", ...args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusé \(INV-8\)/);
    assert.match(r.stderr, /DEMO_ALLOW_PAID=1/);
  }
  const sans = run(CLI_INV, "--station", "BKK");
  assert.equal(sans.status, 1);
  assert.match(sans.stderr, /préciser un mode/);
  const dry = run(CLI_INV, "--station", "BKK", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
});
