# Matrice d'affectation passagers → hôtels — démo v2

Règles appliquées par le moteur v2 (déterministe : les agents relèvent, le code juge).
Défauts dans [lib/policy.mjs](../hai-admin-mcp/lib/policy.mjs) (`DEFAULT_POLICY`), tout est éditable dans le
formulaire de l'UI ou par preset (`data/presets/`). La matrice v1 du POC est conservée en annexe.

**Ce que la matrice ne décide pas.** Elle produit un plan, rien de plus : aucune chambre n'est réservée
(INV-1), aucun agent ne saisit quoi que ce soit au nom d'un passager et aucune donnée passager ne part vers un
agent (INV-5), aucun message n'est envoyé, aucune carte prépayée n'est émise.
La **validation humaine de la répartition est DANS l'outil** (C6) : écran de validation, journal append-only
`out/validation-<runId>.json` portant la décision, son horodatage, l'empreinte SHA-256 du plan réellement
affiché, les lignes écartées avec leur motif, et la PORTÉE de l'identité du validateur (authentifiée par un
proxy déclaré de confiance / déclarée seulement / absente — le serveur lui-même n'authentifie personne).
Le journal ne trace ni l'appel aux hôtels ni aucune confirmation : **la confirmation auprès des hôtels et la
réservation restent hors de l'outil** (INV-1, CDC §2.2).

## Tiers = cabines

Le tier d'un dossier est sa **cabine** (EX-POL-2) ; le statut Flying Blue ne joue que sur l'ordre de traitement
à l'intérieur du tier. Plafond effectif = plafond du tier × `price_cap_factor` de la fiche escale (EX-POL-1).

| Tier | Étoiles | Prestations requises | Souhaitées (`nice_to_have`) | Plafond €/nuit (défaut) |
|---|---|---|---|---|
| **J** | 4★ à 5★ | wifi gratuit, room service 24h/24, espace de travail | navette aéroport, restauration tardive | 250 € |
| **W** | 3★ à 4★ | wifi gratuit, petit-déjeuner disponible | navette aéroport | 130 € |
| **Y** | ≥ 3★ | wifi gratuit | navette aéroport, petit-déjeuner | 80 € |

`max_stars` dépassé n'exclut jamais : l'hôtel est « surclassé » (HORS BAREME si le prix passe le plafond).
`allow_above_cap_if_no_alternative` : au-dessus du plafond accepté en dernier recours, signalé.

## Escale : libre

L'escale n'est pas une liste figée. Toute escale ayant une fiche `data/stations/<IATA>.json` est acceptée,
la liste étant relue sur le disque à chaque saisie — un déroutement se produit justement là où on ne l'attend
pas. Un code sans fiche est refusé avec la liste des fiches présentes et le chemin où déposer la nouvelle.
Fiches livrées : BKK, CDG, NOU.

Chaque fiche porte la zone de recherche, le rayon et sa référence (aéroport ou centre de zone), le
transfert, le facteur de plafond (`price_cap_factor`), des hôtels de repli, et — depuis le 21/09/2026 —
les **couronnes de distance** avec leur temps de trajet **déclaré** (voir « Politique de prise en
charge » ci-dessous).

## Ce que la recherche filtre, et ce qu'elle ne peut pas filtrer

Avant de juger, il faut trouver. Le vivier d'hôtels a **trois sources**, à choisir avant le run :
l'**inventaire de l'escale** constitué à l'avance (`data/inventaire/<CODE>.json`), la **découverte par
agents** sur les pages publiques, et — depuis le 22/09/2026 — l'**API hôtelière** (`lib/liteapi.mjs`,
case « Vivier par API hôtelière » dans l'UI), qui interroge un distributeur sans agent ni lecture
d'écran. Les entrées venues d'une API portent `source: "api"` et ne se déclarent jamais « agent ».

