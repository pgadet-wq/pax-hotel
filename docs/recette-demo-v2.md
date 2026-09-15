# Recette de bout en bout — démo v2 (phase 6)

Vérification CDC §12.3, exécutée le 15/09/2026 (poste Windows 11, Node v22.23.2, dépôt `pax-hotel`).
Les mesures réelles (durée, coût, sessions) sont relevées sur le compte H de démonstration, point d'entrée européen `https://agp.eu.hcompany.ai`.

## 1. Tests hors ligne (§12.3 points 1-2)

| Vérification | Résultat |
|---|---|
| `npm test` | **159 cas, 0 échec** (24 fichiers, ~2,6 s) — inclut les invariants statiques INV-7/INV-9 et les tests du câblage réel phase 5 |
| `rebooking-v2 --offline data/simulate/releves-demo.json` | conforme : 324 pax → **88 dossiers logés, 69 en escalade**, 0 session, 0 € ; plan avec colonnes `conformite` et `mode_reglement`, messages FR/EN (`lang`), coût (`per_night`, `projection_total`, `upper_bound_at_caps`, `allowances` « non renseigné » H-7) |

## 2. Recette UI en mode simulation (§12.3 point 3)

Serveur `node demo/server.mjs` **sans** `DEMO_ALLOW_PAID` (routes payantes verrouillées), navigateur sur `http://127.0.0.1:4310`.

| Point de la liste | Constat |
|---|---|
| Formulaire | Escale BKK par défaut (fiche affichée : rayon 5 km, taxi max 45 min, facteur ×1) ; politique par cabine J/W/Y (étoiles, plafond, prestations), chambrage, règlement, bornes d'extension, presets (`politique-standard` chargeable, sauvegarde) ; panneau repliable |
| Génération A350 | « Générer la liste » → **324 passagers · 157 dossiers — J 34 / W 24 / Y 266 · 234 ADT, 81 CHD, 9 INF · 4 PMR (seed 42)** |
| Run simulé complet | **87 s** (~90 s attendu) : frise §5.8 complète avec « découverte sautée (inventaire frais et suffisant) », 5 agents (relevés) + 1 sonde simulée Hyatt, extension vague 1 = 1 sonde + 1 relevé, bandeau EX-EXT-3 « couvert : aucun manque », bornes 2/18 sessions · 0/10 $ · vague 2/4 ; **157 dossiers logés · 0 escalade** ; 27 390 tokens · 33 pas · 0,00 $ |
| Coût | par nuit : J 4 221 € + W 1 552 € + Y 23 073 € = **28 846 €** ; projection 1 nuit ; **borne haute aux plafonds 32 900 €** ; indemnités « non renseigné » (H-7) |
| Messages | aperçu FR/EN (filtres), filtre par tier, 3 boutons « Copier » |
| Téléchargements | 6 fichiers servis en 200 : `plan-*.csv`, `rapport-*.md`, `messages-*.csv`, `cout-*.json`, `candidats-*.json`, `releves-*.json` |
| Fermeture / réouverture | rechargement d'onglet en cours de run (à 59 s) → snapshot complet re-rendu (5 cartes agents, 157 lignes de plan, chrono continu) — EX-UI-2 |
| Double-run | `POST /api/run` pendant un run → **409** « un run est déjà en cours (INV-10) » (bouton UI remplacé par « Annuler le run ») |
| Annulation propre | annulation à 21 s → frise arrêtée sur « annulé », plan conservé en l'état (105 logés · 52 escalade), bouton « Lancer la prise en charge » de nouveau actif |
| Étage 0 verrouillé | `POST /api/inventaire/BKK/run` sans `DEMO_ALLOW_PAID` → **501** avec le message INV-8 (ajout manuel et drapeaux restent disponibles) |

Le déroulé de démonstration en 8 étapes ([docs/deroule-demo.md](deroule-demo.md)) a été joué une fois en simulation sans accroc au cours de cette recette.

