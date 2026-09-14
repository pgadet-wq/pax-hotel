# Cahier de prompts — Claude Code, démo v2 « Hébergement d'urgence à agents Holo »

Tous les prompts se collent tels quels dans Claude Code, ouvert depuis la racine du clone `pax-hotel`. Une conversation par phase.

## Mode d'emploi

Deux façons de conduire une phase :

- **Mode phase** : un prompt d'ouverture, Claude Code déroule toute la fiche, un prompt de clôture. Rapide. Convient aux phases 0, 2, 6 et 7.
- **Mode item** : un prompt de cadrage, puis un prompt par item, puis le prompt de clôture. Plus de contrôle. Recommandé pour les phases 1, 3, 4 et 5.

Règles :

1. Coller les prompts dans l'ordre. Ne pas passer à l'item suivant tant que la vérification de l'item n'a pas été montrée.
2. Après chaque item, Claude Code rend compte en cinq lignes (fichiers, vérification, hypothèses, prochain item). Ce format est imposé par le prompt de cadrage.
3. Si Claude Code sort du périmètre, coller le prompt de recadrage (section « Prompts transverses »).
4. Avant `/compact`, coller le prompt de sauvegarde d'état.
5. Après deux corrections infructueuses sur le même point, coller le prompt de blocage, clore la conversation, rouvrir avec le prompt de reprise.

---

## Prompts transverses

**Recadrage**
```text
Tu sors du périmètre de l'item en cours. Annule les modifications hors périmètre (git checkout sur les fichiers concernés si nécessaire), reviens à l'item demandé, et rends compte au format en cinq lignes.
```

**Vérification exigée**
```text
Avant de conclure cet item, exécute la commande de vérification indiquée et colle sa sortie brute. Si elle échoue, corrige puis relance. Ne conclus pas sans une sortie verte.
```

**Sauvegarde d'état avant compaction**
```text
Mets à jour docs/cdc/ETAT.md maintenant : cases cochées de la fiche de phase, fichiers créés ou modifiés, commandes de vérification et leur résultat, hypothèses [À CONFIRMER] rencontrées, item en cours et ce qui lui manque. Puis attends. Je vais lancer /compact.
```
Puis, dans Claude Code :
```text
/compact conserve la liste des fichiers modifiés, les commandes de test, les hypothèses rencontrées et les cases restantes de la fiche de phase
```

**Hypothèse rencontrée**
```text
Ce point est une hypothèse [À CONFIRMER] du cahier des charges. Applique la valeur de départ du CDC, note-la dans ETAT.md (tableau des hypothèses, avec l'id H-n), et continue l'item. Ne me pose pas de question sur ce point.
```

**Blocage**
```text
Nous tournons en rond. Note le blocage dans docs/cdc/ETAT.md, section « Points bloquants » : symptôme, ce qui a été tenté, deux options de sortie avec leur coût. Ne choisis pas seul. Mets à jour les cases de la fiche de phase. Commit avec le message "wip(phase-N): blocage <sujet>". Puis arrête-toi : je rouvre une conversation.
```

**Reprise d'une phase interrompue**
```text
Lis docs/cdc/ETAT.md puis la fiche de la phase courante indiquée dedans. La phase est en cours. Reprends exactement à l'item noté « en cours », sans refaire les items cochés. Pour le point bloquant noté, applique l'option que je te donne ici : <option retenue>. Rends compte au format en cinq lignes après chaque item.
```

**Format de compte rendu (rappel)**
```text
Rappel du format de compte rendu après chaque item, en cinq lignes : 1) fichiers créés/modifiés, 2) commande de vérification exécutée et résultat, 3) hypothèses rencontrées, 4) écarts par rapport au CDC, 5) prochain item. Rien d'autre.
```

---

