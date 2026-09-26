# Approvisionnement du vivier hôtelier — agents Holo contre API LiteAPI

**Date : 26 septembre 2026.** Dépôt à `90fc351` (fusion LiteAPI dans `main`), 332 tests verts.
Toutes les mesures citées ici viennent de chemins **gratuits** ou de runs consignés ; aucune n'a été
produite pour les besoins de ce document.

Ce document répond à une question posée telle quelle : *« quelle est la plus-value des agents Holo
maintenant que LiteAPI existe ? »* Elle mérite d'être tranchée, parce que les agents sont le poste de
coût variable de l'outil et qu'ils avaient été construits pour un rôle que l'API remplit mieux.

---

## 1. Ce que chaque source produit réellement

Les deux alimentent **le même moteur** : elles rendent la même forme de relevé (`answer`, schéma v2),
consommée par `fixturesCollect()`. L'allocation, les couronnes, la politique de prise en charge, la
validation humaine et les neuf livrables sont identiques. **Seule la provenance des chambres change.**

| | Agents Holo | LiteAPI |
|---|---|---|
| Hôtels atteints sur BKK | **12** (inventaire du 21/09) | **185** en un appel |
| Durée | 998 s (Étage 0, 8 relevés) · ~25 min (run complet) | **7 s** |
| Coût | 1,68 $ (Étage 0) · ~2,50 $ (run complet, 17 sessions) | **0 $** |
| Plafond de quantité | **9 par hôtel** — plafond du sélecteur Booking | ~10 créneaux servis ; 12 refusé |
| Distance exploitable | **4 fiches sur 12** (2 `0` signifient « non mesuré ») | **40 sur 40**, calculée depuis les coordonnées, avec `distance_ref` |
| Mode de règlement | observé hôtel par hôtel | `prepayment_online: "oui"` — structurel au canal |
| Équipements | **observés** sur la page | **déclarés** par l'hôtel (identifiants de fiche) |
| Preuve visuelle | **156 captures** horodatées (Étage 0 du 21/09) | aucune |
| URL de fiche hôtel | **oui** | `url: ""` |
| Dépendance | le web public | **un fournisseur unique** |

### Le plafond de 9, cause racine du point bloquant

Le sélecteur de quantité des plateformes grand public **plafonne à 9 chambres par hôtel**. Les
111 chambres indicatives de l'inventaire BKK, ce sont 12 hôtels multipliés par ce plafond — pas une
mesure du stock réel de Bangkok.

Aucune optimisation du code d'agent ne pouvait lever cela : c'est une limite de la page, pas de l'agent.
C'est la raison d'être de LiteAPI dans ce projet, et elle est solide.

### La capacité se MESURE, elle ne se lit pas

Ni l'un ni l'autre ne lit une quantité. LiteAPI ne publie **aucun champ de stock** (vérifié : ni
`allotment`, ni `available`). La capacité s'obtient en **demandant N chambres** et en comptant ce qui
est servi : `rates[].occupancyNumber` côté API, réponse du sélecteur côté agent.

D'où la sémantique commune, déjà en place dans le moteur :

- un type qui sert **tous** les créneaux demandés est une **borne basse** — stock « à confirmer » ;
- un type qui en sert **moins** est une **mesure ferme**.

---

## 2. Le chiffre qui circule et qu'il faut corriger

`docs/cdc/ETAT.md` porte cette comparaison :

> **171 dossiers logés / 24 en escalade · 288 personnes sur 324** (contre 122/35 en simulation sur les
> 12 hôtels)

**Elle n'est pas à périmètre égal, et elle surestime l'écart.** Les deux mesures ne portent pas sur la
même liste :

| | Liste | Dossiers | Logés | Taux | **Personnes logées** |
|---|---|---|---|---|---|
| Simulation (12 hôtels) | générée | 157 | 122 | 78 % | **289 / 324** |
| LiteAPI | réelle SB800 | 195 | 171 | 88 % | **288 / 324** |

Sur la mesure qui compte pour la condition C2 — **combien de passagers dorment dans un lit** — les deux
sont à **égalité** : 288 contre 289. L'écart apparent en dossiers vient de ce que les deux listes
groupent différemment les mêmes 324 passagers.

Ce n'est pas un détail de présentation. La règle du projet est qu'aucun chiffre rassurant ne s'affiche
sans être mérité ; elle vaut aussi pour les chiffres qui arrangent une conclusion par ailleurs juste.

**Et surtout : il n'existe aucune comparaison à périmètre égal.** Le chemin par agents n'a jamais été
joué de bout en bout sur la liste réelle avec le code actuel — la tentative du 25/09 (`muavoza5`) est
tombée sur un défaut de schéma depuis corrigé. Tant que ce run n'a pas eu lieu, l'avantage de LiteAPI
sur le *résultat du plan* reste **non démontré**. Ses avantages sur le coût, la durée, le nombre
d'hôtels et la distance, eux, sont mesurés et ne dépendent pas de cette comparaison.

---

## 3. Ce que LiteAPI fait mieux

**Il casse le plafond de 9.** C'est la seule voie identifiée pour lever le point bloquant « vivier
insuffisant », et elle est structurelle, pas incrémentale.

**Il règle la distance à la racine.** Les agents lisent une distance *affichée*, absente ou fausse sur
8 fiches BKK sur 12 — dont deux `0` qui signifient « non mesuré » et non « à l'aéroport ». LiteAPI rend
des coordonnées, donc une distance **calculée qui porte sa référence**. Conséquence directe sur les
couronnes : un hôtel réellement à 1,8 km cesse d'être expédié par prudence en couronne la plus lointaine.