Le reste de cette section décrit la **découverte par agents** : elle ouvre une recherche de zone
Booking et y ajoute des filtres `nflt` dérivés de la politique et de la fiche escale.
`rebooking-v2 --dry-run` et `inventaire --dry-run` affichent **l'URL exacte de chaque passe** avec ses
filtres et leur origine. Par une API, les mêmes exigences sont appliquées **au jugement du relevé** et
non à la requête : la conformité, elle, se calcule exactement de la même façon quelle que soit la
source.

| Filtre | Origine | Statut |
|---|---|---|
| étoiles | `cabins.*.min_stars` | actif |
| note voyageurs | `discovery.min_review_score` | actif ; paliers relevés jusqu'à 8/10 seulement — une exigence plus haute filtre au palier 8 (un sur-ensemble, qui n'exclut aucun hôtel conforme) et l'écart est dit |
| rayon | `discovery.radius_m`, sinon la fiche escale | actif **seulement si** la fiche autorise le filtre de distance (EX-STA-2) ; un rayon saisi mais non envoyé est signalé |
| prestations exigées | `cabins.*.required_amenities` | actif par `discovery.apply_amenity_filters` ; une prestation sans code de filtre sûr (l'espace de travail) est déclarée **non filtrable** et jugée au relevé |
| prix par nuit | plafonds effectifs | **opt-in, désactivé par défaut** (`discovery.apply_price_filter = false`) |
| accessibilité (passe PMR) | `overlays.pmr.require_accessible` | chaîne de filtres construite (socle + accessibilité), mais **la découverte n'envoie aujourd'hui que les passes socle et premium** : l'accessibilité est exigée au jugement du relevé, pas à la recherche. `--dry-run` signale l'écart. |

Le filtre de prix est opt-in parce que la syntaxe `nflt=price=EUR-<min>-<max>-1` est une **hypothèse externe
non validée** : fausse, elle ne rend pas une erreur mais zéro résultat — indiscernable d'une zone sans offre.
Chaque passe porte donc son URL **sans** filtre de prix, comme parade. Les codes de filtres ont été relevés le
2026-09-11 ; la date accompagne le plan de recherche, elle n'est pas revérifiée automatiquement.

## Surcouches (overlays, cumulables)

| Overlay | Déclencheur | Effet |
|---|---|---|
| **PMR** | passager PMR dans le dossier | chambre accessible **requise**, poids distance ×2 au score, surclassement de tier autorisé ; note « transfert adapté à confirmer par l'hôtel ». **Le chambrage PMR n'est PAS déduit** : sans `chambres_demandees`, un PMR est apparié comme un adulte ordinaire (un WCHC et son accompagnante partagent une chambre double). L'ingestion compte et signale les dossiers concernés (`pmr_chambrage_devine`) |
| **Famille** | enfant (CHD) ou bébé (INF) dans le dossier | chambre familiale (≤ 2 ADT + 2 CHD) ou **2 chambres communicantes dans le même hôtel** ; INF : berceau, ne compte pas dans la capacité |

Un dossier (PNR) est indivisible : tous ses occupants vont dans le même hôtel.

L'**ordre de traitement** n'est plus figé (il l'était jusqu'au 21/09/2026 : `pmr → famille → J → W → Y`).
Il est désormais gouverné par la politique de prise en charge, ci-dessous.

## Politique de prise en charge — qui est servi d'abord, qui a droit aux hôtels proches

`policy.global.prise_en_charge` porte **13 critères cochables** (`CRITERE_KEYS`, `lib/policy.mjs`).
Chacun est activable, porte un **rang** et un **droit à la proximité**. L'UI les présente en cases à
cocher ; avant le 21/09 le champ était un texte libre **sans effet**, dont toute valeur inattendue
était ignorée en silence.

| Rang | Critère (`cle`) | Proximité par défaut |
|---|---|---|
| 1 | `correspondance_serree` — horaire du vol suivant | **stricte** |
| 2 | `medical` — cas médical ou civière | **stricte** |
| 3 | `pmr` — mobilité réduite | préférée |
| 4 | `mineur_seul` — mineur non accompagné | préférée |
| 5 | `bebe` — famille avec bébé ou enfant en bas âge | préférée |
| 6 | `famille` | aucune |
| 7 | `equipage` — repos réglementaire | préférée |
| 8 · 9 · 10 | `J` · `W` · `Y` — cabine | aucune |
| 11 | `groupe` | aucune (inactif par défaut) |
| 12 | `sans_droit_entree` | aucune |
| 99 | `flying_blue` — **départage seulement** | aucune |

Un critère marqué `departage: true` (Flying Blue) **ne crée jamais de file** : il ne joue qu'à
l'intérieur d'une file, pour départager deux dossiers de même rang. La valeur de départage est
graduée (PLATINUM > GOLD > SILVER).

Une politique enregistrée **avant le 21/09/2026**, qui ne porte pas `prise_en_charge`, retombe sur
« proximité : aucune » — c'est-à-dire l'ancien comportement, où seule la distance au score jouait.

### Rang et proximité ne font pas le même travail

| Réglage | Ce qu'il décide | Ce qu'il ne décide pas |
|---|---|---|
| **rang** | l'**ordre de service** : qui passe avant qui dans la file d'attribution | rien sur la distance |
| **proximité** | le **droit aux couronnes proches** | rien sur l'ordre |

Concrètement, pour un dossier :

- **`stricte`** — on ne sort **pas** de la couronne la plus proche admissible tant qu'elle a du stock.
  Si elle en a encore mais qu'aucune de ses chambres ne convient, le dossier **escalade** plutôt que
  d'être éloigné.
- **`preferee`** — la couronne la plus proche est essayée seule, puis les suivantes **une par une**,
  et seulement si la politique autorise l'élargissement.
- **`aucune`** — toutes les couronnes admissibles sont examinées en une seule passe ; la distance ne
  joue plus que dans le score de départage.

**Un rang seul ne protège personne.** Si les PMR sont servis d'abord et épuisent le vivier proche, le
passager qui repart à 05h40 finit à 40 km. C'est le budget de trajet, ci-dessous, qui l'en empêche.

### Le budget de trajet — une contrainte DURE

`dossier.trajet_max_min` est calculé sur l'horaire du vol suivant (`heure_correspondance`) :

```
utile  = fenêtre jusqu'au vol suivant − avance_avant_vol − marge − repos_minimal
trajet_max_min = ⌊ utile / 2 ⌋        (aller ET retour)
```

Réglages : `policy.global.correspondance` — avance 120 min, repos minimal 240 min, marge 30 min,
seuil « serrée » 480 min.

- **Aucun rang ne l'outrepasse.** Les hôtels dont la couronne dépasse le budget sont retirés **avant**
  toute passe d'attribution, quel que soit le rang du dossier.
- `trajet_max_min ≤ 0` → escalade **« correspondance trop serrée »** (repos côté piste).
- **Pas d'horaire = pas de contrainte, et jamais de budget inventé.** Le dossier n'est pas non plus
  réputé « serré ». Une fenêtre aberrante est bornée à 72 h là où le budget se calcule.
- Chaque dossier porte une **`explication` en toutes lettres**, pour qu'un agent d'escale puisse
  contester le calcul.
- Quand le budget est en cause dans un échec, le motif d'escalade le dit (`aucun_hotel` /
  `hors_budget`) : écrire « capacité » enverrait des agents relever des hôtels de plus alors que des
  chambres existent — hors d'atteinte.

