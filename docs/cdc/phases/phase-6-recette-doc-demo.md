# Phase 6 — Recette de bout en bout, documentation, déroulé de démonstration

Couvre : CDC §12.3, §1 (critère de succès). Un run complet réel autorisé sur demande explicite.

## Objectif

Prouver le critère de succès (run réel BKK < 30 min, coût lu en direct, simulation ~90 s), livrer la documentation et le déroulé de la démonstration.

## À lire

- `docs/cdc/ETAT.md`
- CDC §1, §12.3, §13, §14

## Tâches

- [ ] `npm test` vert. `rebooking-v2 --offline` conforme.
- [ ] Recette UI en simulation (liste CDC §12.3 point 3), résultats notés dans `docs/recette-demo-v2.md`.
- [ ] Run complet réel depuis l'UI sur BKK, après accord explicite : chronométrer, lire le coût, télécharger plan / rapport / messages / coût. Archiver dans `docs/recette-demo-v2.md`.
- [ ] Si le run dépasse 30 min : appliquer les boutons de réglage CDC §13 (concurrence, décalage, `max_hotels_stage_b`) et relancer une fois maximum, après accord.
- [ ] README du dépôt : section « Démo v2 » (installation, variables d'environnement, commandes, mode simulation, onglet Inventaire, escales, bornes d'extension, limites connues).
- [ ] `docs/matrice-affectation.md` : tiers = cabines, surcouches, conformité, mode de règlement, extension.
- [ ] `docs/deroule-demo.md` : script de démonstration en 8 étapes (CDC §1), plan B en simulation, réglages recommandés, points à ne pas montrer (clé, `out/`).
- [ ] Liste des hypothèses `[À CONFIRMER]` restantes, consolidée dans `ETAT.md`.

## Critères d'acceptation

- `docs/recette-demo-v2.md` contient les mesures réelles (durée, coût, sessions, vagues d'extension).
- Le déroulé de démonstration a été joué une fois en simulation sans accroc.
- Aucun fichier `out/` ni clé dans git.

## Clôture

1. `ETAT.md` : phase courante → 7, liste des hypothèses restantes.
2. `git tag demo-v2-recette && git commit -m "docs(phase-6): recette, README, déroulé de démo"` et push.
3. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-6-recette-doc-demo.md`. Exécute la phase 6. Le run réel se lance uniquement après mon accord explicite. Termine par `ETAT.md`, le tag et le commit indiqués.
