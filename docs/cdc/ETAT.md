# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 5 — Câblage réel et probes
- Statut : non démarrée (phase 4 terminée le 15/09)
- Dernier commit : `feat(phase-4): serveur, SSE, UI vanilla, mode simulation BKK` (à pousser sur `origin/main`)

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés (v1 intacte, INV-6) ; `npm ci` propre ; « Plans and limits » consignés (section dédiée).
- Phase 1 (14/09) — noyau pur : `lib/{csv,policy,scenario,passagers,dossiers,reglement,allocate,cout,messages,rapport}.mjs`, gabarits `data/messages/{fr,en}.md`, fixture `data/simulate/releves-demo.json`, wrapper `tools/generate-passengers.mjs` (seed 42 A330 identique octet à octet). Offline : 324 pax → 88 OK + 69 escalades.
- Phase 2 (15/09) — multi-escale hors ligne : `lib/stations.mjs` + `data/stations/{BKK,CDG,NOU}.json`, `lib/inventaire.mjs` (EX-INV-1/4, isStale, candidatesFrom) + `data/inventaire/*.json` + `data/simulate/inventaire-demo.json`, `lib/hai-urls.mjs`, `tools/inventaire.mjs`.
- Phase 3 (15/09) — pipeline agents complet, zéro session payante : `lib/hai.mjs` (SEUL module SDK, INV-7 testé : client EU H-6, `ensureAgentV2`, schémas plats + convertisseurs EX-REL-2/4, 4 prompts FR INV-1/2, `pumpToCompletion`), `lib/events.mjs` (forme §5.8 + traduction SessionEvent), `lib/discovery.mjs` (EX-DIS-1/2, 2 passes nflt), `lib/releve.mjs` (start_url, rattachement §6.6, concurrence auto→6, repli 3/25 s sur 429, substitution par le code), `lib/capacite.mjs` (detectCap, planExtension pur borné H-2, runProbe EX-EXT-1/5), `lib/pipeline.mjs` (`runPipeline` phases §5.8, allocation incrémentale, boucle §6.4, `realCollect`/`fixturesCollect`), `tools/rebooking-v2.mjs` (--dry-run/--offline gratuits ; payant derrière DEMO_ALLOW_PAID=1, INV-8).
- Phase 4 (15/09) — serveur, SSE, UI, simulation :
  - `demo/sse-hub.mjs` (tampon 1000, `Last-Event-ID`, snapshot, ping 15 s), `demo/run-manager.mjs` (singleton 409 INV-10, snapshot re-rendable EX-UI-2, annulation totale + extension EX-EXT-4, sorties §8 : 6 fichiers `out/*-{runId}.*`, sources de captures privées §11), `demo/session-pump.mjs` (flux `until:"settled"` PUIS `waitForCompletion`, sans SDK — pour la phase 5), `demo/simulate.mjs` (~90 s, 0 €, fixtures BKK + 3 réponses scriptées, pensées FR, 4 PNG `demo/sim-assets/`, sonde simulée max 30), `demo/server.mjs` (routes §9, statiques/téléchargements en liste blanche, proxy captures par clés d'état `Cache-Control: private`, presets `[a-z0-9-]{1,40}`, dry-run synchrone via `POST /api/run {dry_run}`).
  - `demo/public/{index.html,style.css,app.js}` : formulaire repliable (Escale/Politique/Avion/Scénario/presets), frise §5.8, cartes agents (pensée, vignette→lightbox, métriques), bandeau EX-EXT-3 permanent, plan (escalades surlignées, provisoire grisé, remplacement par pnr), coût, messages EX-MSG-4 (FR/EN, filtre tier, copier), panneau final + téléchargements, onglet Inventaire EX-INV-8 (drapeaux, ajout manuel, « Rafraîchir par agents » → 501 en phase 4). Aucune écriture HTML depuis des chaînes (INV-9, test statique).
  - `data/presets/politique-standard.json` livré ; `.claude/launch.json` au format Browser pane (demo-bkk, port 4310).
  - Tests : 151 cas verts (24 fichiers) — hub SSE, pompe de session (ordre strict, AnswerValidationError par nom), simulation (ordre §5.8, vague 1 = 1 sonde + 1 relevé, INV-5 sur événements d'agent, annulations), manager (409, captures privées, plan sans doublon), serveur (routes, gardes INV-8, EX-UI-1, listes blanches, presets, inventaire), invariants statiques INV-7/INV-9.

## En cours

- Rien.

## Décisions prises

- Reconstruction v2 par phases ; l'ébauche `wingmate-holotab` sert de référence.
- `data/` et `out/` à la racine ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"`.
- Découverte SANS `start_url` override (écart au §6.2, probes du 11/09) ; relevés/sondes : override conservé. `pumpToCompletion` dans `lib/hai.mjs` ; `idleTimeoutS` défaut plateforme ; sessions non terminales fermées après réponse.
- L'extension ne compte que ses propres sessions dans `sessions_used` ; `emit("plan_row")` réémet chaque ligne à chaque réallocation (l'UI remplace par pnr).
- Phase 4 — simulation : les fixtures (2 relevés exploitables seulement) ne suffisent pas à la vague « sonde + 1 relevé » exigée par la fiche — la cascade de substitution §6.6 consommerait tous les candidats. `demo/simulate.mjs` complète donc les fixtures par 3 réponses scriptées (`SIM_ANSWERS` : novotel, méridien exploitables ; amaranth relevé en vague 1) ; étage B sans échec, sonde Hyatt (30) + relevé Amaranth en vague 1 → 157 OK / 0 escalade, `couvert : aucun manque`.
- Phase 4 — le run simulé charge `data/simulate/inventaire-demo.json` (4 hôtels) ; l'onglet Inventaire lit/écrit `data/inventaire/{CODE}.json` (3 hôtels BKK) : compteurs différents assumés (fixtures vs réel).
- Phase 4 — sécurité : les événements/snapshots ne portent JAMAIS la source d'une capture, seulement `{hotel_key, seq}` résolus par `GET /api/screenshot` (fichier sim-assets, data:, ou https relayé côté serveur en phase 5) ; run réel et `POST /api/inventaire/:code/run` → 501 (INV-8, câblage phase 5) ; CSP `default-src 'self'`.
- Phase 4 — UI : `sim_speed` (×1/×5/×20) hors schéma scénario (zod ignore les clés inconnues, le serveur borne 1..1000) ; liste passagers téléversée gardée en mémoire process (`passengers: "uploaded"` au run) ; `nice_to_have` non éditable dans le formulaire (défauts conservés) ; « Vue live H » affiché seulement si `live_view_url` (jamais en simulation).

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` ; `out/*` (local, ignoré) ; `test/helpers.mjs` ; `test/phase0.test.mjs` ; `lib/hai-urls.mjs` ; `lib/pipeline.mjs` ; `demo/sim-assets/*.png` (4 captures factices) ; `data/presets/politique-standard.json` ; dry-run servi par `POST /api/run {dry_run:true}` (pas de route dédiée au §9).
- `hai-admin-mcp/package.json` : `main`/`bin` → `src/server.mjs` absent (référence morte assumée, POC intact).

## Environnement (H-8, relevé le 14/09)

- Windows 11 Famille (10.0.26200) ; PowerShell ; Node v22.23.2 ; npm 10.9.8 ; `hai-agents` 1.0.7 ; `zod` 4.5.4 (sous `hai-admin-mcp/`).

## POC v1 — repères (détail dans `tools/rebooking.mjs`, intact)

- CLI v1 ; agent « hotel-scout-bkk » ; `out/releves-poc-bkk-2026-09-01.json` (31/08) : novotel via substitution (Hyatt), méridien `found=false` — base des fixtures v2.

## SDK hai-agents 1.0.7 (TS) — relevé phase 0 (H-6)

- `new HaiAgentsClient({apiKey, environment | baseUrl})` — EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai`, origine SANS `/api/v2` ; seul `HAI_API_KEY` est lu automatiquement (`HAI_API_BASE_URL` câblée dans `createClient`).
- `startSession<TAnswer>({agent, messages, maxSteps, maxTimeS, idleTimeoutS, groupId, overrides, answerSchema, …}) → SessionHandle` ; `stream({until})` / `waitForCompletion({answerSchema})` / `cancel` ; `client.session(id)` pour se rattacher ; `AnswerValidationError`, `isTerminalSessionStatus` exportés.
- Événements : `AgentEvent{policy_event|observation_event}`, `MetricsUpdateEvent`, `LiveViewUrlEvent`, `AgentRunStatusChangeEvent`, `AgentErrorEvent`, `AgentCompletionEvent` (traduits dans `lib/events.mjs`).
- `createAgent/patchAgent` : champ `model?: string|null` (défaut plateforme) ; pas d'API de liste des modèles.

## Hypothèses `[À CONFIRMER]` rencontrées

| Id CDC | Choix appliqué | Statut |
|---|---|---|
| H-1 | `company_payment_possible` dans `lib/reglement.mjs`, recalculée à chaque chargement | fait (ph. 1-2) |
| H-3 | Sonde câblée (`buildProbeUrl`, `probeSchema`, `runProbe`, désactivable) ; simulée en phase 4 (max 30) ; comportement réel Booking à trancher en phase 5 (`--probe-capacity`) | câblé, à mesurer (ph. 5) |
| H-4 | Péremption 30 j ; référence Étage 0 J+14, 1 nuit (éditables) | fait (ph. 2) |
| H-5 | NOU navette 75 min ; CDG facteur 1.0 (éditables) | fait (ph. 2) |
| H-6 | `createClient()` : `environment = HAI_API_BASE_URL ?? HaiAgentsEnvironment.Eu` — câblé, à exercer en phase 5 | câblé (ph. 3) |
| H-7 | `allowances` null → « non renseigné » + `not_determinable` | fait (ph. 1) |
| H-8 / H-9 | Environnement relevé ; modèles (`h/web-surfer-pro|flash`…) ↔ offre à trancher en phase 5 ; `ensureAgentV2` accepte `model_stage_ab` ≠ « auto » | fait / à mesurer (ph. 5) |

## Points bloquants

- Aucun.

## Valeurs lues sur le compte H (phase 0, 14/09)

- Concurrence : sans limite plan → `auto` plafonné à 6, repli 3/25 s sur 429 (§16). Modèles : `h/web-surfer-pro|flash`, `h/web-scraper-pro|flash`, `h/deep-search-pro`. Quotas : 60 M tokens inclus.

## Vérification

- `npm test` : OK (151 cas, 15/09)
- `tools/inventaire.mjs --dry-run/--offline` : OK (15/09) · `rebooking-v2 --dry-run/--offline` : OK (15/09, 0 €)
- UI simulation (15/09, navigateur) : BKK défaut + CDG/NOU ensuite ; NOU simulé → « fixtures non disponibles » + dry-run ; génération A350 → 324 pax ; run simulé complet en 87 s (phases §5.8, extension vague 1 sonde + relevé, bornes 2/18 · 0/10 $ · vague/4, plan 157 OK / 0 escalade, coût borne haute 32 900 €, messages FR/EN filtrés + copier, 6 téléchargements) ; rechargement d'onglet → snapshot complet ; double-run → 409 ; annulation propre ; annulation d'extension seule → plan en l'état, escalade chiffrée ; drapeaux + ajout manuel persistés dans `data/inventaire/BKK.json` (restauré après test) ; « Rafraîchir par agents » → 501 INV-8.
- Probes réels : — (phase 5)

## Prochaine phase

- Phase suivante : 5 — Câblage réel et probes (`realCollect` dans le serveur derrière `DEMO_ALLOW_PAID`, Étage 0 réel, mesures H-3/H-9, captures H via proxy https)
- Fiche : `docs/cdc/phases/phase-5-cablage-reel-probes.md`
