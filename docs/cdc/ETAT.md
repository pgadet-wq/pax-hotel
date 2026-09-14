# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 1 — Noyau pur
- Statut : non démarrée (phase 0 terminée le 14/09)
- Dernier commit : `chore(phase-0): POC v1 + pack CDC démo v2` (poussé sur `origin/main`)

## Fait

- Pack CDC rapatrié à la racine du clone : `CLAUDE.md`, `README.md`, `.gitignore`, `.claude/launch.json`, `package.json`, `docs/`
- POC v1 rapatrié : `hai-admin-mcp/tools/{rebooking,generate-passengers,collect-sessions}.mjs`, `hai-admin-mcp/package.json` + `package-lock.json`, `data/passagers-test.csv`, `out/releves-poc-bkk-2026-09-01.json` (local, non commité), `docs/matrice-affectation.md`
- `hai-admin-mcp/A_REMPLACER_PAR_LE_POC_V1.md` : jamais copié dans le clone (équivaut à sa suppression)
- `npm ci` sous `hai-admin-mcp/` : propre, lockfile du POC
- Valeurs « Plans and limits » consignées (voir section dédiée)
- `hai-admin-mcp/test/phase0.test.mjs` : test vide qui passe ; `npm test` vert depuis la racine
- `.gitignore` vérifié (`out/` et `node_modules/` exclus), aucun secret dans l'index ; commit + push `origin/main`

## En cours

- Rien.

## Décisions prises

- Rapatriement sélectif : la source `C:\Users\pgade\wingmate-holotab` contient une ébauche v2 du 11-13/09 (lib/ ×12, src/server.mjs (serveur MCP), test/ ×4, tools/rebooking-v2.mjs, demo/, data/simulate/, nombreux out/) NON rapatriée — le CDC §3 définit le POC v1 sans ces fichiers et les phases 1-4 reconstruisent la v2 proprement. `.env.example` non copié (variables documentées au README).
- `data/` et `out/` placés à la racine du dépôt : les trois outils v1 les résolvent depuis le cwd avec exécution documentée depuis la racine (`node hai-admin-mcp/tools/…`) — cohérent avec l'arborescence CDC §4.
- Script `test` corrigé : `node --test hai-admin-mcp/test/` échoue sous Node 22.23.2/Windows (répertoire traité comme module) → `node --test "hai-admin-mcp/test/**/*.test.mjs"` (package.json + commentaire CLAUDE.md).

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` (requis par `npm ci`) ; `out/releves-poc-bkk-2026-09-01.json` (local, ignoré par git).
- Absents (normal, à construire en phases 1-4) : tout `hai-admin-mcp/lib/`, `tools/rebooking-v2.mjs`, `tools/inventaire.mjs`, `demo/`, `data/{stations,inventaire,messages,presets,simulate}` ; `hai-admin-mcp/test/` créé en fin de phase 0.
- `hai-admin-mcp/package.json` déclare `main`/`bin` → `src/server.mjs` (serveur MCP resté dans l'ancien projet) : référence morte assumée, fichier POC laissé intact.

## Environnement (H-8, relevé le 14/09)

- OS : Windows 11 Famille (10.0.26200) ; shell PowerShell
- Node v22.23.2 (≥ 22 exigé : OK) ; npm 10.9.8
- `hai-agents` 1.0.7 ; `zod` 4.5.4 (installés par `npm ci` sous `hai-admin-mcp/`)

## POC v1 — résumé (phase 0)

1. `rebooking.mjs` : CLI `--in` (déf. `data/passagers-test.csv`), `--checkin` (déf. demain), `--nights` (déf. 1), `--dry-run`, `--probe` (1 session), `--offline <json>`, `--hotels <clés>` (relance ciblée avec fusion des relevés conservés).
2. CONFIG : agent « hotel-scout-bkk » (modèle plateforme par défaut), maxSteps 70, maxTimeS 1000, timeout client 45 min, 4 hôtels BKK fixes + alternates ; allocation par catégorie (pmr/famille/premium/confort/standard → listes d'hôtels, tri prix asc/desc).
3. `buildDossiers` : groupe par PNR → adultes/enfants/bébés, pmr (`assistance=WCHR`), cabine max (J>W>Y), Flying Blue max ; catégories pmr > famille > premium (J ou Gold+) > confort (W ou Silver) > standard ; chambrage familiale 1 ch (≤ 2A+2C) sinon 2, sinon ceil(adultes/2).
4. `answerSchema` (zod) : `{hotel, found, checkin, checkout, currency, rooms[{room_type, occupancy_adults, occupancy_children, quantity_available, price_per_night, free_cancellation, breakfast_included}], notes}`.
5. `collectInventories` : `ensureAgent` (createAgent si absent — env web booking.com visual 1280×900 markdown, skills h/answering + h/planning, instructions no-booking / no-CAPTCHA) puis `client.runSession` par hôtel en `Promise.all` (groupId `poc-bkk-{checkin}`, `waitForSeconds: 25`, `idleTimeoutS: null`, answerSchema).
6. `allocate` : stock par hôtel, dédup des variantes tarifaires par `room_type` (annulation gratuite prioritaire puis prix), chambre familiale d'abord, décrément du stock, sinon hôtel suivant de la règle, sinon ESCALADE DESK.
7. Sorties (relatives au cwd) : `out/plan-hebergement.csv` (UTF-8 BOM, « ; »), `out/rapport.md`, `out/releves-{groupId}.json` ; clé lue dans `HAI_API_KEY` sinon `~/.config/hai/.env`.
8. `generate-passengers.mjs` : `--out` (déf. `data/passagers-test.csv`), `--seed` (déf. 42) ; PRNG mulberry32 + compteur PNR au niveau module ; A330-900 ~95 % (22 J / 20 W / 236 Y), mix solo/couple/famille, 4 passagers WCHR ; CSV UTF-8 BOM « ; » : `pnr;nom;prenom;type_pax;age;cabine;flying_blue;assistance;remarque` (278 pax).
9. `collect-sessions.mjs` : `--group` `--wait` ; `sessions.listSessions({groupId})` + `getSessionChanges`, hôtel déduit du premier message, meilleure réponse par hôtel ; réécrit `out/releves-{group}.json`.
10. `out/releves-poc-bkk-2026-09-01.json` : tableau `[{hotel (clé), sessionId, createdAt, status, outcome, error, answer{found, hotel (réel), notes, rooms[], checkin, checkout, currency}}]` — run du 31/08 : novotel relevé via substitution (Hyatt Regency), méridien `found=false`.

## SDK hai-agents 1.0.7 (TS) — relevé phase 0 (H-6)

- Point d'entrée : options du constructeur `new HaiAgentsClient({...})` — `environment?: Supplier<HaiAgentsEnvironment | string>` (EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai`, US : `.Us`) et `baseUrl?: Supplier<string>` (URL personnalisée). Le SDK ajoute lui-même `api/v2/…` aux chemins : fournir l'origine SANS `/api/v2`.
- Le SDK ne lit que `HAI_API_KEY` dans l'environnement (auth). `HAI_API_BASE_URL` n'est PAS lue automatiquement : à câbler dans notre code, p. ex. `environment: process.env.HAI_API_BASE_URL ?? HaiAgentsEnvironment.Eu` (valeur = origine). La v1 utilise déjà `environment: HaiAgentsEnvironment.Eu`.
- `startSession<TAnswer>(params: CreateSessionParams & {answerSchema?, tools?}) → Promise<SessionHandle<TAnswer>>` ; `CreateSessionParams` = `SessionRequest & {idempotencyKey?}` ; `SessionRequest` : `{agent: string|Agent, messages?: string|UserMessageEvent|[…], maxSteps?, maxTimeS?, idleTimeoutS?, deleteAfterMin?, deleteScreenshotAfterMin?, queue?: boolean (false → 429 immédiat), groupId?, parentSessionId?, overrides?}`.
- `overrides?: Record<string, unknown>` : chemins pointés, membres de liste sélectionnés par `[field=value]` — ex. `{"agent.environments[kind=web].start_url": "…"}`.
- `SessionHandle` : `get/status/changes/sendMessage/pause/resume/cancel/forceAnswer` ; `stream({fromIndex?, waitForSeconds?, limit?, until?: "settled"|"terminal", timeoutMs?}) → AsyncGenerator<SessionEvent>` ; `waitForCompletion({fromIndex?, waitForSeconds?, limit?, includeEvents?, timeoutMs?, pollBackoffMs?, maxPolls?, answerSchema?, tools?}) → Promise<SessionRunResult>`.
- `runSession(CreateSessionParams & {waitForSeconds?, …, answerSchema?, tools?})` (une passe, utilisé par la v1) ; `client.session(id)` pour se rattacher à une session existante.
- Modèle d'un agent personnalisé : champ `model?: string | null` de `createAgent`/`patchAgent` (« Model that serves the agent. Defaults to the platform model if omitted ») — id de modèle en chaîne. Aucune API de liste des modèles dans le SDK : valeurs à lire sur la page « Plans and limits » (H-9).

