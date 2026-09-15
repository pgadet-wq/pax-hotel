# Matrice d'affectation passagers → hôtels — démo v2

Règles appliquées par le moteur v2 (déterministe : les agents relèvent, le code juge).
Défauts dans [lib/policy.mjs](../hai-admin-mcp/lib/policy.mjs) (`DEFAULT_POLICY`), tout est éditable dans le
formulaire de l'UI ou par preset (`data/presets/`). La matrice v1 du POC est conservée en annexe.

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

## Surcouches (overlays, cumulables)

| Overlay | Déclencheur | Effet |
|---|---|---|
| **PMR** | passager PMR dans le dossier | chambre accessible **requise**, poids distance ×2 au score, surclassement de tier autorisé ; 1 chambre par passager PMR + chambrage normal des accompagnants ; note « transfert adapté à confirmer par l'hôtel » |
| **Famille** | enfant (CHD) ou bébé (INF) dans le dossier | chambre familiale (≤ 2 ADT + 2 CHD) ou **2 chambres communicantes dans le même hôtel** ; INF : berceau, ne compte pas dans la capacité |

Ordre de traitement des files : **pmr → famille → J → W → Y** (priorités éditables).
Un dossier (PNR) est indivisible : tous ses occupants vont dans le même hôtel.

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

## Mode de règlement (EX-ALL-6, règle H-1 validée le 14/09)

`company_payment_possible` (EX-INV-4) : **oui** si hôtel contracté ou prépaiement en ligne ; **non** si
« paiement sur place uniquement » et non contracté ; sinon **a_confirmer**.

| `company_payment_possible` | Mode de la ligne du plan |
|---|---|
| oui | `compagnie` |
| a_confirmer | `compagnie_a_confirmer` |
| non, carte prépayée activée | `carte_prepayee` (chargée : nuit + repas + transport, configurable) |
| non, carte désactivée | **escalade DESK** motif « règlement » |

## Extension (Étage C, bornes H-2 fixées le 14/09)

Quand un type de chambre est plafonné par l'affichage (« Only X left », borne basse) et qu'il reste des manques :

1. **Sonde** sur le même hôtel d'abord (`probe_same_hotel_first`, H-3) : URL modifiée `no_rooms`/`group_adults`,
   ≤ `probe_no_rooms_max` (30) chambres testées — lecture seule, jamais de réservation ;
2. sinon **relevé** du candidat suivant de la découverte ;
3. par **vagues** (taille `auto` = concurrence du plan), jusqu'à couverture des manques ou borne atteinte :
   `max_sessions_per_run` 18 · `max_cost_usd_per_run` 10 $ · `max_waves` 4 — visibles en permanence dans le bandeau,
   éditables, annulation de l'extension seule possible (plan conservé, escalade chiffrée).

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
