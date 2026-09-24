# Cahier des charges — Démo v2 « Hébergement d'urgence à agents Holo »

| Champ | Valeur |
|---|---|
| Projet | Outil interactif d'hébergement d'urgence — aléas d'exploitation (IROPS) |
| Client | Aircalin (rotation NOU–BKK–CDG, A350-900 tri-classe) |
| Maître d'œuvre | OPS INSIGHT |
| Version | 1.1 — 14 septembre 2026 (décisions du 14/09 intégrées) |
| Base | Plan de développement « Démo v2 » du 11/09/2026 (voir `docs/cdc/annexes/`) |
| Dépôt | `https://github.com/pgadet-wq/pax-hotel.git` (public, vide au 14/09 : le pack en est le squelette) |
| Calendrier | Au plus vite. Ordre de bataille en README §« Calendrier » |
| Exécution | Claude Code, 8 phases (0 à 7), une conversation par phase (voir `docs/cdc/phases/`) |

Ce document est écrit pour être lu par Claude Code. Chaque exigence est numérotée (`EX-…`). Chaque phase renvoie aux exigences qu'elle couvre. Les hypothèses non confirmées sont marquées `[À CONFIRMER]`. Ne jamais les trancher silencieusement : les signaler dans `docs/cdc/ETAT.md`.

---

## 1. Objectif de la démo

Montrer au client, en temps réel, qu'un opérateur seul peut :

1. choisir une escale (Bangkok par défaut) et un scénario (A350 plein, 1 nuit) ;
2. éditer la politique d'hébergement (étoiles, équipements, plafonds par cabine, priorités) ;
3. disposer d'un inventaire hôtelier constitué en amont ;
4. lancer une prise en charge et regarder les agents Holo travailler (pensées, captures, coût) ;
5. voir le plan d'hébergement se remplir passager par passager, avec conformité et mode de règlement ;
6. voir l'outil déclencher de nouvelles sessions quand un plafond d'affichage est atteint ;
7. lire le coût par nuit et sa projection ;
8. lire l'aperçu des messages passagers FR/EN ;
9. télécharger le plan, le rapport et les messages.

Critère de succès de la démo : un run complet réel sur Bangkok en moins de 30 minutes, coût lu en direct, plus un mode simulation de 90 secondes à zéro coût comme filet de sécurité. Priorité absolue à la rapidité d'exécution et à la capacité des agents (décision du 14/09).

---

## 2. Périmètre

### 2.1 Dans le périmètre

- Inventaire hôtelier en amont par escale (Étage 0).
- Découverte dynamique (Étage A), relevés (Étage B), extension au plafond (Étage C).
- Allocation incrémentale avec conformité et mode de règlement.
- Messages passagers FR/EN par gabarit déterministe.
- Coût par nuit et projection.
- Application web locale (serveur Node natif, SSE, UI vanilla FR).
- Mode simulation à partir de fixtures Bangkok.
- CLI complet (dry-run, offline, probes, run).

### 2.2 Hors périmètre (documenté pour la v3)

- Réservation effective. Envoi réel de messages. Émission de cartes.
- Import DCS. Runs parallèles multi-escales. Déclenchement OCC.
- API hôtelières B2B. Appel de LLM pour rédiger les messages.

### 2.3 Invariants non négociables

| Id | Invariant |
|---|---|
| INV-1 | Aucune réservation. Les agents s'arrêtent à la page de sélection des chambres. |
| INV-2 | Aucun contournement de CAPTCHA. Un CAPTCHA est signalé (`warning`) et la session s'arrête. |
| INV-3 | Prix publics uniquement. `negotiated_rates: false` verrouillé. |
| INV-4 | Clé API H côté serveur uniquement. Jamais dans le navigateur, jamais dans un fichier commité. |
| INV-5 | Aucune donnée passager (nom, PNR, e-mail, téléphone, besoin médical) ne transite par un agent. Les agents reçoivent des URL, des dates, des nombres de chambres et la politique. |
| INV-6 | `tools/rebooking.mjs` (v1) reste intact. |
| INV-7 | `demo/` n'importe que des builtins `node:` et des chemins relatifs vers `../hai-admin-mcp/lib/`. Tout module qui importe `hai-agents` ou `zod` vit sous `hai-admin-mcp/`. |
| INV-8 | Aucune session payante en dehors de la phase 5 et de la recette finale (phase 6), et jamais sans demande explicite de l'utilisateur dans la conversation. |
| INV-9 | Aucun texte d'agent inséré par `innerHTML`. `textContent` uniquement. |
| INV-10 | Un seul run à la fois (409). Les runs sont néanmoins identifiés par `runId` et `station` pour préparer la v3. |

---

## 3. Contraintes techniques héritées du plan v2 (à revérifier en phase 0)

- Code existant local `hai-admin-mcp/` avec `tools/rebooking.mjs` (POC v1 du 31/08), `tools/generate-passengers.mjs`, `tools/collect-sessions.mjs`, `data/passagers-test.csv`, `out/releves-poc-bkk-2026-09-01.json`. Il n'est pas encore sous git. Le dépôt cible `pax-hotel` existe sur GitHub et est vide : la phase 0 y rapatrie ce code avec le pack.
- SDK `hai-agents` 1.0.7 : `client.startSession()` → `SessionHandle` avec `.stream()` (AsyncGenerator de `SessionEvent`) et `.waitForCompletion({answerSchema})`. `SessionRequest.overrides` accepte `{"agent.environments[kind=web].start_url": "…"}`. Événements : `policy_event {reasoningContent, content, toolReqs}`, `observation_event {image.source}`, `MetricsUpdateEvent`, `LiveViewUrlEvent`, `AgentRunStatusChangeEvent`. Captures : URL plateforme → proxy authentifié obligatoire, repli `client.sessions.getSessionResource`.
- Point d'entrée Agents API : européen (`https://agp.eu.hcompany.ai/api/v2`), confirmé par l'utilisateur le 14/09. Le SDK Python le prend par `HAI_API_BASE_URL` ou `--base-url` ; le nom exact de l'option du SDK TypeScript est à relever en phase 0.
- `hono` / `express` uniquement transitifs : ne pas s'y adosser.
- Filtres Booking par URL (`nflt`, séparés par `;`), vérifiés le 11/09 : `class=3|4|5`, `review_score=70|80`, `mealplan=1`, `hotelfacility=107` (wifi) / `17` (navette) / `5` (room service) / `8` (réception 24 h) / `3` (restaurant) / `185` (PMR), `distance=1000|3000|5000`, `fc=2`, `ht_id=204`, `selected_currency=EUR`. Pas de filtre « business center » ni « room service 24 h » : à lire sur la fiche.
- Mesures du 31/08 : ~0,006 $/step, sessions 4-18 min, concurrence 3 (file au-delà), `waitForSeconds` ≤ 25, plafond d'affichage 9 chambres/type, pannes WebDriver transitoires (échec de suivi ≠ échec de session : se rattacher via l'id avant de relancer).
- Chemins Windows possibles : `fileURLToPath`, jamais `cwd`. CSV Excel : UTF-8 avec BOM.

