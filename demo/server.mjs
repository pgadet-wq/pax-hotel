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
import * as nodeCrypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY, PolicySchema, effectiveCaps, AMENITY_KEYS, AMENITY_LABELS,
  CRITERE_KEYS, CRITERE_LABELS, CRITERES_DEFAUT,
} from "../hai-admin-mcp/lib/policy.mjs";
import { DEFAULT_AVION, DEFAULT_SCENARIO, mergeConfig, resolveDates, stationClock, contexteEscale } from "../hai-admin-mcp/lib/scenario.mjs";
import { loadStation, listStations, couronnesDe } from "../hai-admin-mcp/lib/stations.mjs";
import { loadInventaire, normalizeInventaire, mergeInventaire, reconcileIds, isStale, candidatesFrom, slugify, capaciteIndicative, INVENTAIRE_DIR } from "../hai-admin-mcp/lib/inventaire.mjs";
import { generatePassengers } from "../hai-admin-mcp/lib/passagers.mjs";
import { ingestPassagers, IngestError } from "../hai-admin-mcp/lib/paxlist.mjs";
import {
  buildDossiers, computeNeeds, avertissementsDe, chambresHorsPortee, FILE_REPLI, FILE_REPLI_LABEL,
} from "../hai-admin-mcp/lib/dossiers.mjs";
import { allocate } from "../hai-admin-mcp/lib/allocate.mjs";
import { computeCost } from "../hai-admin-mcp/lib/cout.mjs";
import { preflightUrls } from "../hai-admin-mcp/lib/preflight.mjs";
import { discoveryNeeded } from "../hai-admin-mcp/lib/discovery.mjs";
import { planExtension } from "../hai-admin-mcp/lib/capacite.mjs";
import { buildHotelUrl, buildSearchPlan, HYPOTHESE_FILTRE_PRIX, NFLT_CODES_RELEVES_LE, sourcesActives } from "../hai-admin-mcp/lib/hai-urls.mjs";
import { realCollect, fixturesCollect } from "../hai-admin-mcp/lib/pipeline.mjs";
import { readLiteApiKey, construireVivier, COORD_ESCALES } from "../hai-admin-mcp/lib/liteapi.mjs";
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

