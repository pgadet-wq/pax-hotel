# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 3 — Agents Holo (câblage, sans session payante hors demande explicite)
- Statut : non démarrée (phase 2 terminée le 15/09)
- Dernier commit : `feat(phase-2): fiches escale multi-destination + inventaire hôtelier hors ligne` (poussé sur `origin/main`)

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés sur `origin/main` (v1 intacte, INV-6) ; `npm ci` propre sous `hai-admin-mcp/` ; `npm test` câblé depuis la racine ; valeurs « Plans and limits » consignées (section dédiée).
- Phase 1 (14/09) — noyau pur, zéro import `hai-agents` (vérifié par test) : `lib/csv.mjs`, `policy.mjs` (modèle v2 + ajouts CDC, `effectiveCaps`, `conformityOf` 4 niveaux), `scenario.mjs`, `passagers.mjs` (modes `exact`/`legacy` ; seed 42 A330 identique octet à octet à `data/passagers-test.csv`), `dossiers.mjs`, `reglement.mjs` (EX-INV-4 + EX-ALL-6), `allocate.mjs` (pur, colonnes §5.7, borne EX-ALL-5, PMR, motifs d'escalade), `cout.mjs` (EX-COU-1, borne 32 900 €), `messages.mjs` (FR/EN, 3 variantes, zéro LLM), `rapport.mjs` ; gabarits `data/messages/{fr,en}.md` ; fixture `data/simulate/releves-demo.json` ; `tools/generate-passengers.mjs` en wrapper mince. Acceptation : 324 pax → 157 dossiers → 88 OK + 69 escalades, 3 modes de règlement, 314 messages sans `{{`, coût `not_determinable`.
- Phase 2 (15/09) — multi-escale et inventaire, hors ligne :
  - `lib/stations.mjs` : `StationSchema` (refine EX-STA-2), `loadStation` (erreurs explicites EX-STA-4, casse tolérée, code = nom de fichier), `listStations` (tri `demo_priority`, EX-STA-1), `DEFAULT_STATION = "BKK"`.
  - `data/stations/BKK.json` (fallback = 4 hôtels v1 du POC), `CDG.json`, `NOU.json` (zone_center, sans filtre distance, navette 75 min H-5) — conformes au tableau CDC §5.2.
  - `lib/inventaire.mjs` : `InventaireSchema` (+ `normalizeInventaire` : ids uniques, `company_payment_possible` recalculé EX-INV-4, jamais lu de confiance), `loadInventaire` (null si absent), `mergeInventaire` (EX-INV-1 : manuel intouchable, drapeaux conservés, agents non revisités conservés), `isStale` (EX-INV-2), `candidatesFrom` (EX-INV-3 : non exclus, contracté → préféré → score ; replis fiche escale en fin, dédupliqués par URL/nom, marqués `fallback`), `compatibleTiers`, `slugify`.
  - `data/inventaire/BKK.json` (3 hôtels du POC, source agent), `CDG.json` + `NOU.json` vides valides ; `data/simulate/inventaire-demo.json` (rafraîchissement simulé du 14/09 : 3 hôtels + Novotel relisté, valeurs §5.3).
  - `lib/hai-urls.mjs` (partie pure du futur `lib/hai.mjs`) : `NFLT`, `buildNflt(policy, station)` (EX-DIS-3 : `distance=` omis si `use_distance_filter=false`, `extra_nflt` ajouté), `buildSearchUrl`, `buildHotelUrl`, `buildProbeUrl` (no_rooms, group_adults = 2×n, H-3).
  - `tools/inventaire.mjs` : `--station`, `--checkin`/`--nights` (défaut J+14, 1 nuit — H-4), `--dry-run` (zone, nflt, URLs, replis, état de péremption ; n'écrit rien), `--offline <fixtures>` (merge + écriture + bilan) ; `--refresh`/`--max`/sans option → « non disponible avant la phase 3 », exit 1.
  - Tests : 79 cas verts (13 fichiers) — 3 fiches valides/ordonnées, fiche invalide rejetée, nflt NOU sans `distance=`, merge/manuel/drapeaux, `isStale`, ordre candidats + replis, `company_payment_possible`, plafond × facteur, CLI (dry-run NOU, refus payant, offline avec entrée manuelle préservée et restauration).
  - Acceptation vérifiée : dry-run NOU (zone « Nouméa », aucune `distance=`) ; offline BKK avec entrée manuelle contractée ajoutée avant → 5 hôtels (1 manuel intouché, 3 mis à jour, Novotel ajouté), puis retour à l'état initial committé.

## En cours

- Rien.

## Décisions prises

- Rapatriement sélectif (phase 0) ; reconstruction v2 par phases, l'ébauche `wingmate-holotab` sert de référence de modèle.
- `data/` et `out/` à la racine ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"`.
- Le rayon du score vient de la fiche escale (EX-ALL-3) ; `conformityOf(inv, tierPolicy, global, {capEur, radiusKm})` ; `allocate` branché sur `effectiveCaps` + rayon depuis la phase 1.
- `companyPaymentPossible` (EX-INV-4) vit dans `lib/reglement.mjs` ; `lib/inventaire.mjs` l'importe de là.
- Relevé v2 : chambres avec `quantity_available` (v1) ET `quantity_displayed_max`/`cap_reached` ; l'allocation lit `rooms_available_max ?? quantity_available ?? quantity_displayed_max`.
- Partie URL pure séparée dans `lib/hai-urls.mjs` (autorisé par la fiche 2) : la phase 3 créera `lib/hai.mjs` (SDK) qui la réexporte ; le test INV-7 (aucun import `hai-agents` sous `lib/`) sera ajusté en phase 3 pour exclure les modules SDK.
- `fallback_hotels` BKK : la config v1 ne porte que des noms (pas d'URL) → slugs booking.com reconstruits, cohérents avec les fixtures (valeurs de démo).
- `mergeInventaire` conserve les entrées agent absentes du relevé frais : la péremption se juge par `updated_at`, pas par disparition d'une liste.
- Étage 0 : dates de référence par défaut J+14, 1 nuit (H-4), éditables par `--checkin`/`--nights`.

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` ; `out/releves-poc-bkk-2026-09-01.json` (local, ignoré) ; `test/helpers.mjs` ; `test/phase0.test.mjs` ; `lib/hai-urls.mjs` (partie pure de `hai.mjs`, voir Décisions).
- Absents (normal) : `lib/hai.mjs`, `lib/discovery.mjs`, `lib/releve.mjs`, `lib/capacite.mjs`, `lib/events.mjs`, `tools/rebooking-v2.mjs` (phase 3) ; `demo/`, `data/presets/` (phase 4).
- `hai-admin-mcp/package.json` déclare `main`/`bin` → `src/server.mjs` absent : référence morte assumée, fichier POC intact.

## Environnement (H-8, relevé le 14/09)

- OS : Windows 11 Famille (10.0.26200) ; shell PowerShell ; Node v22.23.2 ; npm 10.9.8 ; `hai-agents` 1.0.7 ; `zod` 4.5.4 (sous `hai-admin-mcp/`).

## POC v1 — repères (phase 0, détail dans `tools/rebooking.mjs`)

- CLI v1 : `--in/--checkin/--nights/--dry-run/--probe/--offline/--hotels` ; agent « hotel-scout-bkk », maxSteps 70, maxTimeS 1000, timeout 45 min ; 4 hôtels BKK + alternates ; logique reprise dans `lib/` en phase 1.
- Sessions : `ensureAgent` (env web booking.com visual 1280×900 markdown, skills h/answering + h/planning, no-booking/no-CAPTCHA) puis `client.runSession` par hôtel en `Promise.all` (`groupId`, `waitForSeconds: 25`, `idleTimeoutS: null`) ; clé `HAI_API_KEY` sinon `~/.config/hai/.env`.
- `out/releves-poc-bkk-2026-09-01.json` (31/08) : novotel via substitution (Hyatt Regency), méridien `found=false` — base des fixtures v2.

## SDK hai-agents 1.0.7 (TS) — relevé phase 0 (H-6)

- `new HaiAgentsClient({...})` : `environment` (EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai`) ou `baseUrl` — origine SANS `/api/v2` ; seul `HAI_API_KEY` est lu automatiquement, `HAI_API_BASE_URL` à câbler dans notre code.
- `startSession<TAnswer>(CreateSessionParams & {answerSchema?, tools?}) → SessionHandle` ; `SessionRequest` : `{agent, messages?, maxSteps?, maxTimeS?, idleTimeoutS?, deleteAfterMin?, queue? (false → 429), groupId?, parentSessionId?, overrides?}` ; `overrides` : `{"agent.environments[kind=web].start_url": "…"}`.
- `SessionHandle` : `get/status/changes/sendMessage/pause/resume/cancel/forceAnswer` ; `stream({until, …})` ; `waitForCompletion({answerSchema, …})` ; `runSession(...)` une passe ; `client.session(id)` pour se rattacher.
- Modèle d'un agent : champ `model?: string | null` (`createAgent`/`patchAgent`), défaut plateforme ; pas d'API de liste des modèles.

## Hypothèses `[À CONFIRMER]` rencontrées

| Id CDC | Choix appliqué | Statut |
|---|---|---|
| H-1 | `company_payment_possible` validée le 14/09, dans `lib/reglement.mjs`, recalculée à chaque chargement d'inventaire | fait (phase 1-2) |
| H-3 | `buildProbeUrl` pose `no_rooms=n`, `group_adults=2×n` ; concluant ou non → tranché en phase 5 (`--probe-capacity`), sinon `probe_same_hotel_first=false` | préparé (phase 2) |
| H-4 | Péremption 30 jours (`inventory.max_age_days`) ; dates de référence Étage 0 : J+14, 1 nuit — défauts appliqués, éditables (`--checkin`, `--nights`, UI phase 4) | fait (phase 2, défauts) |
| H-5 | NOU : navette 75 min ; CDG : facteur de plafond 1.0 — posés dans les fiches, éditables | fait (phase 2, défauts) |
| H-6 | Option TS : `environment`/`baseUrl` (origine sans `/api/v2`) | fait (phase 0) |
| H-7 | Repas/transport non fixés : `allowances` null → « non renseigné » + `not_determinable` | fait (phase 1, défauts) |
| H-8 | OS et Node relevés (voir Environnement) | fait (phase 0) |
| H-9 | « Plans and limits » consignés ; à mesurer en phase 5 | fait (phase 0) |

## Points bloquants

- Aucun.

## Valeurs lues sur le compte H (phase 0, fournies par l'utilisateur le 14/09)

- Concurrence : aucune limite sur le plan ; CDC §16 maintient `auto` plafonné à 6, repli 3 sur 429/file.
- Modèles sélectionnables (agents `h/…`) : `h/web-surfer-pro|flash`, `h/web-scraper-pro|flash`, `h/deep-search-pro` ; correspondance champ `model` ↔ offre à trancher en phase 5 (classe pro pour A/B, flash pour les sondes).
- Quotas : 60 M tokens inclus ; au-delà, abonnement requis.

## Vérification

- `npm test` : OK (79 cas, 15/09)
- `tools/inventaire.mjs --dry-run` / `--offline` : OK (15/09, NOU sans `distance=` ; merge avec manuel préservé)
- `rebooking-v2 --dry-run` : — (phase 3)
- `rebooking-v2 --offline` : — (phase 4)
- UI simulation : — (phase 4)

## Prochaine phase

- Phase suivante : 3 — Agents Holo (puis 4 — Serveur, UI, simulation)
- Fiche : `docs/cdc/phases/phase-3-agents-holo.md`
