# PAXLIST v1 — format du fichier « liste passagers »

Spécification du CSV d'entrée de l'outil d'hébergement d'urgence (déroutement, escale BKK).
Version 1 — 19/09/2026. Établie après audit du code existant : chaque règle indique ce que la valeur
change réellement dans le plan. Les passages en italique rappellent le comportement d'AVANT l'ingestion
PAXLIST (corrigé le 19/09) — ils expliquent pourquoi la règle existe.

**État : IMPLÉMENTÉE le 19/09/2026** — module `hai-admin-mcp/lib/paxlist.mjs`, branchée sur l'UI, la CLI
(`rebooking-v2.mjs --in`) et le pipeline ; 23 tests dédiés. Les écarts restants sont listés au §6. Fichiers à transmettre à la compagnie :
[`data/exemples/paxlist-modele-a-remplir.csv`](../data/exemples/paxlist-modele-a-remplir.csv) (en-tête seul),
[`data/exemples/paxlist-dictionnaire-colonnes.csv`](../data/exemples/paxlist-dictionnaire-colonnes.csv)
(notice lisible dans Excel) et
[`data/exemples/paxlist-exemple.csv`](../data/exemples/paxlist-exemple.csv) (exemple rempli).
**La liste réelle ne se commite jamais** : `data/paxlist*.csv` est ignoré par Git (données nominatives,
dont l'assistance qui relève de l'article 9 du RGPD).

---

## 1. Les trois règles d'or

1. **Une valeur que l'outil ne comprend pas ne devient jamais une valeur par défaut.** Elle produit un refus
   nommé (ligne, colonne, valeur) ou un avertissement tracé dans le rapport d'ingestion. Avant le 19/09, une
   cabine `C` devenait `Y`, un type `ADULT` ne compte personne, un `WCHC` ne déclenche pas PMR, un PNR vide
   fusionne des inconnus — le tout sans un seul message.
2. **Une colonne absente est tolérée ; une colonne présente et illisible ne l'est pas.** L'absence donne un
   défaut *explicite* + un avertissement chiffré en tête de rapport. C'est ce qui rend le fichier remplissable
   à partir d'un export DCS brut sans retravail.
3. **Rien de ce fichier ne part chez un tiers.** Aucune donnée passager n'entre dans un prompt d'agent web
   (invariant INV-5, déjà tenu et testé). La liste reste en mémoire du serveur ; les sorties nominatives
   (plan, messages) sont écrites localement et doivent être effacées après la séance.

---

## 2. Règles de fichier

