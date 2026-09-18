# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : 7 — Déploiement Scaleway (phases 5 et 6 terminées le 15/09)
- Statut : non démarrée
- Dernier commit : `feat(phase-5): fixtures réelles et captures réelles de simulation` (complément de clôture phase 5, poussé sur `origin/main` ; le tag `demo-v2-recette` reste sur le commit de recette)

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés (v1 intacte, INV-6) ; `npm ci` propre ; « Plans and limits » consignés.
- Phase 1 (14/09) — noyau pur : `lib/{csv,policy,scenario,passagers,dossiers,reglement,allocate,cout,messages,rapport}.mjs`, gabarits FR/EN, fixture `releves-demo.json`, seed 42 reproductible. Offline : 324 pax → 88 OK + 69 escalades.
- Phase 2 (15/09) — multi-escale hors ligne : `lib/stations.mjs` + `data/stations/{BKK,CDG,NOU}.json`, `lib/inventaire.mjs` + `data/inventaire/*.json`, `lib/hai-urls.mjs`, `tools/inventaire.mjs`.
- Phase 3 (15/09) — pipeline agents complet zéro session : `lib/hai.mjs` (SEUL module SDK, INV-7), `lib/{events,discovery,releve,capacite,pipeline}.mjs`, `tools/rebooking-v2.mjs` (payant derrière DEMO_ALLOW_PAID=1, INV-8).
- Phase 4 (15/09) — serveur, SSE, UI, simulation : `demo/{sse-hub,run-manager,session-pump,simulate,server}.mjs`, `demo/public/`, preset `politique-standard`, run simulé ~87 s (157 OK / 0 escalade), snapshot, 409, annulations.
- Phase 5 (15/09) — câblage réel et Étage 0 réel (la conversation s'est interrompue avant clôture ; commit rattrapé en phase 6) :
  - `demo/server.mjs` : run réel (`realCollect`) et Étage 0 par agents derrière `DEMO_ALLOW_PAID=1` côté serveur (sinon 501) ; proxy captures https avec bearer vers l'origine API seule (INV-4) + `imageType base64` ; `demo/inventaire-refresh.mjs` (refresher SSE, 409 croisé avec les runs).
  - `demo/session-pump.mjs` + `pumpToCompletion` : annulation RÉELLE (`handle.cancel()` sur abort) ; coût/steps par session agrégés depuis le flux (`discovery/releve/capacite`).
  - `ensureAgentV2` : patch du modèle si l'agent existe avec un autre (la politique est source de vérité) ; journal du point d'entrée EU au démarrage du client (H-6 exercée).
  - `lib/inventaire.mjs` : `reconcileIds` (fusion sans doublon par URL/nom) ; `tools/inventaire.mjs --refresh` : mesures §13 + archives `out/` + captures ; `tools/rebooking-v2.mjs` : `--probe-discovery/--probe-releve/--probe-capacity/--probe-inventaire`.
  - **Étage 0 réel BKK exécuté** (accord donné en phase 5 ; le processus s'est achevé pendant la conversation phase 6) : `data/inventaire/BKK.json` → 9 hôtels `source: agent`, `payment` + `capacity_hint` partout (critère ≥ 8 atteint). Mesures : 693 s, 11 sessions (1 découverte + 10 relevés courts), 0,99 $, 0 × 429, concurrence 3/3 (config 3, stagger 25 s), 10/10 schémas valides, 7 exploitables. Archives : `out/{candidats,inventaire}-mu2gsy9c.json`, `out/captures-mu2gsy9c/`. Une découverte avait échoué avant retry (`mu2goptp`).
  - Non joués (volontaire) : probes unitaires `--probe-releve`/`--probe-capacity` (H-3 non tranchée formellement, → run réel).
  - Complément commité après la recette (même journée, conversation phase 5 achevée) : `data/simulate/inventaire-reel-bkk.json` — les 7 relevés réels reformatés en fixtures §5.3 rejouables par `tools/inventaire.mjs --offline` (2 tests dédiés) — et les 4 PNG `demo/sim-assets/` remplacés par de VRAIES captures du run `mu2gsy9c` (résultats filtrés, fiche, tableau des chambres, paiement rognée hors bandeau cookies). La chorégraphie de simulation (`releves-demo.json`, `inventaire-demo.json`, 157/0 en ~90 s) reste inchangée.
- Phase 6 (15/09) — recette, doc, déroulé : `npm test` 159 verts (3 tests qui figeaient l'inventaire POC — `cli-v2`, `inventaire`, `pipeline` — dérivent désormais du fichier livré, l'inventaire réel les ayant invalidés) ; `--offline` conforme (88 OK + 69 escalades, inchangé : les fixtures pilotent) ; recette UI simulation complète consignée dans `docs/recette-demo-v2.md` (87 s, snapshot, 409, annulation propre, 501 INV-8 sans DEMO_ALLOW_PAID) ; README section « Démo v2 » ; `docs/matrice-affectation.md` v2 (tiers/surcouches/conformité/règlement/extension, v1 en annexe) ; `docs/deroule-demo.md` (8 étapes, plan B simulation, réglages, points à ne pas montrer), joué une fois en simulation sans accroc. **Run complet réel NON joué** (décision explicite de l'utilisateur) → reporté phase 7.

## En cours

- Rien. (Les tâches de fond du 15/09 — Étage 0 réel et rapatriement des captures — sont terminées : 98/99 captures sous `out/captures-mu2gsy9c/`.)
- 19/09 (hors phase) — **format de la liste passagers spécifié** : `docs/format-liste-passagers.md` (PAXLIST v1) + modèle vierge, dictionnaire et exemple sous `data/exemples/`. Issu de l'audit d'aptitude au test réel du 18/09 : l'ingestion actuelle ne valide AUCUNE valeur (cabine hors J/W/Y → Y en silence, `type_pax` hors ADT/CHD/INF → 0 adulte, seul `WCHR` exact déclenche PMR, PNR vide fusionne les dossiers). **Spécifié, non implémenté** (lot ≈ 2,75 j décrit au §6 de la spéc). En attente de la liste passagers réelle de la compagnie. `data/paxlist*.csv` ajouté au `.gitignore` : une liste réelle ne se commite jamais.

## Décisions prises

- Reconstruction v2 par phases ; `data/` et `out/` à la racine ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"`.
- Découverte SANS `start_url` override (écart §6.2) ; relevés/sondes : override conservé. `pumpToCompletion` dans `lib/hai.mjs` ; sessions non terminales fermées après réponse.
- L'extension ne compte que ses propres sessions ; `plan_row` réémis à chaque réallocation (l'UI remplace par pnr).
- Phase 4 — simulation : fixtures + 3 réponses scriptées (`SIM_ANSWERS`) ; sonde Hyatt (30) + relevé Amaranth vague 1 → 157 OK / 0 escalade ; run simulé sur `data/simulate/inventaire-demo.json`, onglet Inventaire sur `data/inventaire/{CODE}.json` (compteurs différents assumés).
- Phase 4 — sécurité : captures par `{hotel_key, seq}` résolues serveur (`Cache-Control: private`), CSP `default-src 'self'` ; `sim_speed` hors schéma ; liste téléversée en mémoire process.
- Phase 5 — H-9 : les ids de MODÈLE sont `holo3-122b-a10b` (le plus capable, agents A/B) et `holo3-1-35b-a3b` (classe flash, sonde) — `h/web-surfer-*` sont des AGENTS ; un modèle inconnu fait échouer la session à 0 step. Défauts de `DEFAULT_POLICY.agents` réglés ainsi ; `ensureAgentV2` réaligne par patch.
- Phase 5 — bearer relayé UNIQUEMENT vers l'origine `apiOrigin()` (redirection S3 suivie sans Authorization) ; garde INV-8 déplacée côté serveur (`DEMO_ALLOW_PAID=1` au démarrage).
- Phase 6 — fixtures de simulation VOLONTAIREMENT inchangées (calibrées pour le plan B de démo : 157/0 en 90 s) ; les sorties réelles restent archivées sous `out/` (non commitées), l'inventaire réel BKK est commité (aucune donnée passager). « Probes réels archivés comme fixtures » (§12.3 p.4) est couvert par BKK.json + archives `out/` — et, depuis le complément phase 5, par `data/simulate/inventaire-reel-bkk.json` (fichier SÉPARÉ : la chorégraphie de démo n'en dépend pas).
- Phase 6 — clôture en DEUX commits : `feat(phase-5): câblage réel, inventaire BKK réel, probes` (rattrapage, sans « fixtures réelles » — non faites), puis `docs(phase-6): recette, README, déroulé de démo` + tag `demo-v2-recette` (commit → tag → push, l'ordre littéral de la fiche taggerait l'avant-commit).
- Run réel : lancé uniquement sur accord explicite dans la conversation, `DEMO_ALLOW_PAID=1` pour la commande seule (INV-8) — non joué en phase 6, à jouer en phase 7 (répétition générale, fiche : un run simulé + un run réel distant).

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` ; `out/*` (local, ignoré) ; `test/helpers.mjs` ; `test/phase0.test.mjs` ; `lib/hai-urls.mjs` ; `lib/pipeline.mjs` ; `demo/sim-assets/*.png` (4 captures RÉELLES depuis la ph. 5) ; `demo/inventaire-refresh.mjs` ; `data/presets/politique-standard.json` ; `data/simulate/inventaire-reel-bkk.json` ; `docs/{recette-demo-v2,deroule-demo,format-liste-passagers}.md` ; `data/exemples/paxlist-*.csv` ; dry-run via `POST /api/run {dry_run:true}`.
- `hai-admin-mcp/package.json` : `main`/`bin` → `src/server.mjs` absent (référence morte assumée, POC intact).

## Environnement (H-8, relevé le 14/09)

- Windows 11 Famille (10.0.26200) ; PowerShell ; Node v22.23.2 ; npm 10.9.8 ; `hai-agents` 1.0.7 ; `zod` 4.5.4 (sous `hai-admin-mcp/`).

## SDK hai-agents 1.0.7 (TS) — repères (H-6)

- `new HaiAgentsClient({apiKey, environment})` — EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai` (origine SANS `/api/v2`), câblée dans `createClient()` avec journal au démarrage ; seul `HAI_API_KEY` est lu automatiquement (sinon `~/.config/hai/.env`).
- `startSession → SessionHandle` ; `stream({until})` / `waitForCompletion({answerSchema})` / `cancel` ; `AnswerValidationError`, `isTerminalSessionStatus` ; événements traduits dans `lib/events.mjs` ; `createAgent/patchAgent` champ `model`.

## Hypothèses `[À CONFIRMER]` — consolidation (phase 6)

| Id CDC | État au 15/09 | Reste à faire |
|---|---|---|
| H-1 | validée 14/09 — `company_payment_possible` dans `lib/reglement.mjs` | — |
| H-2 | bornes 18 / 4 vagues / 10 $ éditables (fixées 14/09) | — |
| **H-3** | sonde câblée + simulée ; indice réel : Hyatt `rooms_displayed_max 9, cap_reached true` (relevé du 15/09) | **restante** : à trancher sur run réel (phase 7) ; si non concluante → `probe_same_hotel_first=false` + note |
| H-4 | péremption 30 j, référence J+14 1 nuit (éditables) | — |
| H-5 | NOU navette 75 min ; CDG facteur 1.0 (valeurs de départ éditables) | — |
| H-6 | point d'entrée EU exercé en réel le 15/09 (journal client + sessions abouties) | — |
| **H-7** | `allowances` null → « non renseigné » + `not_determinable` (aucun montant fixé) | **restante** (choix produit) : montants à saisir dans l'UI si la compagnie les fixe |
| H-8 | environnement relevé (14/09) | — |
| **H-9** | concurrence : plan sans limite → auto plafonné 6, repli 3/25 s ; modèles MESURÉS le 15/09 (`holo3-122b-a10b`, `holo3-1-35b-a3b`) | **restante** (partiel) : concurrence 6 à observer sur un run complet réel (l'Étage 0 tournait à 3 volontairement) |

## Points bloquants

- Aucun. Critère ouvert (non bloquant) : mesures du run complet réel absentes de `docs/recette-demo-v2.md` (run non joué en phase 6, décision utilisateur) — à couvrir en phase 7.

## Valeurs lues sur le compte H (14-15/09)

- Concurrence : sans limite plan → `auto` plafonné à 6, repli 3/25 s sur 429 (§16). Modèles agents : ids réels ci-dessus (H-9). Quotas : 60 M tokens inclus. Étage 0 réel : 0,99 $ / 11 sessions / 693 s.

## Vérification

- `npm test` : OK (161 cas, 15/09 — les 159 de la recette + 2 tests des fixtures réelles)
- `rebooking-v2 --offline` : OK (15/09, 88 OK + 69 escalades, 0 €) · `tools/inventaire.mjs --refresh` réel : OK (15/09, 9 hôtels BKK)
- Recette UI simulation (15/09, navigateur) : complète — voir `docs/recette-demo-v2.md` §2
- Run complet réel : NON JOUÉ (phase 7)

## Prochaine phase

- Phase suivante : 7 — Déploiement Scaleway (CDC §17) + répétition générale : un run simulé + le run réel distant (mesures à archiver dans `docs/recette-demo-v2.md` §4)
- Fiche : `docs/cdc/phases/phase-7-deploiement-scaleway.md`
