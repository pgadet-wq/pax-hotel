/**
 * Serveur de démo (phase 4) — routes §9, gardes INV-8/INV-10, listes blanches,
 * proxy de captures (§11), presets, inventaire (EX-INV-8), SSE.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDemoServer } from "../../demo/server.mjs";
import { mkInv, mkInvEntry } from "./helpers.mjs";
import { DEFAULT_POLICY } from "../lib/policy.mjs";

const DEFAULT_POLICY_JSON = JSON.parse(JSON.stringify(DEFAULT_POLICY));

function tmpDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pax-srv-"));
  const dirs = {
    outDir: path.join(base, "out"),
    presetsDir: path.join(base, "presets"),
    inventaireDir: path.join(base, "inventaire"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(dirs.inventaireDir, "BKK.json"),
    JSON.stringify(mkInv([mkInvEntry("hotel-un"), mkInvEntry("hotel-deux", { preferred: true })]), null, 2),
    "utf8",
  );
  return dirs;
}

/** Serveur sur port éphémère + client fetch ; fermé par t.after. */
async function boot(t) {
  const app = createDemoServer({ port: 0, dirs: tmpDirs(), hub: undefined });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(() => app.close());
  const call = async (method, p, body, raw = false) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined && !raw ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    let data = null;
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("json")) data = await res.json();
    else data = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return { app, base, call };
}

const SIM_RUN = { scenario: { station: "BKK", simulate: true }, sim_speed: 1000 };

test("GET /api/config : défauts, stations triées, presets, runInProgress", async (t) => {
  const { call } = await boot(t);
  const { status, data } = await call("GET", "/api/config");
  assert.equal(status, 200);
  assert.equal(data.defaults.policy.version, 2);
  assert.equal(data.defaults.avion.nom, "A350-900");
  assert.deepEqual(data.stations.map((s) => s.code), ["BKK", "CDG", "NOU"], "ordre demo_priority (BKK d'abord)");
  assert.deepEqual(data.sim_stations, ["BKK"]);
  assert.equal(data.runInProgress, false);
});

test("statiques : liste blanche stricte", async (t) => {
  const { call, base } = await boot(t);
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Hébergement d'urgence/);
  assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal((await call("GET", "/app.js")).status, 200);
  assert.equal((await call("GET", "/style.css")).status, 200);
  assert.equal((await call("GET", "/inconnu.js")).status, 404);
  assert.equal((await call("GET", "/..%2fserver.mjs")).status, 404);
  assert.equal((await call("GET", "/demo/../package.json")).status, 404);
});

test("run simulé complet : 202 → 409 pendant, snapshot, messages, coût, téléchargements, captures", async (t) => {
  const { app, call } = await boot(t);
  const started = await call("POST", "/api/run", SIM_RUN);
  assert.equal(started.status, 202);
  const { runId } = started.data;
  assert.ok(runId);

  // INV-10 : double lancement refusé proprement
  const dbl = await call("POST", "/api/run", SIM_RUN);
  assert.equal(dbl.status, 409);
  assert.match(dbl.data.error, /run est déjà en cours/);
  // l'Étage 0 par agents est aussi bloqué par le 409 pendant un run
  assert.equal((await call("POST", "/api/inventaire/BKK/run", {})).status, 409);

  await app.manager.wait();

  const state = await call("GET", "/api/state");
  assert.equal(state.data.state, "done");
  assert.equal(state.data.plan.length, 157);
  assert.equal(state.data.outputs.length, 7); // + rooming-<runId>.csv (liste d'appel par hôtel)

  const fr = await call("GET", `/api/messages?runId=${runId}&lang=fr`);
  assert.equal(fr.data.count, 157);
  const all = await call("GET", `/api/messages?runId=${runId}`);
  assert.equal(all.data.count, 314);
  assert.equal((await call("GET", "/api/messages?runId=zz")).status, 404);

  const cout = await call("GET", `/api/cout?runId=${runId}`);
  assert.ok(cout.data.per_night.total > 0);
  assert.ok(cout.data.upper_bound_at_caps > 0);

  // téléchargements : liste blanche stricte, attachment
  const plan = await call("GET", `/api/outputs/plan-${runId}.csv`);
  assert.equal(plan.status, 200);
  assert.match(plan.headers.get("content-disposition"), /attachment/);
  assert.equal((await call("GET", "/api/outputs/plan-fantome.csv")).status, 404);
  assert.equal((await call("GET", "/api/outputs/..%2fBKK.json")).status, 404);

  // proxy captures : clés d'état, Cache-Control private, PNG réel
  const shot = await call("GET", "/api/screenshot?hotel=hyatt-regency-bkk-airport&seq=0");
  assert.equal(shot.status, 200);
  assert.match(shot.headers.get("cache-control"), /private/);
  assert.deepEqual([...shot.data.subarray(1, 4)], [0x50, 0x4e, 0x47], "signature PNG");
  assert.equal((await call("GET", "/api/screenshot?hotel=hyatt-regency-bkk-airport&seq=99")).status, 404);
  assert.equal((await call("GET", "/api/screenshot?hotel=zz&seq=0")).status, 404);

  // annulation hors run : 409 propre
  assert.equal((await call("POST", "/api/cancel", {})).status, 409);
});