---

## 4. Architecture cible

```
hai-admin-mcp/
  lib/
    csv.mjs            parsePassagersCsv(text), toCsvBom(cols, rows)
    passagers.mjs      generatePassengers({seats, seed, mix, pmrCount}) → {rows, csv, stats}
    policy.mjs         PolicySchema, DEFAULT_POLICY, tierOf(), conformityOf(), effectiveCaps(policy, station)
    stations.mjs       StationSchema, loadStation(code), listStations(), DEFAULT_STATION="BKK"      [NOUVEAU]
    inventaire.mjs     InventaireSchema, loadInventaire(code), mergeInventaire(), isStale(), candidatesFrom()  [NOUVEAU]
    scenario.mjs       DEFAULT_AVION, DEFAULT_SCENARIO (station BKK), mergeConfig(payload)
    dossiers.mjs       buildDossiers(rows, policy) → tiers + overlays ; computeNeeds()
    hai.mjs            readApiKey(), createClient(), ensureAgentV2(), buildNflt(policy, station), buildSearchUrl(), buildHotelUrl(), buildProbeUrl(), schémas de réponse
    discovery.mjs      runDiscovery({client, policy, station, scenario, emit, signal})
    releve.mjs         runReleve(), runReleves({concurrency:3, staggerMs:25000})
    capacite.mjs       detectCap(releve), planExtension({gaps, surveyed, candidates, policy}), runProbe()   [NOUVEAU]
    allocate.mjs       allocate({dossiers, inventories, policy, station}) → {plan, summary, gaps} — PUR
    reglement.mjs      modeReglement(hotel, policy) → "compagnie" | "carte_prepayee" | "compagnie_a_confirmer"  [NOUVEAU]
    cout.mjs           computeCost(plan, policy, scenario) — PUR                                    [NOUVEAU]
    messages.mjs       buildMessages(plan, station, scenario, policy) → FR/EN — PUR                [NOUVEAU]
    rapport.mjs        buildPlanCsv(), buildRapportMd(), buildMessagesCsv()
    events.mjs         forme d'événement partagée + traduction SessionEvent → événement plat
  tools/
    rebooking.mjs           v1 — INCHANGÉ
    rebooking-v2.mjs        CLI v2 (voir §12)
    inventaire.mjs          CLI Étage 0 (voir §6.1)                                              [NOUVEAU]
    generate-passengers.mjs wrapper mince (défaut CLI inchangé A330 ; défaut UI A350 via scenario.mjs)
    collect-sessions.mjs    inchangé
demo/
  server.mjs         node:http, routing switch, statiques en liste blanche, SSE
  run-manager.mjs    singleton {state, runId, station, phase, agents, plan, metrics, extension}
  sse-hub.mjs        bus + tampon circulaire 1000 + Last-Event-ID + snapshot ; ping 15 s
  session-pump.mjs   for await (ev of handle.stream({until:"settled"})) → emit ; PUIS waitForCompletion
  simulate.mjs       collectFn simulé : fixtures + pensées scriptées FR + PNG locaux, ~90 s
  sim-assets/        3-4 captures PNG factices
  public/index.html, app.js, style.css   vanilla, FR, sans build
data/
  stations/BKK.json, CDG.json, NOU.json                                                  [NOUVEAU]
  inventaire/BKK.json (+ CDG.json, NOU.json vides ou manuels)                            [NOUVEAU]
  messages/fr.md, en.md   gabarits éditables                                              [NOUVEAU]
  presets/                politiques sauvegardées (nom assaini [a-z0-9-]{1,40})
  simulate/releves-demo.json, inventaire-demo.json                                        (BKK)
docs/
  cdc/                    ce pack
  matrice-affectation.md  à mettre à jour (tiers, surcouches, conformité, règlement, extension)
.claude/launch.json       { name: "demo-bkk", runtimeExecutable: "node", runtimeArgs: ["demo/server.mjs"], port: 4310 }
```

---

## 5. Modèle de données