| Point | Règle |
|---|---|
| **Format** | CSV, une ligne par **personne** (pas par dossier). |
| **Encodage** | UTF-8, BOM toléré et recommandé (c'est ce qu'Excel produit). À la lecture : BOM UTF-8, BOM UTF-16, puis test UTF-8 strict ; à défaut repli **Windows-1252 avec avertissement nommé** (un export Excel FR est le cas nominal, pas l'exception). Refus si des caractères de remplacement subsistent : le fichier est déjà corrompu. |
| **Séparateur** | `;` demandé. À la lecture, détection parmi `;` `,` TAB `\|` sur la ligne d'en-tête : est retenu celui qui fait reconnaître le plus de colonnes. |
| **Guillemets** | RFC 4180 : tout champ contenant le séparateur, un guillemet ou un saut de ligne est encadré de `"`, guillemets internes doublés. Un champ cité contenant le séparateur est relu entier (test dédié). |
| **En-tête** | Obligatoire, première ligne. **Ordre des colonnes libre.** Noms en minuscules sans accent, mais comparaison insensible à la casse, aux accents, aux espaces, tirets et underscores, via table d'alias. Colonnes surnuméraires tolérées et listées comme « ignorées ». Deux en-têtes qui normalisent vers le même nom = refus nommé. |
| **Fin de ligne** | LF ou CRLF. Lignes entièrement vides ignorées et comptées. |
| **Volumétrie** | Jusqu'à 8 Mio (≈ 40 000 lignes). 324 passagers = 15 ms de traitement : la taille n'est pas un sujet. |
| **Nom de fichier** | `paxlist_<vol>_<AAAAMMJJ>_<escale>.csv` — ex. `paxlist_SB800_20260920_BKK.csv`. Indicatif. La liste réelle ne doit jamais être déposée dans le dépôt Git. |

---

## 3. Colonnes

### 3.1 Socle obligatoire — 4 colonnes

Sans elles, aucun plan n'est calculable.

| Colonne | Valeurs | Ce que ça change dans le plan |
|---|---|---|
| **pnr** | 1 à 20 caractères, non vide. Gabarit attendu : 6 alphanumériques. Alias d'en-tête : `record_locator`, `rloc`, `booking_ref`, `dossier`. | **Clé de regroupement en dossier.** Détermine le nombre de chambres, le tier retenu (maximum des cabines du PNR), la file de priorité, une ligne de plan et un message FR + un message EN. Le dossier est indivisible : tous ses occupants vont dans le même hôtel. |
| **nom** | 1 à 60 caractères. La forme PNL `NOM/PRENOM TITRE` en un seul champ est acceptée, découpée et tracée (implémenté). Alias : `last_name`, `surname`, `nom_passager`. | Uniquement la colonne `occupants` du plan (liste d'appel au comptoir). Aucun effet sur l'affectation, aucun effet sur les messages. |
| **type_pax** | `ADT`, `CHD`, `INF`. Alias absorbés → ADT : `ADULT`, `ADULTE`, `A`, `SRC`, `YTH` ; → CHD : `CNN`, `CHILD`, `ENFANT`, `UNN`, `UMNR`, et tout code `C00`–`C17` (l'âge est dans les deux chiffres) ; → INF : `INFT`, `INS`, `IN`, `BABY`. **Les titres de civilité (`MR`, `MRS`, `MS`) ne sont PAS acceptés comme type** : ils fabriqueraient des adultes à partir d'une civilité. | Compte adultes / enfants / bébés → **nombre de chambres**, surcouche « famille » et file prioritaire, note « berceau à demander », nombre de personnes de la ligne, et donc les indemnités repas/transport. *Avant le 19/09 : `ADULT` donnait 0 adulte, 0 enfant, 1 chambre et 0 € d'indemnités — et fait prendre la chambre la moins chère sans vérifier qu'elle peut accueillir deux personnes.* |
| **cabine** | `J`, `W`, `Y`. Alias texte : `BUSINESS`/`AFFAIRES` → J, `PREMIUM`/`PREMIUM ECO` → W, `ECO`/`ECONOMY`/`COACH` → Y. **Une classe de réservation (C, D, I, Z, S, P, M, H, K, Q, V, X…) n'est pas une cabine** : voir §3.4. | **C'est le tier de politique.** Fixe le plafond par nuit (J 250 € / W 130 € / Y 80 €, × facteur d'escale), les étoiles minimales et les prestations exigées, la file de priorité, la ventilation du coût. *Avant le 19/09 : une cabine `C` devenait `Y` en silence : même passager, même relevé BKK, on passe d'un hôtel à 151 € réglé par la compagnie à un hôtel à 26 € sur carte prépayée, ligne « CONFORME », notes vides.* |

### 3.2 Recommandées — 7 colonnes

Absence = défaut explicite + avertissement chiffré. Valeur présente et non reconnue = refus nommé.

| Colonne | Valeurs | Ce que ça change | Si absente |
|---|---|---|---|
| **prenom** | Texte. Alias : `first_name`, `given_name`. | Colonne `occupants` uniquement. | `occupants` n'affiche que le nom. |
| **assistance** | Codes SSR IATA, plusieurs acceptés (espace, virgule ou `/`). **À effet hôtel** : `WCHR`, `WCHS`, `WCHC`, `WCBD`, `WCBW`, `WCMP`, `BLND`, `DEAF`, `DPNA`, `EXST` → surcouche PMR. **Escalade nominative** : `UMNR`/`UNN`, `MEDA`, `STCR`. **Reconnus sans effet chambre** : `MAAS`, `BSCT`, `NSST`, `BULK`, `SPEQ`, repas `*ML`. `PETC`/`AVIH` → note animaux. Code inconnu : avertissement, jamais refus. | Surcouche **PMR** : file en tête de traitement, **chambre accessible exigée**, poids distance ×2, surclassement de tier autorisé, dérogation de plafond en dernier recours, note « transfert adapté à confirmer ». | « 0 PMR reconnu » en tête de rapport. *Avant le 19/09 : seul le code exactement `WCHR` comptait : `WCHS`, `WCHC`, `BLND`, `DEAF`, `wchr` et même `WCHR BLND` ne déclenchent rien.* |
| **statut_pax** | `A_LOGER` (alias `EMBARQUE`, `BOARDED`, `FLOWN`), `NON_EMBARQUE` (`NOSHOW`, `OFFLOAD`), `AUTONOME` (`SELF`, `OWN ARRANGEMENT`), `DEJA_LOGE`, `REFUSE`. **`OK` n'est pas accepté** : dans un PSS il signifie « réservation confirmée », pas « embarqué ». | Seules les lignes `A_LOGER` produisent des besoins, des chambres et du coût. Les autres sont comptées et nommées, jamais logées. | Tout est `A_LOGER` + avertissement « un PNL contient des no-shows ». C'est la seule protection contre le fait de payer des chambres vides (5 à 15 % d'un vol se loge seul). |
| **categorie** | `PAX`, `PNT` (cockpit), `PNC` (cabine), `DEADHEAD` (`DH`, `ACM`, mise en place). | Toute ligne ≠ `PAX` **sort du plan passagers** : bloc équipage à part, **une chambre individuelle par personne**, jamais d'appariement deux par deux. | Tout est `PAX` + avertissement. *Avant le 19/09 : le mot « équipage » a zéro occurrence dans tout le code : un commandant de bord est logé comme un passager de tier J, apparié avec un inconnu.* |
| **droit_entree** | `OUI`, `NON`, `INCONNU` (alias `TWOV`, `TRANSIT ONLY` → NON ; vide → INCONNU). | `NON` ou `INCONNU` : le dossier ne part pas à l'hôtel de ville, il sort en escalade **« droit d'entrée — traitement nominatif GHA »**. `INCONNU` n'est jamais rabattu sur `OUI`. | Avertissement : « tous les dossiers planifiés comme entrants ; une nuit à BKK dépasse le seuil de transit sans visa ». *Avant le 19/09 : la fiche escale BKK déclarait `entry_visa_check: true` sans qu'aucune ligne de code ne le lise.* |
| **destination_finale** | Code IATA de l'aéroport d'arrivée finale (`CDG`, `NRT`…). Toujours présent dans un export DCS. | Sert à **déduire** le transit quand `droit_entree` est inconnu : destination ≠ escale ⇒ dossier marqué « transit — droit d'entrée à vérifier ». C'est la donnée que l'escale sait remplir à 2 h du matin, contrairement au visa. | Avertissement seulement. |
| **chambres_demandees** | Entier ≥ 1, par PNR (même valeur sur toutes les lignes du dossier). | **Force le chambrage** du dossier et court-circuite la règle automatique. Indispensable pour les familles nombreuses et les groupes : *aujourd'hui 2 adultes + 5 enfants sortent en 2 chambres, et un groupe de 20 devient 10 chambres doubles d'inconnus.* | Chambrage calculé : unité familiale ≤ 2 adultes + 2 enfants, sinon 2 chambres ; adultes seuls appariés par deux ; 1 chambre par passager PMR. |

### 3.3 Facultatives — 6 colonnes

| Colonne | Valeurs | Rôle |
|---|---|---|
| **flying_blue** | `PLATINUM`, `GOLD`, `SILVER`, `NONE` (+ alias `PLT`, `GLD`, `ULTIMATE`, `EXPLORER`). | **Uniquement l'ordre de service à l'intérieur d'une file** — jamais le tier, jamais le plafond. N'apparaît dans aucune colonne du plan. Valeur inconnue → `NONE` + avertissement. |
| **groupe** | Nom ou référence du groupe (≤ 40 car.). | Marqueur `GROUPE` dans le plan + avertissement « chambrage de groupe non deviné, liste de rooming de l'organisateur à fournir ». |
| **email** / **telephone** | Adresse ou numéro, par personne ou répété sur le PNR. | Alimente une colonne `destinataire` du fichier messages. *Encore vrai : les messages FR/EN produits ne sont adressables à personne : ils renvoient au comptoir.* Donnée sensible : jamais transmise à un tiers. |
| **age** | Entier 0–120, ou vide. | **Contrôle croisé du type** seulement (ADT < 12 ans, CHD ≥ 18, INF ≥ 2 → avertissement). *Avant le 19/09 : cette colonne était obligatoire à fournir et n'était lue par aucun module.* Elle devient facultative. |
| **vol** | `SB800`, éventuellement `SB800/2026-09-20`. | En-tête du rapport. Plusieurs vols dans le fichier → avertissement (un seul scénario — escale, nuits, date — s'applique à tout le fichier). |
| **remarque** | Texte libre, cité si nécessaire. | **Jamais interprétée** — c'est une règle, pas une limite : une contrainte réelle doit passer par `assistance`. Recopiée tronquée dans les notes du plan, pour l'agent de comptoir. |

### 3.4 Le cas des classes de réservation (RBD)

Un DCS exporte le plus souvent une **lettre de réservation** (C, D, S, M, K…), pas une cabine. La même lettre
ne désigne pas la même cabine d'une compagnie à l'autre : **rien ne doit être deviné**.

Deux voies, au choix de la compagnie :

1. **Recommandée** — la compagnie fournit la colonne `cabine` déjà normalisée en `J`/`W`/`Y`. Une colonne
   `classe_reservation` peut accompagner à titre de trace d'audit : elle est conservée et ignorée.
2. **Repli — NON IMPLÉMENTÉ EN v1.** Prévu : à l'import, l'écran liste les lettres rencontrées
   (`C · D · S · M · K…`) et l'opérateur affecte J/W/Y à chacune en quelques clics. **Tant que ce repli
   n'existe pas, un fichier qui ne porte que des lettres RBD est refusé** (l'erreur nomme chaque valeur et
   le nombre de lignes concernées) : la compagnie doit fournir `cabine` en J/W/Y, ou le fichier doit être
   converti avant l'import. C'est le point à confirmer en priorité avec la compagnie (§7.1).

### 3.5 Colonnes écartées de la v1 (et pourquoi)

- **`nuits` par dossier** — le moteur de coût est entièrement bâti sur une durée globale ; une durée par
  dossier n'est pas une colonne, c'est une refonte. Le déroutement BKK n'en a pas besoin.
- **`langue`** — le comptoir imprime FR **et** EN pour tout le monde, à coût nul.
- **`nationalite`** — c'est le champ le plus sensible du fichier et il ne changerait rien au plan ; le dossier
  GHA se construit avec le PNR + `droit_entree` + le DCS du comptoir.
- **`siege`** — aucun effet sur l'hébergement.

---

## 4. Ce qui fait refuser un fichier — trois cas, pas un de plus

Tout le reste est un avertissement tracé.

1. **Structure illisible** : séparateur indétectable, en-tête dupliqué après normalisation, encodage
   irrécupérable, ligne dont le nombre de champs diffère de l'en-tête. → *Refus **par ligne** quand c'est une
   ligne (elle est écartée et comptée) ; refus du fichier seulement quand c'est l'en-tête.* Une seule ligne
   bancale sur 324 ne doit jamais coûter le fichier.
2. **`pnr` vide.** Sans clé, le regroupement est impossible. *Mesuré : 324 lignes sans PNR donnent un unique
   dossier de 324 personnes, 2 chambres, et un champ « occupants » de 5 000 caractères.*
3. **Valeur présente et non résoluble sur une colonne qui commande le tier ou une exclusion** :
   `cabine`, `type_pax`, `categorie`, `statut_pax`, `droit_entree`. Message attendu :
   `cabine inconnue : « C » (34 lignes : 12, 47, 88…) — fournissez J/W/Y ou renseignez la correspondance à l'écran`.

**Tout refus doit être réparable à l'écran**, sans repasser par Excel : affectation des lettres RBD,
« cette colonne vaut X pour tout le fichier », bouton « forcer windows-1252 ».

---

## 5. Rapport d'ingestion — le vrai point de contrôle

Aucun run ne doit pouvoir démarrer avant que l'opérateur ait vu, à l'écran :

- lignes lues / retenues / écartées / refusées, avec le motif de chaque écart ;
- **correspondances appliquées** : « LAST NAME → nom », « CLASS → cabine », « CNN → CHD : 12 lignes »,
  « C05 → CHD (5 ans) : 1 ligne » ;
- compteurs : **par cabine J/W/Y**, par type ADT/CHD/INF, **PMR**, familles, groupes, équipage, escalades
  nominatives (UMNR, MEDA, STCR, droit d'entrée), non-embarqués, autonomes ;
- avertissements : encodage replié, SSR inconnus, incohérences âge/type, PNR hors gabarit, PNR portant
  plusieurs noms de famille sans valeur `groupe`, effectif supérieur aux sièges déclarés, plusieurs vols ;
- rappel de la nuit retenue **en heure locale d'escale**.

**Règle d'arrêt opérateur** : si le rapport annonce J = 0 ou W = 0 sur une liste qui contient de la business,
ou 0 PMR sur une liste qui en contient, **on ne lance pas le run** : la nomenclature n'a pas été comprise.

---

## 6. État de la mise en œuvre (19/09/2026)

**Livré** : module d'ingestion (décodage, parseur RFC 4180 borné, détection de séparateur, alias d'en-têtes
et de valeurs, schéma zod par ligne, rapport d'ingestion), exclusion équipage / non-embarqués, surcouche PMR
sur l'ensemble des codes SSR, escalades nominatives (civière, médical, mineur non accompagné), droit d'entrée
(refusé = hors plan, inconnu = logé sous réserve), `chambres_demandees` qui prime sur le chambrage calculé,
notes par code SSR, colonnes `pax` / `hotel_url` / `hors_plan` / `sous_reserve` au plan, section « Liste
passagers » et avertissements d'ingestion dans le rapport livré, variante de message « hors plan », rapport
d'ingestion affiché dans l'UI et verrou du lancement après un refus. `lib/csv.mjs` et le générateur sont
restés intouchés ; la chorégraphie de démonstration est inchangée (88/69 hors ligne, 157/0 en simulation).

**Reste à faire** (par ordre de valeur) : écran de correspondance RBD → cabine (§3.4) ; `computeNeeds`
compte encore les dossiers hors plan, donc le dry-run surestime de quelques chambres le besoin à couvrir ;
purge des listes et sorties nominatives après séance ; livrable « rooming list par hôtel ».

Charge initialement estimée : **≈ 2,75 jours**, sans toucher au lecteur CSV actuel (verrouillé par des tests de
non-régression) ni au générateur de listes de démonstration.

| # | Travail | Charge |
|---|---|---|
| 1 | Nouveau module d'ingestion : normalisation des valeurs (zod + tables d'alias + codes `C00`–`C17` + jeu de SSR déclencheurs) appliquée **aux lignes**, quelle que soit leur source | 0,5 j |
| 2 | Lecture du fichier : BOM, UTF-8 strict, UTF-16, repli Windows-1252, parseur RFC 4180, détection de séparateur, alias d'en-têtes | 0,5 j |
| 3 | Branchements : téléversement, dry-run, CLI, UI (envoi des octets bruts et affichage du rapport complet) | 0,25 j |
| 4 | Moteur : jeu de codes PMR, exclusion équipage / non-embarqués **avant** regroupement, chambrage des familles nombreuses, 1 chambre par PMR, `chambres_demandees` | 0,5 j |
| 5 | Sorties : motifs d'escalade nommés (droit d'entrée, mineur non accompagné, médical, équipage), colonne destinataire, avertissements d'ingestion dans le rapport | 0,25 j |
| 6 | Tests : un par règle de refus, un par règle d'avertissement, les deux fichiers d'exemple ingérés en entier | 0,5 j |
| 7 | Mise à jour du cahier des charges (§5.5) et du journal d'état | 0,25 j |

Deux points à arbitrer **avant**, pas le jour J : appliquer « 1 chambre par passager PMR » déplace les
chiffres de démonstration publiés ; et aucune ligne hors plan passagers (équipage, exclusions) ne doit entrer
dans le plan, sous peine de faire échouer le calcul de coût en fin de run.

---

## 7. À demander à la compagnie

**La question la plus rentable, et la seule vraiment bloquante :**

> Un **export réel anonymisé de 20 lignes**, tel que le DCS le produit, avec sa ligne d'en-tête.

Il fige en une heure les alias d'en-têtes, la forme des SSR multiples, le codage des enfants et l'encodage —
là où une liste de questions colonne par colonne coûte un aller-retour chacune.

**Ensuite, par ordre d'importance :**

1. Quelles classes de réservation sont vendues sur la rotation, et **laquelle correspond à quelle cabine** ?
   Varient-elles selon la route ? Un passager surclassé au départ figure-t-il avec son RBD d'achat ou sa
   cabine réelle — et **laquelle fait foi** pour l'hébergement ?
2. L'export vient-il du DCS **après embarquement** (qui était réellement à bord) ou d'un **PNL de réservation**
   (qui contient des no-shows) ?
3. **Équipage** : figure-t-il dans le même fichier, sous quel code (PNT/PNC/DH/ACM), combien de personnes
   deadhead compris ? Avez-vous des hôtels sous contrat à BKK et une durée de repos minimale à garantir ?
4. **Droit d'entrée en Thaïlande** : l'export porte-t-il la nationalité ou le droit d'entrée ? Sinon, qui
   fournit l'information, dans quel délai, et quel est le canal d'escalade GHA à BKK ?
5. Disposez-vous d'un **contact par passager ou par dossier** (e-mail, téléphone) exploitable un jour de
   déroutement, ou la remise se fait-elle au comptoir ?
6. Les **groupes** sont-ils identifiables, et avez-vous la liste de chambrage de l'organisateur ?
7. Le record locator exporté est-il le vôtre ou celui de l'agence, et lequel apparaît sur un billet interligne ?
8. Utilisez-vous `CHD`, `CNN`, ou les codes à âge `C05`/`C11` ? Le nom est-il en un champ `NOM/PRENOM` ou en
   deux colonnes ?

---

## 8. Fichier d'exemple

Voir `data/exemples/paxlist-exemple.csv` : 28 lignes couvrant les cas remarquables — couple affaires, famille de 7 avec
bébé, `WCHC` avec accompagnante, `WCHR BLND`, no-show, passager autonome, mineur non accompagné, animal en
cabine, escalade médicale, groupe de 4, transit sans droit d'entrée, code enfant à âge `C05`, champ cité
contenant un point-virgule, et trois lignes d'équipage à clé individuelle.

Passé à l'outil **dans son état actuel**, ce fichier produit un plan qui loge le no-show, le passager
autonome, le mineur non accompagné, le passager sans visa et les trois navigants comme des passagers
ordinaires, ne reconnaît **aucun** des deux PMR, et donne 2 chambres à la famille de 7 — sans un seul
avertissement. C'est précisément l'écart que cette spécification supprime.
