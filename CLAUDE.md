# CLAUDE.md — Démo v2 « Hébergement d'urgence à agents Holo »

## Ce qu'est ce projet

Outil de démonstration pour une compagnie aérienne : à partir d'une liste passagers (A350-900 plein, 324 passagers),
des agents web Holo (H Company, SDK `hai-agents`) relèvent des hôtels sur Booking et le code construit un plan
d'hébergement par passager, avec conformité, mode de règlement, coût et messages FR/EN. Escale de démonstration : Bangkok (BKK).

Dépôt : `https://github.com/pgadet-wq/pax-hotel.git`. Spécification complète : `docs/cdc/CAHIER_DES_CHARGES.md`. Journal d'état : `docs/cdc/ETAT.md`. Phases 0 à 7 : `docs/cdc/phases/`.

## Règle de travail n° 1

Au début de chaque conversation : lire `docs/cdc/ETAT.md`, puis la fiche de phase demandée. Travailler uniquement sur cette phase.
À la fin : mettre à jour `docs/cdc/ETAT.md`, lancer `npm test`, committer avec le message indiqué dans la fiche, puis s'arrêter.

## Invariants (ne jamais contourner, voir CDC §2.3)

- INV-1 Aucune réservation. INV-2 Aucun contournement de CAPTCHA. INV-3 Prix publics uniquement.
- INV-4 Clé API H côté serveur uniquement (`HAI_API_KEY` en variable d'environnement, jamais commitée). Point d'entrée européen : `HAI_API_BASE_URL=https://agp.eu.hcompany.ai/api/v2` (nom de l'option du SDK TS à relever en phase 0).
- INV-5 Aucune donnée passager dans un prompt d'agent ni dans un événement d'agent.
- INV-6 `tools/rebooking.mjs` (v1) reste intact.
- INV-7 `demo/` n'importe que des builtins `node:` et `../hai-admin-mcp/lib/`. `hai-agents` et `zod` s'importent seulement sous `hai-admin-mcp/`.
- INV-8 Aucune session d'agent payante hors phases 5 et 6, et jamais sans demande explicite dans la conversation.
- INV-9 Jamais `innerHTML` avec du texte d'agent.
- INV-10 Un seul run à la fois (409).

## Conventions

- Node ≥ 22, ESM, fichiers `.mjs`, `node:test` pour les tests, aucune dépendance nouvelle sans accord. `node_modules` vit sous `hai-admin-mcp/`.
- Priorité à la rapidité et à la puissance des agents (CDC §16) : concurrence au maximum du plan H, modèle le plus capable disponible, bornes larges mais visibles.
- Chemins via `fileURLToPath`, jamais `process.cwd()`. CSV Excel en UTF-8 avec BOM.
- Toute entrée externe passe par un schéma `zod`. Erreur explicite, jamais de défaut silencieux.
- Fonctions pures dans `lib/allocate.mjs`, `lib/cout.mjs`, `lib/messages.mjs`, `lib/capacite.mjs` (partie planification).
- Textes d'interface et de messages en français ; messages passagers en FR et EN.
- Une hypothèse non confirmée du CDC (`[À CONFIRMER]`) se signale dans `ETAT.md`, elle ne se tranche pas en silence.
- Pas de « pendant que j'y suis » : aucune modification hors du périmètre de la phase.

## Commandes

```
npm test                                            # depuis la racine : node --test "hai-admin-mcp/test/**/*.test.mjs"
node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run  # aucun agent
node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json
node hai-admin-mcp/tools/inventaire.mjs --station BKK --dry-run
node demo/server.mjs                                 # http://127.0.0.1:4310
```

## Compaction

Lors d'une compaction, conserver : la liste des fichiers modifiés, les commandes de test, les hypothèses `[À CONFIRMER]` rencontrées,
et l'état d'avancement des cases de la fiche de phase.
