/**
 * Serveur de démo (CDC §9) — `node:http` natif, port 4310, bind 127.0.0.1,
 * zéro dépendance. Routing par `switch` méthode + chemin, helpers `sendJson` /
 * `readBody`. Statiques et téléchargements en LISTE BLANCHE ; proxy de
 * captures par clés d'état internes (jamais une URL cliente, §11),
 * `Cache-Control: private`.
 *
 * Phase 5 : le run réel (`realCollect`) et l'Étage 0 par agents sont câblés,
 * DERRIÈRE `DEMO_ALLOW_PAID=1` côté serveur (INV-8) — sans elle, 501 comme en
 * phase 4. Les captures H (URL plateforme) sont relayées avec bearer par le
 * proxy, la clé ne quitte jamais le serveur (INV-4). INV-7 : ce fichier
 * n'importe que des builtins `node:` et `../hai-admin-mcp/lib/` (le SDK reste
 * confiné à `lib/hai.mjs`).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_POLICY, PolicySchema, effectiveCaps, AMENITY_KEYS, AMENITY_LABELS } from "../hai-admin-mcp/lib/policy.mjs";
import { DEFAULT_AVION, DEFAULT_SCENARIO, mergeConfig, resolveDates } from "../hai-admin-mcp/lib/scenario.mjs";
import { loadStation, listStations } from "../hai-admin-mcp/lib/stations.mjs";
import { loadInventaire, normalizeInventaire, isStale, candidatesFrom, slugify, INVENTAIRE_DIR } from "../hai-admin-mcp/lib/inventaire.mjs";
import { generatePassengers } from "../hai-admin-mcp/lib/passagers.mjs";
import { parsePassagersCsv } from "../hai-admin-mcp/lib/csv.mjs";
import { buildDossiers, computeNeeds } from "../hai-admin-mcp/lib/dossiers.mjs";
import { discoveryNeeded } from "../hai-admin-mcp/lib/discovery.mjs";
import { planExtension } from "../hai-admin-mcp/lib/capacite.mjs";
import { buildHotelUrl } from "../hai-admin-mcp/lib/hai-urls.mjs";
import { realCollect } from "../hai-admin-mcp/lib/pipeline.mjs";
import { createHub } from "./sse-hub.mjs";
import { createRunManager, HttpError } from "./run-manager.mjs";
import { createSimulation, loadSimInventaire, simAvailable, SIM_STATIONS } from "./simulate.mjs";
import { createInventaireRefresher } from "./inventaire-refresh.mjs";

/** Garde INV-8 côté serveur : sessions payantes seulement si le serveur a été
 * démarré avec DEMO_ALLOW_PAID=1 (accord explicite, phases 5-6 — jamais un défaut). */
const paidAllowed = () => process.env.DEMO_ALLOW_PAID === "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const PRESET_NAME = /^[a-z0-9-]{1,40}$/;
const MAX_BODY = 8 * 1024 * 1024; // upload CSV passagers compris

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req, { limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "corps de requête trop volumineux"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const parseJson = (text) => {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON invalide");
  }
};

/**
 * Fabrique le serveur (injectable pour les tests).
 * @param {object} [opts] {host, port, dirs: {publicDir, simAssetsDir, outDir, presetsDir, inventaireDir}, hub}
 */
