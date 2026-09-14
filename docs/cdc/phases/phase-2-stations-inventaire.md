# Phase 2 — Fiches escale et inventaire hôtelier (hors ligne)

Couvre : CDC §5.2, §5.3, §6.1 (partie hors ligne), EX-STA-*, EX-INV-1 à 4, EX-INV-6 (`--dry-run`, `--offline`), H-4, H-5. Aucune session d'agent.

## Objectif

Rendre l'outil multi-escale sans modifier la trame : la fiche escale porte tous les paramètres qui varient. Constituer le référentiel d'inventaire et son outil, en mode hors ligne.

## À lire

- `docs/cdc/ETAT.md`
- CDC §5.2, §5.3, §6.1, §6.2 (EX-DIS-3), §12.1

## Tâches

- [ ] `lib/stations.mjs` : `StationSchema`, `loadStation`, `listStations` (tri `demo_priority`), `DEFAULT_STATION = "BKK"`.
- [ ] `data/stations/BKK.json`, `CDG.json`, `NOU.json` selon le tableau CDC §5.2. `fallback_hotels` de BKK = liste v1 du POC (reprendre les 4 URL de `tools/rebooking.mjs`).
- [ ] `lib/inventaire.mjs` : `InventaireSchema`, `loadInventaire`, `mergeInventaire` (EX-INV-1), `isStale` (EX-INV-2), `candidatesFrom` (EX-INV-3), calcul `company_payment_possible` (EX-INV-4).
- [ ] `data/inventaire/BKK.json` initial construit à partir des fixtures (source `agent`) + `CDG.json`, `NOU.json` vides valides.
- [ ] `data/simulate/inventaire-demo.json` (BKK).
- [ ] `tools/inventaire.mjs` : options `--station`, `--dry-run` (affiche zone, nflt, URL de recherche), `--offline <fixtures>` (écrit l'inventaire via merge). Les options payantes (`--refresh` réel, `--max`) sont câblées en phase 3 et retournent « non disponible avant phase 3 ».
- [ ] `lib/hai.mjs` — partie pure seulement : `buildNflt(policy, station)` (EX-DIS-3), `buildSearchUrl`, `buildHotelUrl`, `buildProbeUrl` (H-3 : paramètres `no_rooms`, `group_adults`, à confirmer en phase 5). Aucun import de `hai-agents` dans cette phase (séparer en `lib/hai-urls.mjs` si nécessaire).
- [ ] Brancher `effectiveCaps` et le rayon de la fiche dans `allocate` / score.
- [ ] Tests : 3 fiches valides, fiche invalide rejetée, `buildNflt` sans `distance=` pour NOU, merge sans écraser le manuel, drapeaux conservés, `isStale`, ordre des candidats, `company_payment_possible`, plafond effectif × facteur.

## Critères d'acceptation

- `node tools/inventaire.mjs --station NOU --dry-run` affiche une URL sans `distance=` et la zone « Nouméa ».
- `node tools/inventaire.mjs --station BKK --offline data/simulate/inventaire-demo.json` écrit `data/inventaire/BKK.json` sans toucher aux entrées manuelles (ajouter une entrée manuelle avant pour le prouver).
- `npm test` vert.

## Interdits

- Importer `hai-agents`. Lancer un agent. Toucher à `demo/`.

## Clôture

1. `ETAT.md` : fichiers livrés, hypothèses H-3 / H-4 / H-5 notées, phase courante → 3.
2. `git commit -m "feat(phase-2): fiches escale multi-destination + inventaire hôtelier hors ligne"`.
3. Push. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-2-stations-inventaire.md`. Exécute la phase 2 uniquement, hors ligne. Termine par `npm test`, `ETAT.md` et le commit indiqué.