test("SSE /api/events : snapshot à la connexion", async (t) => {
  const { base } = await boot(t);
  const ac = new AbortController();
  const res = await fetch(base + "/api/events", { signal: ac.signal });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: snapshot/);
  assert.match(text, /"state":"idle"/);
  ac.abort();
});

test("INV-8 : sans DEMO_ALLOW_PAID=1, run réel et Étage 0 par agents répondent 501 (phase 5)", async (t) => {
  const avant = process.env.DEMO_ALLOW_PAID;
  delete process.env.DEMO_ALLOW_PAID;
  t.after(() => {
    if (avant === undefined) delete process.env.DEMO_ALLOW_PAID;
    else process.env.DEMO_ALLOW_PAID = avant;
  });
  const { call } = await boot(t);
  const real = await call("POST", "/api/run", { scenario: { station: "BKK", simulate: false } });
  assert.equal(real.status, 501);
  assert.match(real.data.error, /INV-8/);
  assert.match(real.data.error, /DEMO_ALLOW_PAID/);
  const inv = await call("POST", "/api/inventaire/BKK/run", {});
  assert.equal(inv.status, 501);
  assert.match(inv.data.error, /INV-8/);
  assert.match(inv.data.error, /DEMO_ALLOW_PAID/);
});

test("EX-UI-1 : simulation hors BKK refusée avec proposition de dry-run", async (t) => {
  const { call } = await boot(t);
  const res = await call("POST", "/api/run", { scenario: { station: "NOU", simulate: true } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /fixtures non disponibles/);
  assert.equal(res.data.dry_run_available, true);
});

test("dry-run : 200 synchrone, besoins + URLs + extension théorique, aucun run", async (t) => {
  const { app, call } = await boot(t);
  const res = await call("POST", "/api/run", { scenario: { station: "BKK" }, dry_run: true });
  assert.equal(res.status, 200);
  assert.equal(res.data.dry_run, true);
  assert.equal(res.data.passagers, 324);
  assert.ok(res.data.needs.Y.chambres > 0);
  assert.ok(res.data.releves.length >= 1);
  assert.ok(res.data.releves.every((r) => r.url === null || /checkin=/.test(r.url)));
  assert.equal(res.data.extension.limits.sessions_max, 18);
  assert.equal(app.manager.isRunning(), false);
});

test("configuration invalide : 400 zod explicite", async (t) => {
  const { call } = await boot(t);
  const res = await call("POST", "/api/run", { scenario: { station: "XXX", simulate: true } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /configuration invalide/);
  const res2 = await call("POST", "/api/run", { scenario: { station: "BKK", nights: 99, simulate: true } });
  assert.equal(res2.status, 400);
});

test("presets : nom assaini [a-z0-9-]{1,40}, politique validée (GET|POST /api/presets)", async (t) => {
  const { call } = await boot(t);
  const cfg = await call("GET", "/api/config");
  const bad = await call("POST", "/api/presets", { name: "Politique Hiver!", policy: cfg.data.defaults.policy });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /nom de preset invalide/);
  const badPolicy = await call("POST", "/api/presets", { name: "hiver", policy: { version: 1 } });
  assert.equal(badPolicy.status, 400);
  const ok = await call("POST", "/api/presets", { name: "hiver-2026", policy: cfg.data.defaults.policy });
  assert.equal(ok.status, 200);
  const list = await call("GET", "/api/presets");
  assert.deepEqual(list.data.presets.map((p) => p.name), ["hiver-2026"]);
  assert.equal(list.data.presets[0].policy.version, 2);
});

test("passagers : génération A350 (324) et upload CSV rejoué au run", async (t) => {
  const { call } = await boot(t);
  const gen = await call("POST", "/api/generate-passengers", { seats: { J: 34, W: 24, Y: 266 }, seed: 42 });
  assert.equal(gen.status, 200);
  assert.equal(gen.data.stats.passagers, 324);
  assert.ok(gen.data.stats.pmr >= 1);
  const badSeats = await call("POST", "/api/generate-passengers", { seats: { J: -1, W: 0, Y: 0 } });
  assert.equal(badSeats.status, 400);

  const csv = "pnr;nom;prenom;type_pax;age;cabine;flying_blue;assistance;remarque\nZZ001AAA;TEST;Jean;ADT;44;Y;NONE;;\n";
  const up = await call("POST", "/api/passengers", csv, true);
  assert.equal(up.status, 200);
  assert.equal(up.data.stats.passagers, 1);
  assert.equal(up.data.stats.parCabine.Y, 1);
  const badCsv = await call("POST", "/api/passengers", "n'importe quoi", true);
  assert.equal(badCsv.status, 400);
});

test("EX-INV-8 : GET/PUT inventaire — drapeaux persistés, ajout manuel, entrée manuelle intouchable", async (t) => {
  const { app, call } = await boot(t);
  const before = await call("GET", "/api/inventaire/BKK");
  assert.equal(before.status, 200);
  assert.equal(before.data.inventaire.hotels.length, 2);
  assert.equal(before.data.stale, false);

  const put = await call("PUT", "/api/inventaire/BKK", {
    flags: { "hotel-un": { contracted: true, excluded: false } },
    add: [{ name: "Hôtel du Comptoir", url: "https://www.booking.com/hotel/th/comptoir.html", phone: "+66 2 000 000", contracted: true }],
  });
  assert.equal(put.status, 200);
  const hotels = put.data.inventaire.hotels;
  assert.equal(hotels.length, 3);
  const un = hotels.find((h) => h.id === "hotel-un");
  assert.equal(un.contracted, true);
  assert.equal(un.payment.company_payment_possible, "oui", "recalculée après drapeau contracté (EX-INV-4)");
  const manuel = hotels.find((h) => h.source === "manuel");
  assert.equal(manuel.name, "Hôtel du Comptoir");
  assert.equal(manuel.contact.phone, "+66 2 000 000");

  // persistance disque
  const onDisk = JSON.parse(fs.readFileSync(path.join(app.dirs.inventaireDir, "BKK.json"), "utf8"));
  assert.equal(onDisk.hotels.length, 3);

  // escale sans fichier : inventaire vide valide
  const nou = await call("GET", "/api/inventaire/NOU");
  assert.equal(nou.data.inventaire.hotels.length, 0);
  assert.equal(nou.data.stale, true);

  // ajout sans nom : refusé
  assert.equal((await call("PUT", "/api/inventaire/BKK", { add: [{ url: "https://x" }] })).status, 400);
});

test("liste passagers : le dry-run part de la liste TÉLÉVERSÉE, et la source survit au rechargement", async (t) => {
  const { call } = await boot(t);
  // dry-run sans téléversement : liste générée (comportement historique)
  const avant = await call("POST", "/api/run", { dry_run: true, scenario: { station: "BKK" }, avion: { nom: "A350-900", seats: { J: 34, W: 24, Y: 266 } } });
  assert.equal(avant.status, 200);
  assert.equal(avant.data.passagers, 324);
  assert.equal(avant.data.source_liste, "générée");

  const csv =
    "pnr;nom;prenom;type_pax;cabine;categorie;statut_pax;assistance;droit_entree\n" +
    "AA11BB;MARTIN;Jean;ADT;J;PAX;EMBARQUE;WCHS;OUI\n" +
    "AA11BB;MARTIN;Marie;ADT;J;PAX;EMBARQUE;;OUI\n" +
    "CC22DD;DUPONT;Luc;ADT;Y;PAX;NOSHOW;;OUI\n" +
    "CRW01;BERNARD;Ana;ADT;Y;PNC;EMBARQUE;;OUI\n";
  const up = await call("POST", "/api/passengers", csv, true);
  assert.equal(up.status, 200);
  assert.equal(up.data.stats.passagers, 2, "no-show et équipage sortent du plan passagers");
  assert.equal(up.data.stats.pmr, 1, "WCHS déclenche PMR");
  assert.equal(up.data.stats.equipage, 1);

  // le dry-run doit dimensionner sur CETTE liste, pas sur l'A350 généré
  const apres = await call("POST", "/api/run", { dry_run: true, passengers: "uploaded", scenario: { station: "BKK" } });
  assert.equal(apres.status, 200);
  assert.equal(apres.data.passagers, 2);
  assert.equal(apres.data.dossiers, 1);
  assert.equal(apres.data.source_liste, "téléversée");

  // la source vit côté serveur : un onglet rechargé la retrouve dans /api/config
  const cfg = await call("GET", "/api/config");
  assert.equal(cfg.data.uploaded.passagers, 2);
  assert.equal(cfg.data.uploaded.dossiers, 1);

  // liste illisible : 400 AVEC le rapport, et la liste précédente n'est pas conservée en douce
  const bad = await call("POST", "/api/passengers", "pnr;nom;type_pax;cabine\nZZ1;TEST;ADT;C\n", true);
  assert.equal(bad.status, 400);
  assert.ok(/cabine/.test(bad.data.error));
  assert.ok(bad.data.rapport.refus.length >= 1);
  const cfg2 = await call("GET", "/api/config");
  assert.equal(cfg2.data.uploaded, null);
});

test("rejeu gratuit : POST /api/replay rejoue l'allocation sur les relevés déjà payés, sans session", async (t) => {
  const { app, call } = await boot(t);
  const started = await call("POST", "/api/run", SIM_RUN);
  assert.equal(started.status, 202);
  const { runId } = started.data;
  await app.manager.wait();
  const base = (await call("GET", "/api/state")).data.planSummary;

  // même politique : même plan, en quelques millisecondes et 0 €
  const memePolitique = await call("POST", "/api/replay", { runId, scenario: { station: "BKK" } });
  assert.equal(memePolitique.status, 200);
  assert.equal(memePolitique.data.summary.ok, base.ok);
  assert.ok(memePolitique.data.duree_ms < 3000);
  assert.match(memePolitique.data.note, /aucune session/);

  // plafond Y relevé : c'est LA question de séance, et elle se répond sans repayer un run
  const plafondHaut = await call("POST", "/api/replay", {
    runId,
    scenario: { station: "BKK" },
    policy: { ...DEFAULT_POLICY_JSON, cabins: { ...DEFAULT_POLICY_JSON.cabins, Y: { ...DEFAULT_POLICY_JSON.cabins.Y, price_cap_eur: 200 } } },
  });
  assert.equal(plafondHaut.status, 200);
  assert.equal(plafondHaut.data.caps.Y, 200);
  assert.ok(plafondHaut.data.summary.ok >= base.ok, "un plafond plus haut ne loge jamais moins de monde");

  // run inconnu : 404 explicite, jamais un plan vide qui aurait l'air normal
  const inconnu = await call("POST", "/api/replay", { runId: "zzzzzz", scenario: { station: "BKK" } });
  assert.equal(inconnu.status, 404);
  assert.match(inconnu.data.error, /relevés introuvables/);
});
