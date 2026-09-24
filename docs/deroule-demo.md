# Déroulé de démonstration — démo v2 (9 étapes)

> **Chiffres de référence, mesurés le 21/09/2026** (simulation complète, mêmes fixtures que la séance) :
> **122 dossiers logés / 35 escalades** « DESK (capacité) », **26 569 € la nuit**, borne haute **32 900 €**,
> **9 livrables**. Le « 157 logés / 0 escalade » annoncé jusqu'ici datait d'avant la correction de la sonde
> (19-20/09) : ne plus le prononcer. Rejouer la mesure avant chaque séance, elle bouge avec l'inventaire.

Public : opérations compagnie. Durée cible : 15-20 min en run réel (BKK), 5 min en simulation.
Avant la séance : `npm test` vert, serveur démarré, onglet ouvert sur `http://127.0.0.1:4310`, régie ci-dessous lue.

> **Message d'ouverture** : « Un A350 plein vient d'être bloqué une nuit à Bangkok : 324 passagers à loger.
> Un opérateur seul, avec des agents web Holo, construit le plan d'hébergement en direct — sans réserver,
> sans données passagers transmises aux agents. »

## Les 9 étapes (CDC §1)

| # | Geste | À dire / à montrer |
|---|---|---|
| 1 | **Escale et scénario** — laisser BKK ; montrer CDG/NOU dans la liste ; « Générer la liste » A350-900 | la fiche escale (rayon 5 km, taxi ≤ 45 min) ; « 324 passagers · 157 dossiers · 4 PMR, seed reproductible » ; multi-escale prêt |
| 2 | **Politique** — déplier Cabine J : étoiles 4-5★, plafond 250 €, prestations ; montrer un plafond modifiable ; presets | « la compagnie édite sa politique, pas du code » ; plafonds par cabine, PMR/famille en surcouches |
| 3 | **Inventaire** — onglet Inventaire : **12 hôtels BKK** relevés par agents (fichier du 21/09), paiement société, drapeaux contracté/préféré/exclu | « constitué en amont par les agents (Étage 0), rafraîchissable, ajout manuel possible ». Dire aussi le **plafond de 9 chambres par hôtel** des plateformes grand public, qui borne ce vivier — et enchaîner sur la case « **Vivier par API hôtelière** » (voir la variante ci-dessous) |
| 4 | **Lancement** — « Lancer la prise en charge » ; suivre la frise et les cartes agents | pensées en français, captures d'écran, coût qui s'incrémente en direct dans le bandeau ; « chaque agent relève un hôtel sur Booking, lecture seule » |
| 5 | **Plan** — la table se remplit par passager ; montrer une ligne PMR (chambre accessible, notes) et une famille (communicantes) | conformité CONFORME/PARTIELLE par ligne, mode de règlement (`compagnie` / `carte_prepayee` / `à confirmer`) ; provisoire grisé puis confirmé |
| 6 | **Extension** — bandeau Extension : quand un plafond d'affichage est atteint, sonde sur le même hôtel + relevé du candidat suivant, par vagues | bornes visibles **50 sessions · 15 $ · 4 vagues · 60 min d'horloge** (valeurs par défaut du code au 23/09 — les relire à l'écran, elles s'éditent) ; « l'outil rouvre des sessions tout seul, dans des bornes que l'opérateur voit » |
| 7 | **Coût** — panneau Coût : par nuit par cabine, projection, borne haute aux plafonds | « 26 569 € la nuit pour 324 passagers, borne haute 32 900 € ; indemnités à saisir si la compagnie les fixe ». Ne jamais annoncer un total arrondi à la hausse : lire le chiffre à l'écran |
| 8 | **Validation humaine (C6)** — panneau de validation : répartition par hôtel, personnes logées / non logées, réserves, chambres FERMES contre À CONFIRMER ; écarter une ligne avec motif ; « Valider la répartition (sans réserver) » | **c'est la condition client centrale** : « rien ne part avant qu'un humain ait signé ». Montrer les réserves à voix haute (35 dossiers sans chambre, 16 sans couchage suffisant, 99 chambres À CONFIRMER sur 160) et l'empreinte SHA-256 du plan signé, journalisée dans `validation-<run>.json`. Dire aussi ce qui n'est pas prouvé : l'identité du validateur n'est authentifiée que derrière un proxy déclaré de confiance |
| 9 | **Messages et livrables** — aperçu FR/EN, filtre par tier, « Copier » ; puis les **9 téléchargements** (plan CSV, liste d'appel par hôtel, **fiches d'enregistrement CSV et HTML imprimables — C3**, rapport, messages, coût, candidats, relevés) | « prêts pour l'envoi et pour l'archivage ; tout est aussi en CLI ». Les deux fiches sont la réponse à C3 : ne pas les sauter |

