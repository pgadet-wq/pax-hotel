# Phase 4 — Serveur, SSE, interface, mode simulation

Couvre : CDC §9, §10, EX-UI-*, EX-INV-8, EX-EXT-3, EX-EXT-4, EX-MSG-4, §12.3 point 3. Aucune session payante.

## Objectif

L'application web complète, pilotable par un opérateur, avec un mode simulation de 90 s à zéro coût sur Bangkok.

## À lire

- `docs/cdc/ETAT.md`
- CDC §5.8, §9, §10, §11

## Tâches

- [ ] `demo/sse-hub.mjs` : bus, tampon circulaire 1000, `Last-Event-ID`, `snapshot`, ping 15 s.
- [ ] `demo/run-manager.mjs` : singleton `{state, runId, station, phase, agents, plan, metrics, extension}` ; 409 si run en cours ; `collectFn` injectable ; annulation totale et annulation d'extension.
- [ ] `demo/session-pump.mjs` : `for await (ev of handle.stream({until:"settled"}))` → emit ; PUIS `waitForCompletion` (jamais en parallèle).
- [ ] `demo/simulate.mjs` : `collectFn` simulé, fixtures BKK (`releves-demo.json`, `inventaire-demo.json`), pensées scriptées FR, 3-4 PNG dans `demo/sim-assets/`, une extension simulée (vague 1 : sonde + 1 relevé), durée ~90 s.
- [ ] `demo/server.mjs` : routes CDC §9, statiques en liste blanche, proxy captures par clés d'état, `Cache-Control: private`, téléchargements en liste blanche.
- [ ] `demo/public/` : formulaire (Escale, Politique, Avion, Scénario, presets), onglet Inventaire, frise de phases, cartes agents, bandeau coût / bornes d'extension, tableau du plan, panneau coût, panneau messages (FR/EN, filtre tier, copier), panneau final. `textContent` uniquement pour les textes d'agent.
- [ ] Presets : `data/presets/`, nom assaini `[a-z0-9-]{1,40}`.
- [ ] `.claude/launch.json` vérifié.

## Critères d'acceptation (à dérouler dans le navigateur)

- BKK sélectionnée par défaut, CDG et NOU listées ensuite ; sur NOU en simulation, message « fixtures non disponibles » et bouton dry-run.
- Génération A350 → 324 passagers, statistiques affichées.
- Run simulé complet : phases dans l'ordre CDC §5.8, extension visible avec bornes, plan rempli, coût, messages FR/EN, téléchargements.
- Fermeture / réouverture de l'onglet → snapshot complet. Double-run → 409 proprement. Annulation propre. Annulation d'extension seule.
- Onglet Inventaire : drapeaux et ajout manuel persistés dans `data/inventaire/BKK.json`.
- `npm test` vert.

## Interdits

- Session payante. Dépendance nouvelle. Import de `hai-agents` sous `demo/`.

## Clôture

1. `ETAT.md` : fichiers, écarts UI, phase courante → 5.
2. `git commit -m "feat(phase-4): serveur, SSE, UI vanilla, mode simulation BKK"`.
3. Push. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-4-serveur-ui-simulation.md`. Exécute la phase 4 uniquement. Aucune session payante. Vérifie l'UI en mode simulation avant de clore. Termine par `npm test`, `ETAT.md` et le commit indiqué.