## Phase 0 — Rapatriement dans `pax-hotel`, audit, initialisation

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-0-audit-git.md. Exécute la phase 0 uniquement, dans l'ordre des tâches. Ne lance aucun agent, aucun appel réseau vers H. Quand tu arrives à la tâche « valeurs du compte H », demande-les moi et attends ma réponse. Termine par la mise à jour d'ETAT.md, le commit et le push indiqués, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md et docs/cdc/phases/phase-0-audit-git.md. Nous allons dérouler la phase 0 item par item : je te donne chaque item, tu ne fais que celui-là. Aucun agent, aucun appel réseau vers H. Après chaque item, rends compte en cinq lignes : fichiers, vérification et résultat, hypothèses, écarts CDC, prochain item. Confirme que tu as lu les trois fichiers en citant les dix invariants INV-1 à INV-10 en une ligne chacun.
```

**0.1 Présence du POC**
```text
Item 0.1. Vérifie que hai-admin-mcp/ contient le code du POC v1 : tools/rebooking.mjs, tools/generate-passengers.mjs, tools/collect-sessions.mjs, package.json, le CSV passagers de test et le relevé JSON du 1er septembre. Liste ce qui est présent et ce qui manque. Si tout est présent, supprime hai-admin-mcp/A_REMPLACER_PAR_LE_POC_V1.md. Si quelque chose manque, arrête-toi et dis-moi quoi.
```

**0.2 Arborescence et emplacements**
```text
Item 0.2. Liste l'arborescence réelle du dépôt (profondeur 3, sans node_modules). Compare avec CDC §4. Note les écarts dans ETAT.md. Relève l'emplacement réel de data/ et out/ du POC. Ne déplace rien : la v1 reste intacte (INV-6). Note dans ETAT.md que la v2 utilisera data/ et out/ à la racine du dépôt (CDC §4) et copiera les fixtures nécessaires.
```

**0.3 Environnement**
```text
Item 0.3. Relève et note dans ETAT.md : système d'exploitation, version de Node (≥ 22 attendu), version de npm. Exécute npm ci sous hai-admin-mcp/ et relève les versions installées de hai-agents et de zod. Si Node < 22, dis-le et propose la mise à niveau sans l'exécuter.
```

**0.4 Lecture du POC v1**
```text
Item 0.4. Lis hai-admin-mcp/tools/rebooking.mjs et hai-admin-mcp/tools/generate-passengers.mjs sans les modifier. Écris dans ETAT.md un résumé de dix lignes maximum : fonctions principales, schémas zod, options CLI, colonnes du CSV passagers, structure du relevé JSON du 1er septembre (chemins des champs chambres, prix, équipements). Ce résumé servira à la phase 1 pour reprendre l'allocation v1 par copie.
```

**0.5 SDK hai-agents**
```text
Item 0.5. Dans node_modules/hai-agents (types et README), relève : le nom exact de l'option de base URL du client TypeScript (pour viser https://agp.eu.hcompany.ai/api/v2), la signature de startSession, la forme de SessionHandle.stream et de waitForCompletion, la clé d'overrides pour start_url, la façon de désigner le modèle et les limites (maxSteps, maxTimeS) d'un agent personnalisé, et comment retrouver une session par id. Note tout dans ETAT.md avec les chemins de fichiers sources. N'exécute aucun appel réseau.
```

**0.6 Valeurs du compte H**
```text
Item 0.6. Demande-moi les valeurs de la page « Plans and limits » de mon compte H : concurrence maximale de sessions, modèles Holo sélectionnables pour un agent personnalisé, quotas. Attends ma réponse. Consigne-les dans ETAT.md, section « Valeurs lues sur le compte H ». Elles remplacent les défauts de CDC §16 ; note quelle valeur remplace quoi.
```

**0.7 Hygiène git et test vide**
```text
Item 0.7. Vérifie .gitignore (node_modules, out/, .env, clés). Exécute git status et confirme qu'aucune clé, aucun .env et aucun fichier out/ n'est suivi. Crée hai-admin-mcp/test/smoke.test.mjs avec un test node:test qui passe. Vérifie que npm test fonctionne depuis la racine. Colle la sortie.
```

**0.8 Commit et push**
```text
Item 0.8. git add -A, puis commit avec le message "chore(phase-0): POC v1 + pack CDC démo v2", puis git push -u origin sur la branche par défaut du dépôt. Colle la sortie du push et l'URL du commit.
```

**Clôture 0**
```text
Clôture de la phase 0. Mets à jour docs/cdc/ETAT.md : phase courante → 1, section « Fait » complète, hypothèses rencontrées, prochaine fiche docs/cdc/phases/phase-1-noyau-pur.md. Commit "chore(phase-0): clôture, ETAT.md" et push. Confirme en trois lignes puis arrête-toi. Je ferme cette conversation.
```

---

## Phase 1 — Noyau pur et tests hors ligne

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-1-noyau-pur.md et CDC §5.1, §5.4, §5.5, §5.7, §7, §8.1, §8.2, §12.2. Exécute la phase 1 uniquement. Aucun agent, aucun réseau, aucun import de hai-agents. Écris les tests avec chaque module. Termine par npm test vert, la mise à jour d'ETAT.md, le commit et le push indiqués, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-1-noyau-pur.md et CDC §5.1, §5.4, §5.5, §5.7, §7, §8.1, §8.2, §12.2. Nous déroulons la phase 1 item par item. Règles : modules ESM .mjs sous hai-admin-mcp/lib/, tests node:test sous hai-admin-mcp/test/ écrits avec chaque module, aucun import de hai-agents, aucune dépendance nouvelle, zod pour tout schéma. Après chaque item : compte rendu en cinq lignes (fichiers, vérification, hypothèses, écarts CDC, prochain item). Commence par lister les modules de la phase dans l'ordre où tu les feras, en une ligne chacun.
```

**1.1 CSV**
```text
Item 1.1. Crée hai-admin-mcp/lib/csv.mjs : parsePassagersCsv(text) (séparateur détecté virgule/point-virgule, BOM toléré, en-têtes conservés, erreurs explicites) et toCsvBom(cols, rows) (UTF-8 avec BOM, échappement des guillemets). Test : aller-retour identique sur trois lignes, une valeur avec virgule et une avec guillemet.
```

**1.2 Politique**
```text
Item 1.2. Crée hai-admin-mcp/lib/policy.mjs : PolicySchema zod conforme à CDC §5.1 (cabines J/W/Y, global, plus allowances, payment, extension, agents, inventory), DEFAULT_POLICY avec les valeurs de l'annexe A du rapport et de CDC §5.1, tierOf(dossier), conformityOf(hotel, tierPolicy) → CONFORME / PARTIELLE(missing[]) / NON_CONFORME selon EX-ALL-2, effectiveCaps(policy, station) selon EX-POL-1. negotiated_rates verrouillé à false (refus si true). Tests : défauts valides, plafond effectif × facteur, trois niveaux de conformité, non_precise → PARTIELLE, max_stars dépassé → surclassé et non exclu.
```

**1.3 Scénario**
```text
Item 1.3. Crée hai-admin-mcp/lib/scenario.mjs : DEFAULT_AVION {J:34, W:24, Y:266}, DEFAULT_SCENARIO conforme à CDC §5.4 (station BKK, 1 nuit, seed 42, simulate false, force_discovery false, next_update_minutes 30), mergeConfig(payload) qui valide et borne (nights 1 à 7, seed entier, sièges entiers ≥ 0). La validation de la station se fait par un injecteur listStations passé en paramètre (la fiche escale arrive en phase 2). Tests : défauts, bornes, station inconnue rejetée.
```

**1.4 Passagers**
```text
Item 1.4. Crée hai-admin-mcp/lib/passagers.mjs : generatePassengers({seats, seed, mix, pmrCount}) → {rows, csv, stats}, PRNG mulberry32 et compteur PNR locaux à l'appel, avion plein exact, colonnes identiques au CSV du POC v1 (voir ETAT.md item 0.4). Réécris hai-admin-mcp/tools/generate-passengers.mjs comme wrapper mince, défaut CLI inchangé (A330). Test de non-régression : seed 42 A330 → CSV identique octet pour octet au CSV passagers de test du POC. Colle la sortie du test.
```

**1.5 Dossiers**
```text
Item 1.5. Crée hai-admin-mcp/lib/dossiers.mjs : buildDossiers(rows, policy) regroupe par PNR, tier = cabine, surcouches pmr et famille cumulables (EX-POL-2), chambrage selon policy.global.rooming (unité 2A+2C, au-delà deux chambres même hôtel, nourrissons sans capacité) ; computeNeeds(dossiers) → chambres nécessaires par tier et par type (standard, familiale, accessible). Tests : famille 2A+3C → deux chambres même hôtel, PMR en Y → besoin accessible, nourrisson sans capacité, ordre intra-tier Flying Blue Gold+ d'abord.
```