> **À savoir avant de s'appuyer dessus.** Sans les colonnes `vol_correspondance` et
> `heure_correspondance` dans la liste passagers, **aucun dossier n'est sous contrainte** et le
> dispositif ne protège personne. Le dry-run le dit explicitement, dossier par dossier.

### Les couronnes de distance — déclarées, jamais mesurées

`station.search.couronnes[]` (fiche escale) découpe la zone en couronnes, chacune avec un rayon et un
**temps de trajet DÉCLARÉ par l'exploitation**. L'outil n'a **aucun service de routage** et **ne
convertit jamais une distance en durée** : ces temps sont étiquetés « déclarés, non mesurés » partout
où ils s'affichent.

| Escale | Couronnes (rayon / temps déclaré) |
|---|---|
| BKK | 5 km / 15 min · 15 km / 35 min · 40 km / 60 min |
| CDG | 5 km / 15 min · 15 km / 35 min · 40 km / 60 min |
| NOU | 15 km / 45 min · 45 km / 60 min · 60 km / 75 min |

Rattachement d'un hôtel à une couronne, dans l'ordre : la couronne de la **passe de recherche** qui
l'a trouvé, sinon sa **distance mesurée**, sinon — **par prudence — la couronne la plus lointaine
déclarée**. Un hôtel sans distance connue n'est **pas** réputé proche : le supposer reviendrait à
loger un passager en correspondance serrée à 40 km sur une supposition. La conséquence est que le
premier chiffre de couverture affiché est **pessimiste** ; la réponse est de relever les distances,
pas de toucher au code.

