# Matrice d'affectation passagers → hôtels — POC « vol bloqué à BKK »

> **Version v2 (11/09/2026)** : la matrice ci-dessous décrit le POC v1 (liste fixe
> d'hôtels). La démo v2 la remplace par une **politique par cabine** éditable dans
> l'interface : la cabine (J/W/Y) est le tier, PMR et famille sont des overlays
> cumulables, chaque hôtel découvert est jugé CONFORME / PARTIELLE / HORS BAREME /
> NON CONFORME contre le tier, et le plan porte une colonne conformité. Défauts dans
> [lib/policy.mjs](../hai-admin-mcp/lib/policy.mjs) (`DEFAULT_POLICY`) ; règles de
> chambrage et priorités conservées. Le v1 reste documenté ci-dessous.

**Statut : proposition à valider.** Ces règles sont celles que l'orchestrateur v1
([rebooking.mjs](../hai-admin-mcp/tools/rebooking.mjs)) applique. Chaque valeur se change
dans le bloc `CONFIG` en tête de script.

## Hypothèses par défaut du scénario

| Paramètre | Valeur | Justification |
|---|---|---|
| Vol | Nouméa → Paris, escale technique BKK (type A330-900) | scénario fourni ; « Flying Blue » ⇒ partenariat AF/KLM |
| Aéroport d'arrivée | **Suvarnabhumi (BKK)** | l'Amari Don Muang (DMK) sort du périmètre : 45 min de route |
| Passagers | ~278 (jeu de test généré) | A330-900 quasi plein |
| Durée | 1 nuit (check-in J, check-out J+1) | aléa d'exploitation typique ; paramétrable `--nights` |
| Date | demain par défaut | dispos réelles ; paramétrable `--checkin` |
| Devise de relevé | THB TTC | prix affichés Booking.com |

## Priorités de traitement

Les dossiers (PNR) sont traités dans cet ordre — un dossier est indivisible, ses
occupants vont dans le même hôtel :

1. **PMR** et leurs accompagnants de PNR ;
2. **Familles** avec enfants ou bébés ;
3. **Cabine J** et Flying Blue **Platinum / Gold** ;
4. **Cabine W** et Flying Blue **Silver** ;
5. **Y** — solos et couples.

## Matrice profil → hôtel

| # | Profil | Hôtel cible | Repli | Type de chambre | Pourquoi |
|---|---|---|---|---|---|
| 1 | PMR (+ PNR) | **Novotel Bangkok Suvarnabhumi Airport** | escalade humaine | accessible (plain-pied, barres) | liaison souterraine climatisée : zéro voirie, zéro transfert routier |
| 2 | Familles | **Novotel Suvarnabhumi** | Le Méridien Suvarnabhumi | familiale ≤ 2A+2C ; communicantes (2 ch.) au-delà | connecté à pied : pas de taxi sans siège enfant ; enfants gratuits ≤ 12-15 ans |
| 3 | J / FB Gold+ | **Novotel Suvarnabhumi** | Le Méridien Suvarnabhumi | supérieure / executive | qualité + proximité pour les prioritaires commerciaux |
| 4 | W / FB Silver | **Le Méridien Suvarnabhumi** | Novotel standard | deluxe | resort 15-20 min avec navette, bon niveau |
| 5 | Y solo/couple | **Amaranth Suvarnabhumi**, **Divalux Resort & Spa** | Eastin Thana City | standard double/twin | capacité + coût maîtrisé, navettes dédiées |

## Règles de chambrage

- 1 adulte seul → 1 chambre.
- 2 adultes même PNR → 1 chambre double/twin.
- Famille ≤ 2 adultes + 2 enfants → 1 chambre familiale ; au-delà → 2 chambres
  communicantes (comptées 2 chambres physiques).
- Bébé (INF, < 2 ans) : berceau, ne compte pas dans la capacité.
- PMR : chambre accessible, 1 chambre par passager PMR + chambrage normal des
  accompagnants, même étage demandé en note.

## Ce que les agents relèvent (et rien d'autre)

Une session Holo par hôtel cible, sur Booking.com, qui s'arrête **à la page de sélection
des chambres** : types disponibles, capacité, quantité maximale affichée, prix/nuit TTC,
annulation gratuite, petit-déjeuner. Interdits explicites dans les instructions : réserver,
créer un compte, saisir des données personnelles ou de paiement. Un CAPTCHA est signalé
(`outcome: blocked`), pas contourné.

## Sorties et manques

- `out/plan-hebergement.csv` : une ligne par chambre attribuée (occupants, hôtel, type,
  prix relevé).
- `out/rapport.md` : synthèse — demandé vs relevé vs affecté, coût total estimé, et la
  liste des **manques** : ce que l'inventaire visible en ligne n'absorbe pas part en
  « escalade desk » (les OTA basculent de toute façon les volumes de groupe vers un
  traitement humain).

## Limites assumées du POC

- L'inventaire visible sur Booking plafonne ce qu'un agent peut relever (« Only X left »
  n'est pas la capacité réelle de l'hôtel) : le plan est une **borne basse** fiable.
- Pas de réservation, pas de navettes (traitées par le choix d'hôtels connectés ou à
  navette incluse), pas de gestion équipage.
