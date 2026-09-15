/**
 * Étage 0 par agents depuis le serveur (EX-INV-8 « Rafraîchir par agents », phase 5).
 *
 * Reprend la logique de `tools/inventaire.mjs` (EX-INV-5 : 1 découverte puis un
 * relevé court par candidat, concurrence 3, décalage 25 s) côté démo : les sessions
 * RÉELLES sont pompées par `pumpSession` (annulation réelle comprise) et la
 * progression est publiée sur le hub SSE en événements `log`/`warning`/`error`
 * uniquement — les cartes agents de l'UI restent réservées aux runs §5.8.
 *
 * Singleton : un seul rafraîchissement à la fois (INV-10, 409 sinon). L'écriture
 * de `data/inventaire/{CODE}.json` passe par `mergeInventaire` (EX-INV-6 : les
 * entrées manuelles et les drapeaux sont préservés), en tmp + rename.
 */
import fs from "node:fs";
import path from "node:path";
import { loadInventaire, mergeInventaire, normalizeInventaire, reconcileIds, slugify } from "../hai-admin-mcp/lib/inventaire.mjs";
import { newRunId } from "../hai-admin-mcp/lib/scenario.mjs";
import { mkEmitter } from "../hai-admin-mcp/lib/events.mjs";
import { runDiscovery } from "../hai-admin-mcp/lib/discovery.mjs";
import {
  agentNameV2, ensureAgentV2, buildHotelUrl, inventaireHotelSchema, promptInventaireHotel, toInventaireEntry,
} from "../hai-admin-mcp/lib/hai.mjs";
import { pumpSession } from "./session-pump.mjs";
import { HttpError } from "./run-manager.mjs";

const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * @param {object} deps {hub, inventaireDir}
 */