Le plan porte la traçabilité complète : `couronne`, `couronne_source` (passe / distance / inconnue /
hors couronnes), `couronne_trajet_min_declare` et `trajet_max_min`. La restitution par couronne est
reprise au rapport, aux fiches (heure limite de retour à l'aéroport) et à l'écran de validation.

## Conformité d'un hôtel pour un tier (EX-ALL-2)

| Niveau | Signification |
|---|---|
| **CONFORME** | étoiles ≥ min, toutes prestations requises confirmées, ≥ 1 type de chambre sous le plafond effectif |
| **PARTIELLE** | idem mais au moins un élément « à confirmer » : prestation `non_precise` (room service sans mention 24 h, workspace ou navette non précisés), étoiles non affichées |
| **HORS BAREME** | conforme sauf le prix : aucune chambre sous le plafond effectif (montant du dépassement affiché) |
| **NON CONFORME** | indisponible, étoiles < min, prestation requise réellement absente, ou aucune chambre relevée |

Score intra-niveau (départage) : note voyageurs 0,35 · adéquation étoiles 0,15 · distance 0,25 · marge sous
plafond 0,25. Allocation par file : CONFORME d'abord, puis PARTIELLE ; HORS BAREME en dernier recours signalé ;
sinon **escalade DESK** chiffrée (motif : capacité, conformité ou règlement).

## Ce que chaque ligne du plan dit de sa propre fiabilité

Une ligne « OK » ne vaut pas garantie : le validateur humain doit voir sur quoi elle repose avant de signer.
Ces champs sont portés par chaque ligne d'`allocate()` et repris dans les sorties.

| Champ | Valeurs | Ce que le validateur en fait |
|---|---|---|
| `stock_mesure` | `true` / `false` / `""` (non logé) | `false` = au moins une chambre repose sur un **affichage plafonné**, une sonde encore plafonnée ou une quantité supposée. À confirmer avec l'hôtel avant de s'engager. |
| `couchages_insuffisants` / `couchages_manquants` | booléen / nombre de personnes | la chambre allouée ne déclare pas assez de couchages : le statut reste OK, la réserve est à lever avec l'hôtel. |
| `format_cabine` | `""` / `conforme` / `defaut` | C3 : `defaut` = aucun format de chambre correspondant à la cabine n'était disponible sous le plafond, une chambre standard a été retenue. |
| `conformite` | CONFORME / PARTIELLE / HORS BAREME | voir le tableau ci-dessus. |
| `mode_reglement` | voir « Mode de règlement » | avec le motif du choix. |
| `sous_reserve`, `escalade`, `hors_plan` | texte | ce qui interdit de lire la ligne comme acquise. |

Le récapitulatif de l'allocation porte les mêmes réserves au niveau du run : `summary.complet` est **faux** dès
qu'une réserve existe (dossier sans chambre, **dossier HORS PLAN HÔTEL**, couchages insuffisants, stock non
mesuré, avertissement) et tant qu'une personne de la liste reste sans chambre, avec
la répartition par hôtel et la part du plus gros établissement — ce qu'il faut voir avant de signer.
`extension.hotel_cap_without_probe` (20) est un **seuil de VIGILANCE, pas un plafond** : au-delà de 20 chambres
« à confirmer » chez un même hôtel, le volume est signalé au validateur et l'hôtel désigné prioritaire à
sonder — **aucune chambre n'est retranchée du plan**. Sur le rejeu de référence, 99 chambres tiennent ainsi sur
un affichage plafonné chez un seul hôtel. La contrepartie réelle est ailleurs, et elle est visible ligne à
ligne : `stock_mesure`, `chambres_a_confirmer` et `summary.complet = false`.
Une quantité affichée au-delà de `room_qty_sane_max` (60) est, elle, jugée aberrante, ramenée et signalée.

