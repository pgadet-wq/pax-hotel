# Phase 3 — Agents Holo : découverte, relevés, sonde, extension (sans exécution payante)

Couvre : CDC §6.2 à §6.6, §5.6, §5.8, EX-DIS-*, EX-REL-*, EX-EXT-*, EX-PRO-1, §12.1 (`--dry-run`, `--offline`). Aucune session payante : tout est câblé et testé avec un client simulé.

## Objectif

Implémenter le pipeline complet contre un client `hai-agents` réel mais non exécuté (dry-run) et contre un client factice (tests), y compris l'extension au plafond d'affichage.

## À lire

- `docs/cdc/ETAT.md` (signatures SDK relevées en phase 0)
- CDC §5.6, §5.8, §6.2 à §6.6, §7 (EX-ALL-1, EX-ALL-5), §12.1
- `tools/rebooking.mjs` pour les prompts v1 (reprendre par copie)

## Tâches

- [ ] `lib/hai.mjs` : `readApiKey()`, `createClient()` (point d'entrée européen si l'option existe, sinon signaler H-6), `ensureAgentV2()` (« hotel-scout-{code}-v2 », v1 intact), schémas `discoverySchema`, `releveSchema` (avec `payment`, `cap_reached`, `observed_at`), `probeSchema`, `inventaireHotelSchema`.
- [ ] `lib/events.mjs` : forme d'événement plate + traduction `SessionEvent` → événement (types CDC §5.8).
- [ ] `lib/discovery.mjs` : `runDiscovery` (1 session, 2 passes, cartes seulement, retry × 1, repli `fallback_hotels`). Condition d'exécution EX-DIS-1.
- [ ] `lib/releve.mjs` : `runReleve`, `runReleves` (concurrence 3, décalage 25 s, retry × 1 avec rattachement par id, substitution par le code, `warning` si `found = false`). Ordre EX-REL-3. Lecture paiement et `cap_reached` (EX-REL-4).
- [ ] `lib/capacite.mjs` : `detectCap`, `planExtension` (pur, respecte les bornes), `runProbe` (EX-EXT-1, désactivable par `probe_same_hotel_first`).
- [ ] Boucle d'extension (CDC §6.4) dans un orchestrateur `lib/pipeline.mjs` : `runPipeline({client, policy, station, scenario, dossiers, emit, signal, collectFn})` — `collectFn` injectable pour la simulation (phase 4) et les tests.
- [ ] Inventaire par agents : câbler `--refresh` et `--max` dans `tools/inventaire.mjs` (EX-INV-5, EX-INV-7).
- [ ] Prompts : squelettes FR pour découverte, relevé enrichi, inventaire hôtel, sonde de capacité. Garde-fous INV-1 / INV-2 dans chaque prompt.
- [ ] `tools/rebooking-v2.mjs` : `--dry-run`, `--offline <fixtures>`, `--station`. Les options `--probe-*` et le run complet existent mais refusent de s'exécuter sans la variable d'environnement `DEMO_ALLOW_PAID=1` (garde INV-8).
- [ ] Tests : client factice émettant des `SessionEvent` scriptés ; scénario où le relevé n°1 atteint le plafond → `planExtension` planifie une sonde puis un lot de 3 ; scénario bornes atteintes → escalade chiffrée ; scénario `probe_same_hotel_first = false` ; EX-PRO-1 (aucune valeur passager dans les prompts) ; substitution `found = false`.

## Critères d'acceptation

- `node tools/rebooking-v2.mjs --dry-run --station BKK` affiche : besoins par tier, inventaire utilisé, décision découverte (exécutée / sautée), URL des 5 premiers relevés, plan d'extension théorique. Aucun appel réseau.
- `node tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json` produit plan, rapport, messages, coût ; 0 €.
- `npm test` vert.

## Interdits

- Toute session payante. Toute exécution avec `DEMO_ALLOW_PAID=1`.
- Modifier `tools/rebooking.mjs`.

## Clôture

1. `ETAT.md` : fichiers, hypothèses H-3 / H-6, phase courante → 4.
2. `git commit -m "feat(phase-3): pipeline agents (découverte, relevés, sonde, extension) en dry-run/offline"`.
3. Push. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-3-agents-holo.md`. Exécute la phase 3 uniquement. Aucune session payante. Termine par `npm test`, `ETAT.md` et le commit indiqué.