**1.6 Règlement**
```text
Item 1.6. Crée hai-admin-mcp/lib/reglement.mjs : modeReglement(hotel, policy) → "compagnie" | "carte_prepayee" | "compagnie_a_confirmer" selon EX-ALL-6, à partir de hotel.payment.company_payment_possible ("oui" | "non" | "a_confirmer"). Carte désactivée et paiement impossible → retourne { mode: "ESCALADE", motif: "règlement" }. Tests : les quatre cas.
```

**1.7 Allocation**
```text
Item 1.7. Propose d'abord en dix lignes maximum le plan de hai-admin-mcp/lib/allocate.mjs : structures d'entrée (dossiers, inventories = relevés par hôtel avec rooms_available_max et cap_reached, policy, station), parcours EX-ALL-4, priorités, dédup tarifaire, colonnes de sortie CDC §5.7, gaps par tier. Attends mon accord avant de coder. Contraintes : fonction pure, rejouable (EX-ALL-1), borne rooms_available_max (EX-ALL-5), mode_reglement via reglement.mjs, hotel_source, provisoire, escalade avec motif et quantité.
```

**1.7b Allocation — implémentation**
```text
Plan validé. Implémente hai-admin-mcp/lib/allocate.mjs et ses tests : J-PMR surclassé, PARTIELLE choisie faute de mieux, plafond avec dérogation et sans dérogation, épuisement → escalade chiffrée, dédup des variantes tarifaires, borne rooms_available_max, rejouabilité (même entrée → même sortie), gaps corrects. Colle la sortie de npm test.
```

**1.8 Coût**
```text
Item 1.8. Crée hai-admin-mcp/lib/cout.mjs : computeCost(plan, policy, scenario) conforme à CDC §8.1 : per_night par tier et total, nights, projection_total, upper_bound_at_caps = Σ sièges × plafond effectif, allowances depuis policy.allowances (null → "non renseigné" et entrée dans not_determinable), escalated_rooms. Aucun montant estimé (EX-COU-1). Test : 34/24/266 aux plafonds par défaut → upper_bound_at_caps = 32900 ; not_determinable = ["repas","transport"] par défaut ; vide quand les montants sont renseignés.
```

**1.9 Messages**
```text
Item 1.9. Crée data/messages/fr.md et data/messages/en.md (gabarits avec les placeholders de CDC §8.2, trois variantes : affecté, provisoire, escalade, séparées par des en-têtes) et hai-admin-mcp/lib/messages.mjs : buildMessages(plan, station, scenario, policy) → un message FR et un EN par dossier, next_update_time = heure de génération + next_update_minutes, texte du mode de règlement et des repas selon la ligne du plan. Aucun LLM. Tests : chaque dossier a FR et EN, aucun "{{" résiduel, les trois variantes sont produites.
```

**1.10 Rapport**
```text
Item 1.10. Crée hai-admin-mcp/lib/rapport.mjs : buildPlanCsv(plan) (colonnes CDC §5.7, via toCsvBom), buildRapportMd(plan, inventories, ctx) (sections : scénario, escale, politique, inventaire utilisé, relevés horodatés, plan par tier, escalades, extension, coût, avertissements), buildMessagesCsv(messages) (pnr, lang, subject, body). Tests : en-têtes présents, une ligne par dossier, horodatage des relevés affiché.
```

**1.11 Fixtures**
```text
Item 1.11. Crée data/simulate/releves-demo.json à partir du relevé JSON du POC du 1er septembre (emplacement noté en phase 0), reformaté au schéma v2 de CDC §5.6 : ajoute payment (non_precise si absent), quantity_displayed_max et cap_reached par type de chambre (9 → true), observed_at, price_currency EUR. Écris un script hai-admin-mcp/tools/reformat-fixtures.mjs qui fait cette conversion de façon reproductible. Vérifie que le fichier valide releveSchema (défini localement pour ce test, hai.mjs arrive en phase 3).
```

**1.12 Bout en bout hors ligne**
```text
Item 1.12. Écris hai-admin-mcp/test/e2e-offline.test.mjs : génère 324 passagers (seed 42), construit les dossiers, charge data/simulate/releves-demo.json, alloue, calcule le coût, génère les messages et le rapport. Assertions : plan non vide avec conformite et mode_reglement, coût avec not_determinable, messages FR/EN sans placeholder résiduel, rapport contenant "Escalades". Colle la sortie de npm test complète (nombre de tests).
```

**Clôture 1**
```text
Clôture de la phase 1. npm test doit être vert : colle la sortie. Mets à jour docs/cdc/ETAT.md : phase courante → 2, « Fait » avec chaque fichier, hypothèses H-1 et H-7 notées comme appliquées, vérifications. Commit "feat(phase-1): noyau pur (policy, dossiers, allocate, reglement, cout, messages) + tests" et push. Confirme en trois lignes puis arrête-toi.
```

---