## Fiches d'enregistrement par passager (C3)

Le format de chambre affecté commande le document remis au passager. Chaque run produit
`fiches-<run>.csv` (45 colonnes) et `fiches-<run>.html` (imprimable, une fiche par page A4) : **une fiche par
personne**, y compris les dossiers non logés et les escalades — c'est justement au comptoir qu'ils sont
traités. Le format de chambre y est écrit en toutes lettres, surcouches d'abord : « PMR + FAMILLE + business
(J) », « premium éco (W) », etc.

La fiche porte l'identité (si la compagnie l'a transmise — colonnes PAXLIST v2), l'hôtel et sa nuit, le type et
le format de chambre, les occupants et l'adulte référent, le berceau, l'assistance PMR et le transfert, le mode
de règlement et le montant à charger sur la carte prépayée, la conformité, le motif d'escalade et une ligne de
signature. Deux marqueurs, jamais un blanc muet : **« [à remplir] »** (à compléter au comptoir, par l'hôtel ou
par le passager) et **« [non fourni] »** (la compagnie ne l'a pas transmis). Un champ sans objet disparaît.
Le nombre de fiches incomplètes est chiffré dès l'ingestion de la liste, avant le run.

## Mode de règlement (EX-ALL-6, règle H-1 validée le 14/09) — carte prépayée comprise

`payment.default_mode` vaut `compagnie` ou **`carte_prepayee`**. La carte prépayée n'est donc pas seulement un
repli quand l'hôtel refuse le paiement société : elle peut être le **mode nominal** de la compagnie, et le plan
distingue les deux cas.

`company_payment_possible` (EX-INV-4) : **oui** si hôtel contracté ou prépaiement en ligne ; **non** si
« paiement sur place uniquement » et non contracté ; sinon **a_confirmer**.

| Situation | Mode de la ligne | Motif porté par la ligne |
|---|---|---|
| `default_mode = carte_prepayee`, carte activée | `carte_prepayee` | `mode_nominal` |
| hôtel à prépaiement en ligne ou contracté | `compagnie` | `prepaiement_en_ligne_contracte` |
| `company_payment_possible = oui` | `compagnie` | `paiement_compagnie` |
| `company_payment_possible = a_confirmer` | `compagnie_a_confirmer` | — |
| `non`, carte activée | `carte_prepayee` | `repli_carte` |
| `non`, carte désactivée | **escalade DESK** « règlement » | `aucun_moyen` |

Une politique incohérente (`default_mode = carte_prepayee` alors que `prepaid_card.enabled = false`) produit un
avertissement nommé, pas un mode inventé en silence.

### Montant des cartes (C7)

`prepaid_card.per` fixe la granularité : **une carte par dossier** ou **une par personne à loger**. Le montant
d'une carte = (nuit + repas + transport, selon `load_includes`) ÷ nombre de cartes, plus `marge_eur`, arrondi au
multiple supérieur `arrondi_eur`. Au-dessus de `plafond_eur`, la ligne escalade en « carte insuffisante ».

Rien n'est estimé : un poste que la politique ne chiffre pas (repas et transport, tant que H-7 n'est pas
tranchée) laisse le montant **partiel et nommé**, jamais un zéro qui passerait pour un prix. `cout-<run>.json`
porte la commande à passer à l'émetteur — nombre de cartes, montant total à charger (non nul seulement si
toutes les cartes complètes partagent une devise), cartes incomplètes, postes non renseignés. **L'outil n'émet
ni ne charge aucune carte.**