export function createInventaireRefresher({ hub, inventaireDir }) {
  let running = null; // {runId, station} pendant un rafraîchissement
  let lastTask = null; // promesse du dernier rafraîchissement (tests)

  return {
    isRunning: () => running !== null,
    wait: () => lastTask ?? Promise.resolve(),

    /**
     * Démarre l'Étage 0 par agents en tâche de fond (la réponse HTTP part tout de
     * suite ; la progression arrive par SSE). La garde INV-8 (DEMO_ALLOW_PAID) est
     * assurée par l'appelant — ce module ne décide jamais d'une dépense.
     * @returns {{started: true, runId, groupId, station, max}}
     */
    start({ client, station, policy, max = 10, nights = 1 }) {
      if (running) throw new HttpError(409, `un rafraîchissement d'inventaire est déjà en cours (${running.station}, INV-10)`);
      const MAX = Number(max ?? 10);
      if (!Number.isInteger(MAX) || MAX < 1 || MAX > 15) throw new HttpError(400, "max doit être un entier de 1 à 15");

      const runId = newRunId();
      const groupId = `inv-${station.code.toLowerCase()}-${runId}`; // EX-INV-7
      const checkin = localIso(new Date(Date.now() + 14 * 86_400_000)); // H-4 : référence J+14
      const checkout = (() => {
        const d = new Date(`${checkin}T00:00:00`);
        d.setDate(d.getDate() + nights);
        return localIso(d);
      })();
      running = { runId, station: station.code };

      // seuls log / warning / error atteignent le hub — le reste devient des logs lisibles
      const publish = mkEmitter({ run_id: runId }, (ev) => hub.publish(ev.type, ev));
      const emit = (type, data = {}, extra = {}) => {
        if (type === "log" || type === "warning" || type === "error") return publish(type, data, extra);
        if (type === "candidate") return publish("log", { message: `[inventaire] candidat : ${data.name} (${data.stars ?? "?"}★, ${data.review_score ?? "?"}/10)` });
        if (type === "agent_status" && data.status) return publish("log", { message: `[inventaire] ${extra.hotel_key ?? "découverte"} : ${data.status}` });
        return undefined; // pensées, captures, métriques : hors UI pour l'Étage 0
      };

      const task = (async () => {
        const existing = loadInventaire(station.code, { dir: inventaireDir });
        publish("log", { message: `[inventaire] Étage 0 ${station.code} par agents — groupe ${groupId}, max ${MAX} hôtels, référence ${checkin} → ${checkout}` });

        /* 1. découverte (logique Étage A : 1 session, 2 passes) */
        const disc = await runDiscovery({ client, policy, station, checkin, checkout, groupId, emit });
        const candidats = disc.candidates.slice(0, MAX);
        if (!candidats.length) {
          publish("warning", { message: "[inventaire] découverte sans candidat : inventaire inchangé" });
          return;
        }

        /* 2. un relevé d'inventaire court par candidat — concurrence 3, décalage 25 s (EX-INV-5) */
        await ensureAgentV2(client, station, policy);
        const queue = [...candidats];
        const entries = [];
        let costUsd = 0;
        let started = 0;
        async function worker() {
          for (;;) {
            const cand = queue.shift();
            if (!cand) return;
            const delay = started * 25000;
            started += 1;
            if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 25000)));
            const hotelKey = slugify(cand.name);
            const url = cand.url ? buildHotelUrl(cand.url, { checkin, checkout }) : null;
            try {
              const handle = await client.startSession({
                agent: agentNameV2(station),
                messages: promptInventaireHotel({ hotelName: cand.name, hasStartUrl: Boolean(url), checkin, checkout }),
                maxSteps: 30,
                maxTimeS: 600,
                groupId,
                answerSchema: inventaireHotelSchema,
                ...(url ? { overrides: { "agent.environments[kind=web].start_url": url } } : {}),
              });
              let sessionCost = 0;
              const result = await pumpSession(handle, (type, data) => {
                if (type === "metrics") sessionCost = data.cost_usd ?? sessionCost;
                emit(type, data, { hotel_key: hotelKey, session_id: handle.id });
              });
              costUsd += sessionCost;
              let flat = result.answer;
              if (typeof flat === "string") {
                try { flat = JSON.parse(flat); } catch { flat = null; }
              }
              const entry = toInventaireEntry(flat, { id: hotelKey });
              if (entry) {
                entries.push(entry);
                publish("log", { message: `[inventaire] « ${cand.name} » relevé (${entry.capacity_hint?.rooms_displayed_max ?? "?"} ch. affichées)` });
              } else {
                publish("warning", { message: `[inventaire] « ${cand.name} » : relevé sans résultat (${result.error ?? flat?.notes ?? "found=false"})` });
              }
            } catch (err) {
              publish("warning", { message: `[inventaire] « ${cand.name} » : session en échec (${err?.message ?? err})` });
            }
          }
        }
        await Promise.all(Array.from({ length: 3 }, () => worker()));

        /* 3. fusion et écriture atomique (EX-INV-6) — ids réconciliés (pas de doublon d'hôtel) */
        const reconciled = reconcileIds(existing, entries, {
          onDrop: (e, id) => publish("warning", { message: `[inventaire] « ${e.name} » écarté : déjà relevé dans ce lot (${id})` }),
        });
        const fresh = normalizeInventaire({
          station: station.code,
          updated_at: new Date().toISOString(),
          reference: { checkin, nights },
          hotels: reconciled,
        }, "inventaire Étage 0 (serveur)");
        const merged = mergeInventaire(existing, fresh);
        fs.mkdirSync(inventaireDir, { recursive: true });
        const file = path.join(inventaireDir, `${station.code}.json`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, file);
        publish("log", {
          message:
            `[inventaire] ${station.code} écrit : ${merged.hotels.length} hôtel(s), ${reconciled.length} relevé(s) frais, ` +
            `coût sessions ≈ ${Math.round((costUsd + (disc.costUsd ?? 0)) * 100) / 100} $ (groupe ${groupId})`,
          refreshed: reconciled.length,
          total: merged.hotels.length,
        });
      })()
        .catch((err) => {
          publish("error", { message: `[inventaire] échec : ${String(err?.message ?? err)}`, fatal: false });
        })
        .finally(() => {
          running = null;
        });
      lastTask = task;

      return { started: true, runId, groupId, station: station.code, max: MAX };
    },
  };
}
