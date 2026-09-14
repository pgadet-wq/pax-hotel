# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 4 — Serveur, UI, simulation
- Statut : non démarrée (phase 3 terminée le 15/09)
- Dernier commit : `feat(phase-3): pipeline agents (découverte, relevés, sonde, extension) en dry-run/offline` (poussé sur `origin/main`)

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés (v1 intacte, INV-6) ; `npm ci` propre ; « Plans and limits » consignés (section dédiée).
- Phase 1 (14/09) — noyau pur : `lib/{csv,policy,scenario,passagers,dossiers,reglement,allocate,cout,messages,rapport}.mjs`, gabarits `data/messages/{fr,en}.md`, fixture `data/simulate/releves-demo.json`, wrapper `tools/generate-passengers.mjs` (seed 42 A330 identique octet à octet). Offline : 324 pax → 88 OK + 69 escalades, 3 modes de règlement, messages FR/EN sans `{{`.
- Phase 2 (15/09) — multi-escale hors ligne : `lib/stations.mjs` + `data/stations/{BKK,CDG,NOU}.json`, `lib/inventaire.mjs` (merge EX-INV-1, isStale, candidatesFrom, EX-INV-4 recalculé) + `data/inventaire/{BKK,CDG,NOU}.json` + `data/simulate/inventaire-demo.json`, `lib/hai-urls.mjs` (nflt EX-DIS-3, URLs, sonde H-3), `tools/inventaire.mjs` (--dry-run/--offline).
- Phase 3 (15/09) — pipeline agents complet, zéro session payante :
  - `lib/hai.mjs` (SEUL module SDK, INV-7 testé) : `readApiKey`, `createClient` (EU via `HAI_API_BASE_URL` ?? `HaiAgentsEnvironment.Eu`, H-6), `agentNameV2` (« hotel-scout-{code}-v2 », v1 intacte) + `ensureAgentV2` (modèle « auto » = plateforme, H-9 phase 5), schémas plats `discoverySchema`/`releveSchema` (payment + cap_reached, EX-REL-4)/`probeSchema`/`inventaireHotelSchema`, convertisseurs (`toReleveAnswer` horodate `observed_at` côté code, EX-REL-2), 4 prompts FR avec garde-fous INV-1/INV-2, `pumpToCompletion` (AnswerValidationError = échec de réponse, pas d'exception).
  - `lib/events.mjs` : forme plate §5.8 + `translateSessionEvent` (types relevés aux probes du 11-13/09) + `mkEmitter`.
  - `lib/discovery.mjs` : `discoveryNeeded` (EX-DIS-1, pur), `candidateToEntry` (fusion EN MÉMOIRE, EX-DIS-2), `runDiscovery` (1 session, 2 passes par édition d'URL, 35 pas/800 s, retry × 1, repli candidatesFrom).
  - `lib/releve.mjs` : `runReleve` (start_url override sur la fiche, 45 pas/900 s, rattachement par id avant relance §6.6), `runReleves` (concurrence auto→6, décalage `stagger_ms`, repli 3/25 s sur 429 §16, substitution par le code sur `found=false`/inexploitable, `onInventory` incrémental EX-ALL-1).
  - `lib/capacite.mjs` : `detectCap`, `planExtension` (PUR : bornes H-2, budget de sessions, batch auto = concurrence, `allowProbes` hors ligne), `applyProbeResult` (borne EX-ALL-5, non mutant), `runProbe` (EX-EXT-1/EX-EXT-5, 20 pas/400 s).
  - `lib/pipeline.mjs` : `runPipeline` (phases §5.8 ordonnées, allocation incrémentale, boucle §6.4, signal total + extensionSignal EX-EXT-4, sorties §8) ; `realCollect(client)` et `fixturesCollect(records)` injectables.
  - `tools/rebooking-v2.mjs` : `--dry-run` (besoins, inventaire, décision découverte, URLs, extension théorique), `--offline` (pipeline sur fixtures → 5 fichiers `out/*-{runId}.*`, 0 €) ; run complet et `--probe-*` derrière `DEMO_ALLOW_PAID=1` (INV-8), probes fins renvoyés à la phase 5. `tools/inventaire.mjs` : `--refresh`/`--max` câblés (EX-INV-5/7 : découverte + relevés courts, concurrence 3/25 s, merge) derrière la même garde.
  - Tests : 108 cas verts (18 fichiers) — client factice (relevé plafonné → sonde puis lot de 3 ; bornes → escalade chiffrée ; `probe_same_hotel_first=false` ; substitution ; annulation ; EX-EXT-4), events, schémas/convertisseurs, EX-PRO-1, CLI (dry-run, offline, gardes INV-8).
  - Acceptation vérifiée : dry-run BKK complet (découverte SAUTÉE, 5 URLs, bornes 18/4/10 $) ; offline → 88 OK + 69 escalades, extension « épuisé » avec escalade chiffrée (W: 12, Y: 57), 0 €, 5 fichiers écrits ; `--probe-discovery` refusé exit 1.

## En cours

- Rien.

## Décisions prises

- Reconstruction v2 par phases ; l'ébauche `wingmate-holotab` sert de référence (modèles, méthode agents éprouvée aux probes).
- `data/` et `out/` à la racine ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"`.
- Rayon et plafonds effectifs : fiche escale (phases 1-2) ; `companyPaymentPossible` dans `lib/reglement.mjs` ; relevés : `rooms_available_max ?? quantity_available ?? quantity_displayed_max`.
- `lib/hai-urls.mjs` = partie pure réexportée par `lib/hai.mjs` ; test INV-7 : seul `hai.mjs` importe `hai-agents`.
- Découverte SANS `start_url` override (écart au §6.2) : les probes du 11/09 montrent qu'une URL de résultats ouverte à froid est rejetée (`errorc_searchstring_not_found`) — recherche manuelle puis édition `&nflt=` de l'URL de résultats. Relevés/sondes : override `start_url` conservé.
- `pumpToCompletion` vit dans `lib/hai.mjs` (SDK) ; `idleTimeoutS` laissé au défaut plateforme (null tuait la session au premier passage idle) ; sessions non terminales fermées après réponse pour libérer le slot.
- L'extension ne compte que ses propres sessions (sondes + relevés d'extension) dans `sessions_used` ; hors ligne `collect.probe = null` → `planExtension({allowProbes:false})` passe directement aux candidats.
- `emit("plan_row")` réémet chaque ligne à chaque réallocation (l'UI remplacera par pnr) ; coût agrégé par enregistrement (`costUsd`), mesure réelle en phase 5.

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` ; `out/*` (local, ignoré) ; `test/helpers.mjs` ; `test/phase0.test.mjs` ; `lib/hai-urls.mjs` ; `lib/pipeline.mjs` (orchestrateur demandé par la fiche 3, absent du §4).
- Absents (normal) : `demo/`, `data/presets/` (phase 4).
- `hai-admin-mcp/package.json` : `main`/`bin` → `src/server.mjs` absent (référence morte assumée, fichier POC intact).

## Environnement (H-8, relevé le 14/09)

- Windows 11 Famille (10.0.26200) ; PowerShell ; Node v22.23.2 ; npm 10.9.8 ; `hai-agents` 1.0.7 ; `zod` 4.5.4 (sous `hai-admin-mcp/`).

## POC v1 — repères (détail dans `tools/rebooking.mjs`, intact)

- CLI v1 `--in/--checkin/--nights/--dry-run/--probe/--offline/--hotels` ; agent « hotel-scout-bkk » ; 4 hôtels BKK + alternates ; `out/releves-poc-bkk-2026-09-01.json` (31/08) : novotel via substitution (Hyatt), méridien `found=false` — base des fixtures v2.

## SDK hai-agents 1.0.7 (TS) — relevé phase 0 (H-6)

- `new HaiAgentsClient({apiKey, environment | baseUrl})` — EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai`, origine SANS `/api/v2` ; seul `HAI_API_KEY` est lu automatiquement (`HAI_API_BASE_URL` câblée dans `createClient`, phase 3).
- `startSession<TAnswer>({agent, messages, maxSteps, maxTimeS, idleTimeoutS, groupId, overrides, answerSchema, …}) → SessionHandle` ; `overrides` : `{"agent.environments[kind=web].start_url": "…"}` ; `SessionHandle.stream({until})` / `waitForCompletion({answerSchema})` / `cancel` ; `client.session(id)` pour se rattacher ; `AnswerValidationError`, `isTerminalSessionStatus` exportés.
- Événements : `AgentEvent{kind: policy_event|observation_event}`, `MetricsUpdateEvent{metrics{steps,totalCost,costPerModel[]}}`, `LiveViewUrlEvent`, `AgentRunStatusChangeEvent`, `AgentErrorEvent`, `AgentCompletionEvent` (traduits dans `lib/events.mjs`).
- `createAgent/patchAgent` : champ `model?: string|null` (défaut plateforme) ; pas d'API de liste des modèles.

## Hypothèses `[À CONFIRMER]` rencontrées

| Id CDC | Choix appliqué | Statut |
|---|---|---|
| H-1 | `company_payment_possible` dans `lib/reglement.mjs`, recalculée à chaque chargement | fait (ph. 1-2) |
| H-3 | Sonde câblée : `buildProbeUrl` (no_rooms, group_adults=2×n), `probeSchema`, `runProbe`, désactivable (`probe_same_hotel_first`) et coupée hors ligne (`allowProbes`) ; comportement réel Booking à trancher en phase 5 (`--probe-capacity`) | câblé (ph. 3), à mesurer (ph. 5) |
| H-4 | Péremption 30 j ; référence Étage 0 J+14, 1 nuit (éditables) | fait (ph. 2, défauts) |
| H-5 | NOU navette 75 min ; CDG facteur 1.0 (éditables) | fait (ph. 2, défauts) |
| H-6 | `createClient()` : `environment = HAI_API_BASE_URL ?? HaiAgentsEnvironment.Eu` (origine sans `/api/v2`) — câblé, à exercer en phase 5 | câblé (ph. 3) |
| H-7 | `allowances` null → « non renseigné » + `not_determinable` | fait (ph. 1) |
| H-8 / H-9 | Environnement relevé ; modèles (`h/web-surfer-pro|flash`…) et champ `model` ↔ offre à trancher en phase 5 ; `ensureAgentV2` accepte `model_stage_ab` ≠ « auto » | fait / à mesurer (ph. 5) |

## Points bloquants

- Aucun.

## Valeurs lues sur le compte H (phase 0, 14/09)

- Concurrence : sans limite plan → `auto` plafonné à 6, repli 3/25 s sur 429 (§16, implémenté dans `runReleves`).
- Modèles agents : `h/web-surfer-pro|flash`, `h/web-scraper-pro|flash`, `h/deep-search-pro` (classe pro pour A/B, flash pour sondes — phase 5). Quotas : 60 M tokens inclus.

## Vérification

- `npm test` : OK (108 cas, 15/09)
- `tools/inventaire.mjs --dry-run/--offline` : OK (15/09) · `--refresh` : refus INV-8 sans `DEMO_ALLOW_PAID=1`
- `rebooking-v2 --dry-run` : OK (15/09, BKK) · `rebooking-v2 --offline` : OK (15/09, 0 €)
- UI simulation : — (phase 4) · probes réels : — (phase 5)

## Prochaine phase

- Phase suivante : 4 — Serveur, UI, simulation (puis 5 — Câblage réel et probes)
- Fiche : `docs/cdc/phases/phase-4-serveur-ui-simulation.md`