## Phase 2 — Fiches escale et inventaire hôtelier (hors ligne)

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-2-stations-inventaire.md et CDC §5.2, §5.3, §6.1, §6.2 (EX-DIS-3), §12.1. Exécute la phase 2 uniquement, hors ligne : aucun import de hai-agents, aucun agent. Les options payantes de tools/inventaire.mjs répondent « non disponible avant phase 3 ». Termine par npm test vert, ETAT.md, commit et push, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-2-stations-inventaire.md et CDC §5.2, §5.3, §6.1, §6.2, §12.1. Phase 2 item par item, hors ligne, aucun import de hai-agents. Compte rendu en cinq lignes après chaque item. Confirme d'abord en une phrase le principe : la trame ne change pas, seule la fiche escale porte ce qui varie d'une destination à l'autre.
```

**2.1 Fiches escale**
```text
Item 2.1. Crée hai-admin-mcp/lib/stations.mjs (StationSchema zod conforme à CDC §5.2, loadStation(code), listStations() triée par demo_priority, DEFAULT_STATION "BKK", erreur explicite si fiche invalide) et data/stations/BKK.json, CDG.json, NOU.json avec les valeurs du tableau CDC §5.2. fallback_hotels de BKK = les quatre URL de la liste v1 de tools/rebooking.mjs. Branche listStations dans scenario.mergeConfig. Tests : trois fiches valides, fiche invalide rejetée, tri par demo_priority, NOU a distance_ref zone_center et use_distance_filter false.
```

**2.2 Inventaire — module**
```text
Item 2.2. Crée hai-admin-mcp/lib/inventaire.mjs : InventaireSchema et InventaireHotelSchema conformes à CDC §5.3, loadInventaire(code) (fichier absent → inventaire vide valide), mergeInventaire(existing, fresh) selon EX-INV-1 (jamais toucher aux enregistrements source manuel, conserver contracted/preferred/excluded), isStale(inv, policy) selon EX-INV-2, candidatesFrom(inv, policy, needs) selon EX-INV-3 (ajout des fallback_hotels en fin), computeCompanyPaymentPossible(hotel) selon EX-INV-4. Tests : merge sans écraser le manuel, drapeaux conservés, isStale à 31 jours, ordre contracted → preferred → score, les trois valeurs de company_payment_possible.
```

**2.3 Inventaire — données**
```text
Item 2.3. Crée data/simulate/inventaire-demo.json (BKK, construit depuis data/simulate/releves-demo.json, hôtels source agent, capacity_hint renseigné) et data/inventaire/BKK.json initial identique, plus data/inventaire/CDG.json et NOU.json vides et valides. Ajoute une entrée source manuel de test dans BKK.json (hôtel fictif « Hôtel Test Contracté », contracted true) pour prouver EX-INV-1 à l'item 2.5.
```

**2.4 URL et filtres**
```text
Item 2.4. Crée hai-admin-mcp/lib/hai-urls.mjs, pur, sans import de hai-agents : buildNflt(policy, station) (filtres CDC §3 ; pas de distance= quand use_distance_filter est false ; ajout de station.search.extra_nflt), buildSearchUrl(policy, station, scenario), buildHotelUrl(candidate, scenario) (toujours selected_currency=EUR, dates), buildProbeUrl(hotel, checkin, nights, no_rooms, group_adults). Tests : NOU sans distance=, BKK avec distance=5000, devise EUR partout, probe avec no_rooms et group_adults = 2 × no_rooms.
```

**2.5 Outil inventaire — hors ligne**
```text
Item 2.5. Crée hai-admin-mcp/tools/inventaire.mjs : --station (défaut BKK), --dry-run (affiche zone, nflt, URL de recherche, nombre d'hôtels de l'inventaire courant, état périmé ou non), --offline <fixtures> (merge dans data/inventaire/{code}.json). --refresh et --max répondent « non disponible avant phase 3 » et sortent avec le code 2. Vérifications à coller : node hai-admin-mcp/tools/inventaire.mjs --station NOU --dry-run (URL sans distance=) ; node hai-admin-mcp/tools/inventaire.mjs --station BKK --offline data/simulate/inventaire-demo.json puis preuve que l'entrée manuelle « Hôtel Test Contracté » est intacte.
```

**2.6 Branchement dans l'allocation**
```text
Item 2.6. Branche effectiveCaps(policy, station) et station.search.radius_km dans allocate.mjs et dans le score (EX-ALL-3). Le plan affiche transfert (mode et max_transfer_min de la fiche) selon CDC §5.7. Ajoute un test : même relevés, facteur de prix 1,5 → un hôtel HORS_BAREME devient CONFORME.
```

**Clôture 2**
```text
Clôture de la phase 2. npm test vert : colle la sortie. ETAT.md : phase courante → 3, « Fait », hypothèses H-3 (URL de sonde à vérifier en phase 5), H-4, H-5 notées. Commit "feat(phase-2): fiches escale multi-destination + inventaire hôtelier hors ligne" et push. Confirme en trois lignes puis arrête-toi.
```

---

## Phase 3 — Agents Holo : découverte, relevés, sonde, extension (sans exécution payante)

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md (signatures SDK et valeurs du compte H relevées en phase 0) puis docs/cdc/phases/phase-3-agents-holo.md et CDC §5.6, §5.8, §6.2 à §6.6, §7, §12.1, §16. Exécute la phase 3 uniquement. Aucune session payante : les commandes payantes existent mais refusent de s'exécuter sans DEMO_ALLOW_PAID=1, et tu ne poses jamais cette variable. Tests avec un client factice. Termine par npm test vert, ETAT.md, commit et push, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-3-agents-holo.md et CDC §5.6, §5.8, §6.2 à §6.6, §7, §12.1, §16. Phase 3 item par item. Interdits absolus : session payante, variable DEMO_ALLOW_PAID, modification de tools/rebooking.mjs, donnée passager dans un prompt (INV-5). Compte rendu en cinq lignes après chaque item. Commence par me citer, depuis ETAT.md, la signature de startSession, la clé d'overrides pour start_url, l'option de base URL et la concurrence maximale du compte.
```

**3.1 Client et schémas**
```text
Item 3.1. Crée hai-admin-mcp/lib/hai.mjs : readApiKey() (HAI_API_KEY obligatoire, erreur claire sinon), createClient() avec base URL européenne depuis HAI_API_BASE_URL (défaut https://agp.eu.hcompany.ai/api/v2, option SDK relevée en phase 0), ensureAgentV2({station, policy}) qui crée ou retrouve l'agent « hotel-scout-{code}-v2 » avec le modèle de policy.agents.model_stage_ab résolu selon ETAT.md (« auto » → le plus capable du compte), sans toucher à l'agent v1. Schémas zod : discoverySchema, releveSchema (CDC §5.6), probeSchema, inventaireHotelSchema. Réexporte hai-urls.mjs. Test hors ligne : les schémas valident les fixtures et rejettent un relevé sans observed_at.
```

**3.2 Événements**
```text
Item 3.2. Crée hai-admin-mcp/lib/events.mjs : forme d'événement plate {id, ts, runId, station, type, payload} pour tous les types de CDC §5.8, et translateSessionEvent(sessionEvent, ctx) qui traduit policy_event → agent_thought (texte ≤ 400 caractères, action), observation_event → screenshot (signal seul, hotel et seq), MetricsUpdateEvent → metrics agrégé, LiveViewUrlEvent et AgentRunStatusChangeEvent → agent_status. Tests : chaque traduction sur un événement simulé ; aucun champ passager ne peut apparaître (le traducteur ne reçoit jamais de dossier).
```

**3.3 Découverte**
```text
Item 3.3. Crée hai-admin-mcp/lib/discovery.mjs : runDiscovery({client, policy, station, scenario, emit, signal}) conforme à CDC §6.2 : une session, start_url via overrides, deux passes par édition d'URL nflt (socle Y puis premium), lecture des cartes seulement, maxSteps 35, maxTimeS 800, answerSchema = discoverySchema, retry × 1 avec rattachement par id, repli sur station.fallback_hotels avec événement warning. shouldRunDiscovery({inventory, policy, needs, scenario}) selon EX-DIS-1. Le prompt est un squelette FR paramétré (zone, filtres) rappelant INV-1 et INV-2. Tests avec client factice : deux passes émises, retry sur échec, repli sur fallback, shouldRunDiscovery dans les quatre cas.
```

