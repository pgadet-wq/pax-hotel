# Pack « Cahier des charges — Démo v2 » pour Claude Code

Ce pack contient tout ce dont Claude Code a besoin pour construire la démo v2 de l'outil d'hébergement d'urgence, en sept phases, une conversation par phase.

## Démo v2 — mode d'emploi

Outil de démonstration : à partir d'une liste passagers transmise par la compagnie, des agents web Holo
(H Company, SDK `hai-agents`) relèvent des hôtels sur Booking et le code construit un plan d'hébergement par
passager — conformité, mode de règlement, coût, fiches d'enregistrement nominatives, messages FR/EN.
Sans liste fournie, un A350-900 plein (324 passagers) est généré. Escale de démonstration : Bangkok (BKK),
mais l'escale est libre (voir « Escales »).
Déroulé pas à pas : [docs/deroule-demo.md](docs/deroule-demo.md) · règles d'affectation :
[docs/matrice-affectation.md](docs/matrice-affectation.md) · format de la liste passagers :
[docs/format-liste-passagers.md](docs/format-liste-passagers.md) · recette : [docs/recette-demo-v2.md](docs/recette-demo-v2.md).

### Ce que l'outil ne fait pas

Le périmètre est arrêté au CDC §2.2 ; ces limites sont des choix, pas des manques à combler en douce.

- **Aucune réservation** (INV-1). L'outil s'arrête au plan : quelles chambres, chez qui, à quel prix, pour qui.
  La réservation et sa confirmation restent un geste humain, hors de l'outil.
- **Aucune donnée passager confiée à un agent** (INV-5). Les agents ne voient que des hôtels, des dates et des
  filtres ; jamais un nom, un PNR, un numéro de passeport. Un agent ne remplit donc aucun formulaire hôtelier
  au nom d'un passager : les fiches d'enregistrement sont des documents remis au comptoir.
- **Aucun envoi de message.** Les messages FR/EN sont produits en CSV ; leur diffusion (SMS, e-mail, appli) est
  le travail du système de la compagnie.
- **Aucune émission ni aucun chargement de carte prépayée.** L'outil calcule le montant à charger et le nombre
  de cartes ; l'émetteur reste extérieur.