Devises : le coût est ventilé par devise. Si le plan en mélange plusieurs, aucun total consolidé n'est calculé
(`cost.bloquant`) et les totaux valent `null` — ils ne doivent pas être affichés comme un chiffre.

## Extension (Étage C, bornes H-2 fixées le 14/09)

Quand un type de chambre est plafonné par l'affichage (« Only X left », borne basse) et qu'il reste des manques :

1. **Sonde** sur le même hôtel d'abord (`probe_same_hotel_first`, H-3) : URL modifiée `no_rooms`/`group_adults`,
   ≤ `probe_no_rooms_max` (30) chambres testées — lecture seule, jamais de réservation ;
2. sinon **relevé** du candidat suivant de la découverte ;
3. par **vagues** (taille `auto` = concurrence du plan), jusqu'à couverture des manques ou borne atteinte :
   `max_sessions_per_run` **50** · `max_cost_usd_per_run` **15 $** · `max_waves` 4 ·
   **`max_minutes_per_run` 60 min** (défauts de `DEFAULT_POLICY` au 23/09/2026 ; ce paragraphe annonçait
   18 · 10 $ · 45 min, l'intention d'origine — **la valeur voulue reste à trancher**, voir l'encadré du
   README § « Bornes d'extension ») — visibles en permanence dans le bandeau, éditables, annulation de
   l'extension seule possible (plan conservé, escalade chiffrée).

Le **budget d'horloge** (C5, « réserver en moins d'une heure ») est une borne de plein exercice, au même rang
que les vagues, les sessions et le coût. L'échéance du run est calculée une fois et propagée aux relevés : un
relevé qui ne peut plus démarrer à temps est compté `skipped_budget` — jamais confondu avec un échec d'agent
dans les compteurs, le rapport et l'escalade. `rebooking-v2 --dry-run` estime la durée du run face à ce budget,
à partir des deux runs réels mesurés (`docs/recette-demo-v2.md`), et le dit comme une estimation.

Quand l'inventaire est épuisé alors qu'il reste des manques, `rediscover_on_exhaustion` (vrai par défaut) fait
relancer une découverte élargie au lieu de s'arrêter.

Chaque réallocation réémet les lignes du plan (`plan_row` par PNR) : une chambre provisoire (grisée) devient
définitive quand le relevé de sa vague confirme prix et type.

---

## Annexe — matrice v1 du POC (historique, 31/08)

Le POC v1 ([rebooking.mjs](../hai-admin-mcp/tools/rebooking.mjs), intact — INV-6) travaillait sur une liste
fixe d'hôtels avec profils figés ; ses règles de chambrage et ses priorités sont reprises telles quelles en v2.

| # | Profil | Hôtel cible | Repli | Type de chambre |
|---|---|---|---|---|
| 1 | PMR (+ PNR) | Novotel Bangkok Suvarnabhumi Airport | escalade humaine | accessible |
| 2 | Familles | Novotel Suvarnabhumi | Le Méridien Suvarnabhumi | familiale ; communicantes au-delà |
| 3 | J / FB Gold+ | Novotel Suvarnabhumi | Le Méridien Suvarnabhumi | supérieure / executive |
| 4 | W / FB Silver | Le Méridien Suvarnabhumi | Novotel standard | deluxe |
| 5 | Y solo/couple | Amaranth Suvarnabhumi, Divalux Resort & Spa | Eastin Thana City | standard double/twin |

Limites déjà connues au POC et toujours vraies en v2 : l'inventaire visible en ligne est une **borne basse**
(« Only X left ») ; pas de réservation ; un CAPTCHA se signale (`blocked`), ne se contourne pas.
