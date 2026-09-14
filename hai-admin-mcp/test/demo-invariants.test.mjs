/**
 * Invariants statiques de `demo/` (phase 4) :
 * - INV-7 : demo/ n'importe que des builtins `node:`, ses propres modules `./`
 *   et `../hai-admin-mcp/lib/` — jamais `hai-agents` ni `zod` en direct ;
 * - INV-9 : jamais `innerHTML` (le client construit ses nœuds en textContent).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

const DEMO = path.join(ROOT, "demo");

const demoModules = fs.readdirSync(DEMO).filter((f) => f.endsWith(".mjs"));

test("INV-7 : imports de demo/*.mjs limités à node:, ./ et ../hai-admin-mcp/lib/", () => {
  assert.ok(demoModules.length >= 5, "modules demo attendus");
  const importRe = /(?:^|\n)\s*import\s[^"']*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const f of demoModules) {
    const src = fs.readFileSync(path.join(DEMO, f), "utf8");
    for (const m of src.matchAll(importRe)) {
      const spec = m[1] ?? m[2];
      const allowed = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../hai-admin-mcp/lib/");
      assert.ok(allowed, `${f} importe « ${spec} » (interdit par INV-7)`);
      assert.ok(!/hai-agents|(^|\/)zod($|\/)/.test(spec), `${f} importe le SDK ou zod en direct (INV-7)`);
    }
  }
});

test("INV-7 : la fiche de phase impose les modules demo attendus", () => {
  for (const f of ["sse-hub.mjs", "run-manager.mjs", "session-pump.mjs", "simulate.mjs", "server.mjs"]) {
    assert.ok(demoModules.includes(f), `demo/${f} présent`);
  }
});

test("INV-9 : aucun innerHTML/outerHTML/insertAdjacentHTML dans demo/ (client compris)", () => {
  const files = [
    ...demoModules.map((f) => path.join(DEMO, f)),
    path.join(DEMO, "public", "app.js"),
    path.join(DEMO, "public", "index.html"),
  ];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), `${path.basename(file)} contient une écriture HTML interdite (INV-9)`);
  }
});

test("INV-9 : le client rend les textes d'agent via textContent", () => {
  const src = fs.readFileSync(path.join(DEMO, "public", "app.js"), "utf8");
  assert.ok(/textContent/.test(src));
});

test("sim-assets : les 4 captures PNG existent et sont des PNG valides", () => {
  const dir = path.join(DEMO, "sim-assets");
  const expected = ["capture-recherche.png", "capture-fiche.png", "capture-chambres.png", "capture-paiement.png"];
  for (const name of expected) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), `${name} présent`);
    const head = fs.readFileSync(file).subarray(0, 8);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} : signature PNG`);
  }
});

test("launch.json : configuration demo-bkk sur le port 4310", () => {
  const launch = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "launch.json"), "utf8"));
  const conf = launch.configurations.find((c) => c.name === "demo-bkk");
  assert.ok(conf, "configuration demo-bkk");
  assert.equal(conf.port, 4310);
  assert.deepEqual(conf.runtimeArgs, ["demo/server.mjs"]);
});
