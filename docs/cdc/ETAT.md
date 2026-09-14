# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 2 — Stations et inventaire
- Statut : non démarrée (phase 1 terminée le 14/09)
- Dernier commit : `feat(phase-1): noyau pur (policy, dossiers, allocate, reglement, cout, messages) + tests` (poussé sur `origin/main`)

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés sur `origin/main` (v1 intacte, INV-6) ; `npm ci` propre sous `hai-admin-mcp/` ; `npm test` câblé depuis la racine ; valeurs « Plans and limits » consignées (section dédiée).
- Phase 1 (14/09) — noyau pur, 100 % hors ligne, zéro import `hai-agents` (vérifié par test) :
  - `hai-admin-mcp/lib/` : `csv.mjs` (parse passagers + CSV BOM avec échappement), `policy.mjs` (modèle v2 + ajouts `allowances`/`payment`/`extension`/`agents`/`inventory`, `effectiveCaps` EX-POL-1, `conformityOf` CONFORME/PARTIELLE/HORS_BAREME/NON_CONFORME, score EX-ALL-3), `scenario.mjs` (A350 34/24/266, `mergeConfig` bornée, `resolveDates` locales), `passagers.mjs` (générateur pur seedé, modes `exact`/`legacy`), `dossiers.mjs` (tiers + overlays, chambrage, `computeNeeds`), `reglement.mjs` (`companyPaymentPossible` EX-INV-4 + `modeReglement` EX-ALL-6), `allocate.mjs` (pur, incrémental, colonnes §5.7, borne `rooms_available_max` EX-ALL-5, PMR accessible + surclassement de tier, motif d'escalade capacité/règlement), `cout.mjs` (EX-COU-1, borne 32 900 €), `messages.mjs` (gabarits FR/EN, 3 variantes, zéro LLM, erreur sur placeholder non résolu), `rapport.mjs` (plan CSV §5.7, rapport md horodaté EX-REL-2, messages CSV).
  - `data/messages/fr.md` + `en.md` (gabarits éditables) ; `data/simulate/releves-demo.json` : copie v2 du relevé POC du 31/08 (+ `payment`, `cap_reached`, `quantity_displayed_max`, `observed_at`, amenities/étoiles/notes plausibles) — couvre les 3 modes de règlement et un relevé `found=false`.
  - `tools/generate-passengers.mjs` réécrit en wrapper mince de `lib/passagers.mjs` (défauts CLI v1 : A330 22/20/236 legacy, seed 42) — sortie vérifiée identique octet à octet à `data/passagers-test.csv`.
  - Tests `node --test` : 64 cas verts (11 fichiers + `helpers.mjs`), dont tous les cas obligatoires de la fiche (J-PMR surclassé, famille 2A+3C, PARTIELLE faute de mieux, plafond ± dérogation, épuisement → escalade, dédup tarifaire, borne 32 900 €, seed 42 A330 identique).
  - Acceptation vérifiée (mini-script offline) : 324 pax → 157 dossiers → 88 OK + 69 escalades, 3 modes de règlement observés, 314 messages FR/EN sans `{{` résiduel, coût avec `not_determinable: ["repas","transport"]`.

## En cours

- Rien.

## Décisions prises

- Rapatriement sélectif (phase 0) : l'ébauche v2 de `C:\Users\pgade\wingmate-holotab` n'est pas copiée ; les phases 1-4 reconstruisent la v2 — la phase 1 a repris son modèle de politique/dossiers/allocation comme référence (CDC §5.1 « reprend le modèle du plan v2 ») en y appliquant les ajouts CDC.
- `data/` et `out/` à la racine du dépôt ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"` (répertoire nu en échec sous Node 22/Windows).
- Le rayon du score de proximité vient de la fiche escale (EX-ALL-3) : `search_radius_km` retiré de `policy.global.discovery` ; `conformityOf(inv, tierPolicy, global, {capEur, radiusKm})`.
- `companyPaymentPossible` (EX-INV-4) vit dans `lib/reglement.mjs` (nécessaire à l'allocation dès la phase 1) ; `lib/inventaire.mjs` (phase 2) l'importera de là.
- Note « communicantes à confirmer » posée aussi quand une famille au-delà de l'unité familiale prend 2 chambres (chemin standard).
- Relevé v2 : les chambres portent `quantity_available` (v1) ET `quantity_displayed_max`/`cap_reached` (v2) ; l'allocation lit `rooms_available_max ?? quantity_available ?? quantity_displayed_max`.

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` (requis par `npm ci`) ; `out/releves-poc-bkk-2026-09-01.json` (local, ignoré) ; `test/helpers.mjs` (fabriques) ; `test/phase0.test.mjs` (conservé).
- Absents (normal) : `lib/stations.mjs`, `lib/inventaire.mjs`, `data/stations/`, `data/inventaire/`, `data/simulate/inventaire-demo.json`, `tools/inventaire.mjs` (phase 2) ; `lib/hai.mjs`, `lib/discovery.mjs`, `lib/releve.mjs`, `lib/capacite.mjs`, `lib/events.mjs`, `tools/rebooking-v2.mjs` (phase 3) ; `demo/`, `data/presets/` (phase 4).
- `hai-admin-mcp/package.json` déclare `main`/`bin` → `src/server.mjs` (resté dans l'ancien projet) : référence morte assumée, fichier POC intact.

## Environnement (H-8, relevé le 14/09)

- OS : Windows 11 Famille (10.0.26200) ; shell PowerShell
- Node v22.23.2 (≥ 22 exigé : OK) ; npm 10.9.8
- `hai-agents` 1.0.7 ; `zod` 4.5.4 (installés par `npm ci` sous `hai-admin-mcp/`)

## POC v1 — repères (phase 0, détail dans `tools/rebooking.mjs`)

- CLI `rebooking.mjs` : `--in/--checkin/--nights/--dry-run/--probe/--offline/--hotels` ; agent « hotel-scout-bkk », maxSteps 70, maxTimeS 1000, timeout client 45 min ; 4 hôtels BKK fixes + alternates, allocation par catégorie (matrice v1) — logique reprise et généralisée dans `lib/` en phase 1.
- `answerSchema` v1 (zod) : `{hotel, found, checkin, checkout, currency, rooms[{room_type, occupancy_*, quantity_available, price_per_night, free_cancellation, breakfast_included}], notes}`.
- Sessions : `ensureAgent` (env web booking.com visual 1280×900 markdown, skills h/answering + h/planning, instructions no-booking/no-CAPTCHA) puis `client.runSession` par hôtel en `Promise.all` (`groupId`, `waitForSeconds: 25`, `idleTimeoutS: null`) ; clé lue dans `HAI_API_KEY` sinon `~/.config/hai/.env`.
- `out/releves-poc-bkk-2026-09-01.json` (run du 31/08) : novotel relevé via substitution (Hyatt Regency), méridien `found=false` — base de `data/simulate/releves-demo.json`.

## SDK hai-agents 1.0.7 (TS) — relevé phase 0 (H-6)

- `new HaiAgentsClient({...})` : `environment?: Supplier<HaiAgentsEnvironment | string>` (EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai`) et `baseUrl?` (origine SANS `/api/v2`, le SDK l'ajoute).
- Le SDK ne lit que `HAI_API_KEY` ; `HAI_API_BASE_URL` est à câbler dans notre code, p. ex. `environment: process.env.HAI_API_BASE_URL ?? HaiAgentsEnvironment.Eu`.
- `startSession<TAnswer>(CreateSessionParams & {answerSchema?, tools?}) → SessionHandle` ; `SessionRequest` : `{agent, messages?, maxSteps?, maxTimeS?, idleTimeoutS?, deleteAfterMin?, queue? (false → 429), groupId?, parentSessionId?, overrides?}` ; `overrides` : chemins pointés, `[field=value]` — ex. `{"agent.environments[kind=web].start_url": "…"}`.
- `SessionHandle` : `get/status/changes/sendMessage/pause/resume/cancel/forceAnswer` ; `stream({until: "settled"|"terminal", …})` ; `waitForCompletion({answerSchema, …})` ; `runSession(...)` une passe (v1) ; `client.session(id)` pour se rattacher.
- Modèle d'un agent : champ `model?: string | null` de `createAgent`/`patchAgent` (défaut plateforme si omis) ; pas d'API de liste des modèles.

## Hypothèses `[À CONFIRMER]` rencontrées

| Id CDC | Choix appliqué | Statut |
|---|---|---|
| H-1 | Règle `company_payment_possible` validée le 14/09, implémentée et testée dans `lib/reglement.mjs` | fait (phase 1) |
| H-6 | Option TS : `environment`/`baseUrl` (origine sans `/api/v2`) ; `HAI_API_BASE_URL` à câbler manuellement | fait (phase 0) |
| H-7 | Montants repas/transport non fixés : `policy.allowances` à `null` par défaut → « non renseigné » + `not_determinable`, jamais estimés ; saisissables dans l'UI (phase 4) | fait (phase 1, défauts) |
| H-8 | OS et Node relevés (voir Environnement) | fait (phase 0) |
| H-9 | Valeurs « Plans and limits » consignées ; comportement réel à mesurer en phase 5 | fait (phase 0) |

## Points bloquants

- Aucun.

## Valeurs lues sur le compte H (phase 0, fournies par l'utilisateur le 14/09)

- Concurrence : aucune limite de sessions sur le plan ; CDC §16 maintient `agents.concurrency = auto` plafonnée à 6, repli 3 sur 429/file.
- Modèles sélectionnables (agents `h/…`, pas d'ids de modèle bruts) : `h/web-surfer-pro|flash`, `h/web-scraper-pro|flash`, `h/deep-search-pro` ; correspondance champ `model` ↔ offre à trancher en phase 5 — lecture CDC §16 : classe pro pour étages A/B, classe flash pour les sondes.
- Quotas : 60 M tokens inclus ; au-delà, abonnement requis.

## Vérification

- `npm test` : OK (64 cas, 14/09)
- `rebooking-v2 --dry-run` : — (phase 3)
- `rebooking-v2 --offline` : — (phase 4)
- UI simulation : — (phase 4)

## Prochaine phase

- Phase suivante : 2 — Stations et inventaire (puis 3 — Agents Holo)
- Fiche : `docs/cdc/phases/phase-2-stations-inventaire.md`
