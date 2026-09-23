# Recette de bout en bout — démo v2 (phase 6)

Vérification CDC §12.3, exécutée le 15/09/2026 (poste Windows 11, Node v22.23.2, dépôt `pax-hotel`).
Les mesures réelles (durée, coût, sessions) sont relevées sur le compte H de démonstration, point d'entrée européen `https://agp.eu.hcompany.ai`.

## 1. Tests hors ligne (§12.3 points 1-2)

> **PROCÈS-VERBAL DU 15/09/2026 — MESURES PÉRIMÉES.** Les chiffres des §1 et §2 ci-dessous sont conservés tels
> qu'ils ont été relevés ce jour-là : c'est un procès-verbal, il ne se réécrit pas. Ils ne valent PLUS comme
> référence depuis la correction de la sonde (20/09) et le chantier C1-C7 (21/09).
>
> **Références en vigueur, mesurées le 23/09/2026** : `npm test` **332 cas / 13 suites, 0 échec** ·
> `rebooking-v2 --offline` **90 dossiers logés / 67 en escalade**, 8 fichiers écrits (la découverte est
> sautée hors ligne) · `--dry-run` **111 chambres indicatives pour 173 demandées, 15 candidats**
> (couverture INSUFFISANTE, dite comme telle) · **simulation complète 122 logés / 35 escalades**,
> 26 569 € la nuit, borne haute 32 900 €, **9 livrables**.
>
> Le « 85 chambres pour 173, 12 candidats » du 21/09 n'est plus reproductible depuis `ed0c345`
> (vivier de repli à appeler) : la couverture reste insuffisante, mais le chiffre a changé.
> Le « 278 cas » du 21/09 est devenu 332 après les lots API des 22 et 23/09.


| Vérification | Résultat |
|---|---|
| `npm test` | **159 cas, 0 échec** (24 fichiers, ~2,6 s) — inclut les invariants statiques INV-7/INV-9 et les tests du câblage réel phase 5 |
| `rebooking-v2 --offline data/simulate/releves-demo.json` | conforme : 324 pax → **88 dossiers logés, 69 en escalade**, 0 session, 0 € ; plan avec colonnes `conformite` et `mode_reglement`, messages FR/EN (`lang`), coût (`per_night`, `projection_total`, `upper_bound_at_caps`, `allowances` « non renseigné » H-7) |

## 2. Recette UI en mode simulation (§12.3 point 3)

> **PROCÈS-VERBAL DU 15/09/2026 — MESURES PÉRIMÉES.** Les chiffres des §1 et §2 ci-dessous sont conservés tels
> qu'ils ont été relevés ce jour-là : c'est un procès-verbal, il ne se réécrit pas. Ils ne valent PLUS comme
> référence depuis la correction de la sonde (20/09) et le chantier C1-C7 (21/09).
>
> **Références en vigueur, mesurées le 23/09/2026** : `npm test` **332 cas / 13 suites, 0 échec** ·
> `rebooking-v2 --offline` **90 dossiers logés / 67 en escalade**, 8 fichiers écrits (la découverte est
> sautée hors ligne) · `--dry-run` **111 chambres indicatives pour 173 demandées, 15 candidats**
> (couverture INSUFFISANTE, dite comme telle) · **simulation complète 122 logés / 35 escalades**,
> 26 569 € la nuit, borne haute 32 900 €, **9 livrables**.
>
> Le « 85 chambres pour 173, 12 candidats » du 21/09 n'est plus reproductible depuis `ed0c345`
> (vivier de repli à appeler) : la couverture reste insuffisante, mais le chiffre a changé.
> Le « 278 cas » du 21/09 est devenu 332 après les lots API des 22 et 23/09.


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

Le déroulé de démonstration ([docs/deroule-demo.md](deroule-demo.md)) a été joué une fois en simulation sans accroc au cours de cette recette — dans sa version à 8 étapes ; il en compte 9 depuis l'ajout de l'écran de validation humaine (C6).

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

## 4. Run complet réel BKK distant (§12.3 point 5) — JOUÉ le 16/09 (phase 7, run `mu3lnxm4`)

Joué depuis le navigateur du poste opérateur sur `https://51.158.96.47` (instance Scaleway `fr-par`,
voir §5), après accord explicite dans la conversation et `DEMO_ALLOW_PAID=1` posé dans
`/etc/pax-hotel.env` le temps du run (retiré ensuite).

**Premier essai (~04:17 UTC) : échec propre.** Chaque `startSession` refusée par la plateforme H en
403 « explicit deny in an identity-based policy » — cause : clé API **tronquée à la saisie** dans
`nano` sur l'instance (48 caractères au lieu de 51, vérifié par empreintes SHA-256). Le moteur a
dégradé exactement comme spécifié : retries, substitutions en cascade, arrêt d'extension « épuisé »,
escalades chiffrées (Y 131 / J 26 / W 16), 0 session démarrée, 0 $. Clé recopiée à l'identique
(fichier env reconstruit depuis le poste, empreintes concordantes), service redémarré, relance.