**3.4 Relevés**
```text
Item 3.4. Crée hai-admin-mcp/lib/releve.mjs : runReleve({client, candidate, scenario, policy, station, emit, signal, attempt}) session démarrée sur la fiche hôtel, chambres puis équipements puis paiement, answerSchema = releveSchema, maxSteps 45, maxTimeS 900 ; runReleves({candidates, concurrency, staggerMs, ...}) avec concurrence = policy.agents.concurrency résolue (auto → valeur du compte, plafond 6), décalage policy.agents.stagger_ms, repli automatique à 3 et 25000 ms sur file d'attente ou 429, retry × 1 avec rattachement par id, interdiction de substituer, found=false → candidat suivant du tier et warning (EX-REL-3, EX-REL-4). Tests avec client factice : ordre contracted → preferred → score, décalage respecté, substitution par le code, repli de concurrence sur 429.
```

**3.5 Capacité**
```text
Item 3.5. Crée hai-admin-mcp/lib/capacite.mjs : detectCap(releve) (EX-REL-1), planExtension({gaps, surveyed, candidates, policy, limits}) pure, qui renvoie la vague suivante (sondes à faire sur les hôtels cap_reached compatibles non sondés si probe_same_hotel_first, puis lot de candidats non relevés, taille = batch_size résolue) ou null si bornes atteintes (max_waves, max_sessions_per_run, max_cost_usd_per_run), et runProbe({client, hotel, requestedRooms, ...}) session courte sur buildProbeUrl avec le modèle policy.agents.model_probe, answerSchema = probeSchema, EX-EXT-5. Tests : planification sonde puis lot, arrêt propre à chaque borne, probe_same_hotel_first false → aucun sondage.
```

**3.6 Orchestrateur**
```text
Item 3.6. Propose d'abord en dix lignes le plan de hai-admin-mcp/lib/pipeline.mjs : runPipeline({client, policy, station, scenario, dossiers, emit, signal, collectFn}) avec les phases CDC §5.8 dans l'ordre (preparation → generation → besoins → inventaire → discovery ou discovery_skipped → releves → allocation → extension 0..n → sorties → done), allocation rejouée après chaque relevé et chaque sonde, boucle d'extension CDC §6.4, parallélisme des relevés contractés/préférés avec la découverte quand l'inventaire existe (CDC §16), collectFn injectable pour la simulation, annulation totale et annulation d'extension par signal. Attends mon accord avant de coder.
```

**3.6b Orchestrateur — implémentation**
```text
Plan validé. Implémente hai-admin-mcp/lib/pipeline.mjs et ses tests avec client factice : scénario nominal sans extension ; scénario où le relevé n°1 atteint le plafond → sonde puis lot de candidats ; scénario bornes atteintes → escalade chiffrée dans le plan ; annulation d'extension seule → plan conservé ; annulation totale → état cancelled ; discovery_skipped quand l'inventaire est frais et suffisant. Colle la sortie de npm test.
```

**3.7 Inventaire par agents**
```text
Item 3.7. Câble dans hai-admin-mcp/tools/inventaire.mjs les options --refresh et --max (défaut 10) selon EX-INV-5 à EX-INV-7 : découverte puis relevé hôtel court par candidat (équipements, paiement, prix indicatif, capacité observée), concurrence et décalage de policy.agents, écriture via mergeInventaire, groupId inv-{code}-{runId}. Garde INV-8 : refus sans DEMO_ALLOW_PAID=1 avec message explicite. Test avec client factice : dix candidats → dix relevés courts → inventaire fusionné, entrée manuelle intacte.
```

**3.8 Prompts et INV-5**
```text
Item 3.8. Regroupe les quatre squelettes de prompts FR (découverte, relevé enrichi, inventaire hôtel, sonde de capacité) dans hai-admin-mcp/lib/prompts.mjs, chacun avec la méthode URL d'abord et filtres UI en repli, la règle « déclaré par la plateforme, ne rien déduire, non_precise sinon », et les garde-fous INV-1 et INV-2. Test EX-PRO-1 : construis chaque prompt avec 324 passagers générés et vérifie qu'aucune valeur d'aucune colonne passager (PNR, noms, statuts, contacts) n'apparaît dans aucun prompt.
```

**3.9 CLI v2**
```text
Item 3.9. Crée hai-admin-mcp/tools/rebooking-v2.mjs conforme à CDC §12.1 : --dry-run (besoins par tier, inventaire utilisé, décision découverte, URL des cinq premiers relevés, plan d'extension théorique, aucun appel réseau), --offline <fixtures> (plan, rapport, messages, coût, sorties out/*-{runId}.*), --station, et les options payantes (--probe-discovery, --probe-releve, --probe-capacity, --probe-inventaire, run complet) qui refusent sans DEMO_ALLOW_PAID=1. Vérifications à coller : node hai-admin-mcp/tools/rebooking-v2.mjs --dry-run --station BKK ; node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json puis ls out/.
```

**Clôture 3**
```text
Clôture de la phase 3. npm test vert : colle la sortie. ETAT.md : phase courante → 4, « Fait », hypothèses H-3 et H-9 notées, concurrence et modèle résolus. Commit "feat(phase-3): pipeline agents (découverte, relevés, sonde, extension) en dry-run/offline" et push. Confirme en trois lignes puis arrête-toi.
```

---