- **Prix publics uniquement** (INV-3) : aucun tarif négocié, aucun compte hôtelier.

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
npm test                                              # node --test, hors ligne, 0 €
node demo/server.mjs                                  # UI http://127.0.0.1:4310 — simulation et dry-run seulement
DEMO_ALLOW_PAID=1 node demo/server.mjs                # idem + run réel et Étage 0 par agents déverrouillés
node hai-admin-mcp/tools/rebooking-v2.mjs --help      # modes, options, périmètre
node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run   # la recherche réellement envoyée, aucun agent
node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json   # rejeu fixtures, 0 €
node hai-admin-mcp/tools/rebooking-v2.mjs --in liste-compagnie.csv --offline data/simulate/releves-demo.json
node hai-admin-mcp/tools/inventaire.mjs --station BKK --dry-run       # Étage 0 sans agent
node hai-admin-mcp/tools/inventaire.mjs --station BKK --preflight     # contrôle HTTP des fiches, 0 €
DEMO_ALLOW_PAID=1 node hai-admin-mcp/tools/inventaire.mjs --station BKK --refresh --max 10  # Étage 0 réel (payant)
```

Probes unitaires payants (phase 5) : `rebooking-v2 --probe-discovery | --probe-releve <n> | --probe-capacity <url> --rooms <n>`, toujours derrière `DEMO_ALLOW_PAID=1`.

#### Ce que `--dry-run` montre avant de payer

L'opérateur validait jusqu'ici une intention qu'il n'avait jamais vue. Le dry-run affiche désormais, sans
aucune session ni requête : les besoins par cabine et par file ; **l'URL de recherche Booking réellement
construite pour chaque passe**, ses filtres avec leur origine (étoiles, note, rayon, prestation, prix, fiche
escale) et son URL de repli sans filtre de prix ; les exigences qu'aucun filtre ne sait exprimer ; les
avertissements et l'hypothèse non validée du filtre de prix ; **la couverture honnête** (« n chambres
indicatives pour m demandées », en distinguant les chambres vues à un relevé des chambres supposées) ; le plan
d'extension théorique avec ses quatre bornes ; et **une durée estimée** adossée aux deux seuls runs réels
mesurés (`docs/recette-demo-v2.md` §3 et §4), présentée comme une estimation et non comme un engagement.

#### Pré-vol des fiches d'inventaire (`--preflight`)

`inventaire.mjs --preflight` teste en HTTP les URL Booking de l'inventaire avant d'y dépenser des sessions
(le run réel du 16/09 a perdu 3 fiches sur 12 : deux 404 et une redirection vers un autre hôtel, chacune
payée une session puis rattrapée par une substitution en cascade). Gratuit, sans agent, hors INV-8.

Seuls **404/410** et **une redirection vers un autre établissement** sont des verdicts fermes. Un **403**, un
**429**, un **202**, une réponse 3xx, un délai dépassé ou une page trop courte sont **indéterminés** : la fiche
reste candidate. Depuis certains réseaux (proxy d'entreprise, bac à sable) tout revient indéterminé — le
pré-vol se joue depuis la machine qui hébergera le run, sinon il ne sert à rien. Code de sortie 3 s'il y a au
moins une fiche morte ou redirigée, 0 sinon.

### Livrables d'un run — 8 fichiers dans `out/`

| Fichier | Contenu |
|---|---|
| `plan-<run>.csv` | une ligne par dossier : hôtel, type et nombre de chambres, prix, conformité, mode de règlement, escalade |
| `rooming-<run>.csv` | le même plan regroupé **par hôtel** : la liste d'appel du comptoir |
| `fiches-<run>.csv` | **une fiche d'enregistrement par personne** (45 colonnes, C3) : identité, chambre et son format, assistance, règlement |
| `fiches-<run>.html` | les mêmes fiches, document autonome **imprimable** — page de garde puis une fiche par page A4 |
| `messages-<run>.csv` | messages passagers FR et EN (à diffuser par le système de la compagnie) |
| `rapport-<run>.md` | scénario, politique appliquée, relevés horodatés, plan par cabine, escalades, avertissements |
| `cout-<run>.json` | coût par nuit et projection, ventilés par devise, et la commande de cartes prépayées |
| `releves-<run>.json` | relevés bruts — rejouables tels quels par `--offline` |

Sont **nominatifs** : le plan, la liste d'appel, les fiches, les messages, le **rapport** (il porte la liste
d'appel : noms, composition des chambres, mentions PMR) et l'état de run `run-<run>.state.json` (écrit dans
`out/`, jamais téléchargeable). `policy.retention` fixe la durée de vie des sorties purgées (72 h par défaut,
purge au démarrage du serveur, à la fin d'un run et sur demande de l'opérateur — toujours sur la politique du
dernier run lancé). Le **rapport est classé nominatif mais volontairement NON purgé** : l'arbitrage client
n'est pas rendu, et chaque purge le dit en toutes lettres. Coût, candidats et relevés ne sont pas nominatifs.
La purge est celle du SERVEUR : la CLI `rebooking-v2` n'en déclenche aucune.
Aucun de ces fichiers n'est une réservation.

### Mode simulation (filet de sécurité de la démo)

Case « Mode démonstration (sans agents) » de l'UI : run complet en ~90 s, 0 €, fixtures BKK + captures factices,
pensées FR, extension vague 1 (sonde + relevé). Référence mesurée le 21/09/2026 : **122 dossiers logés / 35
escalades** (motif « capacité »), 26 569 EUR par nuit, borne haute 32 900 EUR, **9 livrables**. Le « 157 / 0 »
publié auparavant datait d'avant la correction de la sonde (19-20/09) et reposait sur un sur-comptage.
Vitesse ×1/×5/×20.
Disponible pour BKK uniquement (CDG/NOU : dry-run et message explicite). Rechargement d'onglet → snapshot complet ;
double-run → 409 ; annulation propre (plan conservé en l'état).

### Onglet Inventaire (Étage 0)

Lit/écrit `data/inventaire/{CODE}.json` par escale : hôtels `source: agent | manuel | secours`, note, distance,
prix d'appel, paiement société (`oui / non / a_confirmer`), drapeaux contracté / préféré / exclu, ajout manuel.
« Rafraîchir par agents » relance découverte + relevés courts (payant, derrière `DEMO_ALLOW_PAID=1`) avec
réconciliation des doublons ; l'inventaire est réputé périmé après 30 jours (H-4, éditable). L'inventaire BKK
réel (9 hôtels, relevé du 15/09) est commité — il ne contient aucune donnée passager.

### Escales — libres

L'escale n'est plus une liste figée dans le code : **toute escale ayant une fiche dans `data/stations/`**
est acceptée, la liste étant relue sur le disque à chaque saisie. Le cas nominal d'un déroutement est
justement une escale imprévue : pour l'ouvrir, déposer `data/stations/<IATA>.json` sur le modèle de
`BKK.json` — aucun code à modifier. Un code sans fiche est refusé avec un message qui énumère les fiches
présentes et rappelle où déposer la nouvelle.

Fiches livrées : `BKK`, `CDG`, `NOU`. Chacune porte la zone de recherche, le rayon et sa référence
(aéroport ou centre de zone), le transfert (NOU : navette 75 min), le facteur de plafond
(`price_cap_factor`, CDG 1.0 — H-5) et des hôtels de repli. Plafond effectif par cabine = plafond
politique × facteur.

### Liste passagers — PAXLIST v1 et v2

`--in <liste.csv>` ingère la liste de la compagnie (CSV `;` ou `,`, UTF-8 ou Windows-1252, en-têtes tolérants).
Colonnes obligatoires : `pnr`, `nom`, `type_pax`, `cabine`. Le rapport d'ingestion est imprimé avant tout
travail, et une valeur illisible **refuse** la liste au lieu de l'interpréter.

La **v2 ajoute sept colonnes d'identité, toutes facultatives** : `date_naissance`, `nationalite`,
`passeport_num`, `passeport_exp`, `passeport_pays`, `sexe`, `adresse_domicile`. Elles ne servent qu'aux fiches
d'enregistrement. Trois d'entre elles — `date_naissance`, `nationalite`, `passeport_num` — sont ce qu'un
registre d'hôtel exige partout : sans elles la fiche part avec des blancs, l'agent d'escale ouvrant le
passeport au comptoir. Le rapport d'ingestion chiffre ce manque (« n/m fiches complètes ») **avant** le run,
au lieu de le découvrir au comptoir. Une liste v1 reste acceptée telle quelle : les colonnes absentes restent
vides, rien n'est deviné. Gabarits : `data/exemples/paxlist-modele-a-remplir.csv` et
`docs/format-liste-passagers.md`.

### Recherche : ce qui est filtré, ce qui ne l'est pas

La découverte ouvre une recherche de zone Booking et lui ajoute des filtres `nflt` dérivés de la politique et
de la fiche escale. `--dry-run` affiche l'URL exacte de chaque passe.

| Filtre | Source | Statut |
|---|---|---|
| étoiles, note, type « hôtel » | `policy.cabins.*.min_stars`, `discovery.min_review_score` | actif ; aucun palier de note au-dessus de 8/10 n'a été relevé — une exigence plus haute filtre au palier 8, un sur-ensemble, et l'écart est dit |
| rayon (`distance=`) | `discovery.radius_m` sinon la fiche escale | actif seulement si la fiche autorise le filtre de distance (EX-STA-2) ; un rayon saisi mais non envoyé est signalé |
| prestations exigées | `policy.cabins.*.required_amenities` | actif par `discovery.apply_amenity_filters` ; toute prestation sans code de filtre sûr (l'espace de travail, par exemple) est listée comme **non filtrable** et jugée au relevé |
| prix par nuit | plafonds effectifs | **opt-in, désactivé par défaut** (`discovery.apply_price_filter = false`) |

Le filtre de prix est opt-in à dessein : la syntaxe `nflt=price=EUR-<min>-<max>-1` est une **hypothèse externe
non validée**. Une syntaxe fausse ne rend pas une erreur, elle rend zéro résultat — indiscernable d'une zone
sans offre, et sur un run réel payant elle viderait le vivier sans que rien ne le signale. Chaque passe porte
donc aussi son URL **sans** filtre de prix, comme parade. À basculer à vrai seulement après qu'une sonde aura
montré que le filtre répond. Les codes de filtres ont été relevés le 2026-09-11 et ne sont pas revérifiés
automatiquement : la date est affichée avec le plan de recherche.

### Règlement : compagnie ou carte prépayée

`payment.default_mode` vaut `compagnie` ou **`carte_prepayee`** : la carte prépayée n'est plus seulement un
repli quand l'hôtel refuse le paiement société, elle peut être le **mode nominal** de la compagnie. Le plan dit
pour chaque ligne le mode retenu et *pourquoi* (mode nominal, prépaiement en ligne contracté, paiement
compagnie, repli carte, aucun moyen).

`cout-<run>.json` porte la commande à passer à l'émetteur : nombre de cartes (`prepaid_card.per` = une par
dossier ou une par personne), montant par carte (nuit + repas + transport selon `load_includes`, plus
`marge_eur`, arrondi au multiple supérieur `arrondi_eur`), montant total à charger, et ce qui reste
indéterminé. Un poste non renseigné par la politique laisse le montant **partiel et nommé** — jamais un zéro
qui passerait pour un prix. Un montant au-dessus de `plafond_eur` escalade en « carte insuffisante ».
L'outil n'émet ni ne charge aucune carte.

### Bornes d'extension (Étage C, H-2) — dont le budget d'horloge

Éditables dans le formulaire, visibles en permanence dans le bandeau :

| Borne | Défaut | Effet |
|---|---|---|
| `max_sessions_per_run` | 18 | sessions d'extension d'un run |
| `max_cost_usd_per_run` | 10 $ | coût agents d'un run |
| `max_waves` | 4 | vagues d'extension |
| **`max_minutes_per_run`** | **45 min** | **budget d'horloge du run entier (C5)** — quatrième borne, au même rang que les trois autres |
| `probe_no_rooms_max` | 30 | chambres testées par une sonde de capacité |
| `hotel_cap_without_probe` | 20 | **seuil de VIGILANCE**, pas un plafond : au-delà, le volume à confirmer engagé chez un même hôtel est signalé au validateur et l'hôtel désigné prioritaire à sonder — **aucune chambre n'est retranchée du plan** |
| `room_qty_sane_max` | 60 | au-delà, une quantité affichée est jugée aberrante, ramenée et signalée |

Le budget d'horloge répond à la demande « réserver en moins d'une heure » : l'échéance du run est calculée une
fois, propagée aux relevés, et un relevé qui ne peut plus démarrer à temps est compté `skipped_budget` — jamais
confondu avec un échec d'agent. L'arrêt (borne atteinte ou annulation de l'extension seule) laisse le plan en
l'état avec escalade chiffrée. `--dry-run` estime la durée du run face à ce budget.

### Limites connues

- Prix publics Booking uniquement (INV-3), « borne basse » : « Only X left » plafonne ce qu'un agent voit — la sonde
  (`no_rooms`) repousse ce plafond sans le supprimer ; aucune réservation n'est faite (INV-1).
- Équipements / paiement « déclarés par la plateforme » : `non_precise` = à confirmer (conformité PARTIELLE).
- Anti-bot : repli filtres UI puis proxy géré ; un CAPTCHA arrête la session (`blocked`), jamais de contournement (INV-2).
- Simulation disponible pour BKK seulement ; CDG/NOU exigent un run réel ou le dry-run.
- Un seul run à la fois (INV-10) ; indemnités repas/transport « non renseigné » tant que la politique ne les fixe pas (H-7).
- Le plan peut mélanger des devises : dans ce cas aucun total consolidé n'est calculé (`cost.bloquant`), et le
  détail par devise remplace un chiffre unique. Rien n'est converti, rien n'est estimé.
- Une chambre retenue chez un hôtel jamais sondé repose sur un affichage plafonné : la ligne du plan le dit
  (`stock_mesure = false`) et le validateur le voit avant de signer.
- La durée affichée par `--dry-run` est une **estimation** tirée de deux runs réels sur une seule escale (BKK).
  Elle ne compte pas le temps humain de validation.
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
