# Phase 0 — Rapatriement dans `pax-hotel`, audit, initialisation

Couvre : CDC §3, §4 (arborescence), §16 (valeurs du plan H), H-6, H-8, H-9. Aucune session d'agent.

## Objectif

Mettre le code existant du POC v1 et le pack sous git dans le dépôt `pax-hotel`, connaître l'état réel du code et du compte H avant d'écrire une ligne, pousser un premier commit propre.

## Pré-requis (faits par l'utilisateur avant d'ouvrir Claude Code)

- Clone de `https://github.com/pgadet-wq/pax-hotel.git` sur le poste qui contient le POC v1.
- Pack copié à la racine du clone (`CLAUDE.md`, `README.md`, `.gitignore`, `.claude/`, `package.json`, `docs/`).
- Dossier local `hai-admin-mcp/` (POC v1) copié à la racine du clone, sans `node_modules`, sans `.env`, sans clé.

## À lire

- `docs/cdc/ETAT.md`
- `docs/cdc/CAHIER_DES_CHARGES.md` §2.3, §3, §4, §16
- `docs/cdc/annexes/plan-demo-v2-2026-09-11.md`

## Tâches

- [ ] Vérifier que `hai-admin-mcp/A_REMPLACER_PAR_LE_POC_V1.md` a été remplacé par le code du POC (`tools/rebooking.mjs`, `tools/generate-passengers.mjs`, `tools/collect-sessions.mjs`, `package.json`, `data/passagers-test.csv`, `out/releves-poc-bkk-2026-09-01.json`). Sinon, s'arrêter et le demander.
- [ ] Supprimer `hai-admin-mcp/A_REMPLACER_PAR_LE_POC_V1.md`.
- [ ] Lister l'arborescence réelle. Comparer avec CDC §4. Noter les écarts dans `ETAT.md`.
- [ ] Relever l'OS, la version de Node (≥ 22 attendu), la version installée de `hai-agents` et de `zod` (`npm ci` sous `hai-admin-mcp/`). Noter dans `ETAT.md`.
- [ ] Lire `tools/rebooking.mjs` (v1) et `tools/generate-passengers.mjs`. Résumer en 10 lignes dans `ETAT.md` : fonctions, schémas, options CLI, format du CSV passagers, format de `out/releves-poc-bkk-2026-09-01.json`.
- [ ] Dans le SDK installé (`node_modules/hai-agents`) : relever le nom exact de l'option de point d'entrée (base URL) du client TypeScript, la forme de `startSession`, `stream`, `waitForCompletion`, `overrides`, et la façon de désigner le modèle d'un agent personnalisé. Noter les signatures dans `ETAT.md`.
- [ ] Demander à l'utilisateur les valeurs de la page « Plans and limits » de son compte H (concurrence maximale de sessions, modèles sélectionnables, quotas). Les consigner dans `ETAT.md` section « Valeurs lues sur le compte H ». Elles remplacent les défauts de CDC §16.
- [ ] Vérifier `.gitignore` ; s'assurer qu'aucune clé ni aucun fichier `out/` ne sera commité (`git status`).
- [ ] Créer `hai-admin-mcp/test/` avec un test vide qui passe. Vérifier `npm test` depuis la racine.
- [ ] `git add -A && git commit -m "chore(phase-0): POC v1 + pack CDC démo v2"` puis `git push -u origin main` (ou la branche par défaut du dépôt).

## Critères d'acceptation

- `git log` montre le commit initial sur GitHub, aucune clé ni `out/` dans l'index.
- `npm test` passe depuis la racine.
- `ETAT.md` contient : écarts d'arborescence, versions, signatures SDK, option base URL, valeurs du compte H.

## Interdits

- Modifier `tools/rebooking.mjs`.
- Lancer une session d'agent.
- Commencer la phase 1.

## Clôture

1. `ETAT.md` : phase courante → 1, « Fait », hypothèses rencontrées.
2. Commit et push.
3. S'arrêter. La phase 1 démarre dans une nouvelle conversation.

## Prompt de démarrage (à coller dans une conversation neuve, depuis la racine du clone)

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-0-audit-git.md`. Exécute la phase 0 uniquement. Ne lance aucun agent. Demande-moi les valeurs de la page « Plans and limits » de mon compte H quand tu en es là. Termine par la mise à jour d'`ETAT.md`, le commit et le push indiqués.
