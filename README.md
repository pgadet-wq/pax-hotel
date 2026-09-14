# Pack « Cahier des charges — Démo v2 » pour Claude Code

Ce pack contient tout ce dont Claude Code a besoin pour construire la démo v2 de l'outil d'hébergement d'urgence, en sept phases, une conversation par phase.

## Contenu

```
CLAUDE.md                          → à copier à la racine du dépôt (chargé automatiquement à chaque session)
docs/cdc/CAHIER_DES_CHARGES.md     → spécification complète, exigences numérotées EX-…, hypothèses [À CONFIRMER]
docs/cdc/ETAT.md                   → journal d'état, mémoire entre deux conversations
docs/cdc/PROMPTS.md                → cahier de prompts : ouverture, cadrage, un prompt par item, clôture, prompts transverses
docs/cdc/phases/phase-0 … phase-6  → une fiche par phase : objectif, tâches, critères, interdits, clôture, prompt de démarrage
docs/cdc/annexes/plan-demo-v2-2026-09-11.md → plan de développement d'origine
```

## Installation du pack (dépôt `pax-hotel`, vide au 14/09)

Ce pack est le squelette du dépôt. Le code existant (`hai-admin-mcp/` du POC v1) y est rapatrié en phase 0.

1. `git clone https://github.com/pgadet-wq/pax-hotel.git` sur le poste qui contient le POC v1.
2. Copier le contenu de ce pack à la racine du clone : `CLAUDE.md`, `README.md`, `.gitignore`, `.claude/`, `package.json`, `docs/`.
3. Copier le dossier local `hai-admin-mcp/` (POC v1, avec son `package.json` et sans `node_modules`) à la racine du clone. Ne pas copier de clé ni de fichier `.env`.
4. Ouvrir Claude Code depuis la racine du clone.
5. Coller les prompts de la phase 0 depuis `docs/cdc/PROMPTS.md` (mode phase ou mode item). La phase 0 vérifie l'ensemble, commit et pousse.

## Pourquoi une conversation par phase

Claude Code charge `CLAUDE.md` au début de chaque session. Le reste du contexte se remplit avec les fichiers lus, les sorties de commandes et les échanges. Une conversation longue finit par saturer ce contexte : Claude Code compacte alors automatiquement, avec perte de détails. Elle consomme aussi le quota d'usage du compte. Le découpage en phases traite les deux problèmes :

- chaque phase tient dans une conversation courte ;
- `ETAT.md` et le commit de fin de phase transportent l'état vers la conversation suivante ;
- une phase ratée se rejoue depuis son commit précédent, sans polluer les autres.

## Déroulé

| Phase | Fiche | Sessions d'agents | Durée indicative |
|---|---|---|---|
| 0 | `phase-0-audit-git.md` | aucune | courte |
| 1 | `phase-1-noyau-pur.md` | aucune | longue |
| 2 | `phase-2-stations-inventaire.md` | aucune | moyenne |
| 3 | `phase-3-agents-holo.md` | aucune (dry-run) | longue |
| 4 | `phase-4-serveur-ui-simulation.md` | aucune (simulation) | longue |
| 5 | `phase-5-cablage-reel-probes.md` | payantes, une à une, sur accord ; inventaire BKK réel | moyenne |
| 6 | `phase-6-recette-doc-demo.md` | un run complet, sur accord | moyenne |
| 7 | `phase-7-deploiement-scaleway.md` | un run simulé + un run réel distant | courte |

## Calendrier « au plus vite »

| Jour | Conversations | Résultat attendu en fin de journée |
|---|---|---|
| J1 | phases 0, 1, 2 | dépôt poussé ; noyau pur testé ; fiches escale et inventaire hors ligne |
| J2 | phases 3, 4 | pipeline agents en dry-run ; UI complète en simulation |
| J3 | phases 5, 6 | inventaire BKK réel, probes, run réel chronométré, déroulé de démo |
| J4 | phase 7 | démo accessible depuis Scaleway, répétition générale |

Les phases 1, 3 et 4 sont les plus longues. Si l'une déborde, elle prend la journée et le calendrier glisse d'un jour. Ne jamais compresser deux phases dans une conversation pour rattraper le retard.

Règles :

1. **Une conversation par phase.** À la fin de la phase : `ETAT.md` mis à jour, `npm test` vert, commit, puis fermer la conversation. Ouvrir une conversation neuve pour la phase suivante et coller son prompt de démarrage.
2. **Dans une phase longue (1, 3, 4)**, si le contexte se remplit avant la fin, demander à Claude Code de mettre à jour `ETAT.md` avec les cases cochées et les fichiers touchés, puis utiliser `/compact` avec une consigne (par exemple : « conserve la liste des fichiers modifiés, les commandes de test et les cases restantes de la fiche de phase »). Utiliser `/clear` uniquement après un commit, jamais au milieu d'une implémentation.
3. **Jamais deux phases dans la même conversation.** Si Claude Code propose d'enchaîner, refuser et clore.
4. **Après deux corrections infructueuses sur le même point**, clore la conversation, noter le problème dans `ETAT.md`, rouvrir avec un prompt qui intègre ce qui a été appris.
5. **Vérifier avant d'accepter** : chaque fiche liste des critères d'acceptation exécutables (tests, commandes, écran). Une phase sans vérification n'est pas terminée.

## Sessions d'agents payantes

Aucune session payante avant la phase 5. En phases 5, 6 et 7, Claude Code annonce chaque commande payante avec son coût attendu et attend un accord explicite. La variable `DEMO_ALLOW_PAID=1` s'exporte pour la commande seule. Aucun plafond de crédit n'est imposé (décision du 14/09) ; le coût reste affiché en direct et consigné dans `ETAT.md` après chaque run.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `HAI_API_KEY` | clé Agents API H Company, jamais commitée |
| `HAI_API_BASE_URL` | point d'entrée européen `https://agp.eu.hcompany.ai/api/v2` (nom de l'option du SDK TypeScript à relever en phase 0) |
| `DEMO_ALLOW_PAID` | `1` pour autoriser une commande payante, le temps de cette commande |

## Hypothèses à confirmer

Les hypothèses marquées `[À CONFIRMER]` dans le cahier des charges (H-1 à H-8, §15) sont reportées dans `ETAT.md` au fur et à mesure. Elles se tranchent avec l'utilisateur, jamais en silence.

## Déploiement

La démo se développe en local (`127.0.0.1:4310`) et se déploie en phase 7 sur une instance CPU Scaleway `fr-par` (CDC §17), derrière un reverse proxy authentifié. Aucun GPU n'est nécessaire pour la démo ; le GPU H100 reste réservé à l'auto-hébergement de Holo3.1 en version opérationnelle.
