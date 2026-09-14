# Phase 7 — Déploiement sur Scaleway et répétition générale

Couvre : CDC §17. Un run simulé distant, puis un run réel distant sur accord explicite.

## Objectif

Rendre la démo accessible depuis n'importe quel navigateur, avec la puissance et la latence d'une instance `fr-par` proche du point d'entrée européen H, et répéter le déroulé une fois en conditions réelles.

## À lire

- `docs/cdc/ETAT.md`
- CDC §11, §17
- `docs/deroule-demo.md` (phase 6)

## Tâches

- [ ] Rédiger `deploy/scaleway.md` : création de l'instance (CPU généraliste `fr-par`, Ubuntu 24.04, 8 vCPU / 32 Go), groupe de sécurité (22 et 443 uniquement), utilisateur de service.
- [ ] Rédiger `deploy/install.sh` : Node ≥ 22 (NodeSource), clone du dépôt, `npm ci` sous `hai-admin-mcp/`, création de `/etc/pax-hotel.env` (mode 600, valeurs à saisir par l'utilisateur, jamais dans le script), service `systemd` `pax-hotel.service` (`Restart=always`, `EnvironmentFile`), Caddy avec HTTPS automatique et authentification basique vers `127.0.0.1:4310`.
- [ ] Rédiger `deploy/pax-hotel.service` et `deploy/Caddyfile` (nom de domaine ou IP à renseigner par l'utilisateur).
- [ ] Prévoir `deploy/backup.sh` : `rsync` de `out/` et `data/inventaire/` vers le poste de l'opérateur.
- [ ] L'utilisateur exécute l'installation sur l'instance (Claude Code prépare les commandes, l'utilisateur les lance et colle les sorties). Vérifier le journal `systemd`, l'accès HTTPS authentifié, le SSE à travers Caddy (pas de mise en tampon : directive adaptée dans le `Caddyfile`).
- [ ] Run simulé distant complet. Fermeture / réouverture de l'onglet → snapshot.
- [ ] Run réel distant BKK, après accord explicite : chronométrer, lire le coût, télécharger les sorties. Consigner dans `docs/recette-demo-v2.md`.
- [ ] Répétition générale du `docs/deroule-demo.md` depuis le navigateur du client.

## Critères d'acceptation

- L'URL de démo répond en HTTPS avec authentification ; le SSE fonctionne à travers le proxy.
- Le service redémarre seul après `sudo systemctl restart pax-hotel`.
- Aucun secret dans le dépôt ; `/etc/pax-hotel.env` en mode 600.
- Run simulé et run réel distants consignés.

## Interdits

- Ouvrir le port 4310 sur Internet. Placer une clé dans un script ou dans git.

## Clôture

1. `ETAT.md` : phase courante → « déployé », URL, mesures.
2. `git tag demo-v2-deploye && git commit -m "ops(phase-7): déploiement Scaleway, répétition générale"` et push.
3. S'arrêter.

## Prompt de démarrage

> Lis `docs/cdc/ETAT.md` puis `docs/cdc/phases/phase-7-deploiement-scaleway.md`. Exécute la phase 7. Prépare les scripts et les commandes ; je les exécute sur l'instance et je te colle les sorties. Le run réel distant se lance uniquement après mon accord explicite. Termine par `ETAT.md`, le tag, le commit et le push indiqués.