## Phase 4 — Serveur, SSE, interface, mode simulation

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-4-serveur-ui-simulation.md et CDC §5.8, §9, §10, §11. Exécute la phase 4 uniquement. demo/ n'importe que des builtins node: et ../hai-admin-mcp/lib/ (INV-7). Aucune dépendance, aucune session payante, jamais innerHTML avec du texte d'agent (INV-9). Vérifie l'UI en mode simulation avant de clore. Termine par npm test vert, ETAT.md, commit et push, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-4-serveur-ui-simulation.md et CDC §5.8, §9, §10, §11. Phase 4 item par item. Contraintes : demo/ en builtins node: uniquement, serveur node:http natif sur 127.0.0.1:4310, UI vanilla en français sans build, textContent pour tout texte d'agent, aucune session payante. Compte rendu en cinq lignes après chaque item. Commence par lister les routes de CDC §9 et les types d'événements de CDC §5.8 pour confirmer ta lecture.
```

**4.1 Bus SSE**
```text
Item 4.1. Crée demo/sse-hub.mjs : bus d'événements avec id monotone, tampon circulaire de 1000 événements, relecture depuis Last-Event-ID, événement snapshot (état complet re-rendable) quand l'id demandé est sorti du tampon, ping toutes les 15 s, gestion propre des déconnexions. Test node:test : relecture après perte, snapshot après dépassement du tampon.
```

**4.2 Gestionnaire de run**
```text
Item 4.2. Crée demo/run-manager.mjs : singleton {state idle|running|done|error|cancelled, runId, station, phase, agents, plan, metrics, extension, outputs} ; start({policy, avion, scenario, simulate}) → 202 ou 409 si run en cours ; collectFn injectable (réel ou simulé) ; cancel() et cancelExtension() ; toutes les transitions émettent sur le bus. Test : double démarrage → 409, annulation d'extension conserve le plan, snapshot complet.
```

**4.3 Pompe de session**
```text
Item 4.3. Crée demo/session-pump.mjs : pour une session donnée, for await sur handle.stream({until:"settled"}) → translateSessionEvent → bus, PUIS waitForCompletion (jamais en parallèle du stream), throttle des captures à une toutes les deux secondes par agent avec la dernière toujours émise, rattachement par id en cas d'échec de suivi. Le client réel est câblé en phase 5 : ici, un client factice suffit pour le test.
```

**4.4 Simulation**
```text
Item 4.4. Crée demo/simulate.mjs : collectFn simulé rejouant data/simulate/releves-demo.json et data/simulate/inventaire-demo.json avec des pensées scriptées en français, trois ou quatre captures PNG dans demo/sim-assets/ (génère des PNG simples par code si aucune capture n'est disponible), une extension simulée en vague 1 (une sonde et un relevé), durée totale d'environ 90 s, coût zéro. Le mode simulation n'est disponible que pour BKK ; pour une autre escale, il retourne une erreur explicite « fixtures non disponibles » (EX-UI-1).
```

**4.5 Serveur**
```text
Item 4.5. Propose d'abord en dix lignes la structure de demo/server.mjs (switch méthode + chemin, helpers sendJson/readBody, liste blanche des statiques, liste blanche des téléchargements, proxy de captures par clés d'état internes avec Cache-Control private, SSE branché sur le bus). Attends mon accord. Puis implémente toutes les routes de CDC §9, y compris /api/stations, /api/inventaire/:code (GET, PUT, POST run, POST hotel), /api/messages, /api/cout, /api/cancel-extension. Vérification : curl sur /api/config, /api/stations, /api/state et un run simulé lancé par curl avec suivi de /api/events pendant dix secondes ; colle les sorties.
```

**4.6 Interface — formulaire**
```text
Item 4.6. Crée demo/public/index.html, app.js et style.css (vanilla, français, sans build) avec la colonne formulaire repliable de CDC §10 : Escale (sélecteur trié par demo_priority, BKK par défaut, rappel zone/rayon/transfert, lien vers l'onglet Inventaire), Politique (par cabine : étoiles, cases équipements, plafond €/nuit avec facteur escale affiché ; chambrage ; priorités ; règlement ; bornes d'extension éditables), Avion (sièges J/W/Y, « Générer la liste », upload CSV, statistiques), Scénario (check-in, nuits, seed, force_discovery, case « Mode démonstration (sans agents) »), presets, bouton « Lancer la prise en charge ». Aucun texte d'agent n'est encore affiché ici. Vérifie le rendu dans le navigateur et décris-le en cinq lignes.
```

**4.7 Interface — zone principale**
```text
Item 4.7. Ajoute la zone principale : frise de phases (avec inventaire et extension), cartes agents (statut coloré, dernière pensée, vignette de capture cliquable via /api/screenshot, lien « Vue live H »), bandeau coût / tokens / pas / bornes d'extension (sessions utilisées/max, coût/max, vague/max), tableau du plan qui se remplit (escalades surlignées, lignes provisoires grisées), panneau coût (par nuit, projection, non renseigné), panneau messages (bascule FR/EN, filtre tier, bouton copier, trois premiers dossiers), panneau final avec téléchargements. Reconnexion SSE avec Last-Event-ID et rendu depuis snapshot. Tout texte d'agent via textContent. Vérifie un run simulé complet dans le navigateur et décris ce que tu vois.
```

**4.8 Onglet Inventaire**
```text
Item 4.8. Ajoute l'onglet Inventaire (EX-INV-8) : liste des hôtels de l'escale sélectionnée avec drapeaux contracté / préféré / exclu modifiables, ajout manuel (nom, URL, téléphone, e-mail, contracté), bouton « Rafraîchir par agents » (409 si un run est en cours ; en phase 4 il lance la voie simulée pour BKK), horodatage et badge « périmé ». Les modifications sont persistées dans data/inventaire/{code}.json via PUT. Vérifie : pose un drapeau, recharge la page, le drapeau est conservé ; ajoute un hôtel manuel, il est présent dans le fichier.
```

**4.9 Presets et lancement**
```text
Item 4.9. Presets de politique dans data/presets/ (nom assaini [a-z0-9-]{1,40}, GET et POST), preset « bkk-defaut » livré. Vérifie .claude/launch.json (demo-bkk, node demo/server.mjs, port 4310) et npm run demo. Colle la sortie du démarrage du serveur.
```

**4.10 Recette de la simulation**
```text
Item 4.10. Déroule dans le navigateur la liste de CDC §12.3 point 3 et les critères de la fiche de phase : BKK par défaut puis CDG et NOU listées ; sur NOU en simulation, message « fixtures non disponibles » et bouton dry-run ; génération A350 → 324 passagers ; run simulé complet avec extension visible et bornes ; coût ; messages FR/EN ; téléchargements ; fermeture/réouverture de l'onglet → snapshot ; double-run → 409 ; annulation propre ; annulation d'extension seule. Rends compte point par point : OK ou écart, et corrige les écarts.
```

**Clôture 4**
```text
Clôture de la phase 4. npm test vert : colle la sortie. ETAT.md : phase courante → 5, « Fait », écarts UI restants. Commit "feat(phase-4): serveur, SSE, UI vanilla, mode simulation BKK" et push. Confirme en trois lignes puis arrête-toi.
```

---

## Phase 5 — Câblage réel, inventaire BKK réel, sondes

Chaque item payant se termine par une demande d'accord. Ne répondre « oui » qu'après lecture du coût attendu.

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-5-cablage-reel-probes.md et CDC §6, §12.1, §13, §14, §16. Exécute la phase 5. Annonce chaque commande payante avec son coût attendu et attends mon accord explicite avant de la lancer ; exporte DEMO_ALLOW_PAID=1 pour la commande seule. Règle la concurrence et le modèle au maximum de mon plan (valeurs dans ETAT.md). Termine par npm test vert, ETAT.md, commit et push, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-5-cablage-reel-probes.md et CDC §6, §12.1, §13, §14, §16. Phase 5 item par item. Règle de dépense : avant toute commande payante, tu écris la commande exacte et son coût attendu, puis tu attends mon « oui ». DEMO_ALLOW_PAID=1 s'exporte pour la commande seule, jamais dans un fichier. Après chaque commande payante, consigne le coût réel dans ETAT.md. Compte rendu en cinq lignes après chaque item. Commence par me rappeler la concurrence maximale et le modèle retenus depuis ETAT.md.
```