## 3. Probes réels archivés (§12.3 point 4) — phase 5

Probes lancés depuis la conversation phase 5 (accord explicite donné dans cette conversation-là) ; artefacts sous `out/` (local, non commité) :

- `out/candidats-mu2gsy9c.json` — découverte d'inventaire réelle BKK : 10 candidats, devise EUR, schéma valide, passe premium OK (2 hôtels 4★ ajoutés). Une première session (`mu2goptp`, 20:21) avait échoué (`failed`, réponse nulle) : le retry a suffi.
- `out/inventaire-mu2gsy9c.json` — bilan de l'Étage 0 réel `tools/inventaire.mjs --station BKK --refresh --max 10` (mesures ci-dessous).
- `out/captures-mu2gsy9c/` — captures d'écran réelles des sessions (découverte + relevés), téléchargées avec bearer côté serveur.

### Mesures Étage 0 réel (§13, relevées le 15/09 20:23–20:35)

| Mesure | Valeur |
|---|---|
| Durée totale | **693 s (11 min 33 s)** |
| Sessions | **11** (1 découverte + 10 relevés hôtel courts) |
| Coût total | **0,99 $** (découverte 0,24 $ · 22 pas ; relevés 0,75 $ · 78 pas) |
| Files d'attente / 429 | **0** |
| Concurrence | configurée 3 (stagger 25 s), **observée 3/3** |
| Relevés exploitables | 7/10 `found=true` ; 3 `found=false` en 1 pas (~0,01 $ chacun) ; **10/10 schéma valide** |
| Résultat inventaire | `data/inventaire/BKK.json` : **9 hôtels** `source: agent` (3 existants réconciliés + 6 nouveaux, 1 doublon Hyatt évité par `reconcileIds`), tous avec `payment` renseigné/`non_precise` et `capacity_hint` observé — critère phase 5 « ≥ 8 » atteint |
| Observation H-3 (indice) | relevé réel Hyatt : `rooms_displayed_max: 9, cap_reached: true` — le plafond d'affichage Booking existe bien sur les pages réelles |

## 4. Run complet réel BKK depuis l'UI (§12.3 point 5) — NON JOUÉ (décision du 15/09)

Le run complet réel n'a **pas** été lancé en phase 6 : décision explicite de l'utilisateur à la clôture
(« clôturer sans run réel »). Le critère « mesures réelles du run complet dans la recette » reste donc **ouvert** ;
il sera couvert au plus tard par la répétition générale de la phase 7 (fiche phase 7 : un run simulé + un run
réel distant), suivant le même protocole :

1. accord explicite dans la conversation, puis `DEMO_ALLOW_PAID=1 node demo/server.mjs` (variable pour cette commande seule) ;
2. run depuis l'UI sur BKK, chronométré (< 30 min attendu), coût lu en direct sur le bandeau ;
3. téléchargement de plan / rapport / messages / coût ; mesures archivées dans le tableau ci-dessous ;
4. si > 30 min : boutons §13 (`max_hotels_stage_b` 5→4, `maxSteps` B 45→40, `n_socle` 8→6, concurrence/stagger) et une relance maximum, après accord.

Attendu (base mesures du 15/09) : découverte probablement sautée (inventaire BKK frais, 9 hôtels), relevés
Étage B ~0,75-1,50 $, extension bornée 18 sessions / 10 $ / 4 vagues — coût total ~2-5 $.

| Mesure | Valeur |
|---|---|
| Date / heure | — (non joué en phase 6) |
| Durée totale (bandeau « durée ») | — |
| Coût agents (bandeau, live) | — |
| Sessions (découverte + relevés + extension) | — |
| Vagues d'extension / sondes | — |
| Dossiers logés / escalades | — |
| Téléchargements (plan, rapport, messages, coût) | — |
| Réglages §13 appliqués (si > 30 min) | — |