**Il paie en ligne.** `prepayment_online: "oui"` est structurel sur ce canal de distribution. Le mode de
règlement « compagnie » devient la norme au lieu d'être à confirmer établissement par établissement.

**Il ne coûte rien et ne prend rien.** 0 $, 7 s. À ce prix, la question du budget d'agents cesse d'être
un sujet d'arbitrage.

---

## 4. Ce que les agents font, et que LiteAPI ne fait pas

**Ils atteignent ce que le distributeur ne référence pas.** LiteAPI ne connaît que ses partenaires. Un
hôtel absent de son catalogue est invisible pour lui. Les agents lisent n'importe quelle page publique,
et la source `maps` atteint même les établissements présents sur aucune plateforme — avec leur téléphone.

**Ils observent au lieu de lire une déclaration.** Les équipements LiteAPI viennent des identifiants
**déclarés par l'hôtel**. Un agent regarde la page. Sur l'accessibilité PMR, l'écart n'est pas théorique :
entre « l'hôtel a coché accessible » et « la page montre une chambre accessible », il y a la différence
entre un passager logé et un passager bloqué à la réception.

**Ils produisent des preuves.** 156 captures horodatées au dernier Étage 0. En cas de contestation sur un
prix affiché, vous avez l'image de la page. LiteAPI rend un JSON.

**Ils ne dépendent de personne.** LiteAPI est un tiers unique : une panne, un changement de conditions
commerciales ou la perte de la clé laisse l'outil sans vivier. Les agents fonctionnent tant que le web
fonctionne. Pour un outil dont la raison d'être est de servir en situation dégradée, ce n'est pas une
considération secondaire.

---

## 5. Lecture, et partage recommandé

**Les agents ont perdu leur rôle d'origine.** Ils avaient été construits pour être la *source
d'approvisionnement*. LiteAPI fait ce travail 150 fois plus vite, gratuitement, et sans le plafond qui
bloquait tout. Sur ce terrain, la comparaison n'est pas serrée.

Ils en gagnent un autre, plus étroit et réel : **qualifier, vérifier, atteindre l'inatteignable**. La
formule n'est plus « les agents trouvent les hôtels » mais « l'API trouve, les agents vérifient ce qui
compte et complètent là où l'API est aveugle ».

| Rôle | Source | Quand |
|---|---|---|
| **Vivier primaire** | LiteAPI | à chaque run — couverture, volume, prix, distance |
| **Vérification ciblée** | agents Holo | sur les hôtels qui portent l'essentiel du plan : accessibilité d'un établissement qui reçoit des PMR, conditions de paiement d'un hôtel qui prend 60 chambres, capture de preuve |
| **Filet hors distributeur** | agents + source `maps` | établissements absents du catalogue, avec leur téléphone |

Cinq sondes ciblées à 0,65 $ valent mieux que dix-sept relevés à l'aveugle à 2,50 $.

---

## 6. Réserves, et ce qui reste à prouver

**Les mesures LiteAPI viennent d'une clé de BAC À SABLE** (`"sandbox": true` dans la réponse). Les 185
hôtels et les 11 059 offres prouvent le **protocole**, pas le **stock réel de Bangkok**. À remesurer sur
une clé de production avant d'annoncer une couverture à un client.

**La variabilité du bac à sable est forte** : trois runs consécutifs ont rendu 36, puis 13, puis 8 hôtels,
et le plan a varié de 171 logés / 288 personnes à 141 logés / 300 personnes sur la même liste. Toute
répétition avant une démonstration se fait **juste avant**, jamais la veille.

**Un défaut de l'API est câblé et testé, mais il faut le connaître** : `limit > 40` casse la requête
multi-chambres et l'API rend alors « no availability found » **au lieu d'une erreur**. Un adaptateur naïf
annoncerait « aucune chambre à Bangkok » alors qu'il y en a des centaines. Trois règles protègent :
`limit` ≤ 40, tout appel est rejoué, et **un zéro est recoupé à `limit` plus bas avant d'être cru**.

**Aucune source ne réserve ni ne bloque** (INV-1). Une disponibilité observée est une lecture datée, pas
une garantie : entre le relevé et l'appel du comptoir, une chambre peut partir.

**Piste ouverte, non tranchée** : LiteAPI expose `prebook`, qui **bloque l'inventaire 5 à 15 minutes à
tarif garanti sans réserver**. L'adaptateur ne l'appelle pas. C'est le chaînon manquant entre « plan
validé » et « chambres tenues », et la question — *`prebook` tombe-t-il sous INV-1 ?* — est un arbitrage
client, pas une décision de développeur. Avis technique : bloquer sans engager n'est ni un paiement ni un
contrat, donc probablement hors du champ d'INV-1. À rendre formellement.

---

## 7. Pour une démonstration client

Ne présentez pas LiteAPI comme le remplaçant des agents, pour trois raisons :

1. **Les volumes ne sont pas prouvés** — bac à sable, et variabilité forte.
2. **Les agents sont ce qui rend l'outil visible.** Un appel d'API de 7 secondes est un écran immobile.
   Les cartes d'agents, les pensées en français, les captures : c'est ce qui fait comprendre ce que la
   machine fait à la place d'un humain.
3. **L'argument qui porte est « le même moteur, trois sources »** — même politique, même allocation, même
   validation humaine, mêmes livrables. Ce n'est pas un connecteur qu'on vend, c'est une architecture qui
   ne dépend d'aucun fournisseur.

---

*Analyse du 26/09/2026. Voir `docs/AUDIT-2026-09-26.md` pour l'état général de l'outil,
`docs/cdc/ETAT.md` pour le journal, et `docs/GUIDE-CLIENT.md` pour le guide destiné à la compagnie.*