Conclusion : « run réel chronométré sous 30 minutes, coût agents lu en direct (~1-5 $), zéro réservation, zéro donnée passager chez l'opérateur d'agents, souveraineté européenne (point d'entrée EU). »

## Variante — vivier par API hôtelière (la réponse à C2)

Sur les 12 hôtels de l'inventaire, le plan **ne peut pas** couvrir 324 passagers : le sélecteur de quantité
des plateformes grand public plafonne à 9 chambres par hôtel, soit ~111 chambres indicatives pour 173
demandées. C'est mesuré, l'outil le dit lui-même au dry-run, et **aucune séance ne doit laisser croire le
contraire**.

Pour montrer la réponse : cocher « **Vivier par API hôtelière (prix publics réels, aucun agent)** » à
l'étape 4. Le run interroge un distributeur au lieu de lancer des agents — **0 session, 0 $**, quelques
secondes au lieu de 25 minutes — puis rejoue exactement le même moteur d'allocation.

- Ordre de grandeur mesuré le 22/09 : **185 hôtels, 11 059 offres en 7 s**, plan à **171 dossiers logés /
  288 personnes sur 324**, contre 122/35 sur les 12 hôtels.
- **À dire à voix haute, sans attendre la question** : la clé est une **clé de bac à sable**, les volumes et
  les tarifs sont des **données de test**. Le protocole est prouvé, le stock ne l'est pas.
- Les trois viviers s'excluent à l'écran : cocher l'API décoche et grise la simulation.
- **La variabilité impose une règle** : trois runs consécutifs ont rendu 36, puis 13, puis 8 hôtels. Toute
  répétition se fait **juste avant** la séance, jamais la veille.

## Plan B — simulation (filet de sécurité)

Si le réseau, Booking ou la plateforme H fait défaut pendant la séance :

1. cocher « **Mode démonstration (sans agents)** » (vitesse ×1 pour un déroulé naturel de ~90 s, ×5 pour resserrer) ;
2. rejouer les étapes 4-9 à l'identique : mêmes phases, extension vague 1 (sonde + relevé), **122 logés / 35 escalades**, coût **26 569 €/nuit**, 9 livrables (mesuré le 21/09/2026) ;
3. l'annoncer honnêtement : « rejeu de relevés réels capturés, même moteur, zéro coût ».

Répétition générale : jouer le déroulé complet en simulation une fois avant la séance, et **relever les chiffres du jour** —
ce sont eux qu'on annonce, pas ceux de ce document. (Dernière répétition consignée : 15/09, recette §2 ; ses chiffres
sont périmés depuis la correction de la sonde du 20/09.)

## Réglages recommandés

- **Avant séance (réel)** : politique par défaut ; bornes d'extension par défaut (**50 · 15 $ · 4 · 60 min**) ; concurrence `auto` ;
  modèles par défaut (`holo3-122b-a10b` relevés/découverte, `holo3-1-35b-a3b` sonde — mesure phase 5).
- **Si le run réel s'étire** (> 20 min au 2/3 de la frise), boutons §13 dans l'ordre : `max_hotels_stage_b` 5 → 4,
  `maxSteps` relevés 45 → 40, `n_socle` 8 → 6 ; relancer **une fois maximum**.
- Navigateur : un seul onglet de démo (le snapshot ré-ouvre proprement, mais un seul run à la fois — INV-10) ;
  fermer les DevTools ; zoom 100 %.
- Serveur : démarrer `DEMO_ALLOW_PAID=1 node demo/server.mjs` **juste avant** la séance (la variable ne vit que
  dans ce terminal) ; vérifier la ligne de démarrage « run réel … AUTORISÉS ».

## À ne pas montrer

- La **clé API** (`HAI_API_KEY`) : jamais de `echo`, jamais le fichier `~/.config/hai/.env`, jamais les variables
  d'environnement du terminal à l'écran.
- Le dossier **`out/`** (artefacts de runs précédents, captures brutes) : passer par les téléchargements de l'UI uniquement.
- Le terminal du serveur en grand écran (logs techniques) ; le garder en arrière-plan.
- Les fiches de personnes : la liste passagers générée reste dans le process (aucun CSV réel en séance).
- Ne pas promettre : réservation, tarifs négociés, contournement d'anti-bot — hors périmètre par invariant (INV-1/2/3).