**Run `mu3lnxm4` (16/09) :**

| Mesure | Valeur |
|---|---|
| Date / heure (UTC) | 16/09/2026 — sessions H de 04:27:47 à 04:51:48 |
| Durée totale | **≈ 25 min** (< 30 min, objectif §13 tenu) — sans relance |
| Coût agents | extension mesurée **1,86 $** · total ≈ 2,5 $ (socle + extension ; bandeau exact à reporter) |
| Tokens | **≈ 5,63 M** (delta quota H : 19,68 M → 25,31 M sur la fenêtre) |
| Sessions | **17** : 5 relevés socle + extension **12/18** (5 sondes + 7 relevés) ; découverte **sautée** (inventaire du 15/09 frais) |
| Vagues d'extension | **2** — bornes non atteintes (12/18 sessions, 1,86/10 $), arrêt « plus de sonde possible ni de candidat à relever » |
| Concurrence observée | **5 sessions simultanées** au socle (départs 04:27:47 + 4 × 04:27:57), puis file continue — la limite org affichée (3) n'est pas apparue stricte (H-9) |
| Dossiers | **118 logés (156 chambres) / 39 escalades** Y « DESK (capacité) » |
| Coût hébergement relevé | **12 305,48 €/nuit** (J 1 030 + W 1 187,48 + Y 10 088) ; borne haute aux plafonds 32 900 € ; repas/transport « non renseigné » (H-7) |
| Téléchargements | **6/6 OK** (plan, rapport, messages, coût, candidats, relevés) — après confiance de la CA locale sur le poste (§5) |
| Réglages §13 appliqués | aucun |

Faits notables du run réel :

- **3 fiches d'inventaire mortes sur 12** (Divalux 404, Le Méridien 404, Novotel redirigé vers le
  Hyatt par Booking) → substitutions automatiques jouées en conditions réelles ; c'est la cause
  principale des 39 escalades (≈ un quart du socle disparu), avec le plafond Y (80 €) serré face au
  stock du jour — 24 chambres Y prises au Hyatt en dérogation « HORS BARÈME +88 € ».
- **H-3 observée en réel** : plafonds d'affichage Booking bien présents (Hyatt 9/9 affichées,
  King 7 `cap_reached`) ; 5 sondes exécutées par l'extension.
- 1 session `completed`, 16 fermées `interrupted` **après réponse** par le pump (comportement voulu,
  phase 5) ; aucune 429, aucune file d'attente visible.
- Levier de résorption des 39 : relancer avec « Forcer la découverte » (candidats au-delà de
  l'inventaire) et/ou rafraîchir l'Étage 0 (répare les URLs mortes) — et, en séance, montrer
  l'édition du plafond/dérogation Y.

## 5. Déploiement Scaleway et vérifications distantes (phase 7, 15-16/09)

Instance `fr-par-1` PRO2-S (Ubuntu 24.04), IP `51.158.96.47`, installée par `deploy/install.sh`
(Node 22, utilisateur `paxhotel`, service systemd durci, Caddy). Détails : `deploy/scaleway.md`.

| Vérification (fiche phase 7) | Résultat |
|---|---|
| HTTPS + auth basique | OK — `401` sans identifiants, UI complète avec `demo` + mot de passe ; certificat `tls internal` (IP sans domaine), CA locale de Caddy installée sur le poste (cadenas propre) |
| SSE à travers Caddy | OK — `flush_interval -1`, frise et cartes agents en direct pendant les runs simulé et réel |
| `systemctl restart pax-hotel` | OK — service revenu `active` seul (`Restart=always`), bandeau INV-8 correct |
| Secrets | OK — aucun secret dans le dépôt ; `/etc/pax-hotel.env` en `600 root:root` ; clé jamais dans un script |
| Ports | 22 et 443 seuls ouverts ; 4310 lié à `127.0.0.1` uniquement |
| Run simulé distant | OK — run `mu2jvzt7` : 1 min 27 s, 157 logés / 0 escalade, 0,00 $, extension vague 1 (2/18 sessions), fermeture/réouverture d'onglet → snapshot complet |
| Run réel distant | OK — run `mu3lnxm4`, voir §4 |

Incidents d'installation, tous résolus (détail : conversation phase 7) : image Scaleway avec Docker
préinstallé occupant 80/443 (conteneur coupé, `docker.service`/`docker.socket` désactivés,
`auto_https disable_redirects` dans le Caddyfile) ; téléchargements bloqués par Edge sur certificat
auto-signé (« Problème de réseau ») → résolu par confiance de la CA locale Caddy sur le poste —
pour une séance depuis une autre machine : installer cette CA ou passer sur un nom de domaine
(Let's Encrypt automatique) ; clé API tronquée à la saisie (§4).
