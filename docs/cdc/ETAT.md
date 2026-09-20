# ETAT.md — Journal d'état du projet

Ce fichier est la mémoire entre deux conversations Claude Code. Il est lu au début de chaque conversation et mis à jour à la fin de chaque phase. Il reste court : moins de 120 lignes. Les détails vont dans les fichiers de code et de tests.

## Phase courante

- Phase : hors phases — **chantier C1-C7 (conditions client)**, 21/09/2026. Phases 0 à 7 terminées.
- Statut : phase 7 **CLOSE le 16/09** (déploiement Scaleway `fr-par` 51.158.96.47 + run réel `mu3lnxm4` : 25 min, 17 sessions, ~2,5 $, 118 logés / 39 escalades — voir `docs/recette-demo-v2.md` §4 et §5). Ne PAS la rejouer.
- Dernier commit : `f0b5557 fix(sonde): la mesure de capacité plafonne le total de l'hôtel au lieu de s'y ajouter`. Arbre de travail non commité : chantier C1-C7 puis traitement de la relecture adverse.

## Fait

- Phase 0 (14/09) : pack CDC + POC v1 rapatriés (v1 intacte, INV-6) ; `npm ci` propre ; « Plans and limits » consignés.
- Phase 1 (14/09) — noyau pur : `lib/{csv,policy,scenario,passagers,dossiers,reglement,allocate,cout,messages,rapport}.mjs`, gabarits FR/EN, fixture `releves-demo.json`, seed 42 reproductible. Offline : 324 pax → 88 OK + 69 escalades.
- Phase 2 (15/09) — multi-escale hors ligne : `lib/stations.mjs` + `data/stations/{BKK,CDG,NOU}.json`, `lib/inventaire.mjs` + `data/inventaire/*.json`, `lib/hai-urls.mjs`, `tools/inventaire.mjs`.
- Phase 3 (15/09) — pipeline agents complet zéro session : `lib/hai.mjs` (SEUL module SDK, INV-7), `lib/{events,discovery,releve,capacite,pipeline}.mjs`, `tools/rebooking-v2.mjs` (payant derrière DEMO_ALLOW_PAID=1, INV-8).
- Phase 4 (15/09) — serveur, SSE, UI, simulation : `demo/{sse-hub,run-manager,session-pump,simulate,server}.mjs`, `demo/public/`, preset `politique-standard`, run simulé ~87 s (157 OK / 0 escalade), snapshot, 409, annulations.
- Phase 5 (15/09) — câblage réel et Étage 0 réel (la conversation s'est interrompue avant clôture ; commit rattrapé en phase 6) :
  - `demo/server.mjs` : run réel (`realCollect`) et Étage 0 par agents derrière `DEMO_ALLOW_PAID=1` côté serveur (sinon 501) ; proxy captures https avec bearer vers l'origine API seule (INV-4) + `imageType base64` ; `demo/inventaire-refresh.mjs` (refresher SSE, 409 croisé avec les runs).
  - `demo/session-pump.mjs` + `pumpToCompletion` : annulation RÉELLE (`handle.cancel()` sur abort) ; coût/steps par session agrégés depuis le flux (`discovery/releve/capacite`).
  - `ensureAgentV2` : patch du modèle si l'agent existe avec un autre (la politique est source de vérité) ; journal du point d'entrée EU au démarrage du client (H-6 exercée).
  - `lib/inventaire.mjs` : `reconcileIds` (fusion sans doublon par URL/nom) ; `tools/inventaire.mjs --refresh` : mesures §13 + archives `out/` + captures ; `tools/rebooking-v2.mjs` : `--probe-discovery/--probe-releve/--probe-capacity/--probe-inventaire`.
  - **Étage 0 réel BKK exécuté** (accord donné en phase 5 ; le processus s'est achevé pendant la conversation phase 6) : `data/inventaire/BKK.json` → 9 hôtels `source: agent`, `payment` + `capacity_hint` partout (critère ≥ 8 atteint). Mesures : 693 s, 11 sessions (1 découverte + 10 relevés courts), 0,99 $, 0 × 429, concurrence 3/3 (config 3, stagger 25 s), 10/10 schémas valides, 7 exploitables. Archives : `out/{candidats,inventaire}-mu2gsy9c.json`, `out/captures-mu2gsy9c/`. Une découverte avait échoué avant retry (`mu2goptp`).
  - Non joués (volontaire) : probes unitaires `--probe-releve`/`--probe-capacity` (H-3 non tranchée formellement, → run réel).
  - Complément commité après la recette (même journée, conversation phase 5 achevée) : `data/simulate/inventaire-reel-bkk.json` — les 7 relevés réels reformatés en fixtures §5.3 rejouables par `tools/inventaire.mjs --offline` (2 tests dédiés) — et les 4 PNG `demo/sim-assets/` remplacés par de VRAIES captures du run `mu2gsy9c` (résultats filtrés, fiche, tableau des chambres, paiement rognée hors bandeau cookies). La chorégraphie de simulation (`releves-demo.json`, `inventaire-demo.json`, 157/0 en ~90 s) reste inchangée.
- Phase 6 (15/09) — recette, doc, déroulé : `npm test` 159 verts (3 tests qui figeaient l'inventaire POC — `cli-v2`, `inventaire`, `pipeline` — dérivent désormais du fichier livré, l'inventaire réel les ayant invalidés) ; `--offline` conforme (88 OK + 69 escalades, inchangé : les fixtures pilotent) ; recette UI simulation complète consignée dans `docs/recette-demo-v2.md` (87 s, snapshot, 409, annulation propre, 501 INV-8 sans DEMO_ALLOW_PAID) ; README section « Démo v2 » ; `docs/matrice-affectation.md` v2 (tiers/surcouches/conformité/règlement/extension, v1 en annexe) ; `docs/deroule-demo.md` (8 étapes, plan B simulation, réglages, points à ne pas montrer), joué une fois en simulation sans accroc. **Run complet réel NON joué** (décision explicite de l'utilisateur) → reporté phase 7.

## En cours

- Rien. (Les tâches de fond du 15/09 — Étage 0 réel et rapatriement des captures — sont terminées : 98/99 captures sous `out/captures-mu2gsy9c/`.)
- 19/09 (hors phase) — **ingestion de la liste passagers compagnie : spécifiée PUIS implémentée**.
  - Spécification `docs/format-liste-passagers.md` (PAXLIST v1) + modèle vierge, dictionnaire et exemple sous `data/exemples/` ; `data/paxlist*.csv` au `.gitignore` (une liste réelle ne se commite jamais).
  - Implémentation : `lib/paxlist.mjs` (décodage BOM/UTF-16/repli windows-1252, parseur RFC 4180 borné, détection de séparateur, alias d'en-têtes et de valeurs, codes `C00`–`C17`, schéma zod par ligne, rapport d'ingestion bloquant), branchée sur l'UI, la CLI (`--in`) et le pipeline. Moteur : PMR sur l'ensemble des codes SSR (et non le seul `WCHR`), escalades nominatives (civière/médical/UMNR), droit d'entrée (refusé = hors plan, INCONNU = logé **sous réserve**), `chambres_demandees` prioritaire sur le chambrage calculé, motif d'escalade « accessibilité », contrôle des couchages, colonnes `pax`/`hotel_url`/`hors_plan`/`sous_reserve`, section « Liste passagers » dans le rapport, variante de message **hors plan** (un passager sur civière n'est plus convoqué au comptoir), verrou du lancement après refus de liste.
  - **Testé sur la liste réelle de la compagnie** (324 passagers, format PAXLIST) : ingestion 324/324 sans refus, 238 dossiers, J 34 / W 24 / Y 266, 8 PMR, 4 escalades nominatives, 8 sans droit d'entrée. Run simulé complet : **232 logés / 6 escalades** (les 6 hors plan). Rejeu hors ligne : 101 logés / 137 escalades (fixtures à 2 hôtels exploitables). `npm test` : **185 verts** (161 d'origine + 24). Références de démo inchangées : 88/69 hors ligne (désormais verrouillé par test), 157/0 en simulation.
  - Reste ouvert (§6 de la spéc) : écran de correspondance RBD → cabine (un export DCS qui ne porte que des lettres est refusé), `computeNeeds` compte encore les dossiers hors plan, purge des sorties nominatives après séance.
- 20/09 (hors phase) — **lot « prêt pour le run réel »** :
  - **Sonde de capacité corrigée** : `rooms_selectable_max` est un maximum d'HÔTEL, désormais appliqué comme supplément PARTAGÉ entre les types plafonnés (`lib/capacite.mjs` + `lib/allocate.mjs`). Avant, il était recopié sur chaque type : 23 chambres réelles étaient annoncées 90. La chorégraphie de démo retrouve 157/0 avec `SIM_PROBE_MAX` 30 → 40.
  - **Allocation en DEUX PASSES** (`lib/allocate.mjs`) : tout le monde dans le barème d'abord, dérogation de prix ensuite et seulement pour les non logés, y compris chez un hôtel CONFORME. Avant, un hôtel conforme refusait ses chambres au-dessus du plafond alors qu'un hôtel hors barème les offrait toutes : **monter le plafond Y de 80 à 150 € faisait tomber le plan de 157 à 62 dossiers logés** — or c'est LE levier de séance. Après correction : 157 logés de 60 à 200 €. Référence hors ligne : 88/69 → **90/67** (deux dossiers de plus logés par dérogation), assertion mise à jour.
  - **Fuseau de l'escale** (`lib/scenario.mjs`) : la nuit est datée à Bangkok, plus sur l'horloge du serveur (`resolveDates(scenario, now, timezone)`, `stationClock`). Déterminant : la date/heure du test sera confirmée le jour même depuis un poste hors BKK.
  - **Pré-vol des fiches** (`lib/preflight.mjs`, `tools/inventaire.mjs --preflight`, injecté dans le run réel) : contrôle HTTP gratuit, aucun agent. Verdict ferme seulement sur 404/410 et redirection vers un autre établissement ; 403/429/202/timeout restent indéterminés. Depuis ce poste le réseau est intercepté (202 partout) : **à rejouer depuis la machine du run**.
  - **Rejeu gratuit** `POST /api/replay` : rejoue l'allocation sur les relevés déjà payés (« et si on montait le plafond Y ? » sans repayer 25 min et 2,5 $). **`GET /api/health`** : clé présente, longueur, empreinte, quota H — l'incident du 16/09 (clé tronquée) coûtait 10 min de séance.
  - **7e livrable** `rooming-<runId>.csv` : liste d'appel PAR HÔTEL avec totaux chambres/personnes + section « À appeler » du rapport. Sur la liste réelle : Hyatt 99 ch./138 pers., Divalux 26/46, Canalis 3/3.
  - **Alerte de couverture** au dry-run (CLI et UI) : « 12 candidats — capacité indicative ~85 chambres pour un besoin de 253 ». **C'est le point bloquant du run réel : l'inventaire BKK ne peut pas couvrir 324 passagers.** `divalux-resort-spa-bkk` exclu (404 du 16/09) ; `data/stations/BKK.json` inchangé (ses replis servent la démo).
  - `npm test` : **194 verts**.
  - **Relecture adverse du 20/09 (11 constats confirmés, tous traités)** :
    - **Sonde = PLAFOND, pas supplément.** Le maximum sondé était ADDITIONNÉ aux quantités affichées : la liste d'appel demandait 139 chambres là où la sonde payante en avait mesuré 40. Désormais `cap_reached` porte la sémantique — sélecteur non plafonné = mesure FERME (le total pris chez l'hôtel ne peut pas la dépasser, même à la baisse), sélecteur encore plafonné = borne BASSE (on retient le plus favorable entre affichage cumulé et mesure). Valeur invraisemblable bornée par `probe_no_rooms_max` avec avertissement.
    - **Conséquence assumée : la chorégraphie de démonstration passe de 157/0 à 122 logés / 35 escalades** (motif « capacité »). Le 157/0 reposait sur le sur-comptage. Fixture alignée : `SIM_PROBE_MAX` 30 (ce que le pipeline demande) et `cap_reached: true`. Pour retrouver une démo sans escalade, il faut enrichir `data/simulate/inventaire-demo.json` (2 hôtels de plus), pas rétablir le bug.
    - **Pré-vol : le filet pouvait vider l'inventaire.** `hotelSlug` prenait le suffixe de langue Booking (`.en-gb`, `.zh-cn`) pour un autre hôtel → toutes les fiches « redirigées », 0 logé sans qu'aucun agent ne tourne. Corrigé ; le pipeline n'écarte plus que les fiches `morte` (404/410), les « redirigées » sont conservées et reléguées en fin de liste, et un **plancher** annule tout filtrage au-delà du tiers des candidats.
    - **Dépassement de plafond affiché sur la chambre ALLOUÉE** et non sur la moins chère de l'hôtel : 6 700 €/nuit d'écart étaient masqués. Sur la vraie liste : 61 lignes hors barème, 10 581 €/nuit annoncés.
    - **Rejeu** : refuse désormais de comparer deux listes différentes (empreinte non nominative `pax-<runId>.json` écrite à côté des relevés) — il répondait « 157 logés / 0 escalade » sur une liste fictive là où la vraie donnait 176/62. **Health** lit la clé par `readApiKey()` (donc aussi `~/.config/hai/.env`) : il annonçait « clé absente » sur une installation qui marche.
    - Reste ouvert (mineur, mesuré) : la monotonie du plafond n'est pas totale sur les relevés de référence (105 → 103 entre 140 et 150 €), parce que le plafond change aussi le classement des hôtels (`headroom` dans le score). À traiter en sortant `headroom` de la clé de tri.

- 21/09 (hors phase) — **chantier C1-C7 (7 conditions client), puis traitement de la relecture adverse**.
  - **C1** recherche pilotée par la saisie · **C2** chambres pour la TOTALITÉ des passagers · **C3** fiches de saisie par passager selon le format de chambre · **C4** remplacer une équipe d'escale · **C5** réserver en moins d'une heure (budget d'horloge du run) · **C6** répartition validée par un humain · **C7** règlement par cartes prépayées.
  - Modules créés : `lib/fiches.mjs` (C3). Routes : `POST` / `GET /api/validation` (C6), `POST /api/retention-purge`. Livrables portés de 7 à **9** : `fiches-<run>.csv` et `fiches-<run>.html` (une fiche par personne, imprimable A4).
  - Tests ajoutés : `conditions-c1-c2`, `conditions-c3`, `conditions-c5-c7`, `conditions-c6`, `creneaux-presentation`, puis `chiffres-merites` et `allocate-monotonie` (relecture adverse).
  - **Relecture adverse traitée le 21/09** — corrections, toutes sur le même fil rouge « aucun chiffre rassurant qui ne soit mérité » :
    - **Message passager** : la variante se choisit sur la certitude de la LIGNE (`stock_mesure`, `chambres_a_confirmer`, `couchages_insuffisants`), plus sur le drapeau de RUN `provisoire`, faux pour toutes les lignes en fin de run. 179 personnes recevaient « une chambre vous est attribuée, la réservation est en cours de confirmation avec l'hôtel » pour un stock jamais mesuré, chez un hôtel que personne n'avait appelé. La phrase « réservation en cours de confirmation » est retirée des gabarits FR et EN : elle décrivait un échange qui n'a pas eu lieu (INV-1). Mesure : 0 message affirmatif sur le rejeu, 79 dossiers en variante « provisoire ».
    - **`summary.complet`** exige désormais que PERSONNE ne reste sans chambre, hors plan hôtel compris, et une réserve nommée sort pour les dossiers hors plan. Un plan dont tous les non-logés étaient hors plan (civière, médical, mineur seul) se déclarait « complet » et l'écran C6 écrivait « tous les dossiers sont logés ».
    - **Coût agents non rapporté** : `events.mjs` propage `null` au lieu de `0` (`totalCost`, `steps` et `costPerModel` sont optionnels sur le flux). Le `null` traverse relevés, sondes, découverte, pipeline, bandeau et rapport (« non mesuré ») ; l'extension **s'arrête** sur « coût NON MESURÉ — budget non contrôlable » au lieu de courir sans frein sous `max_cost_usd_per_run`.
    - **Coût du plan** : `per_night` reste `null` quand AUCUN prix n'est lisible, au lieu de « 0 EUR ». Le coût agents du rejeu hors ligne est libellé en dollars, comme la borne.
    - **Colonnes C7** : `{ cost }` est passé à `buildPlanCsv` et `buildRoomingCsv` — les quatre colonnes de carte prépayée étaient vides sur 100 % des lignes ; `carte_incomplet=oui` sort désormais sur les 15 cartes incomplètes du rejeu, et la liste d'appel porte enfin adresse et téléphone quand le relevé les donne.
    - **Créneaux de convocation** : l'occupation RÉELLE par créneau est calculée et imprimée (min, max, série). « 32 dossiers par créneau » était une capacité, pas une répartition : 8 × 32 = 256 pour 157 dossiers convoqués.
    - **Concentration par hôtel (UI)** : « 0 ferme(s) / 0 À CONFIRMER » remplacé par « ventilation indéterminée » quand le résumé ne porte pas les compteurs — la cellule voisine le disait déjà, celle-ci la contredisait.
    - **Bandeau de run** : coût, tokens et pas démarrent à « — » et non à « 0,00 $ / 0 / 0 ».
    - **Fiche d'inventaire** : `capacity_hint.rooms_displayed_max` (maximum PAR TYPE) ne borne plus le total d'un hôtel. La branche était morte en production ; alimentée, elle aurait divisé le plan par deux sur l'inventaire BKK réel en présentant l'écart comme une « capacité MESURÉE ».
    - **Rétention RGPD** : les trois purges (démarrage du serveur, fin de run, bouton manuel) obéissent à la politique du DERNIER RUN LANCÉ, plus à `DEFAULT_POLICY` ; le seuil ET sa provenance sont écrits dans `out/retention.log` et dans le bilan ; un `statSync` en échec est compté et nommé au lieu de disparaître des deux compteurs ; un journal non écrit lève un avertissement au lieu d'être avalé ; un journal de validation présent mais illisible fait échouer l'écriture (500) au lieu de repartir à `seq = 1` ; `NOMINATIF_RE` ne porte plus l'entrée morte du rapport.
    - **Alias d'en-tête** : `class` et `cos` étaient annoncés au dictionnaire comme alias de `classe_reservation` alors qu'ils sont alias de `cabine` — un export DCS qui suivait le dictionnaire à la lettre était refusé en bloc, zéro ligne ingérée. Le dictionnaire est corrigé, la collision d'alias est interdite à l'import, le message d'erreur nomme le remède, et `classe_reservation` est désormais réellement conservée comme trace d'audit.
    - **Jeu de fichiers remis à la compagnie** : modèle, exemple et dictionnaire portent les mêmes 26 colonnes, verrouillé par test.
  - **Restent OUVERTS, arbitrage à rendre** : « 1 chambre par passager PMR » (non implémentée ; les documents sont alignés sur le code et l'ingestion émet `pmr_chambrage_devine`) · déduction du transit depuis `destination_finale` (colonne collectée, validée, sans consommateur ; documents alignés) · écran de correspondance RBD vers cabine · sort du `rapport-<run>.md`, classé nominatif mais volontairement NON purgé · `couvrirCouchages` (levier C2 écrit et testé qu'aucun appelant n'active) · protection du run courant à la purge par sous-chaîne plutôt que par égalité (sous-suppression, jamais suppression de trop) · **monotonie du levier « plafond »** : la mesure la dément (87 puis 83 dossiers logés quand le plafond Y monte de 50 à 70 EUR, à nombre de chambres constant), le commentaire qui l'affirmait est retiré et un test de caractérisation fige la mesure (`test/allocate-monotonie.test.mjs`).

- 21/09 (hors phase, second chantier de la journée) — **politique de prise en charge et couronnes de distance**.
  - **Question posée par l'utilisateur** : le vivier proche ne couvre pas 324 passagers — peut-on élargir la distance et répartir les hôtels selon la priorité des passagers (correspondance et son horaire, famille avec bébé, etc.), réglée par des cases à cocher ?
  - **Trois constats préalables** : `fileOf()` était FIGÉ (`pmr → famille → cabine`) et le champ « priorités » de l'UI était un texte libre **sans effet** — tout autre mot était ignoré en silence ; la distance n'entrait que dans un score de tri, **jamais dans l'affectation** ; et la donnée n'existait pas (ni vol de correspondance, ni horaire).
  - **Décision d'architecture (validée par l'utilisateur)** : l'horaire du vol suivant sert de DEUX façons, et c'est la seconde qui protège. Le **rang** décide de l'ordre de service ; le **budget de trajet** `dossier.trajet_max_min` est une **CONTRAINTE DURE** qu'aucun rang n'outrepasse. Un rang seul ne protège personne : si les PMR sont servis d'abord et épuisent le vivier proche, le passager qui repart à 05h40 finit à 40 km. Formule : `(fenêtre − avance_avant_vol − marge − repos_minimal) / 2` (aller ET retour) ; budget ≤ 0 → escalade « correspondance trop serrée » (repos côté piste) ; **pas d'horaire = aucune contrainte, jamais de budget inventé**. Le dossier porte une `explication` en toutes lettres, pour qu'un agent d'escale puisse contester le calcul.
  - **Les temps de trajet des couronnes sont DÉCLARÉS dans la fiche escale, jamais mesurés** (décision validée) : l'outil n'a aucun service de routage et **ne convertit pas une distance en durée**. Étiquetés « déclarés, non mesurés » partout où ils s'affichent. `station.search.couronnes[]` + helper `couronnesDe(station)` qui distingue `declaree` de `derivee`. BKK 5/15/40 km · CDG 5/15/40 km · NOU 15/45/60 km.
  - **Livré** : `policy.global.prise_en_charge` — **13 critères cochables** (`CRITERE_KEYS`), chacun avec `rang`, `proximite` (stricte/préférée/aucune) et `departage` ; `policy.global.correspondance` (avance 120 min, repos minimal 240, marge 30, seuil « serrée » 480) ; **PAXLIST v3** (28 colonnes : `vol_correspondance`, `heure_correspondance`, règle de datage d'un `HH:MM` seul tranchée et avertie, fuseau jamais converti en silence) ; contrainte de couronne appliquée à l'allocation avec traçabilité (`couronne`, `couronne_source`, `couronne_trajet_min_declare`, `trajet_max_min` au plan) ; recherche **par couronne**, ouverte seulement si elle sert ; restitution par couronne au rapport, aux fiches (heure limite de retour à l'aéroport) et à l'écran de validation ; l'UI remplace le champ texte par les cases à cocher et explique rang contre proximité.
  - **Correctifs de fond de la recette** : `Date.parse` n'est plus appelé que sur une forme vérifiée (« 9999 » rendait un budget de 2 096 506 840 min sans avertissement, donc un dossier réputé libre d'aller à 40 km) ; une fenêtre aberrante est bornée à 72 h là où le budget se calcule ; le message passager porte enfin l'heure limite de retour que la fiche imprimait déjà. **Câblés après coup** : `couronne` entre au `HotelEntrySchema` (zod la retirait à l'écriture, le marquage ne survivait pas au run) et `contexteEscale()` est passé à `ingestPassagers` par la CLI **et** par le serveur (sans lui, les contrôles de plausibilité ne tournaient jamais).
  - `npm test` : **302 verts / 13 suites** (dont 24 cas neufs), y compris le test qui protège tout le dispositif : *un dossier à budget court servi EN DERNIER obtient quand même la couronne 1, ou sort en escalade « temps de trajet » — jamais un hôtel hors budget.*
  - **La réponse honnête, que le dry-run imprime seul** : élargir la distance **ne suffit pas** à BKK. Les trois couronnes ouvertes, le vivier reste à **85 chambres indicatives pour 173 demandées**. La politique décide QUI va loin et qui n'en a pas le droit ; elle ne fabrique pas les chambres manquantes. Et le premier chiffre affiché est **pessimiste** : 11 des 12 candidats n'ont aucune distance mesurée et sont rattachés à la couronne la plus lointaine PAR PRUDENCE — la réponse est de relever les distances, pas de toucher au code.
  - **Restent ouverts sur ce lot** : datage d'un `HH:MM` seul plafonné à +24 h (erreur dans le sens prudent, annoncée) · le dry-run des deux CLI affiche les passes ordinaires et non les passes par couronne (sous-estime, ne rassure pas) · `tools/rebooking-v2.mjs:741` (chemin payant `--probe-releve`) appelle `buildDossiers` sans horloge d'escale, sans conséquence sur le plan.

## Décisions prises

- Reconstruction v2 par phases ; `data/` et `out/` à la racine ; script `test` : `node --test "hai-admin-mcp/test/**/*.test.mjs"`.
- Découverte SANS `start_url` override (écart §6.2) ; relevés/sondes : override conservé. `pumpToCompletion` dans `lib/hai.mjs` ; sessions non terminales fermées après réponse.
- L'extension ne compte que ses propres sessions ; `plan_row` réémis à chaque réallocation (l'UI remplace par pnr).
- Phase 4 — simulation : fixtures + 3 réponses scriptées (`SIM_ANSWERS`) ; sonde Hyatt (30) + relevé Amaranth vague 1 → 157 OK / 0 escalade ; run simulé sur `data/simulate/inventaire-demo.json`, onglet Inventaire sur `data/inventaire/{CODE}.json` (compteurs différents assumés).
- Phase 4 — sécurité : captures par `{hotel_key, seq}` résolues serveur (`Cache-Control: private`), CSP `default-src 'self'` ; `sim_speed` hors schéma ; liste téléversée en mémoire process.
- Phase 5 — H-9 : les ids de MODÈLE sont `holo3-122b-a10b` (le plus capable, agents A/B) et `holo3-1-35b-a3b` (classe flash, sonde) — `h/web-surfer-*` sont des AGENTS ; un modèle inconnu fait échouer la session à 0 step. Défauts de `DEFAULT_POLICY.agents` réglés ainsi ; `ensureAgentV2` réaligne par patch.
- Phase 5 — bearer relayé UNIQUEMENT vers l'origine `apiOrigin()` (redirection S3 suivie sans Authorization) ; garde INV-8 déplacée côté serveur (`DEMO_ALLOW_PAID=1` au démarrage).
- Phase 6 — fixtures de simulation VOLONTAIREMENT inchangées (calibrées pour le plan B de démo : 157/0 en 90 s) ; les sorties réelles restent archivées sous `out/` (non commitées), l'inventaire réel BKK est commité (aucune donnée passager). « Probes réels archivés comme fixtures » (§12.3 p.4) est couvert par BKK.json + archives `out/` — et, depuis le complément phase 5, par `data/simulate/inventaire-reel-bkk.json` (fichier SÉPARÉ : la chorégraphie de démo n'en dépend pas).
- Phase 6 — clôture en DEUX commits : `feat(phase-5): câblage réel, inventaire BKK réel, probes` (rattrapage, sans « fixtures réelles » — non faites), puis `docs(phase-6): recette, README, déroulé de démo` + tag `demo-v2-recette` (commit → tag → push, l'ordre littéral de la fiche taggerait l'avant-commit).
- Run réel : lancé uniquement sur accord explicite dans la conversation, `DEMO_ALLOW_PAID=1` pour la commande seule (INV-8) — non joué en phase 6, à jouer en phase 7 (répétition générale, fiche : un run simulé + un run réel distant).

## Écarts d'arborescence vs CDC §4

- En plus : `hai-admin-mcp/package-lock.json` ; `out/*` (local, ignoré) ; `test/helpers.mjs` ; `test/phase0.test.mjs` ; `lib/hai-urls.mjs` ; `lib/pipeline.mjs` ; `demo/sim-assets/*.png` (4 captures RÉELLES depuis la ph. 5) ; `demo/inventaire-refresh.mjs` ; `data/presets/politique-standard.json` ; `data/simulate/inventaire-reel-bkk.json` ; `docs/{recette-demo-v2,deroule-demo,format-liste-passagers}.md` ; `data/exemples/paxlist-*.csv` ; dry-run via `POST /api/run {dry_run:true}`.
- `hai-admin-mcp/package.json` : `main`/`bin` → `src/server.mjs` absent (référence morte assumée, POC intact).

## Environnement (H-8, relevé le 14/09)

- Windows 11 Famille (10.0.26200) ; PowerShell ; Node v22.23.2 ; npm 10.9.8 ; `hai-agents` 1.0.7 ; `zod` 4.5.4 (sous `hai-admin-mcp/`).

## SDK hai-agents 1.0.7 (TS) — repères (H-6)

- `new HaiAgentsClient({apiKey, environment})` — EU : `HaiAgentsEnvironment.Eu` = `https://agp.eu.hcompany.ai` (origine SANS `/api/v2`), câblée dans `createClient()` avec journal au démarrage ; seul `HAI_API_KEY` est lu automatiquement (sinon `~/.config/hai/.env`).
- `startSession → SessionHandle` ; `stream({until})` / `waitForCompletion({answerSchema})` / `cancel` ; `AnswerValidationError`, `isTerminalSessionStatus` ; événements traduits dans `lib/events.mjs` ; `createAgent/patchAgent` champ `model`.

## Hypothèses `[À CONFIRMER]` — consolidation (phase 6)

| Id CDC | État au 15/09 | Reste à faire |
|---|---|---|
| H-1 | validée 14/09 — `company_payment_possible` dans `lib/reglement.mjs` | — |
| H-2 | bornes 18 / 4 vagues / 10 $ éditables (fixées 14/09) | — |
| **H-3** | sonde câblée + simulée ; indice réel : Hyatt `rooms_displayed_max 9, cap_reached true` (relevé du 15/09) | **restante** : à trancher sur run réel (phase 7) ; si non concluante → `probe_same_hotel_first=false` + note |
| H-4 | péremption 30 j, référence J+14 1 nuit (éditables) | — |
| H-5 | NOU navette 75 min ; CDG facteur 1.0 (valeurs de départ éditables) | — |
| H-6 | point d'entrée EU exercé en réel le 15/09 (journal client + sessions abouties) | — |
| **H-7** | `allowances` null → « non renseigné » + `not_determinable` (aucun montant fixé) | **restante** (choix produit) : montants à saisir dans l'UI si la compagnie les fixe |
| H-8 | environnement relevé (14/09) | — |
| **H-9** | concurrence : plan sans limite → auto plafonné 6, repli 3/25 s ; modèles MESURÉS le 15/09 (`holo3-122b-a10b`, `holo3-1-35b-a3b`) | **restante** (partiel) : concurrence 6 à observer sur un run complet réel (l'Étage 0 tournait à 3 volontairement) |

## Points bloquants

- **L'inventaire BKK ne peut pas couvrir 324 passagers.** Mesure du 21/09 (`--dry-run`) : **85 chambres indicatives pour 173 demandées**, 12 candidats au vivier. Le run sort « épuisé » et escalade. Contournements : `tools/inventaire.mjs --station BKK --refresh --max 20` (payant, INV-8), ou « Forcer la découverte ». Rien ne corrige cela côté code : c'est un manque de vivier, pas un défaut du moteur.
- Conséquence directe : **aucun chiffre de démonstration « sans escalade » n'est atteignable** sur l'inventaire actuel. Toute communication qui annonce « tous les passagers logés » est fausse.

## Valeurs lues sur le compte H (14-15/09)

- Concurrence : sans limite plan → `auto` plafonné à 6, repli 3/25 s sur 429 (§16). Modèles agents : ids réels ci-dessus (H-9). Quotas : 60 M tokens inclus. Étage 0 réel : 0,99 $ / 11 sessions / 693 s.

## Vérification

**Mesuré le 21/09/2026**, chemins GRATUITS uniquement — aucune session d'agent, aucun run réel (INV-8) :

- `npm test` : **278 cas, 0 échec** (13 fichiers de suites)
- `rebooking-v2 --offline data/simulate/releves-demo.json` : **90 dossiers logés / 67 en escalade**, 128 chambres dont **29 FERMES et 99 À CONFIRMER**, 16 dossiers logés sans couchage suffisant, 15 cartes prépayées incomplètes, **8 fichiers écrits** (la découverte est sautée hors ligne), 0 session, 0,00 $
- `rebooking-v2 --dry-run` : couverture **85 chambres indicatives pour 173 demandées** — 315 personnes à coucher (hors 9 nourrissons, 324 à bord), 157 dossiers, 12 candidats. **Couverture INSUFFISANTE, dite comme telle.**
- Simulation complète (`createRunManager` + `createSimulation`, serveur sans `DEMO_ALLOW_PAID`) : **122 logés / 35 escalades**, coût **26 569 €/nuit** (J 5 405 + W 1 552 + Y 19 612), borne haute **32 900 €**, **9 livrables**, `summary.complet = false` avec 4 réserves nommées
- `git diff --stat -- data/inventaire/` : **vide** (fichier versionné non touché)
- Recette UI simulation (15/09, navigateur) : `docs/recette-demo-v2.md` §2 — **chiffres périmés**, encadré ajouté en tête
- Run complet réel : **JOUÉ le 16/09** (`mu3lnxm4`, recette §4)

## Prochaine phase

- **Les phases 0 à 7 du CDC sont terminées** (phase 7 close le 16/09). Il n'y a plus de fiche de phase à ouvrir.
- Travaux suivants, par ordre de valeur : (1) **élargir le vivier BKK** — seul point bloquant ; (2) rendre le tri de `rankedFor()` indépendant du plafond, pour que le levier de séance soit sûr ; (3) arbitrer « 1 chambre par PMR » et le sort du rapport nominatif ; (4) écran de correspondance RBD vers cabine.
- Avant toute clôture : `git fetch`, relire ce fichier, compléter sans écraser (plusieurs conversations commitent dans ce dépôt).