Tous les schémas sont des schémas `zod` exportés. Toute entrée externe (fichier, requête HTTP, réponse d'agent) est validée. Une validation échouée produit une erreur explicite, jamais un défaut silencieux.

### 5.1 Politique d'hébergement (`policy.mjs`)

Reprend intégralement le modèle du plan v2 (cabines J/W/Y, `global.priorities`, `rooming`, `overlays`, `scoring`, `discovery`, `negotiated_rates`, `currency`, `free_cancellation_preferred`). Ajouts :

```jsonc
{
  "allowances": { "meal_eur_per_pax_per_day": null, "transport_eur_per_pax": null },   // null = « non renseigné »
  "payment": {
    "default_mode": "compagnie",
    "prepaid_card": { "enabled": true, "load_includes": ["nuit", "repas", "transport"] }
  },
  "extension": {
    "enabled": true,
    "probe_same_hotel_first": true,        // H-3 : tranchée en phase 5
    "batch_size": "auto",                  // = agents.concurrency
    "max_waves": 4,
    "max_sessions_per_run": 18,
    "max_cost_usd_per_run": 10,            // décision du 14/09 : bornes larges, visibles, éditables
    "probe_no_rooms_max": 30
  },
  "agents": {
    "concurrency": "auto",                 // = maximum autorisé par le plan H (lu en phase 0/5), plafonné à 6
    "stagger_ms": 10000,                   // ramené de 25 s à 10 s si le plan l'autorise ; retour à 25 s sur file d'attente
    "model_stage_ab": "auto",              // modèle Holo le plus capable disponible sur le plan (Holo3 122B si sélectionnable)
    "model_probe": "auto"                  // modèle rapide pour les sondes courtes (classe web-surfer-flash)
  },
  "inventory": { "max_age_days": 30, "min_candidates_per_tier": 2 }
}
```

EX-POL-1 : `effectiveCaps(policy, station)` = `price_cap_eur × station.pricing.price_cap_factor`, arrondi à l'euro.
EX-POL-2 : la cabine est le tier. Flying Blue n'agit que sur l'ordre intra-tier (Gold+ d'abord). PMR et famille sont des surcouches cumulables.
EX-POL-3 : `breakfast_available` se calcule depuis `rooms[]` (≥ 1 variante avec petit-déjeuner), jamais depuis `amenities`.

### 5.2 Fiche escale (`stations.mjs`) — NOUVEAU

```jsonc
{
  "code": "BKK", "name": "Bangkok Suvarnabhumi", "country": "TH", "timezone": "Asia/Bangkok",
  "search": {
    "zone_query": "Suvarnabhumi Airport Bangkok",
    "radius_km": 5,
    "distance_ref": "airport",          // "airport" | "zone_center"
    "use_distance_filter": true,        // false quand distance_ref = zone_center
    "extra_nflt": []
  },
  "transfer": { "default_mode": "taxi", "max_transfer_min": 45, "note": "" },
  "constraints": { "entry_visa_check": true, "transit_hotel_airside": true, "notes": "Passagers sans droit d'entrée : traitement nominatif GHA." },
  "pricing": { "price_cap_factor": 1.0 },
  "fallback_hotels": [ { "name": "…", "url": "https://www.booking.com/…" } ],   // liste v1 du POC pour BKK
  "demo_priority": 1
}
```

Fiches livrées :

| Code | zone_query | radius_km | distance_ref | use_distance_filter | transfer | demo_priority |
|---|---|---|---|---|---|---|
| BKK | `Suvarnabhumi Airport Bangkok` | 5 | airport | true | taxi, 45 min | 1 |
| CDG | `Aéroport Paris-Charles de Gaulle` | 10 | airport | true | navette, 45 min | 2 |
| NOU | `Nouméa` | 10 | zone_center | false | navette, 75 min (valeur de départ, éditable) | 3 |

EX-STA-1 : l'UI liste les escales par `demo_priority` croissant. BKK est sélectionnée par défaut.
EX-STA-2 : quand `distance_ref = zone_center`, le champ relevé `distance_km` désigne la distance au centre de zone et le critère de proximité du score utilise `radius_km` de la fiche. Aucun filtre `distance=` n'est ajouté à `nflt`.
EX-STA-3 : `max_transfer_min` est affiché dans le plan et dans les messages. Il ne filtre pas les hôtels en démo (information seulement).
EX-STA-4 : une fiche invalide bloque le démarrage du serveur avec un message explicite.

### 5.3 Inventaire hôtelier (`inventaire.mjs`) — NOUVEAU

```jsonc
{
  "station": "BKK",
  "updated_at": "2026-09-20T03:12:00Z",
  "reference": { "checkin": "2026-10-04", "nights": 1 },
  "hotels": [
    {
      "id": "novotel-bkk-airport",
      "name": "…", "url": "https://www.booking.com/hotel/th/….html",
      "source": "agent",                 // "agent" | "manuel"
      "contracted": false, "preferred": false, "excluded": false,
      "stars": 4, "review_score": 8.1, "review_count": 3120,
      "distance_km": 1.2, "distance_ref": "airport",
      "amenities": {
        "wifi_free": true, "room_service": "24h", "workspace": true,
        "airport_shuttle": "gratuite", "restaurant_late": true, "accessible": true,
        "breakfast_available": true, "family_capable": true
      },                                  // valeurs : true | false | null ; enums avec "non_precise"
      "payment": {
        "prepayment_online": "oui",       // "oui" | "non" | "non_precise"
        "pay_at_property_only": false,    // true | false | null
        "company_payment_possible": "oui" // calculé : "oui" | "non" | "a_confirmer"
      },
      "indicative_price_from_eur": 92,
      "capacity_hint": { "rooms_displayed_max": 9, "cap_reached": true, "observed_at": "…" },
      "contact": { "phone": null, "email": null },
      "notes": "", "last_survey_at": "…"
    }
  ]
}
```

EX-INV-1 : `mergeInventaire(existing, fresh)` ne supprime ni ne modifie jamais un enregistrement `source: "manuel"`. Il met à jour les enregistrements `agent` par `id`, conserve les drapeaux `contracted / preferred / excluded` posés par l'utilisateur.
EX-INV-2 : `isStale(inv, policy)` = `updated_at` plus ancien que `inventory.max_age_days` ou inventaire absent.
EX-INV-3 : `candidatesFrom(inv, policy, needs)` renvoie les hôtels non `excluded`, ordonnés : `contracted` → `preferred` → score souple décroissant. Les `fallback_hotels` de la fiche escale sont ajoutés en fin de liste s'ils n'y figurent pas.
EX-INV-4 : `company_payment_possible` (règle validée le 14/09) : `"oui"` si `contracted` ou `prepayment_online = "oui"` ; `"non"` si `pay_at_property_only = true` et non contracté ; sinon `"a_confirmer"`.

### 5.4 Scénario (`scenario.mjs`)

```jsonc
{ "station": "BKK", "checkin": "2026-10-04", "nights": 1, "seed": 42, "simulate": false,
  "force_discovery": false, "next_update_minutes": 30 }
```

`DEFAULT_AVION` = A350-900 `{ J: 34, W: 24, Y: 266 }` (éditable). `mergeConfig` valide et borne (`nights` 1-7, `seed` entier, `station` connue).

### 5.5 Passagers (CSV)

Colonnes existantes du générateur v1/v2 conservées (PNR, nom, cabine, statut Flying Blue, PMR, famille, adultes/enfants/nourrissons, etc.). `generatePassengers` produit un avion plein exact avec PRNG `mulberry32` et compteur PNR locaux à l'appel. Vérification de non-régression : seed 42 A330 → CSV identique à `data/passagers-test.csv`.

### 5.6 Relevé (`releveSchema`)

Reprend le schéma v2 (chambres avec `family_capable`, niveau hôtel avec `amenities`). Ajouts :

```jsonc
{ "payment": { "prepayment_online": "oui|non|non_precise", "pay_at_property_only": true|false|null },
  "rooms": [ { "…": "…", "quantity_displayed_max": 9, "cap_reached": true } ],
  "observed_at": "ISO", "price_currency": "EUR" }
```

EX-REL-1 : `cap_reached = true` quand la quantité maximale sélectionnable d'un type de chambre égale le plafond connu de la plateforme (9) ou quand l'agent signale un sélecteur tronqué.
EX-REL-2 : chaque relevé porte `observed_at`. Le rapport affiche « prix relevé le … à … ». Le prix relevé n'est pas un prix garanti.

### 5.7 Ligne du plan

Colonnes v1 + `conformite` (v2) + ajouts :

| Colonne | Valeurs |
|---|---|
| `mode_reglement` | `compagnie` · `carte_prepayee` · `compagnie_a_confirmer` |
| `hotel_source` | `contracted` · `preferred` · `agent` · `fallback` |
| `provisoire` | `true` tant qu'un relevé ou une extension est en cours |
| `session_ref` | identifiant de la session H ayant produit le relevé |
| `transfert` | mode par défaut de la fiche escale et `max_transfer_min` |
| `escalade` | vide · `DESK` (avec motif) |

### 5.8 Événements (SSE)

Types v2 conservés : `phase`, `agent_status`, `agent_thought`, `screenshot`, `candidate`, `plan_row`, `metrics`, `warning`, `log`, `done`, `error`. Ajouts :

| Type | Charge |
|---|---|
| `inventory_status` | `{station, updated_at, hotels_count, stale, used: true|false}` |
| `extension` | `{wave, reason: "gaps", gaps: [{tier, rooms_missing}], planned: {probes: n, surveys: n}, limits: {sessions_used, sessions_max, cost_usd, cost_max}}` |
| `probe` | `{hotel, requested_rooms, result: {rooms_available_max, cap_reached} | null, status}` |
| `cost` | sortie de `computeCost` |
| `messages_ready` | `{count_fr, count_en, sample: [3 premiers]}` |

Phases émises dans l'ordre : `preparation → generation → besoins → inventaire → discovery|discovery_skipped → releves → allocation → extension (0..n) → sorties → done`.

---

## 6. Pipeline agents

### 6.1 Étage 0 — Inventaire en amont (NOUVEAU)

Outil séparé, exécuté hors événement, par escale.

```
node tools/inventaire.mjs --station BKK [--refresh] [--checkin 2026-10-04] [--nights 1] [--max 10] [--offline <fixtures>] [--dry-run]
```

EX-INV-5 : l'inventaire enchaîne une découverte (logique Étage A, 1 session, 2 passes) puis un relevé hôtel par candidat (`--max`, défaut 10, concurrence 3, décalage 25 s) limité aux équipements, aux modalités de paiement, au prix indicatif et à la capacité observée. Les chambres détaillées ne sont pas nécessaires ici.
EX-INV-6 : la sortie écrit `data/inventaire/{CODE}.json` via `mergeInventaire`. `--dry-run` affiche les URL et ne lance rien. `--offline` rejoue des fixtures.
EX-INV-7 : `groupId = inv-{code}-{runId}`. Tous les événements et fichiers portent le `runId`.
EX-INV-8 : l'UI expose un onglet « Inventaire » : liste, drapeaux (contracté / préféré / exclu), ajout manuel (nom, URL, contact, contracté), bouton « Rafraîchir par agents » (409 si un run est en cours), horodatage et état « périmé ».
EX-INV-9 : le jour de l'événement, la phase `inventaire` charge l'inventaire de l'escale et émet `inventory_status`.
EX-INV-10 : aucune liste d'hôtels contractés n'existe au 14/09. L'inventaire initial de Bangkok est produit par l'Étage 0 lui-même, en phase 5 (`--max 10`), avant tout run de démonstration. Les drapeaux `contracted / preferred` sont posés ensuite à la main dans l'onglet Inventaire.

### 6.2 Étage A — Découverte

Reprise du plan v2 : 1 session, `maxSteps 35`, `maxTimeS 800`, `start_url` via overrides, 2 passes par édition d'URL `nflt` (socle Y : `class=3;class=4;class=5`, wifi, `review_score=70`, distance selon fiche escale, `ht_id=204` ; passe premium : `class=4;class=5;hotelfacility=5`), lecture des cartes de résultats uniquement, `discoverySchema` (≤ 10 candidats). Retry × 1. Repli : `fallback_hotels` de la fiche escale.

EX-DIS-1 : la découverte ne s'exécute que si `force_discovery`, ou si l'inventaire est absent ou périmé, ou si `candidatesFrom` renvoie moins de `inventory.min_candidates_per_tier` candidats compatibles pour un tier ayant des besoins. Sinon la phase `discovery_skipped` est émise.
EX-DIS-2 : les candidats découverts sont fusionnés dans l'inventaire en mémoire pour le run (pas d'écriture sur disque sans action explicite de l'utilisateur : bouton « Enregistrer dans l'inventaire »).
EX-DIS-3 : `buildNflt(policy, station)` omet `distance=` quand `use_distance_filter = false` et ajoute `station.search.extra_nflt`.

### 6.3 Étage B — Relevés

Reprise du plan v2 : ≤ `max_hotels_stage_b` sessions (5), `maxSteps 45`, `maxTimeS 900`, décalage `agents.stagger_ms`, concurrence `agents.concurrency` (maximum du plan H, plafond 6 ; repli automatique à 3 et 25 s sur file d'attente ou erreur 429), session démarrée directement sur la fiche hôtel (URL + dates + `selected_currency=EUR`), relevé des chambres puis des équipements, interdiction de substituer, `found = false` → candidat suivant du tier (`warning`). `groupId = {code}-v2-{checkin}-{runId}`.

EX-REL-3 : l'ordre des relevés suit `candidatesFrom` (contracté → préféré → score).
EX-REL-4 : l'agent lit en plus les modalités de paiement (§5.6) et signale `cap_reached` par type de chambre.

### 6.4 Étage C — Extension au plafond d'affichage (NOUVEAU)

Après chaque allocation, `gaps[]` liste, par tier, les chambres manquantes.

```
wave = 1
tant que gaps non vide
     et wave ≤ extension.max_waves
     et sessions_used < extension.max_sessions_per_run
     et cost_usd < extension.max_cost_usd_per_run :
  émettre extension {wave, gaps, planned, limits}
  si extension.probe_same_hotel_first :
     pour chaque hôtel relevé avec cap_reached sur un type compatible avec un tier en manque,
     non encore sondé :
        runProbe(hotel, requested_rooms = min(rooms_missing, probe_no_rooms_max))
        → met à jour rooms_available_max ; réallouer ; recalculer gaps
  candidats suivants = candidatesFrom(...) non relevés, compatibles avec les tiers en manque,
     pris par lots de extension.batch_size
  runReleves(lot) → réallouer → recalculer gaps
  wave += 1
si gaps non vide : lignes ESCALADE DESK avec le nombre de chambres manquantes par tier ; warning
```

EX-EXT-1 : `runProbe` ouvre `buildProbeUrl(hotel, checkin, nights, no_rooms, group_adults = 2 × no_rooms)` et lit la disponibilité affichée pour ce nombre de chambres. H-3 est tranchée en phase 5 par `--probe-capacity` : si le comportement de Booking avec `no_rooms` / `group_adults` n'est pas concluant, `probe_same_hotel_first` passe à `false` et seule l'extension par candidats suivants s'applique.
EX-EXT-2 : chaque sonde ou relevé d'extension compte dans `sessions_used` et dans le coût agrégé des `MetricsUpdateEvent`.
EX-EXT-3 : les bornes sont visibles dans l'UI en permanence : `sessions_used / max`, `cost_usd / max`, `wave / max_waves`.
EX-EXT-4 : l'utilisateur peut interrompre l'extension (`POST /api/cancel-extension`) sans annuler le run. Le plan reste en l'état avec escalade chiffrée.
EX-EXT-5 : une sonde ne substitue jamais un hôtel. L'agent reçoit une URL et un nombre de chambres, rien d'autre.

### 6.5 Prompts

Squelettes en français, dérivés de la v2 : méthode URL d'abord, filtres UI en repli ; « déclaré par la plateforme, ne rien déduire, `non_precise` sinon » ; garde-fous INV-1 et INV-2 rappelés dans chaque prompt. Trois nouveaux squelettes : inventaire hôtel (équipements + paiement + capacité), sonde de capacité, relevé enrichi paiement.

EX-PRO-1 : un test unitaire construit chaque prompt avec un jeu de passagers et vérifie qu'aucune valeur d'aucune colonne passager n'y apparaît (INV-5).

### 6.6 Robustesse

Retry × 1 avec rattachement par id de session avant relance. Substitution par le code uniquement. Pannes WebDriver : échec de suivi ≠ échec de session. Crash serveur : les sessions H continuent, `collect-sessions.mjs` reste compatible (`groupId`).

---

## 7. Allocation et règlement

EX-ALL-1 : `allocate()` reste pur et rejouable. Il est rejoué après chaque relevé terminé et après chaque sonde (plan incrémental, lignes `provisoire` jusqu'au dernier relevé).
EX-ALL-2 : `conformityOf` : filtre dur (étoiles min, équipements requis — `room_service_24h` exige `"24h"`, `non_precise` → PARTIELLE « à confirmer » —, ≥ 1 chambre sous plafond effectif) → `CONFORME` / `PARTIELLE(missing[])` / `NON_CONFORME`. `max_stars` dépassé = « surclassé », jamais exclu.
EX-ALL-3 : score souple = `w_review·(note/10) + w_stars_fit·fit + w_distance·max(0, 1 − km/rayon) + w_price_headroom·marge + 0,02 par nice_to_have`. Le rayon est celui de la fiche escale.
EX-ALL-4 : parcours `CONFORME → PARTIELLE → HORS_BAREME (si dérogation) → ESCALADE DESK`. Priorités `pmr, famille, J, W, Y`. Dédup des variantes tarifaires par type physique. Annulation gratuite prioritaire.
EX-ALL-5 : `rooms_available_max` (issu du relevé ou de la sonde) borne le nombre de chambres allouables par type. `cap_reached` sans sonde = borne basse.
EX-ALL-6 : `mode_reglement` par ligne : `compagnie` si `company_payment_possible = "oui"` ; `carte_prepayee` si `"non"` et `policy.payment.prepaid_card.enabled` ; `compagnie_a_confirmer` si `"a_confirmer"`. Si la carte est désactivée et le paiement impossible : `ESCALADE DESK` motif « règlement ».

---

## 8. Sorties

| Fichier | Contenu |
|---|---|
| `out/plan-{runId}.csv` | une ligne par dossier, colonnes §5.7, UTF-8 BOM |
| `out/rapport-{runId}.md` | synthèse : scénario, escale, politique, inventaire utilisé, relevés (horodatés), plan par tier, escalades, extension (vagues, sondes), coût, avertissements |
| `out/messages-{runId}.csv` | `pnr, lang, subject, body` — FR et EN pour chaque dossier |
| `out/cout-{runId}.json` | sortie de `computeCost` |
| `out/candidats-{runId}.json`, `out/releves-{runId}.json` | données brutes (fixtures potentielles) |

### 8.1 Coût (`cout.mjs`)

```jsonc
{ "per_night": { "J": 0, "W": 0, "Y": 0, "total": 0 },
  "nights": 1, "projection_total": 0,
  "upper_bound_at_caps": 32900,                 // Σ sièges × plafond effectif (une chambre par passager)
  "allowances": { "meal": null, "transport": null },
  "not_determinable": ["repas", "transport"],    // vide quand la politique renseigne les montants
  "escalated_rooms": { "J": 0, "W": 0, "Y": 0 } }
```

EX-COU-1 : aucun montant n'est estimé. Un poste non renseigné est listé dans `not_determinable` et affiché « non renseigné ».

### 8.2 Messages (`messages.mjs`)

Gabarits éditables `data/messages/fr.md` et `en.md`, placeholders `{{…}}` : `{{pnr}}`, `{{hotel_name}}`, `{{hotel_address}}`, `{{hotel_url}}`, `{{transfer_mode}}`, `{{max_transfer_min}}`, `{{mode_reglement_texte}}`, `{{repas_texte}}`, `{{next_update_time}}`, `{{station_name}}`, `{{contact_channel}}`.

EX-MSG-1 : un message par dossier (PNR), en FR et en EN. Trois variantes : affecté, provisoire, escalade.
EX-MSG-2 : contenu minimal : situation, hôtel et adresse, transfert et qui le règle, repas, prochaine mise à jour (`next_update_minutes` après l'heure de génération), canal de contact.
EX-MSG-3 : aucun appel de LLM. Génération déterministe et testable.
EX-MSG-4 : l'UI affiche un aperçu (3 premiers dossiers, bascule FR/EN, filtre par tier, bouton copier).

---

## 9. Serveur, API, SSE

Serveur `node:http` natif, port 4310, bind `127.0.0.1`, zéro dépendance nouvelle. Routing par `switch` sur méthode + chemin, helpers `sendJson` / `readBody`.

| Route | Rôle |
|---|---|
| `GET /` + statiques (liste blanche) | UI |
| `GET /api/config` | défauts, presets, stations, `runInProgress` |
| `GET /api/stations` | fiches escale validées |
| `GET /api/inventaire/:code` · `PUT /api/inventaire/:code` | lecture / mise à jour des drapeaux et entrées manuelles |
| `POST /api/inventaire/:code/run` | Étage 0 par agents (409 si run en cours) |
| `GET|POST /api/presets` | politiques sauvegardées |
| `POST /api/generate-passengers` · `POST /api/passengers` | génération / upload CSV |
| `POST /api/run` | `{policy, avion, scenario, simulate}` → 202 `{runId}` / 409 |
| `POST /api/cancel` · `POST /api/cancel-extension` | annulation totale / arrêt de l'extension |
| `GET /api/events` | SSE |
| `GET /api/state` | instantané |
| `GET /api/screenshot?hotel=&seq=` | proxy authentifié (clés d'état internes, jamais une URL cliente, `Cache-Control: private`) |
| `GET /api/messages?runId=&lang=` · `GET /api/cout?runId=` | sorties |
| `GET /api/outputs/:file` | téléchargement (liste blanche, attachment) |

Protocole SSE : `id:` monotone, `event:` / `data:` JSON une ligne, tampon circulaire 1000, `Last-Event-ID`, sinon `snapshot` complet re-rendable, ping 15 s. Le run vit dans le process serveur : l'onglet est fermable pendant les 20-30 minutes.

---

## 10. Interface

Colonne formulaire repliable :

- **Escale** : sélecteur ordonné par `demo_priority`, BKK par défaut ; rappel des paramètres de la fiche (zone, rayon, transfert) ; lien vers l'onglet Inventaire.
- **Politique** : par cabine (étoiles, cases équipements, plafond €/nuit affiché avec le facteur escale), chambrage, priorités, règlement (mode par défaut, carte activée), extension (bornes), presets.
- **Avion** : A350-900, sièges J/W/Y, « Générer la liste », upload, statistiques.
- **Scénario** : check-in, nuits, seed, `force_discovery`, « Mode démonstration (sans agents) ».
- Bouton « Lancer la prise en charge ».

Zone principale : frise de phases (incluant `inventaire` et `extension`), cartes agents (statut, dernière pensée, vignette cliquable, lien « Vue live H »), bandeau coût / tokens / pas / bornes d'extension, tableau du plan qui se remplit (escalades surlignées, `provisoire` grisé), panneau coût, panneau messages, panneau final avec téléchargements.

Onglet **Inventaire** : §6.1.

EX-UI-1 : mode simulation disponible pour BKK (fixtures). Pour CDG et NOU, le mode simulation affiche « fixtures non disponibles pour cette escale » et propose le dry-run (URL construites, aucun agent).
EX-UI-2 : après fermeture / réouverture de l'onglet, l'état complet est restitué (snapshot).
EX-UI-3 : double lancement → 409 affiché proprement. Annulation propre.

---

## 11. Sécurité, RGPD, souveraineté

- INV-4, INV-5, INV-9 (voir §2.3).
- Proxy captures : paramètres = clés d'état internes → aucune SSRF possible.
- Aucune donnée passager écrite dans les journaux d'agents ni dans les événements `agent_thought`.
- Point d'entrée Agents API européen `[À CONFIRMER]` ; variable d'environnement dédiée, documentée dans le README.
- Les fichiers `out/` contenant des données passagers (plan, messages) restent locaux et sont exclus de git (`.gitignore`).
- Trajectoire v3 (hors périmètre) : Holo3.1 en poids ouverts auto-hébergé sur GPU H100 Scaleway.

---

## 12. CLI, tests et vérification

### 12.1 CLI `tools/rebooking-v2.mjs`

```
--dry-run                    construit URL, nflt, dossiers, besoins ; n'appelle aucun agent
--offline <fixtures.json>    rejoue relevés + inventaire de fixtures → plan, rapport, messages, coût, 0 €
--station BKK|CDG|NOU        défaut BKK
--probe-discovery            1 session de découverte (payant, phase 5)
--probe-releve <n>           n sessions de relevé (payant, phase 5)
--probe-capacity <url> --rooms <n>   1 sonde de capacité (payant, phase 5)
--probe-inventaire --max <n> Étage 0 limité (payant, phase 5)
(sans option)                run complet (payant, phase 6)
```

### 12.2 Tests unitaires hors ligne (`node --test`)

| Domaine | Cas |
|---|---|
| policy | défauts valides ; plafond effectif × facteur escale ; conformité 3 niveaux ; `non_precise` → PARTIELLE |
| stations | 3 fiches valides ; fiche invalide rejetée ; `buildNflt` sans `distance=` pour NOU |
| inventaire | merge sans écraser le manuel ; drapeaux conservés ; `isStale` ; ordre des candidats ; `company_payment_possible` |
| dossiers | tiers + surcouches ; famille 2A+3C → deux chambres même hôtel ; nourrissons sans capacité |
| allocate | J-PMR (surclassement), PARTIELLE faute de mieux, plafond ± dérogation, épuisement → escalade, dédup tarifaire, borne `rooms_available_max` |
| capacite | `detectCap` ; `planExtension` respecte bornes (sessions, vagues, coût) ; sonde avant candidats ; arrêt propre |
| reglement | 3 modes ; carte désactivée + paiement impossible → escalade |
| cout | somme par tier ; projection N nuits ; `not_determinable` ; borne haute 32 900 € pour 34/24/266 aux plafonds par défaut |
| messages | FR et EN par dossier ; 3 variantes ; placeholders tous résolus ; aucun `{{` résiduel |
| prompts | INV-5 : aucune valeur passager dans aucun prompt |
| passagers | seed 42 A330 → CSV identique à `data/passagers-test.csv` |

### 12.3 Vérification de bout en bout (phase 6)

1. `node --test` vert.
2. `rebooking-v2 --offline` → plan avec `conformite` et `mode_reglement`, messages FR/EN, coût.
3. UI en mode simulation, BKK : formulaire, génération A350 (324 passagers), run simulé ~90 s complet, fermeture / réouverture → snapshot, double-run → 409, annulation propre.
4. Probes réels (phase 5) archivés comme fixtures.
5. Run complet réel BKK depuis l'UI, chronométré, coût lu sur le bandeau ; plan, rapport, messages, coût téléchargés.

---

## 13. Coûts et bornes (base mesures 31/08)

| Poste | Attendu |
|---|---|
| Inventaire (Étage 0, 10 hôtels) | ~1 session découverte + ~10 relevés hôtel courts ; à mesurer en phase 5 |
| Découverte (si exécutée) | ~6-12 min, ~0,21 $ |
| Relevés (5 sessions, 2 vagues de 3) | ~10-22 min, ~1,35 $ |
| Extension | bornée par `max_sessions_per_run` (18), `max_waves` (4), `max_cost_usd_per_run` (10 $) ; bornes éditables dans l'UI |
| Run complet réel | objectif < 30 min ; coût sans plafond imposé, lu en direct sur le bandeau (attendu < 5 € avec extension) |
| Mode simulation | ~90 s, 0 € |

Boutons de réglage : `max_hotels_stage_b` 5 → 4, `maxSteps` B 45 → 40, `n_socle` 8 → 6, `agents.concurrency` et `agents.stagger_ms`.

---

## 14. Risques et parades

| Risque | Parade |
|---|---|
| Candidat découvert puis indisponible | substitution par le code (candidat suivant) |
| Anti-bot sur pages de résultats | repli filtres UI, puis `network.managedProxy` ; jamais de contournement CAPTCHA |
| Paramètres `no_rooms` non concluants | sonde désactivée, extension par candidats suivants seulement |
| Véracité équipements / paiement | « déclaré par la plateforme », `non_precise` = à confirmer |
| Plafond 9 chambres / type | borne basse + sonde + extension + escalade chiffrée |
| Pannes WebDriver | rattachement par id avant relance, retry × 1 |
| Dérive de coût | bornes visibles, arrêt d'extension à la main |
| Fiche escale hors BKK sans fixtures | dry-run, mention explicite dans l'UI |
| Clé API exposée | jamais côté navigateur, `.gitignore`, variable d'environnement |

---

## 15. Hypothèses à confirmer (résumé)

| Id | Hypothèse | Impact |
|---|---|---|
| H-1 | Règle `company_payment_possible` (§5.3) | validée le 14/09 |
| H-2 | Bornes d'extension | fixées le 14/09 : 18 sessions / 4 vagues / 10 $, éditables |
| H-3 | Sonde de capacité via `no_rooms` / `group_adults` | à trancher en phase 5 |
| H-4 | Inventaire périmé après 30 jours ; dates de référence J+14, 1 nuit | valeur de départ, éditable |
| H-5 | Transfert NOU 75 min, facteur de prix CDG 1,0 | valeurs de départ, éditables |
| H-6 | Point d'entrée Agents API européen | confirmé le 14/09 ; nom de l'option du SDK TS à relever en phase 0 |
| H-7 | Montants repas / transport par passager | pas de montant fixé le 14/09 : champs vides par défaut (« non renseigné »), saisissables dans l'UI |
| H-8 | Environnement | dépôt `pax-hotel` (vide) ; OS et version Node relevés en phase 0 |
| H-9 | Concurrence maximale et modèles sélectionnables sur le plan H | à lire en phase 0 (page « Plans and limits ») et à mesurer en phase 5 |

---

## 16. Décisions de vitesse et de puissance (14/09)

| Levier | Décision |
|---|---|
| Concurrence des sessions | `agents.concurrency = auto` : maximum autorisé par le plan H, plafond 6. Repli automatique à 3 sur file d'attente ou erreur 429. |
| Décalage entre sessions | 10 s par défaut, retour à 25 s en repli. |
| Modèle des agents A/B | le modèle Holo le plus capable sélectionnable sur le plan (Holo3 122B si proposé, sinon Holo3.1 35B). |
| Modèle des sondes | modèle rapide (classe `web-surfer-flash`) : tâches courtes, une page. |
| Parallélisme des étages | découverte et relevés des hôtels contractés/préférés démarrent en parallèle quand l'inventaire existe. |
| Bornes d'extension | 18 sessions, 4 vagues, 10 $, éditables ; aucune borne cachée. |
| Hébergement | instance Scaleway `fr-par` (proche du point d'entrée européen H), voir §17. |
| GPU | non requis pour la démo. Réservé à l'auto-hébergement Holo3.1 en v3. |

Toute valeur lue sur la page « Plans and limits » du compte H (concurrence, modèles, quotas) est consignée dans `ETAT.md` en phase 0 et remplace les défauts ci-dessus.

## 17. Déploiement Scaleway (phase 7)

- Instance CPU généraliste, zone `fr-par`, Ubuntu 24.04, 8 vCPU / 32 Go (large marge ; le serveur est léger).
- Node ≥ 22 via NodeSource ; clone de `pax-hotel` ; `npm ci` sous `hai-admin-mcp/`.
- Variables dans `/etc/pax-hotel.env` (mode 600) : `HAI_API_KEY`, `HAI_API_BASE_URL` (EU), `PORT=4310`, `BIND=127.0.0.1`.
- Service `systemd` `pax-hotel.service` (`Restart=always`, `EnvironmentFile`).
- Accès : reverse proxy Caddy avec HTTPS automatique et authentification basique, ou tunnel SSH. Le serveur reste lié à `127.0.0.1`.
- Sauvegarde des sorties `out/` et `data/inventaire/` par `rsync` vers le poste de l'opérateur avant la démo.
- Vérification : run simulé distant complet, puis run réel BKK depuis le navigateur du client.

## 18. Glossaire

| Terme | Définition |
|---|---|
| IROPS | Irregular Operations, aléas d'exploitation |
| GHA | Ground Handling Agent, prestataire d'assistance en escale |
| PMR | Passager à mobilité réduite |
| UM | Mineur non accompagné |
| Tier | Niveau de service d'hébergement, égal à la cabine (J, W, Y) |
| Surcouche | Règle additionnelle cumulable (PMR, famille) |
| Étage 0 / A / B / C | Inventaire / Découverte / Relevés / Extension |
| Sonde de capacité | Session courte vérifiant la disponibilité d'un nombre de chambres supérieur au plafond d'affichage |
| Escalade DESK | Ligne du plan renvoyée à un traitement humain, avec motif et quantité |

---

## 19. Amendements datés (21/09 et 23/09/2026)

Ce cahier des charges est aussi un document historique : les sections d'origine ne sont pas réécrites.
Les amendements ci-dessous disent ce que le code fait **réellement** là où il a dépassé la spécification.
En cas de contradiction, ce sont eux qui font foi.

### 19.1 — §5.5bis · Liste passagers : format PAXLIST

Le §5.5 décrit les colonnes du générateur v1/v2. La porte d'entrée nominale est désormais l'**ingestion
d'une liste de compagnie au format PAXLIST** (`lib/paxlist.mjs`, ~1 000 lignes) : décodage BOM / UTF-16 /
repli windows-1252, parseur RFC 4180 borné, détection de séparateur, alias d'en-têtes et de valeurs,
schéma `zod` par ligne, rapport d'ingestion bloquant. **28 colonnes canoniques** (`PAXLIST_COLS`), dont
sept d'identité pour les fiches C3. Spécification de référence : `docs/format-liste-passagers.md`.
Fichiers remis à la compagnie : `data/exemples/paxlist-{modele-a-remplir,exemple,dictionnaire-colonnes}.csv`
— les trois portent exactement les mêmes 28 colonnes, verrouillé par test.

> **Corrigé le 23/09/2026.** Cet amendement annonçait **26** colonnes : c'était le compte de la v2, au
> matin du 21/09. Le second chantier du même jour a porté le format en **v3** en ajoutant
> `vol_correspondance` et `heure_correspondance` — les deux colonnes dont dépend le budget de trajet
> (§19.6). Le code, les trois fichiers remis à la compagnie et `docs/format-liste-passagers.md` portent
> 28 colonnes ; seul ce paragraphe était resté à 26, ce qui aurait conduit un export bâti sur le CDC à
> omettre exactement les colonnes qui protègent les correspondances.

### 19.2 — §5.7bis · Ligne du plan : 36 colonnes

Le §5.7 décrit « colonnes v1 + `conformite` ». La liste effective est `PLAN_COLS`
(`hai-admin-mcp/lib/rapport.mjs`), **36 colonnes**. Les dix-sept ajoutées portent les réserves C2, C3,
C6 et C7, et ce sont elles qui empêchent de lire une ligne comme acquise :

- C2 — `pax`, `hotel_url`, `hors_plan`, `sous_reserve`, `stock_mesure`, `chambres_fermes`,
  `chambres_a_confirmer`, `couchages_insuffisants`, `couchages_manquants` ;
- C3 — `format_cabine` ;
- C6 — `creneau_presentation`, `reglement_source`, `reglement_paiement_compagnie` ;
- C7 — `carte_montant`, `carte_devise`, `carte_nb`, `carte_incomplet`.

Une cellule vide n'est jamais un zéro : un montant non calculable s'écrit « non calculable », une donnée
jamais relevée « [non relevé] », une ventilation inconnue « indéterminée ».

### 19.3 — §8bis · Sorties : 9 livrables

Le §8 en liste six. Un run avec découverte en produit **neuf** :
`plan-<run>.csv`, `rooming-<run>.csv` (liste d'appel PAR HÔTEL), `fiches-<run>.csv` et
`fiches-<run>.html` (**C3** : une fiche d'enregistrement par personne, imprimable A4),
`rapport-<run>.md`, `messages-<run>.csv`, `cout-<run>.json`, `candidats-<run>.json`,
`releves-<run>.json`. Un rejeu `--offline` en écrit huit (pas de découverte).
Écrits à côté sans être des livrables : `run-<run>.state.json` (NOMINATIF, non téléchargeable),
`validation-<run>.json` (journal append-only C6), `pax-<run>.json` (empreinte non nominative de la liste),
`retention.log`.

### 19.4 — §2.2bis · Validation humaine (C6) : dans l'outil

Le §2.2 place la validation du plan hors de l'outil. Elle y est entrée : écran de validation,
`POST` / `GET /api/validation`, journal append-only `out/validation-<runId>.json` portant la décision,
son horodatage, l'empreinte SHA-256 du plan réellement affiché, les lignes écartées avec leur motif et la
**portée** de l'identité du validateur (authentifiée derrière un proxy déclaré de confiance, déclarée
seulement, ou absente — le serveur n'authentifie personne lui-même).
**Restent hors de l'outil, par invariant : l'appel aux hôtels, la confirmation et la réservation (INV-1).**

### 19.5 — §11bis · Rétention

`policy.retention.{nominative_hours, purge_on_start}` gouverne trois purges du répertoire `out/` :
au démarrage du serveur, à la fin d'un run, et sur demande de l'opérateur. Les trois utilisent la
politique du **dernier run lancé**. Chaque purge écrit le seuil ET sa provenance dans `out/retention.log`.
`rapport-<run>.md` est classé nominatif mais **volontairement non purgé** : arbitrage client non rendu,
dit à chaque purge. La CLI `rebooking-v2` ne purge rien.

### 19.6 — §7bis · Ordre de traitement : politique de prise en charge et couronnes (21/09/2026)

Le §7 et la matrice d'affectation d'origine fixaient un ordre de files **figé** : `pmr → famille →
J → W → Y`, et la distance n'entrait que dans un score de tri, **jamais dans l'affectation**. Le champ
« priorités » de l'UI était un texte libre **sans effet** : toute autre valeur était ignorée en silence.

Ce qui fait foi désormais :

- `policy.global.prise_en_charge` porte **13 critères cochables** (`CRITERE_KEYS`), chacun avec un
  **rang** (ordre de service) et une **proximité** (`stricte` / `preferee` / `aucune`). Un critère
  `departage: true` (Flying Blue) **ne crée jamais de file** ; il départage à l'intérieur d'une file.
  Une politique enregistrée avant le 21/09 retombe sur « proximité : aucune », c'est-à-dire
  l'ancien comportement.
- `policy.global.correspondance` : avance avant vol 120 min, repos minimal 240 min, marge 30 min,
  seuil « serrée » 480 min.
- **`dossier.trajet_max_min` est une CONTRAINTE DURE** qu'aucun rang n'outrepasse :
  `(fenêtre − avance − marge − repos_minimal) / 2`, divisé par deux pour l'aller ET le retour. Les
  hôtels hors budget sont retirés **avant** toute passe. `≤ 0` → escalade « correspondance trop
  serrée ». **Pas d'horaire = aucune contrainte, jamais de budget inventé.** Chaque dossier porte une
  `explication` en toutes lettres.
- `station.search.couronnes[]` + `couronnesDe(station)` : les **temps de trajet sont DÉCLARÉS par
  l'exploitation, jamais mesurés** — aucun service de routage, aucune conversion d'une distance en
  durée. Un hôtel dont la couronne est indéterminée est rattaché **par prudence** à la plus lointaine.
- Traçabilité au plan : `couronne`, `couronne_source`, `couronne_trajet_min_declare`, `trajet_max_min`.
  Restitution par couronne au rapport, aux fiches et à l'écran de validation.

Document de référence tenu à jour : `docs/matrice-affectation.md`
§ « Politique de prise en charge ».

**Ce que la politique ne fait pas** : elle décide **qui** va loin et qui n'en a pas le droit ; elle ne
fabrique pas les chambres manquantes. Mesuré à BKK, les trois couronnes ouvertes ne suffisent pas.

### 19.7 — §2.2bis · Approvisionnement du vivier par API hôtelière (22-23/09/2026)

Le §2.2 plaçait les « API hôtelières B2B » hors périmètre. Une **API hôtelière en libre-service**
(inscription immédiate, sans contrat ni volume minimum) y est entrée, le client ayant écarté les
passerelles B2B contractuelles pour raison de coût.

Motif : le point bloquant « vivier insuffisant » avait une cause que la lecture d'écran ne pouvait pas
lever — **le sélecteur de quantité des plateformes grand public plafonne à 9 chambres**. Les 111
chambres indicatives, c'était 12 hôtels multipliés par ce plafond.

- Livré : `lib/liteapi.mjs`, `tools/liteapi-releves.mjs`, `tools/sonde-api.mjs`, `test/liteapi.test.mjs`.
  Une seule modification du code existant : `source: z.enum([…, "api"])` dans `lib/inventaire.mjs` — une
  entrée venue d'une API ne se déclare pas « agent ».
- **INV-1 et INV-2 intacts** : ni `prebook`, ni `book`, ni moyen de paiement ; aucune émulation de
  navigateur. INV-3 intact : prix publics. INV-8 non concerné : aucune session d'agent.
- L'UI construit le vivier **en mémoire** et rejoue par le chemin déjà testé du mode hors ligne ;
  l'inventaire versionné n'est pas modifié.
- Trois règles nées de la mesure, câblées et testées : `limit` ≤ 40 · tout appel rejoué · **un zéro est
  recoupé à `limit` plus bas avant d'être cru** (l'API répond « no availability found » au lieu d'une
  erreur).
- **Réserve** : mesuré sur **clé de bac à sable** (`"sandbox": true`). Le protocole est prouvé, le stock
  ne l'est pas.
- **Reste à trancher** : `prebook` (blocage d'inventaire 5 à 15 min à tarif garanti, **sans réserver**)
  tombe-t-il ou non sous INV-1 ?