## Hypothèses `[À CONFIRMER]` rencontrées

| Id CDC | Choix provisoire appliqué | À valider par |
|---|---|---|
| H-6 | Option TS relevée : `environment` / `baseUrl` (origine sans `/api/v2`) ; `HAI_API_BASE_URL` à câbler manuellement | fait (phase 0) |
| H-8 | OS et Node relevés (voir Environnement) | fait (phase 0) |
| H-9 | Valeurs « Plans and limits » fournies par l'utilisateur le 14/09 (voir section dédiée) ; comportement réel à mesurer en phase 5 | fait (phase 0) |

## Points bloquants

- Aucun.

## Valeurs lues sur le compte H (phase 0, fournies par l'utilisateur le 14/09)

- Concurrence maximale : aucune limite de sessions sur le plan. CDC §16 maintient `agents.concurrency = auto` plafonnée à 6, repli 3 sur 429/file d'attente.
- Modèles sélectionnables pour un agent personnalisé : `h/web-surfer-pro` et `h/web-surfer-flash` (agents web visuels), `h/web-scraper-pro` et `h/web-scraper-flash` (agents web textuels, lecture/extraction massive), `h/deep-search-pro` (orchestrateur deep-research). NB : la page liste des agents `h/…`, pas des ids de modèle bruts (« Holo3 122B » non proposé tel quel) ; correspondance champ `model` ↔ offre à trancher en phase 5 — lecture CDC §16 : classe pro pour étages A/B, classe flash pour les sondes.
- Quotas : 60 M tokens inclus ; au-delà, abonnement requis.
- Option SDK TS pour le point d'entrée européen : `environment: HaiAgentsEnvironment.Eu` (= `https://agp.eu.hcompany.ai`) ou `baseUrl` ; origine sans `/api/v2`

## Vérification

- `npm test` : OK (1 test vide, vert depuis la racine, 14/09)
- `rebooking-v2 --dry-run` : — (phase 3)
- `rebooking-v2 --offline` : — (phase 4)
- UI simulation : — (phase 4)

## Prochaine phase

- Phase suivante : 1 — Noyau pur (puis 2 — Stations et inventaire)
- Fiche : `docs/cdc/phases/phase-1-noyau-pur.md`
