# PAXLIST v3 — format du fichier « liste passagers »

Spécification du CSV d'entrée de l'outil d'hébergement d'urgence (déroutement, escale BKK).
Version 1 — 19/09/2026 · **version 2 — 21/09/2026** (sept colonnes d'identité optionnelles, §3.3bis) ·
**version 3 — 21/09/2026** (deux colonnes de correspondance optionnelles, §3.3ter).
Établie après audit du code existant : chaque règle indique ce que la valeur
change réellement dans le plan. Les passages en italique rappellent le comportement d'AVANT l'ingestion
PAXLIST (corrigé le 19/09) — ils expliquent pourquoi la règle existe.

**Une liste v1 ou v2 reste valable telle quelle** : les colonnes ajoutées en v2 et en v3 sont toutes
optionnelles ; leur absence ne change aucune valeur du plan et ne produit qu'un avertissement chiffré
(§3.3bis, §3.3ter).

**État : IMPLÉMENTÉE le 19/09/2026** — module `hai-admin-mcp/lib/paxlist.mjs`, branchée sur l'UI, la CLI
(`rebooking-v2.mjs --in`) et le pipeline ; 23 tests dédiés. Les colonnes v3 (§3.3ter) sont **lues par le
module** mais leur contexte d'escale (`opts.escale`) n'est pas encore passé par la CLI, le serveur ni l'UI :
voir §6. Les écarts restants sont listés au §6. Fichiers à transmettre à la compagnie :
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
   (plan, rooming, messages et, depuis la v2, **les fiches d'enregistrement**) sont écrites localement et
   doivent être effacées après la séance (`policy.retention.nominative_hours`). La v2 ajoute des données
   d'identité — passeport, date de naissance, nationalité, adresse — qui durcissent cette règle sans la
   changer : elles ne servent qu'à imprimer un document remis en main propre au comptoir.

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
| **droit_entree** | `OUI`, `NON`, `INCONNU` (alias `TWOV`, `TRANSIT ONLY` → NON ; vide → INCONNU). | `NON` : le dossier ne part pas à l'hôtel de ville, il sort **HORS PLAN HÔTEL** en escalade **« droit d'entrée — traitement nominatif GHA »**. `INCONNU` : le dossier est **LOGÉ SOUS RÉSERVE** — sa chambre est provisionnée, la colonne `sous_reserve` du plan porte « droit d'entrée à vérifier », et la chambre est à annuler si l'entrée est refusée. `INCONNU` n'est jamais rabattu sur `OUI`. | Avertissement : « tous les dossiers planifiés comme entrants ; une nuit à BKK dépasse le seuil de transit sans visa ». *Avant le 19/09 : la fiche escale BKK déclarait `entry_visa_check: true` sans qu'aucune ligne de code ne le lise.* |
| **destination_finale** | Code IATA de l'aéroport d'arrivée finale (`CDG`, `NRT`…). Toujours présent dans un export DCS. | **Aucun effet à elle seule.** La colonne est lue, contrôlée (format IATA) et recopiée. Elle n'entre dans aucune décision de droit d'entrée : un dossier au droit d'entrée `INCONNU` est traité de la même façon quelle que soit sa destination, et la déduction de transit reste **à implémenter** (§6). **Depuis la v3 elle n'est plus une trace morte** : lue AVEC `heure_correspondance` (§3.3ter), destination ≠ escale + horaire fourni = dossier en correspondance ; les deux qui se contredisent déclenchent un avertissement nommé. | Avertissement seulement. |
| **chambres_demandees** | Entier ≥ 1, par PNR (même valeur sur toutes les lignes du dossier). | **Force le chambrage** du dossier et court-circuite la règle automatique. Indispensable pour les familles nombreuses et les groupes : *aujourd'hui 2 adultes + 5 enfants sortent en 2 chambres, et un groupe de 20 devient 10 chambres doubles d'inconnus.* | Chambrage calculé : unité familiale ≤ 2 adultes + 2 enfants, sinon 2 chambres ; adultes seuls appariés par deux. **Les passagers PMR sont appariés comme des adultes ordinaires** : la règle « 1 chambre par PMR » n'est PAS implémentée (§6). Sans `chambres_demandees`, un `WCHC` et son accompagnante partagent une chambre double ; l'ingestion compte et nomme les dossiers concernés (`pmr_chambrage_devine`). |

### 3.3 Facultatives — 6 colonnes

| Colonne | Valeurs | Rôle |
|---|---|---|
| **flying_blue** | `PLATINUM`, `GOLD`, `SILVER`, `NONE` (+ alias `PLT`, `GLD`, `ULTIMATE`, `EXPLORER`). | **Uniquement l'ordre de service à l'intérieur d'une file** — jamais le tier, jamais le plafond. N'apparaît dans aucune colonne du plan. Valeur inconnue → `NONE` + avertissement. |
| **groupe** | Nom ou référence du groupe (≤ 40 car.). | Marqueur `GROUPE` dans le plan + avertissement « chambrage de groupe non deviné, liste de rooming de l'organisateur à fournir ». |
| **email** / **telephone** | Adresse ou numéro, par personne ou répété sur le PNR. | Alimente une colonne `destinataire` du fichier messages. *Encore vrai : les messages FR/EN produits ne sont adressables à personne : ils renvoient au comptoir.* Donnée sensible : jamais transmise à un tiers. |
| **age** | Entier 0–120, ou vide. **Une date ne s'écrit pas ici** : `dob`, `date of birth`, `birthdate` désignent désormais la colonne `date_naissance` (§3.3bis) — en v1 ils étaient rabattus sur `age`, et « 1982-03-14 » était rejeté comme « âge hors 0–120 ». | **Contrôle croisé du type** seulement (ADT < 12 ans, CHD ≥ 18, INF ≥ 2 → avertissement). *Avant le 19/09 : cette colonne était obligatoire à fournir et n'était lue par aucun module.* Elle devient facultative : à défaut, l'âge est déduit de `date_naissance`. Un écart de plus d'un an entre les deux est signalé (`age_date_naissance`). |
| **vol** | `SB800`, éventuellement `SB800/2026-09-20`. | En-tête du rapport. Plusieurs vols dans le fichier → avertissement (un seul scénario — escale, nuits, date — s'applique à tout le fichier). |
| **remarque** | Texte libre, cité si nécessaire. | **Jamais interprétée** — c'est une règle, pas une limite : une contrainte réelle doit passer par `assistance`. Recopiée tronquée dans les notes du plan, pour l'agent de comptoir. |

### 3.3bis Identité — 7 colonnes optionnelles ajoutées en v2 (pour les fiches, pas pour le plan)

**Le problème que ces colonnes résolvent.** La condition client C3 demande « les formulaires de saisie des
informations pour chaque passager ». Un registre d'hôtel se remplit avec un nom, une date de naissance, une
nationalité et un numéro de passeport. Le format v1 ne demandait aucun des trois derniers : on ne peut pas
pré-remplir un formulaire avec des champs qui n'ont jamais été collectés. Ces colonnes ferment l'écart.

**Elles ne changent RIEN au plan** : ni le tier, ni le chambrage, ni le coût, ni une escalade. Elles ne
servent qu'aux fiches produites par `hai-admin-mcp/lib/fiches.mjs` (`fiches-<runId>.csv` et
`fiches-<runId>.html`). Fournies, elles économisent une saisie manuscrite par passager au comptoir ;
absentes, la fiche part avec un blanc **explicitement marqué `[non fourni]`** — jamais une valeur devinée.

| Colonne | Valeurs | Alias d'en-tête | Si absente |
|---|---|---|---|
| **date_naissance** | `AAAA-MM-JJ` (ISO 8601). Aussi acceptés : `AAAAMMJJ` (export DCS) et `JJMMMAAAA` (`14MAR1982`). **`03/04/1982` est écarté avec avertissement** : selon le pays d'export c'est le 3 avril ou le 4 mars, et une année à deux chiffres est tout aussi ambiguë. | `dob`, `date of birth`, `birthdate`, `date de naissance` | Blanc sur la fiche. Fournit aussi l'`age` quand la colonne `age` est vide. |
| **nationalite** | ISO 3166-1 alpha-2 ou alpha-3 (`FR` ou `FRA`). Un nom de pays en clair est **conservé tel quel** et signalé hors format : un hôtelier sait lire « FRANCE », et le convertir au jugé serait inventer. | `nationality`, `citizenship`, `natio` | Blanc sur la fiche. |
| **passeport_num** | 4 à 20 caractères alphanumériques. Espaces et tirets retirés, transformation tracée au rapport. | `passport`, `passport number`, `doc number`, `travel doc number` | Blanc sur la fiche. |
| **passeport_exp** | Mêmes formats que `date_naissance`. Une date déjà passée déclenche un avertissement nommé. | `passport expiry`, `expiry date`, `expiration date` | Blanc sur la fiche. |
| **passeport_pays** | Comme `nationalite`. | `issuing country`, `country of issue`, `pays emission` | Blanc sur la fiche. |
| **sexe** | `M`, `F`, `X` (+ alias `MALE`/`HOMME`, `FEMALE`/`FEMME`, `U`/`UNSPECIFIED`). **La civilité `MR`/`MRS` n'est pas acceptée** : un titre de politesse n'est pas un sexe — même règle que pour `type_pax`. | `gender`, `sex`, `genre` | Blanc sur la fiche. |
| **adresse_domicile** | Texte libre, 200 caractères. | `address`, `home address`, `domicile` | Blanc sur la fiche. Exigée par certains registres locaux (Thaïlande, formulaire TM30 rempli par l'hôtel). |

**Avertissement chiffré à l'ingestion** (code `fiches_incompletes`), en tête de rapport :

> `12 fiche(s) sur 23 seront incomplètes : date_naissance absent sur 11, nationalite absent sur 11,
> passeport_num absent sur 12 — les formulaires d'enregistrement partiront avec ces champs en blanc, à
> remplir passeport en main au comptoir.`

Les trois colonnes comptées comme *essentielles* sont `date_naissance`, `nationalite`, `passeport_num` :
ce sont celles qu'un registre d'hôtel exige partout. Le compteur `compteurs.fiches`
(`{attendues, completes, manques}`) porte le détail colonne par colonne.

**Une colonne fournie spontanément n'est plus écartée en silence** : toute colonne non reconnue produit
désormais un avertissement nommé (code `colonnes_ignorees`) invitant à signaler son contenu — une colonne
d'identité mal nommée est une fiche remplie de moins, pas une curiosité de rapport.

**Données personnelles sensibles (INV-5, RGPD).** Numéro de passeport, date de naissance, nationalité et
adresse ne sortent jamais du processus : aucune n'entre dans un prompt ni dans un événement d'agent — les
agents relèvent des hôtels, ils ne voient aucun passager. Elles ne vont que dans les livrables locaux, soumis
à `policy.retention.nominative_hours`, et **ne se commitent jamais** (`data/paxlist*.csv` est ignoré par Git).
Le fichier d'exemple du dépôt porte des identités entièrement fictives.

### 3.3ter Correspondance — 2 colonnes optionnelles ajoutées en v3 (le budget de trajet)

**Le problème que ces colonnes résolvent.** Le vivier d'hôtels proches de BKK ne couvre pas 324 passagers
(85 chambres indicatives pour 173 demandées, mesuré). La seule issue est d'**élargir la distance** — et dès
qu'on élargit, il faut savoir **qui peut aller loin**. Un passager dont le vol suivant part dans 20 h peut
être logé à 40 km ; un passager qui repart à 05h40 ne le peut pas. Cette information n'existait nulle part :
la v2 portait `destination_finale` (où il va) mais aucun **horaire** (quand il repart).

**Ce que l'horaire commande.** L'heure du vol suivant sert de deux façons, et la seconde est la vraie
protection :

- **le rang** — l'ordre de service : qui choisit sa chambre en premier (critère `correspondance_serree` de la
  politique de prise en charge) ;
- **le budget de trajet** — `dossier.trajet_max_min`, une **CONTRAINTE DURE** par dossier. Un rang seul ne
  protège personne : si les PMR sont servis d'abord et épuisent le vivier proche, le passager de 05h40 finit
  à 40 km et manque son vol. **Aucun rang ne permet d'outrepasser le budget de trajet.**

**Ce module ne calcule aucun budget.** Il lit l'horaire, le date quand il le peut, dit d'où vient la date
qu'il rend, et s'arrête là. Le calcul du budget (avance à l'enregistrement, repos minimal, marge d'aléas) est
réglé dans `policy.global.correspondance` et fait ailleurs. **L'outil n'a aucun service de routage et ne
convertit jamais une distance en durée** : les temps de trajet des couronnes sont DÉCLARÉS par l'exploitation.

| Colonne | Valeurs | Alias d'en-tête | Si absente |
|---|---|---|---|
| **vol_correspondance** | Indicatif IATA du vol **suivant** : 2 ou 3 caractères de compagnie puis 1 à 4 chiffres, suffixe de lettre toléré (`TG930`, `AF165`, `AF1234A`). Espaces et tirets retirés, transformation tracée. Hors gabarit : **valeur conservée telle quelle** (« Thai Airways 930 » reste lisible par un agent de comptoir) et signalée. | `onward flight`, `connecting flight`, `next flight`, `vol suivant`, `prochain vol` | Aucun effet. Seule, cette colonne ne permet rien : c'est l'horaire qui commande. |
| **heure_correspondance** | Départ du vol suivant. Quatre formes acceptées, voir ci-dessous. | `std`, `etd`, `departure time`, `onward departure`, `connecting flight time`, `heure vol suivant` | **Avertissement chiffré** `correspondance_absente` : « n dossier(s) sur m sans horaire de correspondance : leur budget de trajet ne peut pas être calculé, **aucune contrainte de distance ne s'appliquera** — ces dossiers peuvent être logés dans n'importe quelle couronne, y compris la plus lointaine ». |

**Formes d'horaire acceptées** (ce qu'un DCS exporte réellement) :

| Forme | Exemple | Date | Fuseau |
|---|---|---|---|
| ISO 8601 complet avec fuseau | `2026-09-21T05:40:00+07:00`, `…Z` | déclarée | déclaré — l'instant absolu est calculé (`correspondance_utc`) |
| ISO 8601 sans fuseau | `2026-09-21T05:40` | déclarée | **celui de l'escale** |
| date + heure séparées d'une espace | `2026-09-21 05:40` | déclarée | **celui de l'escale** |
| `HH:MM` seul | `05:40` | **INFÉRÉE**, voir la règle ci-dessous | **celui de l'escale** |

La partie **date** accepte les trois formes non ambiguës de `date_naissance` : `AAAA-MM-JJ`, `AAAAMMJJ` et
`21SEP2026`. Comme pour les dates de naissance, `03/04/2026` est **refusé** : selon le pays d'export c'est le
3 avril ou le 4 mars.

**Forme refusée à dessein : l'horaire en chiffres collés** (`0540`). Rien ne le distingue d'une année —
« 2026 » se lirait 20:26. La compagnie écrit `05:40`.

#### La règle de datage de `HH:MM` seul — tranchée, jamais devinée en silence

Un vol à 05:40 est presque toujours **le lendemain** d'un déroutement de nuit. La règle retenue est donc :

> **`HH:MM` seul est daté à la première occurrence de cette heure STRICTEMENT POSTÉRIEURE à l'arrivée du vol
> dérouté à l'escale**, dans le fuseau de l'escale.

Arrivée à 23h15 → `05:40` tombe **le lendemain** (6 h 25 plus tard) ; `23:50` tombe **le soir même** (35 min
plus tard) ; `23:15` tombe le lendemain (l'égalité n'est pas une correspondance). La date ainsi obtenue porte
`correspondance_date_source: "inferee"` et **déclenche l'avertissement nommé `correspondance_date_inferee`**,
chiffré, qui rappelle la règle : *une date inférée à tort décale le budget de trajet de 24 h.*

**Sans heure d'arrivée fournie à l'ingestion, aucune date n'est inventée** : l'heure brute est conservée,
`correspondance_date_source` vaut `"indeterminee"`, et l'avertissement `correspondance_date_indeterminee` dit
que c'est à l'appelant de la dater. C'est le cas par défaut : `lib/paxlist.mjs` ne charge pas la fiche escale.

#### Le fuseau est décisif

**Une heure sans fuseau explicite est l'heure LOCALE DE L'ESCALE** (`station.timezone` — `Asia/Bangkok` à
BKK), jamais l'horloge du serveur. Un serveur en Europe qui lirait « 05:40 » sur sa propre horloge se
tromperait de 5 à 6 heures sur le budget de trajet, c'est-à-dire d'une couronne entière.

Le module d'ingestion **ne convertit rien** : il rend l'horloge murale telle quelle et dit dans quel fuseau
la lire. Le contrat de sortie, posé sur chaque ligne canonique
(`PAXLIST_CORRESPONDANCE_DERIVEES` dans `lib/paxlist.mjs`) :

| Champ | Contenu |
|---|---|
| `heure_correspondance` | horloge **murale** canonique `AAAA-MM-JJTHH:MM`, ou `""` |
| `heure_correspondance_brute` | la cellule telle que la compagnie l'a écrite — toujours conservée |
| `correspondance_fuseau` | `"escale"` (à lire dans `station.timezone`) ou `"declare"` (le fichier portait un décalage) |
| `correspondance_offset` | le décalage déclaré (`+07:00`), `""` sinon |
| `correspondance_utc` | instant absolu `AAAA-MM-JJTHH:MMZ` — rempli **seulement** si la compagnie a déclaré un décalage |
| `correspondance_date_source` | `"declaree"` / `"inferee"` / `"indeterminee"` / `""` |
| `correspondance_rejet` | `""` / `"format"` / `"anterieure_arrivee"` / `"au_dela_72h"` |

L'appelant qui connaît la fiche escale passe le contexte à l'ingestion :
`ingestPassagers(bytes, { escale: { code, timezone, arrivee_locale, offset_min } })`. `arrivee_locale` est
l'**horloge murale d'escale** de l'arrivée du vol dérouté (`AAAA-MM-JJTHH:MM`) ; elle seule permet de dater un
`HH:MM` et de juger un horaire aberrant. `offset_min` (décalage UTC déclaré de l'escale) n'est nécessaire que
pour comparer un horaire qui porte **lui-même** un fuseau ; sans lui, les contrôles de plausibilité sont
sautés sur ces lignes et l'avertissement `correspondance_non_comparable` le dit.

#### Un horaire impossible est écarté et nommé, jamais conservé en silence

| Cas | Code d'avertissement | Effet |
|---|---|---|
| Valeur illisible (`demain matin`, `0540`, `25:00`, `03/04/2026 05:40`) | `correspondance_horaire` | horaire écarté, valeur brute conservée |
| Horaire **antérieur à l'arrivée** à l'escale | `correspondance_anterieure` | horaire écarté : un budget de trajet négatif escaladerait tout le dossier |
| Horaire **au-delà de 72 h** après l'arrivée | `correspondance_lointaine` | horaire écarté comme aberrant (année ou date de saisie erronée) |
| Indicatif de vol hors gabarit IATA | `correspondance_vol` | valeur **conservée telle quelle**, signalée |
| En-tête d'horaire **ambigu** (`STD`, `ETD`, `departure time`, `connection time`…) | `correspondance_entete_ambigue` | colonne lue, mais le nom ne dit pas DE QUEL VOL : l'opérateur doit confirmer qu'il s'agit du vol **suivant** et non du vol dérouté — se tromper de vol fabrique un budget faux sans que rien ne le montre |

Un horaire écarté fait retomber le dossier dans le compte `correspondance_absente` : il est traité comme un
dossier sans horaire — **aucune contrainte de distance**. C'est volontaire : mieux vaut un dossier sans
contrainte, annoncé et chiffré, qu'un budget calculé sur une donnée fausse.

#### Comment `destination_finale` et `heure_correspondance` se combinent

`destination_finale` était, depuis la v2, une **trace sans effet** : la colonne était lue, contrôlée et
recopiée, mais aucun module ne la comparait au code d'escale. Maintenant qu'un horaire existe, la lecture des
deux colonnes ensemble devient explicite :

| `destination_finale` | `heure_correspondance` | Lecture |
|---|---|---|
| ≠ code de l'escale | fourni | **Dossier en correspondance** : rang + budget de trajet. |
| ≠ code de l'escale | absent | Dossier probablement en correspondance, mais **aucun budget calculable** — compté dans `correspondance_absente`. |
| = code de l'escale | fourni | **Contradiction** : le passager serait arrivé à destination et repartirait. Avertissement nommé `correspondance_destination` ; rien n'est tranché en silence. |
| = code de l'escale ou absente | absent | Dossier terminant son voyage à l'escale : aucune contrainte de distance, et c'est correct. |

**L'horaire seul suffit** à calculer un budget de trajet : `destination_finale` n'est pas exigée. Elle sert à
lire le dossier et à repérer les contradictions, pas à décider.

**Données passager (INV-5, RGPD).** Comme toute colonne de ce fichier, ni le vol suivant ni son horaire
n'entrent dans un prompt ou un événement d'agent — les agents relèvent des hôtels, ils ne voient aucun
passager. Ces valeurs ne vont que dans les livrables locaux, soumis à `policy.retention.nominative_hours`.

### 3.4 Le cas des classes de réservation (RBD)

Un DCS exporte le plus souvent une **lettre de réservation** (C, D, S, M, K…), pas une cabine. La même lettre
ne désigne pas la même cabine d'une compagnie à l'autre : **rien ne doit être deviné**.

Deux voies, au choix de la compagnie :

1. **Recommandée** — la compagnie fournit la colonne `cabine` déjà normalisée en `J`/`W`/`Y`. Une colonne
   `classe_reservation` peut accompagner à titre de trace d'audit : elle est conservée telle quelle et ne sert
   jamais de source de tier. **Elle doit porter ce nom** (ou `rbd`, `booking class`, `fare class`) : `class` et
   `cos` sont des alias de `cabine`, et un fichier qui porte les deux est refusé pour en-tête en double.
2. **Repli — NON IMPLÉMENTÉ EN v1.** Prévu : à l'import, l'écran liste les lettres rencontrées
   (`C · D · S · M · K…`) et l'opérateur affecte J/W/Y à chacune en quelques clics. **Tant que ce repli
   n'existe pas, un fichier qui ne porte que des lettres RBD est refusé** (l'erreur nomme chaque valeur et
   le nombre de lignes concernées) : la compagnie doit fournir `cabine` en J/W/Y, ou le fichier doit être
   converti avant l'import. C'est le point à confirmer en priorité avec la compagnie (§7.1).

### 3.5 Colonnes écartées de la v1 (et pourquoi)

- **`nuits` par dossier** — le moteur de coût est entièrement bâti sur une durée globale ; une durée par
  dossier n'est pas une colonne, c'est une refonte. Le déroutement BKK n'en a pas besoin.
- **`langue`** — le comptoir imprime FR **et** EN pour tout le monde, à coût nul.
- ~~**`nationalite`**~~ — **arbitrage révisé en v2 (21/09), voir §3.3bis.** L'argument d'origine (« elle ne
  changerait rien au plan ») reste exact et le demeure : elle n'entre toujours dans aucune décision
  d'affectation. Ce qui a changé, c'est le livrable : la condition C3 demande des formulaires
  d'enregistrement par passager, et un registre d'hôtel exige nationalité et passeport. La colonne revient
  donc comme **optionnelle, à destination des fiches seulement**, avec le régime de protection qu'exige sa
  sensibilité.
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
- **fiches d'enregistrement (v2)** : combien sur combien seront complètes, quelles colonnes d'identité
  manquent et sur combien de lignes, passeports périmés, colonnes du fichier non reconnues ;
- **correspondances (v3)** : combien de dossiers À LOGER ont un budget de trajet calculable, combien n'en ont
  pas (« aucune contrainte de distance ne s'appliquera »), combien de dates ont été **inférées** d'un `HH:MM`
  seul, combien restent indéterminées, combien d'horaires ont été écartés et pourquoi ;
- rappel de la nuit retenue **en heure locale d'escale**.

**Règle d'arrêt opérateur** : si le rapport annonce J = 0 ou W = 0 sur une liste qui contient de la business,
ou 0 PMR sur une liste qui en contient, **on ne lance pas le run** : la nomenclature n'a pas été comprise.
**Règle jumelle depuis la v3** : si le rapport annonce « 0/n dossier(s) à loger calculables » sur une escale
où l'élargissement des couronnes est prévu, l'opérateur sait que **la répartition par priorité ne s'appliquera
pas** — tous les dossiers sont éligibles à la couronne la plus lointaine.

---

## 5bis. Ce que la liste alimente en aval : les fiches d'enregistrement (C3)

Le plan et la liste d'appel s'arrêtent au **dossier** ; un registre d'hôtel se remplit par **personne**.
`hai-admin-mcp/lib/fiches.mjs` fait la jonction et produit deux livrables par run :

| Livrable | Contenu |
|---|---|
| `fiches-<runId>.csv` | Une ligne par personne, 45 colonnes (`FICHE_COLS`) : identité, vol, nuit, hôtel, format de chambre, règlement, assistance, blancs marqués. Pour l'archivage et le tableur du desk. |
| `fiches-<runId>.html` | Le rendu **imprimable** : une fiche par page A4, regroupées par hôtel puis par dossier, avec page de garde (totaux par hôtel, mode d'emploi). Autonome, sans script ni ressource externe — double-clic, Ctrl+P. |

Le contenu de chaque fiche **varie selon le format de chambre** : bloc « qui dort où » et adulte responsable
du mineur pour une chambre famille ; nature de l'assistance, chambre accessible et transfert adapté pour un
PMR ; format de chambre retenu et barème applicable pour business / premium / éco. Les dossiers **non logés
et les escalades ont aussi leur fiche** — c'est précisément au comptoir qu'ils sont traités.

Deux marqueurs, jamais une valeur inventée : `[à remplir]` (le comptoir, l'hôtel ou le passager complète —
n° de chambre, signature) et `[non fourni]` (la compagnie ne l'a pas transmis — c'est le manque chiffré par
`fiches_incompletes`).

**Ce que l'outil ne fait pas** : aucune saisie en ligne par un agent sur le site d'un hôtel. INV-5 l'interdit
(aucune donnée passager dans un prompt d'agent) et c'est un arbitrage client non rendu. Les fiches sont des
documents papier pré-remplis, vérifiés et signés par le passager, saisis par l'hôtel.

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

**Ajouté le 21/09/2026 (v2, condition C3)** : sept colonnes d'identité optionnelles avec alias d'en-tête,
schéma zod par colonne et avertissement chiffré `fiches_incompletes` (§3.3bis) ; `dob`/`date of birth`
rendus à `date_naissance` au lieu d'être rabattus sur `age` ; âge déduit de la date de naissance et écart
âge/date signalé ; passeport périmé signalé ; colonnes non reconnues désormais annoncées
(`colonnes_ignorees`) ; module `lib/fiches.mjs` et ses deux livrables (§5bis). Branchement sur le pipeline,
le rapport, le serveur et l'UI : **vague suivante**, avec les tests dédiés.

**Ajouté le 21/09/2026 (v3, budget de trajet)** : deux colonnes de correspondance optionnelles
`vol_correspondance` / `heure_correspondance` avec alias d'en-tête, quatre formes d'horaire acceptées, règle
de datage de `HH:MM` seul **tranchée et avertie** (`correspondance_date_inferee`), fuseau explicité et jamais
converti en silence (`correspondance_fuseau`, `correspondance_offset`, `correspondance_utc`), horaires
impossibles écartés et nommés (`correspondance_anterieure`, `correspondance_lointaine`,
`correspondance_horaire`), croisement avec `destination_finale` (`correspondance_destination`), avertissement
chiffré `correspondance_absente` et compteur `compteurs.correspondance` au rapport. Option d'appel
**additive et facultative** `opts.escale` : sans elle, l'ingestion se comporte exactement comme en v2.
Le module **ne calcule aucun budget de trajet et ne convertit aucune distance en durée** — il fournit la
donnée, le calcul et la contrainte dure vivent ailleurs. Branchement sur le pipeline, le serveur et l'UI
(passage de la fiche escale et de l'heure d'arrivée à `ingestPassagers`) : **vague suivante**, avec les tests
dédiés.

**Reste à faire au 21/09/2026** (par ordre de valeur) : brancher `opts.escale` sur la CLI, le serveur et l'UI
(sans quoi tout `HH:MM` seul reste `indeterminee`) ; « 1 chambre par passager PMR » (§3.2, arbitrage non rendu :
l'appliquer déplace les chiffres de démonstration) ; déduction du transit à partir de `destination_finale`
(§3.2) ; écran de correspondance RBD → cabine (§3.4) ; `computeNeeds`
compte encore les dossiers hors plan, donc le dry-run surestime de quelques chambres le besoin à couvrir.
**LIVRÉS depuis** : purge des sorties nominatives (`policy.retention`, serveur), livrable « rooming list par
hôtel » (`rooming-<run>.csv`), fiches d'enregistrement (`fiches-<run>.csv` / `.html`).

Charge initialement estimée : **≈ 2,75 jours**, sans toucher au lecteur CSV actuel (verrouillé par des tests de
non-régression) ni au générateur de listes de démonstration.

| # | Travail | Charge |
|---|---|---|
| 1 | Nouveau module d'ingestion : normalisation des valeurs (zod + tables d'alias + codes `C00`–`C17` + jeu de SSR déclencheurs) appliquée **aux lignes**, quelle que soit leur source | 0,5 j |
| 2 | Lecture du fichier : BOM, UTF-8 strict, UTF-16, repli Windows-1252, parseur RFC 4180, détection de séparateur, alias d'en-têtes | 0,5 j |
| 3 | Branchements : téléversement, dry-run, CLI, UI (envoi des octets bruts et affichage du rapport complet) | 0,25 j |
| 4 | Moteur : jeu de codes PMR **(LIVRÉ)**, exclusion équipage / non-embarqués **avant** regroupement **(LIVRÉ)**, chambrage des familles nombreuses **(LIVRÉ)**, `chambres_demandees` **(LIVRÉ)** — **OUVERT : « 1 chambre par passager PMR », non implémentée** | 0,5 j |
| 5 | Sorties : motifs d'escalade nommés (droit d'entrée, mineur non accompagné, médical, équipage), colonne destinataire, avertissements d'ingestion dans le rapport | 0,25 j |
| 6 | Tests : un par règle de refus, un par règle d'avertissement, les deux fichiers d'exemple ingérés en entier | 0,5 j |
| 7 | Mise à jour du cahier des charges (§5.5) et du journal d'état | 0,25 j |

Deux points à arbitrer, **toujours ouverts au 21/09/2026** : appliquer « 1 chambre par passager PMR » déplace
les chiffres de démonstration publiés — tant que l'arbitrage n'est pas rendu, le document remis à la compagnie
(dictionnaire de colonnes, §3.2) dit que les PMR sont appariés comme des adultes ordinaires, et l'ingestion
émet « n dossier(s) PMR sans chambres_demandees » ; et aucune ligne hors plan passagers (équipage, exclusions)
ne doit entrer dans le plan, sous peine de faire échouer le calcul de coût en fin de run **(point traité)**.

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
2bis. **Correspondances (v3, §3.3ter)** — c'est la question qui décide si la répartition par priorité
   fonctionne ou non. L'export porte-t-il **l'horaire du vol suivant** ? Sous quelle forme exactement : date
   et heure, ou heure seule ? Dans **quel fuseau** — celui de l'escale de correspondance, l'UTC, ou le fuseau
   de la base ? Sans horaire, aucun budget de trajet n'est calculable et **aucune contrainte de distance ne
   s'applique** : tous les dossiers sont alors éligibles à la couronne la plus lointaine. Question jumelle :
   quelle **avance à l'enregistrement** et quel **repos minimal à l'hôtel** la compagnie retient à BKK (ce
   sont les réglages `policy.global.correspondance`, aujourd'hui 120 min et 240 min par défaut) ?
3. **Équipage** : figure-t-il dans le même fichier, sous quel code (PNT/PNC/DH/ACM), combien de personnes
   deadhead compris ? Avez-vous des hôtels sous contrat à BKK et une durée de repos minimale à garantir ?
4. **Droit d'entrée en Thaïlande** : l'export porte-t-il la nationalité ou le droit d'entrée ? Sinon, qui
   fournit l'information, dans quel délai, et quel est le canal d'escalade GHA à BKK ?
   **Question jumelle depuis la v2** : l'export porte-t-il **date de naissance, nationalité et numéro de
   passeport** (colonnes §3.3bis) ? C'est la seule question qui décide si l'agent d'escale recopie 324 fois
   un passeport à la main ou présente une fiche déjà remplie à signer. Si le DCS les porte mais que la
   diffusion est restreinte, quelle validation faut-il et sous quel délai ?
5. Disposez-vous d'un **contact par passager ou par dossier** (e-mail, téléphone) exploitable un jour de
   déroutement, ou la remise se fait-elle au comptoir ?
6. Les **groupes** sont-ils identifiables, et avez-vous la liste de chambrage de l'organisateur ?
7. Le record locator exporté est-il le vôtre ou celui de l'agence, et lequel apparaît sur un billet interligne ?
8. Utilisez-vous `CHD`, `CNN`, ou les codes à âge `C05`/`C11` ? Le nom est-il en un champ `NOM/PRENOM` ou en
   deux colonnes ?

---

## 8. Fichier d'exemple

Voir `data/exemples/paxlist-exemple.csv` : 28 lignes, **28 colonnes** — les 18 colonnes v1, `classe_reservation`,
les sept colonnes d'identité §3.3bis et les deux colonnes de correspondance §3.3ter. Le modèle à remplir et le
dictionnaire portent exactement les mêmes
28 colonnes (test de non-régression : `test/paxlist.test.mjs`). Les cas remarquables couverts — couple affaires, famille de 7 avec
bébé, `WCHC` avec accompagnante, `WCHR BLND`, no-show, passager autonome, mineur non accompagné, animal en
cabine, escalade médicale, groupe de 4, transit sans droit d'entrée, code enfant à âge `C05`, champ cité
contenant un point-virgule, et trois lignes d'équipage à clé individuelle.

**Identité (v2)** : 12 des 28 lignes portent les colonnes §3.3bis, les autres les laissent vides — le fichier
exerce donc les deux chemins. Il couvre aussi un numéro de passeport saisi avec des espaces (normalisé et
tracé), une nationalité en clair (« FRANCE », conservée et signalée hors format), un passeport périmé
(avertissement nommé) et un bébé sans document au dossier. **Toutes ces identités sont fictives.**

**Correspondance (v3)** : 5 des 14 dossiers portent un horaire, sous les quatre formes acceptées — ISO 8601
avec fuseau (`3KQW7P`, `2026-09-21T13:25+07:00`), `AAAA-MM-JJ HH:MM` (`5RBQ9D`), ISO 8601 sans fuseau
(`QN7V2X`), `AAAA-MM-JJ HH:MM` au surlendemain (`M5TK7B`, le groupe) et **`HH:MM` seul** (`8HFT2M`,
`05:40` — le cas piégeux, daté du lendemain quand l'heure d'arrivée est fournie). Les neuf autres dossiers
n'en portent pas : le fichier exerce donc les deux chemins, y compris les dossiers sans contrainte de
distance. Aucun horaire du fichier d'exemple n'est volontairement fautif — les cas fautifs (antérieur,
au-delà de 72 h, `0540`, indicatif hors gabarit) sont exercés par les tests, pas par le document remis à
la compagnie.

*Rappel d'état antérieur — avant le 19/09/2026 : passé à l'outil, ce fichier produisait un plan qui logeait le
no-show, le passager autonome, le mineur non accompagné, le passager sans visa et les trois navigants comme
des passagers ordinaires, ne reconnaissait aucun des deux PMR, et donnait 2 chambres à la famille de 7 — sans
un seul avertissement. C'est l'écart que cette spécification a supprimé.*

**État mesuré au 21/09/2026 (v3)** : les 28 lignes sont ingérées sans refus — 23 passagers à loger, 14 dossiers
dont **10 à loger**, 3 lignes d'équipage à chambre individuelle, 2 lignes exclues (no-show, autonome), les deux
PMR reconnus, le dossier sans droit d'entrée identifié.

Sans contexte d'escale (`ingestPassagers(bytes)`, le défaut) : **dix avertissements nommés** — passeport
périmé, nationalité hors format ISO, chambrage PMR deviné, SSR sans effet chambre, animal en cabine,
13 fiches incomplètes sur 23, identité partielle, **5 dossiers sur 10 sans horaire de correspondance**,
**2 horaires en `HH:MM` seul restés indéterminés**, **11 horaires sans fuseau** (fuseau d'escale non fourni).
Compteur : 12 lignes porteuses d'un horaire, 10 dates déclarées, 0 inférée, 2 indéterminées, 0 écartée.

Avec le contexte d'escale BKK (`{code: "BKK", timezone: "Asia/Bangkok", arrivee_locale: "2026-09-20T23:15",
offset_min: 420}`) : **neuf avertissements** — les deux `HH:MM` seuls sont datés au **21/09 à 05:40**
(lendemain) et l'avertissement `correspondance_date_inferee` remplace les deux avertissements de fuseau et
d'indétermination. Compteur : 10 dates déclarées, **2 inférées**, 0 indéterminée, 0 écartée.

**Écarts subsistants** : le chambrage PMR, qui reste à arbitrer (§6), et le branchement d'`opts.escale` sur la
CLI, le serveur et l'UI — tant qu'il n'est pas fait, tout `HH:MM` seul reste `indeterminee` et le budget de
trajet de ces dossiers n'est pas calculable.