**5.1 Câblage réel**
```text
Item 5.1. Câble demo/session-pump.mjs au client réel de hai.mjs, le proxy de captures réel (bearer, repli getSessionResource), l'annulation réelle (handle.cancel() sur les sessions actives). Vérifie au démarrage du serveur que la base URL affichée dans le journal est bien https://agp.eu.hcompany.ai/api/v2 et que HAI_API_KEY est lue sans être affichée. Aucune session lancée dans cet item.
```

**5.2 Réglages de puissance**
```text
Item 5.2. Applique dans DEFAULT_POLICY.agents les valeurs du compte H notées dans ETAT.md : concurrency (plafond 6), stagger_ms 10000, model_stage_ab (le plus capable sélectionnable), model_probe (rapide). Ajoute un journal de démarrage qui affiche la résolution de ces valeurs. Aucune session lancée dans cet item.
```

**5.3 Sonde de découverte**
```text
Item 5.3. Prépare la commande node hai-admin-mcp/tools/rebooking-v2.mjs --probe-discovery --station BKK avec DEMO_ALLOW_PAID=1 pour cette commande seule. Coût attendu ≈ 0,21 $. Écris la commande exacte et attends mon accord. Après exécution : valide nflt depuis le runner, devise EUR, flux de pensées et de captures ; archive out/candidats-*.json ; consigne durée et coût réels dans ETAT.md.
```

**5.4 Sonde de relevé**
```text
Item 5.4. Prépare --probe-releve 1 sur le premier candidat archivé. Coût attendu ≈ 0,30 $. Commande exacte, attends mon accord. Après exécution : chambres, équipements, paiement, cap_reached et observed_at présents et valides contre releveSchema ; archive ; consigne durée, steps et coût.
```

**5.5 Sonde de capacité — H-3**
```text
Item 5.5. Prépare --probe-capacity <url du candidat relevé> --rooms 12. Coût attendu ≈ 0,15 $. Commande exacte, attends mon accord. Après exécution : tranche H-3. Si la plateforme affiche une disponibilité pour 12 chambres via no_rooms/group_adults, garde probe_same_hotel_first true et note le format observé ; sinon passe-le à false dans DEFAULT_POLICY et note la raison dans ETAT.md.
```

**5.6 Inventaire réel de Bangkok**
```text
Item 5.6. Prépare node hai-admin-mcp/tools/inventaire.mjs --station BKK --refresh --max 10 avec la concurrence réglée à l'item 5.2. Coût attendu : une découverte plus dix relevés courts, à estimer depuis les mesures 5.3 et 5.4. Commande exacte, attends mon accord. Après exécution : data/inventaire/BKK.json contient au moins huit hôtels source agent avec payment renseigné ou non_precise et capacity_hint observé ; l'entrée manuelle de test est intacte ; commit de l'inventaire (aucune donnée passager dedans).
```

**5.7 Mesures et réglages**
```text
Item 5.7. Consigne dans ETAT.md et dans CDC §13 : durées, coûts, concurrence réellement obtenue, files d'attente ou 429 observés. Si des files d'attente sont apparues, abaisse agents.concurrency ; sinon garde le maximum. Ajuste stagger_ms. Aucune session lancée dans cet item.
```

**5.8 Fixtures réelles**
```text
Item 5.8. Reformate les sorties réelles archivées en fixtures de démo dans data/simulate/ (releves-demo.json et inventaire-demo.json), remplace les PNG factices de demo/sim-assets/ par des captures réelles si elles sont utiles, vérifie que le mode simulation rejoue les fixtures réelles en ~90 s. npm test vert avec les fixtures réelles : colle la sortie.
```

**Clôture 5**
```text
Clôture de la phase 5. ETAT.md : phase courante → 6, mesures, H-3 et H-9 tranchées, coût total de la phase. Commit "feat(phase-5): câblage réel, inventaire BKK réel, probes, fixtures réelles" et push. Confirme en trois lignes puis arrête-toi.
```

---

