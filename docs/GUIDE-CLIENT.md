# Guide de fonctionnement — pax-hotel

**Hébergement d'urgence des passagers à l'escale — outil d'aide à la décision**

| | |
|---|---|
| Destinataire | Aircalin — exploitation, escales, sûreté/RGPD, direction |
| Maître d'œuvre | OPS INSIGHT |
| Version du guide | 1.0 — 23 septembre 2026 |
| État de l'outil | démonstrateur en état de marche, éprouvé une fois en conditions réelles (Bangkok, 16/09/2026) |
| Documents liés | [cahier des charges](cdc/CAHIER_DES_CHARGES.md) · [règles d'affectation](matrice-affectation.md) · [format de la liste passagers](format-liste-passagers.md) · [recette](recette-demo-v2.md) · [audit du 23/09](AUDIT-2026-09-23.md) |

---

## 1. En une page

**Ce que c'est.** Une application web, tenue par **un seul opérateur**, qui transforme la liste
passagers d'un vol immobilisé en un **plan d'hébergement complet, nom par nom**, et en produit les
documents d'exécution : liste d'appel par hôtel, fiche d'enregistrement par personne, messages
passagers FR/EN, coût de la nuit, commande de cartes prépayées.

**Ce qu'elle produit, en chiffres mesurés.** Sur le run réel de Bangkok du 16/09/2026 :
**25 minutes**, 324 passagers traités, **118 dossiers logés**, 39 escalades chiffrées et motivées,
**12 305 € la nuit** lus en direct, pour **2,50 $ de coût machine**.

**Ce que ce n'est pas.** Ce n'est **pas un moteur de réservation**. L'outil s'arrête à la page de
sélection des chambres : il dit *quelles chambres, chez qui, à quel prix, pour qui, et payées
comment*. **Appeler l'hôtel, confirmer, réserver reste un geste humain**, volontairement hors de
l'outil. Cette limite n'est pas un manque à combler : c'est l'invariant n° 1 du projet.

**Le principe de conception, en une phrase.** *Aucun chiffre rassurant qui ne soit mérité.* Une
cellule vide n'est jamais un zéro ; une chambre jamais mesurée est dite « à confirmer » ; un plan qui
laisse une seule personne sans chambre ne se déclare pas complet. L'outil est construit pour qu'un
responsable puisse **signer en connaissance de cause**, pas pour produire un écran qui rassure.

---

## 2. Pourquoi cet outil a été construit

### 2.1 Le problème

Un A350-900 tri-classe immobilisé à l'escale, c'est **jusqu'à 324 personnes à coucher dans la nuit**,
dans une ville où la compagnie n'a pas forcément d'équipe étoffée, et souvent hors des heures
ouvrables. Chaque passager n'est pas une unité interchangeable :

- il appartient à un **dossier (PNR)** qu'on ne coupe pas en deux — une famille ne se répartit pas
  sur deux hôtels ;
- il a une **cabine** qui commande un niveau de prestation et un plafond de prix ;
- il peut être **PMR**, sur civière, mineur non accompagné, en transit sans droit d'entrée sur le
  territoire, accompagné d'un nourrisson, ou **reparti par un vol de correspondance à 05h40** ;
- il devra **présenter une identité au comptoir** de l'hôtel, et quelqu'un devra **payer**.

Chacune de ces caractéristiques change l'hôtel acceptable, la chambre acceptable, la distance
acceptable et le mode de règlement. Traitée à la main, la combinaison de ces contraintes sur 324
personnes est le vrai coût de l'événement — en temps, en erreurs, et en passagers laissés au
comptoir pendant qu'on cherche.

### 2.2 Ce qui a déclenché la construction

La compagnie a posé **sept conditions** (reprises au §7, avec l'état de chacune). Trois d'entre elles
fixent le cap : *trouver des chambres pour la **totalité** des passagers*, *en moins d'une heure*,
*avec une répartition validée par un humain avant toute exécution*. Les quatre autres décrivent ce
qu'il faut produire pour que l'escale puisse réellement exécuter : fiches par passager selon le
format de chambre, règlement par cartes prépayées, recherche pilotée par la saisie de l'opérateur,
et — condition la plus exigeante — **tenir le rôle d'une équipe d'escale qui ne serait pas là**.

> **À confirmer par la compagnie.** Ce guide décrit ce que l'outil fait ; il ne prétend pas décrire
> le processus manuel actuel d'Aircalin, qui n'a pas été mesuré dans le cadre de ce projet. Le §6
> (« ce que cela remplace ») est donc rédigé en termes de **produits de travail**, pas en termes
> d'heures économisées.

---

## 3. Ce que l'outil est — et les cinq choses qu'il ne fera jamais

Ces cinq limites sont des **invariants** : câblées dans le code, vérifiées par la suite de tests, et
elles ne se contournent pas par un réglage.

| Il ne fait pas | Pourquoi | Conséquence pratique |
|---|---|---|
| **Aucune réservation** | INV-1 — engager la compagnie auprès d'un hôtel est un acte commercial qui appartient à un humain | l'outil produit un **plan à exécuter**, pas une confirmation |
| **Aucune donnée passager ne part vers un agent** | INV-5 — les agents web ne voient que des URL d'hôtels, des dates, des nombres de chambres et la politique | aucun nom, aucun PNR, aucun passeport ne quitte le serveur vers un tiers |
| **Aucun message envoyé** | les messages FR/EN sont produits en CSV | leur diffusion (SMS, e-mail, appli) reste le travail du système de la compagnie |
| **Aucune carte prépayée émise ni chargée** | l'outil calcule le montant et le nombre de cartes | l'émission reste chez l'émetteur |
| **Prix publics uniquement** | INV-3 — aucun tarif négocié, aucun compte hôtelier | ce que voit l'outil est ce que verrait n'importe quel client |

Deux autres garde-fous méritent d'être connus de la direction : **aucun contournement de CAPTCHA**
(un CAPTCHA arrête la session et le signale), et **la clé d'accès aux agents ne quitte jamais le
serveur** — elle n'est ni dans le navigateur, ni dans le dépôt de code.

---

## 4. Le fonctionnement, bout en bout

La chaîne compte six maillons. Les quatre premiers sont automatiques, le cinquième est humain, le
sixième est l'exécution à l'escale.

```
  [1] Liste passagers  ->  [2] Politique  ->  [3] Vivier d'hôtels  ->  [4] Plan
                                                                        |
                                                    [5] Validation humaine (dans l'outil)
                                                                        |
                                                    [6] Exécution à l'escale (hors outil)
```

### 4.1 — Entrée : la liste passagers (format PAXLIST v3)

L'outil ingère un **CSV transmis par la compagnie**, au format documenté dans
[format-liste-passagers.md](format-liste-passagers.md) : **28 colonnes**, dont quatre seulement sont
obligatoires (`pnr`, `nom`, `type_pax`, `cabine`). Trois modèles prêts à remplir sont livrés sous
`data/exemples/`.

Le fichier est lu avec tolérance sur la forme (séparateur `;` ou `,`, UTF-8 ou Windows-1252, en-têtes
alternatifs reconnus) et **intransigeance sur le fond** : une valeur illisible **refuse la liste** au
lieu de l'interpréter. Un **rapport d'ingestion** est imprimé avant tout travail : combien de
dossiers, quelle ventilation par cabine, combien de PMR, combien d'escalades nominatives, combien de
fiches partiront avec une identité incomplète.

Ce que les colonnes facultatives changent réellement :

| Colonnes | Ce qu'elles apportent | Si elles manquent |
|---|---|---|
| `date_naissance`, `nationalite`, `passeport_num` | la fiche d'enregistrement part **complète** au comptoir | la fiche part avec des blancs, l'agent ouvre le passeport au comptoir — et le nombre est chiffré **avant** le run |
| `vol_correspondance`, `heure_correspondance` | l'outil calcule un **budget de trajet** par dossier et **interdit** de loger loin un passager qui repart tôt | **aucune correspondance n'est protégée** — l'outil le dit explicitement plutôt que d'inventer un horaire |
| `assistance` (codes SSR), `droit_entree` | PMR, civière, médical, mineur seul, refus d'entrée sur le territoire | traitement standard, escalades non détectées |

> **Point d'attention.** Sur la liste de démonstration, l'outil signale aujourd'hui : *« aucun budget
> de trajet n'a pu être calculé : la liste ne porte pas d'horaire de vol suivant exploitable »*.
> C'est exact et c'est voulu — **il ne fabrique pas un horaire pour faire joli**. Tant que la
> compagnie ne transmet pas ces deux colonnes, la contrainte de distance ne protège personne.

### 4.2 — La politique : ce que l'exploitation décide, et que l'outil applique

Tout ce qui relève d'une décision de compagnie est **éditable dans l'écran**, jamais codé en dur, et
peut être enregistré comme *preset* :

- **Par cabine (J / W / Y)** : étoiles minimum, prestations exigées (wifi, room service 24 h, espace
  de travail, petit-déjeuner…), **plafond de prix par nuit** (défauts : J 250 € · W 130 € · Y 80 €).
- **Chambrage** : combien d'adultes et d'enfants par chambre, chambre familiale ou deux chambres
  communicantes, berceau pour les nourrissons.
- **Politique de prise en charge** — le cœur des arbitrages sociaux : **13 critères cochables**
  (correspondance serrée, médical/civière, PMR, mineur seul, bébé, famille, équipage, cabine J/W/Y,
  groupe, sans droit d'entrée, statut Flying Blue). Chacun porte **un rang** (l'ordre de service) et
  **un droit à la proximité** (stricte / préférée / aucune).
- **Règlement** : paiement société ou **carte prépayée comme mode nominal**, montant à charger,
  marge, arrondi, plafond par carte.
- **Bornes du run** : nombre de sessions, coût maximum en dollars, nombre de vagues, et **budget
  d'horloge** — le run s'arrête à l'échéance plutôt que de déborder.

**Le mécanisme à comprendre — rang contre budget de trajet.** Le rang décide *qui est servi
d'abord*. Il ne protège personne à lui seul : si les PMR sont servis en premier et épuisent les
hôtels proches, le passager qui repart à 05h40 finit à 40 km. C'est pourquoi le **budget de trajet**
est une **contrainte dure qu'aucun rang n'outrepasse** :

```
budget = (fenêtre jusqu'au vol suivant − avance avant vol − marge − repos minimal) / 2
```

divisé par deux parce qu'il faut **aller et revenir**. Budget ≤ 0 → escalade « correspondance trop
serrée » (repos côté piste). Pas d'horaire → **aucune contrainte inventée**. Chaque dossier porte son
calcul **en toutes lettres**, pour qu'un agent d'escale puisse le contester.

**Les couronnes de distance** sont **déclarées par l'exploitation** dans la fiche escale, jamais
mesurées : BKK 5 / 15 / 40 km, avec des temps de trajet (15 / 35 / 60 min) qui sont des **durées
déclarées, pas des mesures de circulation**. L'outil n'a aucun service de routage et ne convertit
jamais une distance en durée. C'est écrit partout où ces temps s'affichent.

### 4.3 — Le vivier d'hôtels : trois sources, à choisir avant le run

C'est la partie du dispositif qui a le plus évolué, et celle qui détermine si le plan tiendra.

| Source | Ce que c'est | Coût | État |
|---|---|---|---|
| **Inventaire de l'escale** | un fichier par escale (`data/inventaire/BKK.json`), constitué à l'avance, hôtels notés, avec paiement société et drapeaux « contracté / préféré / exclu » | gratuit | en service — BKK porte 12 fiches |
| **Agents web Holo** | des agents lisent les pages publiques, découvrent des hôtels, relèvent chambres et prix, et **sondent** la capacité réelle | payant (~2,50 $ le run) | en service, éprouvé en réel le 16/09 |
| **API hôtelière (LiteAPI)** | interrogation directe d'un distributeur, prix publics, sans agent | quasi nul | **livré le 23/09, à confirmer sur clé de production** |

**Pourquoi la troisième source a été ajoutée — c'est le point le plus important de ce guide.**
La lecture d'écran se heurte à un plafond que rien, côté code, ne peut lever : **le sélecteur de
quantité d'une plateforme grand public s'arrête à 9 chambres**. Douze hôtels multipliés par ce
plafond, cela fait environ 110 chambres « indicatives » — pour **173 demandées**. Autrement dit :
*l'outil marchait, mais le vivier ne pouvait pas couvrir un A350 plein.*

La mesure du 22/09 sur Bangkok via l'API hôtelière : **185 hôtels et 11 059 offres en un appel de
7 secondes**, au lieu de 12 hôtels et 111 chambres. Rejouée de bout en bout sur la liste réelle de la
compagnie : **171 dossiers logés / 24 escalades — 288 personnes sur 324**, dont seulement **17
escalades pour manque de chambres**.

> **Réserve qui doit être dite.** Ces mesures viennent d'une **clé de bac à sable** : le protocole est
> prouvé, **les volumes sont des données de test**. La même mesure doit être refaite avec une clé de
> production avant d'annoncer quoi que ce soit au-delà. Trois runs consécutifs en bac à sable ont
> rendu 36 hôtels, puis 13, puis 8 : **toute répétition avant une démonstration se fait juste avant,
> pas la veille**.

### 4.4 — Les relevés : quatre étages

| Étage | Rôle | Quand |
|---|---|---|
| **0 — Inventaire** | constituer le vivier de l'escale à l'avance, hors urgence | en amont ; réputé périmé après 30 jours |
| **A — Découverte** | ouvrir une recherche de zone avec les filtres tirés de la politique, et rapporter des candidats | au run, si le vivier est insuffisant |
| **B — Relevés** | ouvrir la fiche de chaque hôtel : types de chambres, prix, quantités affichées, prestations, moyens de paiement | au run, en parallèle |
| **C — Extension** | quand un affichage est plafonné, **sonder** l'hôtel (« et si je demandais 30 chambres ? ») ou aller chercher des candidats supplémentaires | au run, par vagues, sous bornes |

Avant de dépenser quoi que ce soit, **deux contrôles gratuits** sont disponibles :

- le **dry-run** affiche la recherche qui *sera réellement envoyée* — URL complète, chaque filtre avec
  son origine, les exigences qu'aucun filtre ne sait exprimer, la couverture honnête (« *111 chambres
  indicatives pour 173 demandées* »), le plan d'extension et une **durée estimée** confrontée au
  budget d'horloge ;
- le **pré-vol** teste en HTTP les fiches d'inventaire avant d'y dépenser des sessions. Ce n'est pas
  un luxe : sur le run réel du 16/09, **3 fiches sur 12 étaient mortes** (deux pages supprimées, une
  redirigée vers un autre établissement) — chacune payée une session avant d'être rattrapée.

### 4.5 — L'allocation : les agents relèvent, le code juge

**C'est une séparation de responsabilité, pas un détail d'architecture.** Les agents ne décident
rien : ils rapportent des observations. **La décision est prise par du code déterministe, sans
intelligence artificielle** — même entrée, même sortie, explicable ligne à ligne, rejouable
gratuitement.

Chaque hôtel reçoit, pour chaque cabine, un niveau de conformité :

| Niveau | Signification |
|---|---|
| **CONFORME** | étoiles suffisantes, toutes prestations requises confirmées, au moins une chambre sous le plafond |
| **PARTIELLE** | idem, mais au moins un élément « à confirmer » (room service sans mention 24 h, étoiles non affichées…) |
| **HORS BARÈME** | conforme sauf le prix — le montant du dépassement est affiché |
| **NON CONFORME** | indisponible, étoiles insuffisantes, prestation réellement absente, ou aucune chambre relevée |

L'allocation se fait **en deux passes** : d'abord tout le monde dans le barème ; **ensuite
seulement**, la dérogation de prix, et uniquement pour ceux qui restent sans chambre. Faute de quoi,
relever le plafond ferait *baisser* le nombre de logés — ce qui s'est produit et a été corrigé.

Et par-dessus tout : **un dossier est indivisible**. Tous les occupants d'un PNR vont dans le même
hôtel. Une famille ne se coupe pas.

Quand il n'y a plus de solution, l'outil ne bricole pas : il **escalade**, avec un motif nommé
(capacité, conformité, règlement, accessibilité, correspondance trop serrée, droit d'entrée) et un
chiffre. Les escalades sont **un résultat**, pas un échec : ce sont les dossiers que le comptoir doit
traiter à la main, et il vaut mieux qu'ils soient comptés et nommés à l'avance.

### 4.6 — La validation humaine (dans l'outil)

Avant tout téléchargement, un écran de validation présente le plan tel qu'il sera exécuté :
répartition par hôtel, part du plus gros établissement, **répartition géographique par couronne**,
réserves nommées, lignes que le validateur écarte avec leur motif.

La décision est écrite dans un **journal non réinscriptible** qui porte l'horodatage, **l'empreinte
SHA-256 du plan réellement affiché**, les lignes écartées, et la **portée de l'identité du
validateur** — authentifiée par un proxy déclaré de confiance, simplement déclarée, ou absente. Le
serveur n'authentifie personne lui-même et **le dit**, plutôt que de faire croire à une traçabilité
qu'il n'a pas.

Le récapitulatif ne se déclare **complet** que si **personne** ne reste sans chambre, dossiers hors
plan hôtel compris.

### 4.7 — Les neuf livrables

| Fichier | Pour qui, pour quoi |
|---|---|
| `plan-<run>.csv` | **36 colonnes**, une ligne par dossier : hôtel, chambres, prix, conformité, règlement, escalade, et les réserves qui interdisent de la lire comme acquise |
| `rooming-<run>.csv` | le même plan **groupé par hôtel** : la liste d'appel du comptoir, avec totaux chambres/personnes, adresse et téléphone |
| `fiches-<run>.csv` | **une fiche d'enregistrement par personne** (45 colonnes) |
| `fiches-<run>.html` | les mêmes fiches, **imprimables** : page de garde puis une fiche par page A4 |
| `messages-<run>.csv` | messages passagers **FR et EN**, à diffuser par le système de la compagnie |
| `rapport-<run>.md` | le procès-verbal : scénario, politique appliquée, relevés horodatés, plan par cabine, escalades, avertissements |
| `cout-<run>.json` | coût par nuit, projection, ventilation par devise, **et la commande à passer à l'émetteur de cartes** |
| `candidats-<run>.json` | les hôtels découverts |
| `releves-<run>.json` | les relevés bruts — **rejouables gratuitement** |

**Le rejeu gratuit mérite une mention à part.** Une fois les relevés payés, on peut rejouer
l'allocation autant de fois qu'on veut, sans agent et sans coût : « *et si on montait le plafond Y ?* »,
« *et si on ouvrait la troisième couronne ?* ». En séance, c'est le levier qui transforme une
présentation en discussion d'exploitation. L'outil refuse de comparer deux listes différentes — il
l'a fait une fois, cela a été corrigé.

### 4.8 — Ce qui borne le run

Quatre bornes, visibles en permanence dans le bandeau, éditables avant le lancement : **nombre de
sessions**, **coût maximum en dollars**, **nombre de vagues d'extension**, et **budget d'horloge**.
L'échéance est calculée une fois et propagée : un relevé qui ne peut plus démarrer à temps est compté
« sauté faute de budget » — jamais confondu avec un échec. À l'arrêt, **le plan reste en l'état**,
avec ses escalades chiffrées.

Si le coût des agents n'est pas mesurable, l'extension **s'arrête** sur « coût non mesuré — budget non
contrôlable », au lieu de courir sans frein.

---

## 5. Comment lire une ligne du plan — la partie qui protège le signataire

Une ligne « OK » **ne vaut pas garantie**. Chaque ligne porte ce sur quoi elle repose :

| Champ | Ce qu'il dit | Ce que le validateur en fait |
|---|---|---|
| `stock_mesure = false` | au moins une chambre repose sur un **affichage plafonné** ou une quantité supposée | à confirmer avec l'hôtel avant de s'engager |
| `chambres_fermes` / `chambres_a_confirmer` | la ventilation entre stock **mesuré** et stock supposé | savoir combien d'appels seront des découvertes |
| `couchages_insuffisants` | la chambre ne déclare pas assez de couchages | réserve à lever avec l'hôtel |
| `format_cabine = defaut` | aucun format correspondant à la cabine n'était disponible sous le plafond | arbitrage commercial à assumer |
| `conformite` | CONFORME / PARTIELLE / HORS BARÈME | avec, pour HORS BARÈME, **le montant du dépassement** |
| `mode_reglement` | compagnie / carte prépayée / à confirmer | **avec le motif du choix** |
| `sous_reserve`, `escalade`, `hors_plan` | ce qui interdit de lire la ligne comme acquise | la liste de ce qui reste à faire |

Exemple concret de cette discipline : les messages passagers ne disent plus « *la réservation est en
cours de confirmation avec l'hôtel* ». Cette phrase décrivait un échange qui **n'a pas eu lieu**.
Elle partait vers 179 personnes. Elle a été retirée des gabarits FR et EN.

---

## 6. Ce que cela remplace, ce que cela renforce

> Lecture : la colonne « fait à la main » décrit le **produit de travail** attendu, pas une mesure du
> processus actuel d'Aircalin. À confronter au terrain par la compagnie.

### Ce que l'outil **remplace** (le travail disparaît, la décision reste)

| Produit de travail | Fait à la main | Fait par l'outil |
|---|---|---|
| Chercher des hôtels conformes autour de l'escale | recherches manuelles, hôtel par hôtel | recherche construite depuis la politique, **URL visible avant de payer** |
| Relever chambres, prix, prestations, paiement | onglets, notes, copier-coller | relevé structuré, **schéma validé**, horodaté, archivé, rejouable |
| Comparer et choisir l'hôtel par cabine | jugement au fil de l'eau | conformité en 4 niveaux + score de départage, **identique d'un opérateur à l'autre** |
| Construire les chambres (qui avec qui) | tableur | chambrage déterministe, **dossier indivisible**, berceaux, chambres communicantes |
| Produire la liste d'appel par hôtel | recopie manuelle | `rooming-<run>.csv`, totaux compris |
| Produire une fiche par passager | rarement fait | `fiches-<run>.html` **imprimable A4**, format de chambre en toutes lettres |
| Rédiger les messages FR/EN | copier-coller de modèles | gabarits déterministes, **variante choisie sur la situation réelle de la ligne** |
| Chiffrer la nuit | estimation | coût par cabine, par devise, borne haute, **et la commande de cartes** |
| Tracer la décision | e-mail, mémoire | journal non réinscriptible + **empreinte du plan signé** |

### Ce que l'outil **renforce** (le travail reste, il devient mieux armé)

| Renforcement | Ce que cela change |
|---|---|
| **La décision d'exploitation** | l'arbitrage reste humain, mais il se prend sur un plan chiffré, avec ses réserves nommées — et le rejeu gratuit permet d'essayer une autre politique en quelques secondes |
| **La tenue d'une escale sans équipe sur place** (C4) | un opérateur à distance produit ce qu'une équipe locale produirait ; il reste à **appeler et confirmer** |
| **L'équité de traitement** | 13 critères cochables et un ordre écrit remplacent un arbitrage implicite ; la politique devient un document, pas une habitude |
| **La protection des correspondances** | le budget de trajet est une contrainte dure — **à condition que la compagnie transmette les horaires** |
| **La conformité RGPD** | données passagers jamais exposées aux agents, purge des sorties nominatives paramétrable, journal de rétention |
| **La maîtrise du coût** | quatre bornes, coût lu en direct, arrêt propre plutôt que débordement |

### Ce que cela **ne remplace pas**

Appeler les hôtels. Négocier. Confirmer. Réserver. Payer. Accueillir au comptoir. Décider d'une
dérogation. **Signer.** Ce sont, littéralement, les actes que l'outil refuse de faire.

---

## 7. Les sept conditions de la compagnie — état au 23/09/2026

| | Condition | État | Ce qu'il faut savoir |
|---|---|---|---|
| **C1** | La recherche est pilotée par ce que saisit l'opérateur | **tenue** | le dry-run affiche l'URL réellement envoyée, filtre par filtre, avec son origine ; les exigences non filtrables sont listées et jugées au relevé |
| **C2** | Des chambres pour la **totalité** des passagers | **conditionnée au vivier** | le moteur sait loger tout le monde ; sur 12 hôtels il ne le peut pas (111 chambres pour 173). Avec l'API hôtelière : **288 personnes sur 324** — mesuré en bac à sable, à reconfirmer en production |
| **C3** | Une fiche de saisie par passager, selon le format de chambre | **tenue** | `fiches-<run>.csv` + `.html` imprimable ; les blancs sont marqués « [à remplir] » ou « [non fourni] », jamais muets |
| **C4** | Remplacer une équipe d'escale | **partiellement — par construction** | tout le travail d'étude et de production documentaire, oui ; **l'appel, la confirmation et la réservation, non** (INV-1) |
| **C5** | Réserver en moins d'une heure | **tenue sur la mesure disponible** | run réel : **25 min**. Le budget d'horloge est une borne de run. ⚠ le défaut actuel du code est **60 min**, et le dry-run avertit quand l'estimation haute le dépasse (voir l'audit, constat B1) |
| **C6** | Répartition validée par un humain | **tenue** | écran de validation, journal non réinscriptible, empreinte du plan, portée de l'identité du validateur dite explicitement |
| **C7** | Règlement par cartes prépayées | **tenue côté calcul** | mode nominal possible, montant par carte, nombre de cartes, total à charger, cartes incomplètes signalées. **L'émission reste extérieure** |

Trois arbitrages restent à rendre **par la compagnie** (ils ne peuvent pas l'être par le
prestataire) : **une chambre par passager PMR** (aujourd'hui un PMR est apparié comme un adulte
ordinaire, et l'ingestion le signale) ; **le sort du rapport nominatif**, classé nominatif mais
volontairement non purgé tant que l'arbitrage n'est pas rendu ; **les indemnités repas et transport**,
qui restent « non renseigné » tant que la compagnie ne les fixe pas.

---

## 8. Ce qu'il faut de la compagnie pour mettre l'outil en service

1. **La liste passagers au format PAXLIST v3** — en particulier `vol_correspondance` et
   `heure_correspondance`, sans lesquelles aucune correspondance n'est protégée, et
   `date_naissance` / `nationalite` / `passeport_num`, sans lesquelles les fiches partent avec des
   blancs.
2. **Une clé de production pour l'API hôtelière** — pour confirmer sur des volumes réels ce qui n'est
   mesuré qu'en bac à sable.
3. **Les trois arbitrages du §7.**
4. **Les temps de trajet par couronne, déclarés par l'exploitation**, pour chaque escale ouverte —
   l'outil ne les mesurera jamais.
5. **Une fiche escale par escale à ouvrir** (`data/stations/<IATA>.json`) : un déroutement se produit
   justement là où on ne l'attend pas. Aucun code à modifier ; BKK, CDG et NOU sont livrées.

---

## 9. Chiffres mesurés — et dans quelles conditions

Aucun de ces chiffres n'est une projection.

| Mesure | Valeur | Conditions |
|---|---|---|
| Run réel complet, Bangkok | **25 min · 17 sessions · ~2,50 $ · 118 logés / 39 escalades · 12 305 €/nuit** | 16/09/2026, inventaire de 12 hôtels, 3 fiches mortes rattrapées en séance |
| Inventaire constitué par agents | **693 s · 11 sessions · 0,99 $ · 9 hôtels** | 15/09/2026, concurrence 3 |
| Vivier par API hôtelière | **185 hôtels · 11 059 offres · 7 s** | 22/09/2026, **clé bac à sable** |
| Plan sur vivier API, liste réelle | **171 logés / 24 escalades — 288 personnes sur 324** | 22/09/2026, rejeu hors ligne, 0 session, 0 $, **bac à sable** |
| Mode démonstration (filet de sécurité) | **~90 s · 0 € · 122 logés / 35 escalades · 26 569 €/nuit** | fixtures BKK, aucun agent |
| Couverture du vivier de 12 hôtels | **111 chambres indicatives pour 173 demandées — INSUFFISANT** | mesuré le 23/09, dit comme tel par l'outil |
| Suite de tests | **332 cas, 0 échec** | vérifié le 23/09/2026 |

---

## 10. Limites connues, dites d'avance

- **Prix publics uniquement**, et « borne basse » : ce qu'un agent voit est plafonné par la
  plateforme ; la sonde repousse ce plafond sans le supprimer.
- **Équipements et moyens de paiement « déclarés par la plateforme »** : non précisé = à confirmer,
  d'où la conformité PARTIELLE.
- **Un seul run à la fois.**
- **Le mode démonstration n'existe que pour Bangkok** ; les autres escales exigent un run réel ou un
  dry-run.
- **Devises mélangées** : aucun total consolidé n'est calculé, le détail par devise le remplace.
  Rien n'est converti, rien n'est estimé.
- **La durée affichée par le dry-run est une estimation** tirée de deux runs sur une seule escale.
  Elle ne compte pas le temps humain de validation.
- **Le levier « plafond de prix » n'est pas strictement monotone** : le monter peut, sur certains
  relevés, faire baisser d'un ou deux le nombre de dossiers logés, parce qu'il change aussi le
  classement des hôtels. La mesure est figée par un test ; le correctif est identifié.
- **Les temps de trajet des couronnes sont déclarés, jamais mesurés.**

---

*Ce guide décrit l'outil au 23 septembre 2026. L'audit technique correspondant, avec ses constats et
ses recommandations, est dans [AUDIT-2026-09-23.md](AUDIT-2026-09-23.md).*