function readBody(req, { limit = MAX_BODY, raw = false } = {}) {
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
    req.on("end", () => resolve(raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
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
  // `policy` sert UNIQUEMENT ici à `retention.purge_on_start` : chaque run purge ensuite
  // selon SA propre politique.
  const manager = createRunManager({ hub, outDir: dirs.outDir, policy: DEFAULT_POLICY });
  const invRefresher = createInventaireRefresher({ hub, inventaireDir: dirs.inventaireDir });
  let uploadedRows = null; // dernière liste passagers téléversée (mémoire process)
  let uploadedInfo = null; // résumé d'ingestion exposé à l'UI (jamais nominatif)
  let uploadedRapport = null; // rapport d'ingestion complet, repris tel quel dans le rapport de run
  let haiClient = null; // client H partagé, créé au premier run réel (journal du point d'entrée EU)
  /* INV-10 pendant la CONSTRUCTION du vivier par API. `manager.isRunning()` ne couvre pas
   * cette phase : elle dure une quinzaine de secondes d'appels et précède `manager.start`.
   * Sans ce verrou, un second clic sur « lancer » déclenchait un second balayage complet —
   * constaté en séance : sept runs en quatre-vingts secondes, et autant d'appels inutiles
   * à un fournisseur dont la gratuité dépend d'un ratio d'usage raisonnable. */
  let vivierApiEnCours = false;

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
      // POLITIQUE DE PRISE EN CHARGE : le vocabulaire des cases à cocher, servi par le
      // serveur pour que l'interface n'en recopie jamais une version divergente. `rang`
      // (ordre de service) et `proximite` (droit aux couronnes proches) sont DEUX
      // réglages distincts — l'interface doit le dire à l'écran.
      prise_en_charge: { keys: CRITERE_KEYS, labels: CRITERE_LABELS, defaut: CRITERES_DEFAUT },
      stations: listStations().map((s) => ({
        code: s.code,
        name: s.name,
        demo_priority: s.demo_priority,
        search: s.search,
        transfer: s.transfer,
        pricing: s.pricing,
        timezone: s.timezone,
        // COURONNES effectives : `source: "declaree"` = l'exploitation les a fichées,
        // `"derivee"` = repli calculé sur le rayon, qui n'est PAS une déclaration.
        // Les `trajet_min` sont DÉCLARÉS, jamais mesurés (aucun service de routage ici).
        couronnes: couronnesDe(s),
      })),
      presets: listPresets(),
      sim_stations: SIM_STATIONS,
      uploaded: uploadedInfo,
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

  /**
   * Couverture de repli si le moteur n'en rend pas (version de `discovery.mjs`
   * antérieure au contrat de vague 2) : même forme, et un avertissement NOMMÉ
   * plutôt qu'un chiffre qui aurait l'air officiel.
   */
  function couvertureDeRepli(needs, candidates) {
    const demandees = ["J", "W", "Y"].reduce((n, t) => n + (needs.parTier[t]?.chambres ?? 0), 0);
    const cap = capaciteIndicative(candidates);
    return {
      hotels: cap.hotels, indicatives: cap.total, relevees: cap.connue, supposees: cap.estimee,
      demandees, suffisante: demandees <= 0 ? true : cap.total >= demandees,
      avertissement: "couverture recalculée par le serveur : le moteur de découverte ne l'a pas rendue",
    };
  }

  /**
   * Plan de recherche C1 : les URLs réellement envoyées, passe par passe, avec
   * les filtres appliqués, ceux qui ne sont PAS filtrables, le rayon réellement
   * transmis et l'hypothèse de syntaxe du filtre de prix. Fonction pure, aucun réseau.
   */
  function planDeRecherche({ policy, station, checkin, checkout, needs }) {
    try {
      // la passe PMR n'est demandée que si des dossiers PMR existent réellement
      // (file « pmr » de computeNeeds) ; sinon `null` = selon l'overlay de politique
      // `parCritere` et non `parFile` : un PMR servi en file « correspondance_serree »
      // reste un PMR, et la recherche doit lui chercher une chambre accessible. La
      // lecture par file le manquait dès que la correspondance passait devant.
      const pmr = (needs?.parCritere?.pmr?.dossiers ?? needs?.parFile?.pmr?.dossiers ?? 0) > 0 ? true : null;
      const plan = buildSearchPlan({ policy, station, checkin, checkout, needs: needs.parTier, pmr });
      return { ...plan, hypothese_prix: HYPOTHESE_FILTRE_PRIX, codes_releves_le: plan.codes_releves_le ?? NFLT_CODES_RELEVES_LE };
    } catch (err) {
      // une URL non constructible est une information d'exploitation, pas une panne du dry-run
      return { erreur: `plan de recherche non constructible : ${String(err?.message ?? err)}`, passes: [] };
    }
  }

  /**
   * Horloge de l'escale, sous les DEUX formes que `buildDossiers` sait recouper :
   * l'instant absolu (`maintenant`) et l'horloge MURALE de l'escale (`maintenantLocal`),
   * cadre de `heure_correspondance`. Sans elles, aucun budget de trajet n'est calculé et
   * aucune correspondance n'est protégée — c'est le câblage, pas une option d'affichage.
   * @returns {{horloge: object, maintenant: Date, maintenantLocal: string|null}}
   */
  function horlogeEscale(station, now = new Date()) {
    const horloge = stationClock(now, station.timezone);
    // heure vide = fuseau refusé par Intl : on ne fabrique pas une horloge murale fausse
    const maintenantLocal = horloge.heure ? `${horloge.date}T${horloge.heure}` : null;
    return { horloge, maintenant: now, maintenantLocal };
  }

  /**
   * Ce que la POLITIQUE DE PRISE EN CHARGE produit réellement sur cette liste : quels
   * critères sont cochés, combien de dossiers chacun attrape, combien de chambres doivent
   * rester proches, et ce que chaque couronne DÉCLARÉE laisse hors de portée.
   *
   * Aucun temps de trajet n'est mesuré ici : les `trajet_min` des couronnes sont des
   * déclarations d'exploitation, et l'interface doit les présenter comme telles.
   */
  function lecturePriseEnCharge({ policy, station, dossiers, needs }) {
    const pec = policy.global.prise_en_charge ?? { criteres: [], age_bas_max: 6, elargir_si_insuffisant: true };
    const { couronnes, source } = couronnesDe(station);
    const criteres = [...(pec.criteres ?? [])]
      .sort((a, b) => a.rang - b.rang || String(a.cle).localeCompare(String(b.cle)))
      .map((c) => ({
        ...c,
        libelle: CRITERE_LABELS[c.cle] ?? c.cle,
        // `parCritere` compte les critères SATISFAITS, pas seulement ceux qui ont donné
        // la file : c'est le chiffre qui dit ce que la case à cocher change vraiment.
        satisfait: needs.parCritere?.[c.cle] ?? null,
        file: needs.parFile?.[c.cle] ?? null,
      }));
    return {
      criteres,
      age_bas_max: pec.age_bas_max,
      elargir_si_insuffisant: pec.elargir_si_insuffisant,
      correspondance: policy.global.correspondance ?? null,
      // file de repli : les dossiers qu'aucune case cochée n'attrape
      repli: { cle: FILE_REPLI, libelle: FILE_REPLI_LABEL, besoins: needs.parFile?.[FILE_REPLI] ?? null },
      couronnes: {
        source,
        liste: couronnes.map((c) => ({
          rang: c.rang, rayon_m: c.rayon_m, trajet_min_declare: c.trajet_min, mode: c.mode, note: c.note,
          // ce que cette couronne ne peut PAS accueillir, budgets de trajet en main
          hors_portee: chambresHorsPortee(needs, c.trajet_min),
        })),
      },
      trajet: needs.parTrajet ?? null,
      total: needs.total ?? null,
      avertissements: avertissementsDe(dossiers),
    };
  }

  /** Dry-run synchrone (aucun agent) : besoins, inventaire, décision, URLs, extension théorique. */
  function dryRun({ policy, avion, scenario }, body = {}) {
    const station = loadStation(scenario.station);
    const { checkin, checkout } = resolveDates(scenario, new Date(), station.timezone);
    // la source de liste vient de la RACINE du corps : `ScenarioSchema` ne déclare pas
    // `passengers`, zod la supprimerait du scénario (le dry-run partirait sur la liste générée)
    const rows = uploadedRowsFor(body) ?? generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
    // HEURE DE L'ESCALE injectée : sans elle, `trajet_max_min` reste null partout et le
    // dry-run annoncerait « aucune contrainte de distance » pour tout le monde.
    const { horloge, maintenant, maintenantLocal } = horlogeEscale(station);
    const dossiers = buildDossiers(rows, policy, { maintenant, maintenantLocal });
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
      source_liste: uploadedRowsFor(body) ? "téléversée" : "générée",
      uploaded: uploadedInfo,
      heure_escale: horloge,
      // POLITIQUE DE PRISE EN CHARGE : les cases cochées, ce qu'elles attrapent, les
      // couronnes DÉCLARÉES de l'escale et ce qu'elles laissent hors de portée.
      prise_en_charge: lecturePriseEnCharge({ policy, station, dossiers, needs }),
      // C2 — la couverture est celle que le MOTEUR a jugée (`discoveryNeeded`), pas une
      // seconde arithmétique parallèle qui pourrait diverger de la décision affichée.
      // `supposees` = hôtels sans indice de capacité comptés au plafond d'affichage :
      // une hypothèse de cadrage, jamais une mesure — l'écran doit le dire.
      couverture: decision.couverture ?? couvertureDeRepli(needs, candidates),
      // C1/§6 — l'URL de recherche RÉELLEMENT construite, ce qui est filtré et ce qui
      // ne peut PAS l'être : l'opérateur ne doit plus payer à l'aveugle.
      recherche: planDeRecherche({ policy, station, checkin, checkout, needs }),
      // SOURCES — chaque source cochée est AU MOINS une session d'agent payante à la
      // découverte. L'opérateur doit le voir avant de lancer, pas le découvrir sur la facture.
      sources: (() => {
        const { sources, avertissements } = sourcesActives(policy, station, {
          rayonM: policy.global?.discovery?.radius_m ?? null,
        });
        return {
          actives: sources.map((x) => ({
            cle: x.cle, nature: x.nature, rang: x.rang, max_candidats: x.max_candidats,
            entree: x.entree, filtres_releves: x.filtres_releves,
          })),
          sessions_decouverte_min: sources.length,
          plateformes: sources.filter((x) => x.nature === "plateforme").length,
          annuaires: sources.filter((x) => x.nature === "annuaire").length,
          note: sources.some((x) => x.nature === "annuaire")
            ? "un annuaire rend des LEADS : nom, adresse et téléphone, aucun prix public — ils ne sont pas alloués au plan (INV-3) mais forment le vivier à appeler"
            : "",
          avertissements,
        };
      })(),
      // C5 — la seule borne d'horloge que le run appliquera vraiment.
      bornes: {
        minutes_max: policy.extension?.max_minutes_per_run ?? null,
        sessions_max: policy.extension?.max_sessions_per_run ?? null,
        cout_max_usd: policy.extension?.max_cost_usd_per_run ?? null,
        vagues_max: policy.extension?.max_waves ?? null,
        note_duree:
          "durée ESTIMÉE non calculée ici : la seule base de mesure du dépôt est MESURES_REELLES " +
          "dans hai-admin-mcp/tools/rebooking-v2.mjs, que demo/ ne peut pas importer (INV-7). " +
          "Pour une estimation chiffrée : node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run",
      },
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
    if (body.dry_run === true) {
      // même refus que le run réel : un dry-run qui replie en silence sur la liste
      // générée donnerait un dimensionnement de passagers qui n'existent pas
      if (body.passengers === "uploaded" && !uploadedRows) throw new HttpError(400, "aucune liste passagers téléversée");
      return sendJson(res, 200, dryRun(config, body));
    }

    const { policy, avion, scenario } = config;
    const station = loadStation(scenario.station);
    const rows = body.passengers === "uploaded" ? uploadedRows : null;
    if (body.passengers === "uploaded" && !rows) throw new HttpError(400, "aucune liste passagers téléversée");

    /* Vivier par API hôtelière (LiteAPI). Ni agent, ni simulation : de vraies fiches et de
     * vrais tarifs publics, obtenus par une API en libre-service. AUCUNE session payante
     * n'est lancée, donc INV-8 n'est pas concerné ; INV-1 non plus, l'adaptateur n'appelle
     * que des points d'entrée de recherche. Le vivier est construit AVANT le run, écrit
     * dans l'inventaire de l'escale, puis rejoué par `fixturesCollect` — le même chemin,
     * déjà testé, que le mode hors ligne. */
    if (body.source === "api") {
      // INV-10 vérifié AVANT le premier appel réseau, pas seulement à `manager.start`
      if (manager.isRunning()) throw new HttpError(409, "un run est déjà en cours (INV-10)");
      if (vivierApiEnCours) throw new HttpError(409, "un vivier par API est déjà en construction — attendre sa fin (INV-10)");
      if (invRefresher.isRunning()) throw new HttpError(409, "un rafraîchissement d'inventaire est en cours (INV-10)");
      const coord = COORD_ESCALES[station.code];
      if (!coord) {
        throw new HttpError(400, `coordonnées inconnues pour l'escale ${station.code} — le vivier par API en a besoin (connues : ${Object.keys(COORD_ESCALES).join(", ")})`);
      }
      let cle;
      try {
        cle = readLiteApiKey();
      } catch (err) {
        throw new HttpError(501, `vivier par API indisponible : ${String(err.message)}`);
      }
      const { checkin, checkout, nights } = resolveDates(scenario, station);
      let vivier;
      vivierApiEnCours = true;
      try {
        vivier = await construireVivier({
          station: station.code, coord, checkin, checkout, nuits: nights,
          rayonM: Math.round((station.search?.radius_km ?? 40) * 1000) || 40000,
          cle, slugify,
          onProgress: (etape, data) => hub.publish({ type: "log", etape, ...data }),
        });
      } finally {
        // le verrou tombe même en cas d'échec : sinon un appel raté bloquait tous les suivants
        vivierApiEnCours = false;
      }
      if (!vivier.records.length) {
        throw new HttpError(502, "l'API hôtelière n'a rendu aucun établissement exploitable — vérifier la clé, l'escale et les dates");
      }
      /* Le moteur choisit ses CANDIDATS dans l'inventaire de l'escale : les entrées de
       * l'API doivent donc s'y trouver. Elles y entrent EN MÉMOIRE, jamais sur disque —
       * `data/inventaire/<escale>.json` est versionné, et une écriture le salissait à
       * chaque run : arbre git modifié après une démonstration, et surtout suite de tests
       * en échec (un test vérifie que l'inventaire LIVRÉ ne contient que des entrées
       * `agent`). Le mode simulation passe son inventaire de la même façon.
       * La persistance délibérée reste possible par `tools/liteapi-releves.mjs
       * --ecrire-inventaire`, où l'opérateur la demande explicitement. */
      const existant = loadInventaire(station.code, { dir: dirs.inventaireDir });
      const fusion = mergeInventaire(existant, { ...vivier.inventaire, hotels: reconcileIds(existant, vivier.entrees) });

      const { runId } = manager.start({
        policy, avion, scenario, station, rows, ingestion: rows ? uploadedRapport : null,
        empreintePax: rows ? empreintePax(rows) : null,
        inventaire: fusion,
        simulate: false,
        collectFactory: () => fixturesCollect(vivier.records),
      });
      return sendJson(res, 202, {
        runId, simulate: false, source: "api",
        vivier: { hotels: vivier.records.length, chambres: vivier.chambres, sandbox: vivier.sandbox },
        avertissements: vivier.avertissements,
      });
    }

    if (!scenario.simulate) {
      // INV-8 : sessions payantes seulement derrière DEMO_ALLOW_PAID=1 côté serveur (phases 5-6)
      if (!paidAllowed()) {
        throw new HttpError(501, "run réel refusé (INV-8) : sessions d'agents PAYANTES — démarrer le serveur avec DEMO_ALLOW_PAID=1 après accord explicite dans la conversation. Modes gratuits : simulation, dry-run.");
      }
      if (invRefresher.isRunning()) throw new HttpError(409, "un rafraîchissement d'inventaire est en cours (INV-10)");
      const client = await getHaiClient();
      const { runId } = manager.start({
        policy, avion, scenario, station, rows, ingestion: rows ? uploadedRapport : null,
        empreintePax: rows ? empreintePax(rows) : null,
        // filet gratuit : les fiches mortes sont écartées avant la première session payante
        preflight: (candidats) => preflightUrls(candidats, { timeoutMs: 8000, concurrency: 6 }),
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
      policy, avion, scenario, station, rows, ingestion: rows ? uploadedRapport : null,
      empreintePax: rows ? empreintePax(rows) : null,
      inventaire: loadSimInventaire(),
      simulate: true,
      collectFactory: ({ signal, extensionSignal }) => createSimulation({ speed, signal, extensionSignal }),
    });
    sendJson(res, 202, { runId, simulate: true, sim_speed: speed });
  }

  /**
   * POST /api/replay — rejoue l'ALLOCATION sur les relevés déjà payés d'un run.
   * Aucune session, aucun euro : c'est la réponse à « et si on montait le plafond Y ? »,
   * qui coûtait sinon un run complet (25 min, ~2,5 $, et un stock Booking qui a bougé).
   */
  /** Empreinte non nominative d'une liste : de quoi dire « ce n'est pas la meme liste ». */
  function empreintePax(rows) {
    const cle = rows.map((r) => `${r.pnr}|${r.cabine}|${r.type_pax}`).sort().join(";");
    return {
      passagers: rows.length,
      dossiers: new Set(rows.map((r) => r.pnr)).size,
      empreinte: createHashSync(cle),
    };
  }
  function createHashSync(texte) {
    // eslint-disable-next-line no-undef
    const { createHash } = nodeCrypto;
    return createHash("sha256").update(texte).digest("hex").slice(0, 12);
  }
  function lireEmpreintePax(runId) {
    const f = path.join(dirs.outDir, `pax-${runId}.json`);
    if (!fs.existsSync(f)) return null;
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  }

  function postReplay(body, res) {
    const runId = String(body.runId ?? "").replace(/[^a-z0-9]/gi, "");
    if (!runId) throw new HttpError(400, "runId manquant");
    const fichier = path.join(dirs.outDir, `releves-${runId}.json`);
    if (!fs.existsSync(fichier)) throw new HttpError(404, `relevés introuvables pour le run ${runId} (fichier out/releves-${runId}.json)`);
    let inventories;
    try {
      inventories = JSON.parse(fs.readFileSync(fichier, "utf8"));
    } catch (err) {
      throw new HttpError(500, `relevés illisibles : ${String(err.message)}`);
    }
    let config;
    try {
      config = mergeConfig(body);
    } catch (err) {
      throw new HttpError(400, `politique invalide : ${err.issues?.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ") ?? err.message}`);
    }
    const { policy, avion, scenario } = config;
    const station = loadStation(scenario.station);
    // La liste doit etre CELLE du run rejoue. Un repli silencieux sur une liste generee
    // repondait « 157 loges / 0 escalade » la ou la vraie liste donnait 176/62 : une
    // fausse reponse flatteuse a la question de seance.
    if (body.passengers === "uploaded" && !uploadedRows) throw new HttpError(400, "aucune liste passagers televersee");
    const empreinteRun = lireEmpreintePax(runId);
    if (body.passengers !== "uploaded" && empreinteRun) {
      throw new HttpError(409, `ce run a ete joue sur une liste televersee (${empreinteRun.passagers} passagers, ${empreinteRun.dossiers} dossiers) : rejouez-le avec passengers:"uploaded", sinon la comparaison porte sur des passagers qui n'existent pas`);
    }
    const rows = uploadedRowsFor(body) ?? generatePassengers({ seats: avion.seats, seed: scenario.seed, fill: "exact" }).rows;
    const t0 = Date.now();
    // même câblage que le dry-run : sans l'heure de l'escale, le rejeu hors ligne
    // montrerait un plan sans aucun budget de trajet, donc sans la protection qu'on rejoue
    const { maintenant, maintenantLocal } = horlogeEscale(station);
    const dossiers = buildDossiers(rows, policy, { maintenant, maintenantLocal });
    const alloc = allocate({ dossiers, inventories, policy, station, nights: scenario.nights, provisoire: false });
    const cost = computeCost(alloc.plan, policy, scenario, { avion, station });
    return sendJson(res, 200, {
      runId,
      source_liste: uploadedRowsFor(body) ? "téléversée" : "générée",
      passagers: rows.length,
      dossiers: dossiers.length,
      liste_du_run: empreinteRun ?? null,
      liste_differente: Boolean(empreinteRun && empreinteRun.empreinte !== empreintePax(rows).empreinte),
      duree_ms: Date.now() - t0,
      caps: effectiveCaps(policy, station),
      summary: alloc.summary,
      gaps: alloc.gaps,
      // politique incohérente, horaires illisibles, horloge d'escale absente : jamais tus
      avertissements_politique: avertissementsDe(dossiers),
      cost,
      hotels: [...new Set(alloc.plan.filter((r) => r.statut === "OK").map((r) => r.hotel))].length,
      note: "rejeu hors ligne sur les relevés déjà payés — aucune session d'agent, 0 $",
    });
  }

  /**
   * GET /api/health — état d'exploitation AVANT de payer : clé présente, longueur et
   * empreinte (jamais la clé), garde INV-8, et quota H si l'appel gratuit répond.
   * L'incident du 16/09 (clé tronquée à la saisie) a coûté 10 minutes de séance et
   * une cascade de 403 indiscernables d'échecs d'hôtels.
   */
  async function getHealth(res) {
    // MEME source que le run : `readApiKey()` se replie sur ~/.config/hai/.env quand la
    // variable d'environnement est absente — lire seulement process.env annoncait
    // « cle absente » sur une installation qui marche.
    let brute = "";
    let source = "aucune";
    if (process.env.HAI_API_KEY) {
      brute = process.env.HAI_API_KEY;
      source = "variable d'environnement";
    } else {
      try {
        const { readApiKey } = await import("../hai-admin-mcp/lib/hai.mjs");
        brute = readApiKey() ?? "";
        if (brute) source = "~/.config/hai/.env";
      } catch {
        /* pas de cle lisible : verdict « cle absente » */
      }
    }
    const cle = String(brute).trim();
    const out = {
      paid_allowed: paidAllowed(),
      cle_source: source,
      cle_presente: Boolean(cle),
      cle_longueur: cle.length,
      cle_espaces_parasites: cle.length !== brute.length,
      cle_empreinte: null,
      quota: null,
      verdict: "clé absente",
    };
    if (cle) {
      const { createHash } = await import("node:crypto");
      out.cle_empreinte = createHash("sha256").update(cle).digest("hex").slice(0, 8);
      out.verdict = "clé présente — non vérifiée auprès de H";
      if (/^(a_saisir|xxx|todo|changeme)/i.test(cle)) out.verdict = "clé de remplacement (placeholder) : le run échouerait en 403";
    }
    if (cle && out.verdict.startsWith("clé présente")) {
      try {
        const client = await getHaiClient();
        const quota = await (client.quota?.getTokenQuota?.() ?? client.sessions?.getSessionQuota?.() ?? Promise.reject(new Error("aucun point de quota exposé par le SDK")));
        out.quota = quota ?? null;
        out.verdict = "clé VALIDE (quota lu, aucune session créée)";
      } catch (err) {
        const msg = String(err?.message ?? err);
        out.quota_erreur = msg.slice(0, 300);
        out.verdict = /403|401|deny|unauthor/i.test(msg)
          ? "clé REFUSÉE par la plateforme (403/401) — ne pas lancer le run"
          : "clé non vérifiable (quota indisponible) — vérifier manuellement avant le run";
      }
    }
    return sendJson(res, 200, out);
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

  /* ------------------------------------------- validation humaine (C6) */

  /**
   * En-têtes d'identité qu'un reverse proxy authentifiant pose habituellement.
   * Le serveur n'authentifie PERSONNE : il reprend ce que le proxy lui donne et,
   * s'il n'a rien, il l'écrit noir sur blanc dans le journal. Aucune
   * authentification n'est bricolée ici — ce serait une fausse traçabilité.
   */
  const ENTETES_IDENTITE = [
    "x-forwarded-user",
    "x-forwarded-email",
    "x-forwarded-preferred-username",
    "x-auth-request-user",
    "x-auth-request-email",
    "x-remote-user",
    "remote-user",
  ];

  /**
   * Proxys d'identité DÉCLARÉS de confiance par l'exploitant, via `DEMO_TRUSTED_PROXY` :
   * une liste d'adresses séparées par des virgules, ou `any` quand le serveur n'est
   * joignable QUE par son proxy. Vide par défaut.
   *
   * Sans cette déclaration, un en-tête d'identité n'est qu'une AFFIRMATION du client :
   * n'importe qui joignant le serveur en direct peut poser `x-forwarded-user`. Le tenir
   * pour une authentification donnerait au journal de validation une valeur probante
   * qu'il n'a pas — c'est exactement le genre de chiffre rassurant non mérité que ce
   * projet refuse. Lu à CHAQUE requête : la configuration d'exploitation peut changer
   * sans redémarrer une démo.
   * @param {string|null} remote adresse d'origine de la requête
   * @returns {boolean} vrai seulement si l'exploitant a déclaré ce proxy de confiance
   */
  function proxyDeConfiance(remote) {
    const brut = String(process.env.DEMO_TRUSTED_PROXY ?? "").trim();
    if (!brut) return false;
    const liste = brut.split(",").map((x) => x.trim()).filter(Boolean);
    if (liste.some((x) => x.toLowerCase() === "any" || x === "1")) return true;
    if (!remote) return false;
    // ::ffff:10.0.0.2 et 10.0.0.2 désignent la même machine
    const nu = remote.replace(/^::ffff:/i, "");
    return liste.some((x) => x === remote || x === nu);
  }

  /**
   * Identité du validateur telle qu'un proxy la fournit — ou l'absence, dite.
   * `declaree` : un en-tête d'identité a été reçu. `authentifiee` : ET il vient d'un
   * proxy déclaré de confiance. Les deux sont distingués parce qu'ils n'ont pas la
   * même valeur devant un litige.
   */
  function validateurDe(req) {
    const remote = req.socket?.remoteAddress ?? null;
    for (const h of ENTETES_IDENTITE) {
      const v = req.headers[h];
      if (typeof v === "string" && v.trim()) {
        const confiance = proxyDeConfiance(remote);
        return {
          identite: v.trim().slice(0, 200),
          source: `en-tête ${h}`,
          declaree: true,
          authentifiee: confiance,
          proxy_de_confiance: confiance,
          remote,
        };
      }
    }
    return { identite: null, source: "aucune", declaree: false, authentifiee: false, proxy_de_confiance: false, remote };
  }

  const RUNID_RE = /^[A-Za-z0-9._-]{1,80}$/;

  /**
   * POST /api/validation — enregistre la décision humaine sur la répartition (C6).
   *
   * INV-1 : cette route NE RÉSERVE RIEN. Elle consigne ce que le validateur
   * accepte de demander aux hôtels. La « poursuite vers la confirmation de
   * réservation » du CDC est un arbitrage client non rendu : elle n'existe pas
   * dans cet outil, et l'écran le dit.
   */
  function postValidation(req, body, res) {
    const runId = String(body.runId ?? "").trim();
    if (!RUNID_RE.test(runId)) throw new HttpError(400, "runId manquant ou invalide");
    const entree = manager.valider({
      runId,
      decision: String(body.decision ?? ""),
      empreinte: body.empreinte ? String(body.empreinte) : null,
      exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
      validateur: validateurDe(req),
      commentaire: body.commentaire,
    });
    return sendJson(res, 200, {
      enregistre: true,
      journal: `validation-${runId}.json`,
      entree,
      // aucune ambiguïté à la sortie de l'appel non plus
      suite: "aucune réservation n'a été faite : ce plan validé est ce qu'il faut maintenant DEMANDER aux hôtels",
    });
  }

  /** GET /api/validation?runId= — journal append-only + empreinte du plan courant. */
  function getValidation(query, res) {
    const runId = String(query.get("runId") ?? "").trim();
    if (!RUNID_RE.test(runId)) throw new HttpError(400, "runId manquant ou invalide");
    return sendJson(res, 200, {
      runId,
      empreinte_plan: manager.empreinteDe(runId),
      journal: manager.journalValidation(runId),
    });
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
          // choix explicite de la liste générée : la liste téléversée est OUBLIÉE,
          // sinon un rechargement d'onglet la remettrait en source du prochain run
          uploadedRows = null;
          uploadedInfo = null;
          uploadedRapport = null;
          return sendJson(res, 200, { stats });
        }
        case "POST /api/passengers": {
          const bytes = await readBody(req, { raw: true });
          // v3 : le contexte d'escale date un horaire de correspondance donne en « HH:MM »
          // seul et fait tourner les controles de plausibilite (PAXLIST §3.3ter). L'escale
          // n'est pas encore arretee a l'upload : l'UI envoie celle qui est selectionnee,
          // et un code inconnu retombe sur l'escale par defaut plutot que de refuser la
          // liste — la correspondance est un CONFORT, l'ingestion ne doit pas en dependre.
          let escale = null;
          try {
            const code = (url.searchParams.get("station") ?? DEFAULT_SCENARIO.station).toUpperCase();
            escale = contexteEscale(loadStation(code), new Date());
          } catch {
            escale = null;
          }
          let ing;
          try {
            ing = ingestPassagers(bytes, escale ? { escale } : {});
          } catch (err) {
            if (err instanceof IngestError) {
              // liste REFUSÉE : le rapport part avec l'erreur pour que l'opérateur
              // sache quelle ligne corriger (jamais un repli silencieux)
              uploadedRows = null;
              uploadedInfo = null;
              uploadedRapport = null;
              return sendJson(res, 400, { error: String(err.message), rapport: err.rapport ?? null });
            }
            throw new HttpError(400, String(err.message));
          }
          uploadedRows = ing.pax;
          uploadedRapport = ing.rapport;
          uploadedInfo = {
            passagers: ing.rapport.compteurs.a_loger,
            dossiers: new Set(ing.pax.map((r) => r.pnr)).size,
            lignes: ing.rapport.lignes,
            parCabine: ing.rapport.compteurs.parCabine,
            parType: ing.rapport.compteurs.parType,
            pmr: ing.rapport.compteurs.pmr,
            groupes: ing.rapport.compteurs.groupes,
            animaux: ing.rapport.compteurs.animaux,
            escalades: ing.rapport.compteurs.escalades,
            equipage: ing.equipage.length,
            exclus: ing.rapport.compteurs.exclus,
            fichier: ing.rapport.fichier ? { encodage: ing.rapport.fichier.encodage, separateur: ing.rapport.fichier.separateur, alias_appliques: ing.rapport.fichier.alias_appliques, colonnes_ignorees: ing.rapport.fichier.colonnes_ignorees, lignes_ignorees: ing.rapport.fichier.lignes_ignorees } : null,
            alias_valeurs: ing.rapport.alias_valeurs,
            avertissements: ing.rapport.avertissements.map((a) => a.message),
            recu_le: new Date().toISOString(),
          };
          return sendJson(res, 200, { stats: uploadedInfo });
        }
        case "POST /api/run":
          return await postRun(parseJson(await readBody(req)), res);
        case "POST /api/cancel":
          return sendJson(res, 200, manager.cancel());
        case "POST /api/cancel-extension":
          return sendJson(res, 200, manager.cancelExtension());
        case "GET /api/events":
          return hub.handle(req, res, manager.snapshot);
        case "POST /api/replay":
          return postReplay(parseJson(await readBody(req)), res);
        case "POST /api/validation":
          return postValidation(req, parseJson(await readBody(req)), res);
        case "GET /api/validation":
          return getValidation(url.searchParams, res);
        case "POST /api/retention-purge": {
          // purge manuelle, sur le MÊME critère d'âge que la purge automatique
          // sur la politique de rétention COURANTE (celle du dernier run lancé), jamais sur
          // `DEFAULT_POLICY` : le seuil supprimé était un seuil que l'exploitant n'avait pas choisi
          const bilan = manager.purgerNominatives(null, { raison: "demande explicite de l'opérateur" });
          return sendJson(res, 200, bilan);
        }
        case "GET /api/health":
          return await getHealth(res);
        case "GET /api/state":
          return sendJson(res, 200, manager.snapshot());
        case "GET /api/screenshot":
          return await getScreenshot(url.searchParams, res);
        case "GET /api/messages": {
          const r = manager.result(url.searchParams.get("runId"));
          if (!r) throw new HttpError(404, "runId inconnu");
          // run restitué depuis le disque après redémarrage : les messages ne sont
          // pas persistés (nominatifs). Le CSV du run, lui, l'est — on y renvoie
          // plutôt que de rendre une liste vide qui passerait pour « 0 message ».
          if (!Array.isArray(r.messages)) {
            // ne renvoyer vers le CSV que s'il existe VRAIMENT : un run annulé n'en a
            // jamais écrit, et l'annoncer enverrait l'opérateur chercher un fichier absent
            const csv = `messages-${url.searchParams.get("runId")}.csv`;
            const ou = r.outputs?.includes(csv) ? ` — télécharger ${csv}` : " — ce run n'a produit aucun fichier de messages";
            throw new HttpError(410, `messages non chargés (run restitué après un redémarrage du serveur)${ou}`);
          }
          const lang = url.searchParams.get("lang");
          const messages = lang ? r.messages.filter((m) => m.lang === lang) : r.messages;
          return sendJson(res, 200, { count: messages.length, messages });
        }
        case "GET /api/cout": {
          const r = manager.result(url.searchParams.get("runId"));
          if (!r) throw new HttpError(404, "runId inconnu");
          if (!r.cost) {
            const json = `cout-${url.searchParams.get("runId")}.json`;
            const ou = r.outputs?.includes(json) ? ` — télécharger ${json}` : " — ce run n'a produit aucun coût consolidé (run annulé ou interrompu)";
            throw new HttpError(410, `coût non chargé pour ce run${ou}`);
          }
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