## Phase 6 — Recette, documentation, déroulé de démonstration

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-6-recette-doc-demo.md et CDC §1, §12.3, §13, §14. Exécute la phase 6. Le run réel complet se lance uniquement après mon accord explicite, avec DEMO_ALLOW_PAID=1 pour la commande seule. Termine par ETAT.md, le tag, le commit et le push indiqués, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-6-recette-doc-demo.md et CDC §1, §12.3, §13, §14. Phase 6 item par item. Le run réel n'est lancé qu'après mon accord. Compte rendu en cinq lignes après chaque item.
```

**6.1 Vérifications hors ligne**
```text
Item 6.1. npm test vert et node hai-admin-mcp/tools/rebooking-v2.mjs --offline data/simulate/releves-demo.json conforme : plan avec conformite et mode_reglement, messages FR/EN, coût. Colle les sorties.
```

**6.2 Recette de la simulation**
```text
Item 6.2. Déroule la liste CDC §12.3 point 3 dans le navigateur et consigne chaque point (OK ou écart, avec correction) dans docs/recette-demo-v2.md, section « Simulation ».
```

**6.3 Run réel complet**
```text
Item 6.3. Prépare le run réel complet depuis l'UI sur BKK (politique par défaut, A350 plein, 1 nuit). Coût attendu depuis les mesures de la phase 5. Attends mon accord. Pendant le run : chronomètre, note les phases, les vagues d'extension, les sondes, le coût lu sur le bandeau. Après : télécharge plan, rapport, messages, coût ; consigne tout dans docs/recette-demo-v2.md, section « Run réel ».
```

**6.4 Réglage si dépassement**
```text
Item 6.4. Si le run a dépassé 30 minutes : applique les boutons de réglage CDC §13 (concurrence, décalage, max_hotels_stage_b, maxSteps B, n_socle), explique le choix, et propose un second run. Attends mon accord avant de relancer. Un seul second run maximum.
```

**6.5 README**
```text
Item 6.5. Écris la section « Démo v2 » du README du dépôt : installation, variables d'environnement (sans valeurs), commandes, mode simulation, onglet Inventaire, escales et fiches, bornes d'extension, limites connues, hypothèses restantes.
```

**6.6 Matrice d'affectation**
```text
Item 6.6. Écris docs/matrice-affectation.md : tiers = cabines, surcouches PMR et famille, conformité en trois niveaux, mode de règlement, parcours d'allocation, extension au plafond, escalades. Un tableau par sujet, pas de prose longue.
```

**6.7 Déroulé de démonstration**
```text
Item 6.7. Écris docs/deroule-demo.md : script en huit étapes (CDC §1), durée par étape, ce que l'opérateur dit et montre, plan B en simulation si la plateforme est lente, réglages recommandés avant la séance, points à ne jamais montrer (clé, dossier out/, journaux bruts).
```

**6.8 Hypothèses restantes**
```text
Item 6.8. Consolide dans ETAT.md la liste des hypothèses [À CONFIRMER] encore ouvertes avec, pour chacune, la valeur appliquée et qui doit trancher.
```

**Clôture 6**
```text
Clôture de la phase 6. ETAT.md : phase courante → 7. git tag demo-v2-recette, commit "docs(phase-6): recette, README, déroulé de démo" et push (avec le tag). Confirme en trois lignes puis arrête-toi.
```

---

## Phase 7 — Déploiement Scaleway et répétition générale

**Ouverture (mode phase)**
```text
Lis docs/cdc/ETAT.md puis docs/cdc/phases/phase-7-deploiement-scaleway.md et CDC §11, §17. Exécute la phase 7. Prépare les scripts et les commandes ; je les exécute sur l'instance et je te colle les sorties. Le run réel distant se lance uniquement après mon accord explicite. Termine par ETAT.md, le tag, le commit et le push indiqués, puis arrête-toi.
```

**Cadrage (mode item)**
```text
Lis docs/cdc/ETAT.md, CLAUDE.md, docs/cdc/phases/phase-7-deploiement-scaleway.md et CDC §11, §17. Phase 7 item par item. Tu ne te connectes pas à l'instance : tu prépares les fichiers et les commandes, je les exécute et je te colle les sorties. Aucun secret dans un script ni dans git. Compte rendu en cinq lignes après chaque item.
```

**7.1 Guide d'instance**
```text
Item 7.1. Écris deploy/scaleway.md : création d'une instance CPU généraliste en fr-par, Ubuntu 24.04, 8 vCPU / 32 Go, groupe de sécurité limité aux ports 22 et 443, création d'un utilisateur de service sans sudo pour l'application, clé SSH. Étapes numérotées, commandes à copier.
```

**7.2 Script d'installation**
```text
Item 7.2. Écris deploy/install.sh (idempotent, set -euo pipefail) : Node ≥ 22 via NodeSource, clone du dépôt dans /opt/pax-hotel, npm ci sous hai-admin-mcp/, création de /etc/pax-hotel.env en mode 600 à partir d'un gabarit deploy/pax-hotel.env.example (HAI_API_KEY, HAI_API_BASE_URL, PORT=4310, BIND=127.0.0.1, valeurs vides à saisir), installation de Caddy. Le script n'écrit jamais de valeur secrète.
```

**7.3 Service et reverse proxy**
```text
Item 7.3. Écris deploy/pax-hotel.service (systemd, Restart=always, EnvironmentFile=/etc/pax-hotel.env, utilisateur de service, WorkingDirectory=/opt/pax-hotel) et deploy/Caddyfile (HTTPS automatique sur le nom de domaine ou l'IP que je te donnerai, authentification basique avec mot de passe haché, reverse proxy vers 127.0.0.1:4310, directives pour ne pas mettre le SSE en tampon). Indique-moi la commande pour générer le hachage du mot de passe.
```

**7.4 Sauvegarde**
```text
Item 7.4. Écris deploy/backup.sh : rsync de /opt/pax-hotel/out/ et /opt/pax-hotel/data/inventaire/ vers le poste de l'opérateur, avec horodatage, à lancer avant et après chaque démonstration.
```

**7.5 Installation guidée**
```text
Item 7.5. Donne-moi, dans l'ordre, les commandes à exécuter sur l'instance (transfert des fichiers deploy/, exécution de install.sh, saisie de /etc/pax-hotel.env, activation du service, démarrage de Caddy). Je te colle chaque sortie ; tu analyses et tu corriges avant de passer à la commande suivante. Termine par la vérification : journal systemd sain, accès HTTPS authentifié, flux /api/events qui reçoit le ping toutes les 15 s à travers Caddy.
```

**7.6 Run simulé distant**
```text
Item 7.6. Je lance un run simulé depuis mon navigateur sur l'URL de démo et je ferme puis rouvre l'onglet en cours de run. Dis-moi ce que je dois observer à chaque étape et ce qui prouverait un défaut (snapshot manquant, capture non chargée, SSE coupé par le proxy). Je te décris ce que je vois ; tu corriges.
```

**7.7 Run réel distant**
```text
Item 7.7. Prépare le run réel distant BKK depuis l'URL de démo. Coût attendu depuis la phase 6. Attends mon accord. Après le run : consigne durée, coût, sessions, vagues d'extension dans docs/recette-demo-v2.md, section « Run réel distant ».
```

**7.8 Répétition générale**
```text
Item 7.8. Nous jouons docs/deroule-demo.md de bout en bout depuis le navigateur du client. Tiens le chronomètre par étape, note chaque accroc, propose les corrections, et mets à jour le déroulé.
```

**Clôture 7**
```text
Clôture de la phase 7. ETAT.md : phase courante → « déployé », URL de démo (sans identifiants), mesures. git tag demo-v2-deploye, commit "ops(phase-7): déploiement Scaleway, répétition générale" et push avec le tag. Confirme en trois lignes puis arrête-toi.
```
