# Pack « Cahier des charges — Démo v2 » pour Claude Code

Ce pack contient tout ce dont Claude Code a besoin pour construire la démo v2 de l'outil d'hébergement d'urgence, en sept phases, une conversation par phase.

## Démo v2 — mode d'emploi

Outil de démonstration : à partir d'une liste passagers (A350-900 plein, 324 passagers), des agents web Holo
(H Company, SDK `hai-agents`) relèvent des hôtels sur Booking et le code construit un plan d'hébergement par
passager — conformité, mode de règlement, coût, messages FR/EN. Escale de démonstration : Bangkok (BKK).
Déroulé pas à pas : [docs/deroule-demo.md](docs/deroule-demo.md) · règles d'affectation :
[docs/matrice-affectation.md](docs/matrice-affectation.md) · recette : [docs/recette-demo-v2.md](docs/recette-demo-v2.md).

### Installation

1. Node ≥ 22 (ESM, aucun build). Dépendances confinées sous `hai-admin-mcp/` : `cd hai-admin-mcp && npm ci`.
2. Clé Agents API H dans l'environnement (`HAI_API_KEY`) ou dans `~/.config/hai/.env` — jamais dans le dépôt (INV-4).
3. `npm test` depuis la racine doit être vert avant toute démo.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `HAI_API_KEY` | clé Agents API H Company (serveur uniquement, jamais commitée) |
| `HAI_API_BASE_URL` | optionnelle — origine de l'API (défaut : point d'entrée européen `https://agp.eu.hcompany.ai`, journalisé au démarrage du client) |
| `DEMO_ALLOW_PAID` | `1` pour déverrouiller les sessions payantes (run réel, Étage 0 par agents), exportée pour la commande seule, après accord explicite — sans elle le serveur répond 501 (INV-8) |

### Commandes

```
npm test                                              # node --test (159 cas, hors ligne, 0 €)
node demo/server.mjs                                  # UI http://127.0.0.1:4310 — simulation et dry-run seulement
DEMO_ALLOW_PAID=1 node demo/server.mjs                # idem + run réel et Étage 0 par agents déverrouillés
node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run   # URLs et plan d'exécution, aucun agent
node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json   # rejeu fixtures, 0 €
node hai-admin-mcp/tools/inventaire.mjs --station BKK --dry-run       # Étage 0 sans agent
DEMO_ALLOW_PAID=1 node hai-admin-mcp/tools/inventaire.mjs --station BKK --refresh --max 10  # Étage 0 réel (payant)
```

Probes unitaires payants (phase 5) : `rebooking-v2 --probe-discovery | --probe-releve <n> | --probe-capacity <url> --rooms <n>`, toujours derrière `DEMO_ALLOW_PAID=1`.

### Mode simulation (filet de sécurité de la démo)

Case « Mode démonstration (sans agents) » de l'UI : run complet en ~90 s, 0 €, fixtures BKK + captures factices,
pensées FR, extension vague 1 (sonde + relevé), 157 dossiers logés / 0 escalade. Vitesse ×1/×5/×20.
Disponible pour BKK uniquement (CDG/NOU : dry-run et message explicite). Rechargement d'onglet → snapshot complet ;
double-run → 409 ; annulation propre (plan conservé en l'état).

### Onglet Inventaire (Étage 0)

Lit/écrit `data/inventaire/{CODE}.json` par escale : hôtels `source: agent | manuel | secours`, note, distance,
prix d'appel, paiement société (`oui / non / a_confirmer`), drapeaux contracté / préféré / exclu, ajout manuel.
« Rafraîchir par agents » relance découverte + relevés courts (payant, derrière `DEMO_ALLOW_PAID=1`) avec
réconciliation des doublons ; l'inventaire est réputé périmé après 30 jours (H-4, éditable). L'inventaire BKK
réel (9 hôtels, relevé du 15/09) est commité — il ne contient aucune donnée passager.

### Escales

`data/stations/{BKK,CDG,NOU}.json` : zone de recherche, rayon, transfert (NOU : navette 75 min),
facteur de plafond (`price_cap_factor`, CDG 1.0 — H-5). L'UI affiche la fiche de l'escale choisie ;
le plafond effectif par cabine = plafond politique × facteur.

### Bornes d'extension (Étage C, H-2)

Éditables dans le formulaire, visibles en permanence dans le bandeau : `max_sessions_per_run` 18,
`max_cost_usd_per_run` 10 $, `max_waves` 4, sonde ≤ `probe_no_rooms_max` 30 chambres, `batch_size` auto.
L'arrêt (borne atteinte ou annulation de l'extension seule) laisse le plan en l'état avec escalade chiffrée.

### Limites connues

- Prix publics Booking uniquement (INV-3), « borne basse » : « Only X left » plafonne ce qu'un agent voit — la sonde
  (`no_rooms`) repousse ce plafond sans le supprimer ; aucune réservation n'est faite (INV-1).
- Équipements / paiement « déclarés par la plateforme » : `non_precise` = à confirmer (conformité PARTIELLE).
- Anti-bot : repli filtres UI puis proxy géré ; un CAPTCHA arrête la session (`blocked`), jamais de contournement (INV-2).
- Simulation disponible pour BKK seulement ; CDG/NOU exigent un run réel ou le dry-run.
- Un seul run à la fois (INV-10) ; indemnités repas/transport « non renseigné » tant que la politique ne les fixe pas (H-7).
- La sonde de capacité réelle (H-3) reste à confirmer sur un vrai cas de plafond en run réel ; si elle se révèle
  non concluante : `probe_same_hotel_first = false` (extension par candidats suivants seulement).

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
