# Phase 5 — Câblage réel, inventaire BKK réel, sondes (Bangkok uniquement)

Couvre : CDC §6 (exécution réelle), §6.1 (EX-INV-10 : inventaire initial produit par l'outil), §12.1 probes, §13, §16, H-3, H-9. Sessions payantes autorisées, sur demande explicite dans la conversation.

## Objectif

Valider le pipeline contre la plateforme réelle, constituer l'inventaire réel de Bangkok (aucune liste d'hôtels n'existe), régler la concurrence et le modèle au maximum du plan, trancher H-3, capturer des fixtures réelles.

## À lire

- `docs/cdc/ETAT.md` (valeurs du compte H relevées en phase 0)
- CDC §6, §12.1, §13, §14, §16

## Règle de dépense

Chaque commande payante est annoncée avant exécution avec son coût attendu. Elle n'est lancée qu'après un « oui » explicite de l'utilisateur dans la conversation. Aucun plafond de crédit imposé ; le coût réel est consigné dans `ETAT.md` après chaque commande. Toujours exporter `DEMO_ALLOW_PAID=1` pour la commande seule, jamais dans un fichier.

## Tâches (dans l'ordre)

- [ ] Câbler `demo/session-pump.mjs` au client réel ; proxy captures réel (bearer ou `getSessionResource`) ; annulation réelle (`handle.cancel()`).
- [ ] Appliquer les valeurs du compte H : `agents.concurrency`, `agents.stagger_ms`, `agents.model_stage_ab`, `agents.model_probe` (CDC §16). Vérifier que le point d'entrée européen est effectif (journal du client au démarrage).
- [ ] `--probe-discovery --station BKK` (≈ 0,21 $) : valider `nflt` depuis le runner, devise EUR, flux pensées / captures. Archiver `out/candidats-*.json`.
- [ ] `--probe-releve 1` (≈ 0,30 $) : navigation directe, chambres + équipements + paiement en ≤ 45 steps. Archiver.
- [ ] `--probe-capacity <url> --rooms 12` (≈ 0,15 $) : trancher H-3. Si non concluant : `probe_same_hotel_first = false` dans `DEFAULT_POLICY` et note dans `ETAT.md`.
- [ ] **Inventaire réel de Bangkok** : `node hai-admin-mcp/tools/inventaire.mjs --station BKK --refresh --max 10` (coût attendu : 1 découverte + 10 relevés courts, à mesurer). Écrire `data/inventaire/BKK.json` via merge. Commiter l'inventaire (il ne contient aucune donnée passager).
- [ ] Mesurer : durée totale, coût, concurrence réellement obtenue, files d'attente ou 429. Ajuster `agents.concurrency` et `agents.stagger_ms`. Consigner dans `ETAT.md` et dans CDC §13.
- [ ] Reformater les sorties réelles en fixtures de démo (`data/simulate/`), remplacer les PNG factices par des captures réelles si utiles.

## Critères d'acceptation

- Chaque probe a produit un fichier `out/*-{runId}.json` valide contre son schéma.
- H-3 tranchée et documentée.
- `data/inventaire/BKK.json` contient ≥ 8 hôtels `source: agent` avec `payment` renseigné ou `non_precise`, et `capacity_hint` observé.
- Concurrence et modèle réglés, mesures consignées.
- `npm test` vert (fixtures réelles intégrées).

## Interdits

- Run complet (réservé à la phase 6). Probes sur CDG ou NOU sans demande explicite.
- Contournement de CAPTCHA (arrêt et `warning`).

## Clôture

1. `ETAT.md` : mesures, H-3 / H-9, phase courante → 6.
2. `git commit -m "feat(phase-5): câblage réel, inventaire BKK réel, probes, fixtures réelles"` et push.
3. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-5-cablage-reel-probes.md`. Exécute la phase 5. Annonce chaque commande payante avec son coût attendu et attends mon accord avant de la lancer. Règle la concurrence et le modèle au maximum de mon plan. Termine par `npm test`, `ETAT.md`, le commit et le push indiqués.
