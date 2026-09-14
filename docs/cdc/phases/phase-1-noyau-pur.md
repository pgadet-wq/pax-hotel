# Phase 1 — Noyau pur et tests hors ligne

Couvre : CDC §5.1, §5.4, §5.5, §5.7, §7, §8.1, §8.2, §12.2 (policy, dossiers, allocate, reglement, cout, messages, passagers). Aucune session d'agent. Aucun réseau.

## Objectif

Livrer le cœur métier en modules purs, testés hors ligne, sans dépendance à `hai-agents`.

## À lire

- `docs/cdc/ETAT.md`
- CDC §5.1, §5.4, §5.5, §5.7, §7, §8.1, §8.2, §12.2
- `tools/rebooking.mjs` (reprendre par copie la logique d'allocation v1 ; ne pas le modifier)

## Tâches

- [ ] `lib/csv.mjs` : `parsePassagersCsv(text)`, `toCsvBom(cols, rows)`.
- [ ] `lib/policy.mjs` : `PolicySchema` (zod) avec les ajouts `allowances`, `payment`, `extension`, `inventory` ; `DEFAULT_POLICY` ; `tierOf`, `conformityOf`, `effectiveCaps(policy, station)`.
- [ ] `lib/scenario.mjs` : `DEFAULT_AVION` (34/24/266), `DEFAULT_SCENARIO` (station BKK, 1 nuit, seed 42, `next_update_minutes` 30), `mergeConfig`.
- [ ] `lib/passagers.mjs` : `generatePassengers` (PRNG mulberry32 local, avion plein exact) + `tools/generate-passengers.mjs` (wrapper, défaut CLI inchangé A330).
- [ ] `lib/dossiers.mjs` : `buildDossiers`, `computeNeeds`.
- [ ] `lib/reglement.mjs` : `modeReglement(hotel, policy)` (EX-ALL-6, H-1 signalée dans ETAT.md).
- [ ] `lib/allocate.mjs` : `allocate({dossiers, inventories, policy, station})` pur, incrémental, colonnes §5.7, borne `rooms_available_max`, parcours EX-ALL-4.
- [ ] `lib/cout.mjs` : `computeCost` (EX-COU-1).
- [ ] `lib/messages.mjs` + `data/messages/fr.md`, `data/messages/en.md` : `buildMessages` (EX-MSG-1 à 3).
- [ ] `lib/rapport.mjs` : `buildPlanCsv`, `buildRapportMd`, `buildMessagesCsv`.
- [ ] Fixtures : `data/simulate/releves-demo.json` = copie reformatée v2 de `out/releves-poc-bkk-2026-09-01.json` (ajout `payment`, `cap_reached`, `observed_at`).
- [ ] Tests `node --test` : policy, dossiers, allocate, reglement, cout, messages, passagers (CDC §12.2). Cas obligatoires : J-PMR surclassé, famille 2A+3C, PARTIELLE faute de mieux, plafond ± dérogation, épuisement → escalade, dédup tarifaire, borne haute 32 900 €, seed 42 A330 identique à `data/passagers-test.csv`.

## Critères d'acceptation

- `npm test` vert, ≥ 25 cas.
- `node -e` d'un mini-script : dossiers + fixtures → plan avec `conformite` et `mode_reglement`, messages FR/EN sans `{{` résiduel, coût avec `not_determinable: ["repas","transport"]`.
- Aucun import de `hai-agents` dans les modules de cette phase.

## Interdits

- Toucher à `demo/`, à `lib/hai.mjs`, à `tools/rebooking.mjs`.
- Ajouter une dépendance.

## Clôture

1. `ETAT.md` : « Fait » (fichiers), hypothèses H-1 / H-7 notées, phase courante → 2.
2. `git commit -m "feat(phase-1): noyau pur (policy, dossiers, allocate, reglement, cout, messages) + tests"`.
3. Push. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-1-noyau-pur.md`. Exécute la phase 1 uniquement. Aucun agent, aucun réseau. Termine par `npm test`, la mise à jour d'`ETAT.md` et le commit indiqué.