export function createDemoServer(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4310;
  const dirs = {
    publicDir: path.join(HERE, "public"),
    simAssetsDir: path.join(HERE, "sim-assets"),
    outDir: path.join(ROOT, "out"),
    presetsDir: path.join(ROOT, "data", "presets"),
    inventaireDir: INVENTAIRE_DIR,
    ...(opts.dirs ?? {}),
  };
  const hub = opts.hub ?? createHub();
  const manager = createRunManager({ hub, outDir: dirs.outDir });
  const invRefresher = createInventaireRefresher({ hub, inventaireDir: dirs.inventaireDir });
  let uploadedRows = null; // dernière liste passagers téléversée (mémoire process)
  let haiClient = null; // client H partagé, créé au premier run réel (journal du point d'entrée EU)

  async function getHaiClient() {
    if (!haiClient) {
      const { createClient } = await import("../hai-admin-mcp/lib/hai.mjs");
      haiClient = createClient();
    }
    return haiClient;
  }

  // liste blanche des statiques : fichiers plats de demo/public, relevés au démarrage
  const staticFiles = new Set(
    fs.existsSync(dirs.publicDir) ? fs.readdirSync(dirs.publicDir).filter((f) => MIME[path.extname(f)]) : [],
  );

  /* ------------------------------------------------------------- handlers */

  function serveStatic(res, name) {
    if (!staticFiles.has(name)) return sendJson(res, 404, { error: "introuvable" });
    const file = path.join(dirs.publicDir, name);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(name)],
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'",
    });
    fs.createReadStream(file).pipe(res);
  }

  function getConfig(res) {
    sendJson(res, 200, {
      defaults: { policy: DEFAULT_POLICY, avion: DEFAULT_AVION, scenario: DEFAULT_SCENARIO },
      amenities: { keys: AMENITY_KEYS, labels: AMENITY_LABELS },
      stations: listStations().map((s) => ({
        code: s.code,
        name: s.name,
        demo_priority: s.demo_priority,
        search: s.search,
        transfer: s.transfer,
        pricing: s.pricing,
      })),
      presets: listPresets(),
      sim_stations: SIM_STATIONS,
      runInProgress: manager.isRunning(),
    });
  }

  function listPresets() {
    if (!fs.existsSync(dirs.presetsDir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dirs.presetsDir)) {
      if (!f.endsWith(".json")) continue;
      const name = f.slice(0, -5);
      if (!PRESET_NAME.test(name)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dirs.presetsDir, f), "utf8"));
        out.push({ name, saved_at: raw.saved_at ?? null, policy: PolicySchema.parse(raw.policy) });
      } catch {
        /* preset illisible : ignoré, jamais bloquant */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function savePreset(body, res) {
    const name = String(body.name ?? "").trim();
    if (!PRESET_NAME.test(name)) throw new HttpError(400, "nom de preset invalide (attendu : [a-z0-9-]{1,40})");
    let policy;
    try {
      policy = PolicySchema.parse(body.policy);
    } catch (err) {
      throw new HttpError(400, `politique invalide : ${err.issues?.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ") ?? err.message}`);
    }
    fs.mkdirSync(dirs.presetsDir, { recursive: true });
    const file = path.join(dirs.presetsDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ name, saved_at: new Date().toISOString(), policy }, null, 2) + "\n", "utf8");
    sendJson(res, 200, { saved: name });
  }

  function getInventaire(code, res) {
    const upper = String(code).toUpperCase();
    let inv;
    try {
      inv = loadInventaire(upper, { dir: dirs.inventaireDir });
    } catch (err) {
      throw new HttpError(500, String(err.message));
    }
    inv ??= { station: upper, updated_at: null, reference: null, hotels: [] };
    sendJson(res, 200, { inventaire: inv, stale: isStale(inv, DEFAULT_POLICY) });
  }

  /** PUT /api/inventaire/:code — drapeaux + ajouts manuels, persistés (EX-INV-8). */
  function putInventaire(code, body, res) {
    const upper = String(code).toUpperCase();
    const current = loadInventaire(upper, { dir: dirs.inventaireDir }) ?? { station: upper, updated_at: null, reference: null, hotels: [] };
    const flags = body.flags ?? {};
    for (const h of current.hotels) {
      const f = flags[h.id];
      if (!f) continue;
      for (const k of ["contracted", "preferred", "excluded"]) {
        if (typeof f[k] === "boolean") h[k] = f[k];
      }
    }
    for (const add of body.add ?? []) {
      const name = String(add.name ?? "").trim();
      if (!name) throw new HttpError(400, "ajout manuel : nom requis");
      let id = slugify(name);
      while (current.hotels.some((h) => h.id === id)) id = `${id.slice(0, 55)}-m${current.hotels.length}`;
      current.hotels.push({
        id,
        name,
        url: String(add.url ?? ""),
        source: "manuel",
        contracted: Boolean(add.contracted),
        preferred: Boolean(add.preferred),
        excluded: false,
        contact: { phone: add.phone ? String(add.phone) : null, email: add.email ? String(add.email) : null },
        notes: String(add.notes ?? ""),
      });
    }
    let normalized;
    try {
      normalized = normalizeInventaire(current, `inventaire ${upper}`);
    } catch (err) {
      throw new HttpError(400, String(err.message));
    }
    fs.mkdirSync(dirs.inventaireDir, { recursive: true });
    const file = path.join(dirs.inventaireDir, `${upper}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    sendJson(res, 200, { inventaire: normalized, stale: isStale(normalized, DEFAULT_POLICY) });
  }

  /** Dry-run synchrone (aucun agent) : besoins, inventaire, décision, URLs, extension théorique. */
  function dryRun({ policy, avion, scenario }) {
    const station = loadStation(scenario.station);
    const { checkin, checkout } = resolveDates(scenario);
    const rows = uploadedRowsFor(scenario) ?? generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
    const dossiers = buildDossiers(rows, policy);
    const needs = computeNeeds(dossiers);
    const inv = loadInventaire(station.code, { dir: dirs.inventaireDir });
    const decision = discoveryNeeded({ inv, policy, station, needs: needs.parTier, force: scenario.force_discovery });
    const candidates = candidatesFrom(inv, policy, { station, needs: needs.parTier });
    const maxB = policy.global.discovery.max_hotels_stage_b;
    const gaps = { chambresManquantes: Object.fromEntries(["J", "W", "Y"].map((t) => [t, needs.parTier[t]?.chambres ?? 0])) };
    const theorique = planExtension({
      gaps, inventories: [], candidates,
      surveyedKeys: new Set(candidates.slice(0, maxB).map((c) => c.id)), probedKeys: new Set(),
      policy, station, wave: 1, sessionsUsed: 0, costUsd: 0,
    });
    return {
      dry_run: true,
      station: { code: station.code, name: station.name },
      checkin, checkout, nights: scenario.nights,
      passagers: rows.length, dossiers: dossiers.length,
      caps: effectiveCaps(policy, station),
      needs: needs.parTier,
      inventaire: { hotels: inv?.hotels?.length ?? 0, updated_at: inv?.updated_at ?? null, stale: isStale(inv, policy) },
      discovery: decision,
      releves: candidates.slice(0, maxB).map((c) => ({
        name: c.name, tiers: c.tiers, fallback: c.fallback,
        url: c.url ? buildHotelUrl(c.url, { checkin, checkout }) : null,
      })),
      extension: { limits: theorique.limits, stop: theorique.stop, reason: theorique.reason, probes: theorique.probes.length, surveys: theorique.surveys.map((s) => s.name) },
    };
  }

  function uploadedRowsFor(scenarioOrBody) {
    return scenarioOrBody?.passengers === "uploaded" ? uploadedRows : null;
  }

  /** POST /api/run — validation zod, 202 {runId} | 409 | 400 ; dry-run 200. */
  async function postRun(body, res) {
    let config;
    try {
      config = mergeConfig(body);
    } catch (err) {
      throw new HttpError(400, `configuration invalide : ${err.issues?.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ") ?? err.message}`);
    }
    if (body.dry_run === true) return sendJson(res, 200, dryRun(config));

    const { policy, avion, scenario } = config;
    const station = loadStation(scenario.station);
    const rows = body.passengers === "uploaded" ? uploadedRows : null;
    if (body.passengers === "uploaded" && !rows) throw new HttpError(400, "aucune liste passagers téléversée");

    if (!scenario.simulate) {
      // INV-8 : sessions payantes seulement derrière DEMO_ALLOW_PAID=1 côté serveur (phases 5-6)
      if (!paidAllowed()) {
        throw new HttpError(501, "run réel refusé (INV-8) : sessions d'agents PAYANTES — démarrer le serveur avec DEMO_ALLOW_PAID=1 après accord explicite dans la conversation. Modes gratuits : simulation, dry-run.");
      }
      if (invRefresher.isRunning()) throw new HttpError(409, "un rafraîchissement d'inventaire est en cours (INV-10)");
      const client = await getHaiClient();
      const { runId } = manager.start({
        policy, avion, scenario, station, rows,
        simulate: false,
        collectFactory: () => realCollect(client),
      });
      return sendJson(res, 202, { runId, simulate: false });
    }
    if (!simAvailable(station.code)) {
      return sendJson(res, 400, {
        error: `fixtures non disponibles pour cette escale (${station.code}) — mode simulation limité à ${SIM_STATIONS.join(", ")}`,
        dry_run_available: true,
      });
    }
    const speed = Math.min(1000, Math.max(1, Number(body.sim_speed) || 1));
    const { runId } = manager.start({
      policy, avion, scenario, station, rows,
      inventaire: loadSimInventaire(),
      simulate: true,
      collectFactory: ({ signal, extensionSignal }) => createSimulation({ speed, signal, extensionSignal }),
    });
    sendJson(res, 202, { runId, simulate: true, sim_speed: speed });
  }

  /** GET /api/screenshot?hotel=&seq= — proxy par clés d'état internes (§11). */
  async function getScreenshot(query, res) {
    const entry = manager.captureSource(query.get("hotel"), query.get("seq"));
    if (!entry) return sendJson(res, 404, { error: "capture inconnue" }, { "Cache-Control": "private" });
    const headers = { "Content-Type": entry.mediaType || "image/png", "Cache-Control": "private, max-age=3600" };
    const source = String(entry.source ?? "");
    if (entry.imageType === "base64" && !source.startsWith("data:")) {
      // ImageContent {type: "base64"} : la source est la charge base64 nue (SDK, phase 5)
      res.writeHead(200, headers);
      res.end(Buffer.from(source, "base64"));
      return;
    }
    if (source.startsWith("sim-assets/")) {
      const name = path.basename(source); // aplati : aucun chemin client ne touche le disque
      const file = path.join(dirs.simAssetsDir, name);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "capture absente du disque" }, { "Cache-Control": "private" });
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (source.startsWith("data:")) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(source);
      if (!m) return sendJson(res, 404, { error: "capture illisible" }, { "Cache-Control": "private" });
      const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
      res.writeHead(200, { ...headers, "Content-Type": m[1] || headers["Content-Type"] });
      res.end(buf);
      return;
    }
    if (/^https:\/\//.test(source)) {
      // Captures H hébergées — relayées côté serveur avec bearer quand l'URL est sur la
      // plateforme (redirection S3 présignée suivie par fetch) ; la clé ne quitte jamais
      // le serveur (INV-4), le client ne voit que {hotel_key, seq} (§11).
      try {
        const { apiOrigin, readApiKey } = await import("../hai-admin-mcp/lib/hai.mjs");
        // bearer UNIQUEMENT vers l'origine de l'API H (INV-4) ; fetch suit la redirection
        // S3 présignée en retirant l'Authorization au changement d'origine
        const onPlatform = new URL(source).origin === new URL(apiOrigin()).origin;
        const upstream = await fetch(source, onPlatform ? { headers: { Authorization: `Bearer ${readApiKey()}` } } : undefined);
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        res.writeHead(200, { ...headers, "Content-Type": upstream.headers.get("content-type") ?? headers["Content-Type"] });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        sendJson(res, 502, { error: `capture inaccessible : ${err.message}` }, { "Cache-Control": "private" });
      }
      return;
    }
    sendJson(res, 404, { error: "source de capture non prise en charge" }, { "Cache-Control": "private" });
  }

  function getOutput(name, res) {
    if (!manager.isOutputAllowed(name)) return sendJson(res, 404, { error: "fichier inconnu de ce serveur" });
    const file = path.join(dirs.outDir, path.basename(name));
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: "fichier absent du disque" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(name)] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(name)}"`,
      "Cache-Control": "private",
    });
    fs.createReadStream(file).pipe(res);
  }

  /* --------------------------------------------------------------- routage */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    const key = `${req.method} ${p}`;
    try {
      // routes exactes d'abord
      switch (key) {
        case "GET /":
          return serveStatic(res, "index.html");
        case "GET /api/config":
          return getConfig(res);
        case "GET /api/stations":
          return sendJson(res, 200, { stations: listStations() });
        case "GET /api/presets":
          return sendJson(res, 200, { presets: listPresets() });
        case "POST /api/presets":
          return savePreset(parseJson(await readBody(req)), res);
        case "POST /api/generate-passengers": {
          const body = parseJson(await readBody(req));
          const seats = body.seats ?? DEFAULT_AVION.seats;
          for (const t of ["J", "W", "Y"]) {
            const n = seats[t];
            if (!Number.isInteger(n) || n < 0 || n > 600) throw new HttpError(400, `sièges ${t} invalides (entier 0-600 attendu)`);
          }
          const seed = Number.isInteger(body.seed) ? body.seed : 42;
          const { stats } = generatePassengers({ seats, seed, fill: "exact" });
          return sendJson(res, 200, { stats });
        }
        case "POST /api/passengers": {
          const text = await readBody(req);
          let rows;
          try {
            rows = parsePassagersCsv(text);
          } catch (err) {
            throw new HttpError(400, String(err.message));
          }
          uploadedRows = rows;
          const parCabine = { J: 0, W: 0, Y: 0 };
          for (const r of rows) parCabine[r.cabine] = (parCabine[r.cabine] ?? 0) + 1;
          return sendJson(res, 200, { stats: { passagers: rows.length, dossiers: new Set(rows.map((r) => r.pnr)).size, parCabine } });
        }
        case "POST /api/run":
          return await postRun(parseJson(await readBody(req)), res);
        case "POST /api/cancel":
          return sendJson(res, 200, manager.cancel());
        case "POST /api/cancel-extension":
          return sendJson(res, 200, manager.cancelExtension());
        case "GET /api/events":
          return hub.handle(req, res, manager.snapshot);
        case "GET /api/state":
          return sendJson(res, 200, manager.snapshot());
        case "GET /api/screenshot":
          return await getScreenshot(url.searchParams, res);
        case "GET /api/messages": {
          const r = manager.result(url.searchParams.get("runId"));
          if (!r) throw new HttpError(404, "runId inconnu");
          const lang = url.searchParams.get("lang");
          const messages = lang ? r.messages.filter((m) => m.lang === lang) : r.messages;
          return sendJson(res, 200, { count: messages.length, messages });
        }
        case "GET /api/cout": {
          const r = manager.result(url.searchParams.get("runId"));
          if (!r) throw new HttpError(404, "runId inconnu");
          return sendJson(res, 200, r.cost);
        }
        default:
          break;
      }
      // routes à segment
      let m;
      if ((m = /^\/api\/inventaire\/([A-Za-z]{3})$/.exec(p))) {
        if (req.method === "GET") return getInventaire(m[1], res);
        if (req.method === "PUT") return putInventaire(m[1], parseJson(await readBody(req)), res);
      }
      if ((m = /^\/api\/inventaire\/([A-Za-z]{3})\/run$/.exec(p)) && req.method === "POST") {
        if (manager.isRunning()) throw new HttpError(409, "un run est déjà en cours (INV-10)");
        if (!paidAllowed()) {
          throw new HttpError(501, "Étage 0 par agents refusé (INV-8) : sessions PAYANTES — démarrer le serveur avec DEMO_ALLOW_PAID=1 après accord explicite. L'ajout manuel et les drapeaux restent disponibles.");
        }
        const body = parseJson(await readBody(req));
        const station = loadStation(m[1].toUpperCase());
        const started = invRefresher.start({ client: await getHaiClient(), station, policy: DEFAULT_POLICY, max: body.max });
        return sendJson(res, 202, started);
      }
      if ((m = /^\/api\/outputs\/([A-Za-z0-9._-]{1,80})$/.exec(p)) && req.method === "GET") {
        return getOutput(m[1], res);
      }
      if (req.method === "GET" && /^\/[A-Za-z0-9._-]{1,64}$/.test(p)) {
        return serveStatic(res, p.slice(1));
      }
      sendJson(res, 404, { error: "route inconnue" });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      sendJson(res, 500, { error: `erreur serveur : ${String(err?.message ?? err)}` });
    }
  });

  return {
    server,
    hub,
    manager,
    dirs,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/* ------------------------------------------------------- lancement direct */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // CDC §17 : en service systemd, PORT et BIND viennent de /etc/pax-hotel.env (EnvironmentFile).
  const bind = process.env.BIND || "127.0.0.1";
  const portRaw = process.env.PORT || "4310";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PORT invalide : « ${portRaw} » (entier 1-65535 attendu)`);
    process.exit(1);
  }
  const app = createDemoServer({ host: bind, port });
  const addr = await app.listen();
  console.log(
    `Démo v2 — http://${addr.address}:${addr.port} (simulation BKK gratuite ; run réel et Étage 0 par agents : ` +
      `${paidAllowed() ? "AUTORISÉS (DEMO_ALLOW_PAID=1, sessions payantes)" : "verrouillés — INV-8, démarrer avec DEMO_ALLOW_PAID=1 après accord explicite"})`,
  );
}
