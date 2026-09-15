# Déploiement Scaleway — instance, sécurité, installation (phase 7, CDC §17)

Runbook de l'opérateur. Les scripts vivent à côté : [`install.sh`](install.sh) (instance),
[`pax-hotel.service`](pax-hotel.service), [`Caddyfile`](Caddyfile), [`backup.sh`](backup.sh) (poste opérateur).
Aucun secret dans ces fichiers ni dans git : tout secret se saisit à la main sur l'instance, dans
`/etc/pax-hotel.env` (mode 600).

## 1. Création de l'instance (console Scaleway)

| Champ | Valeur |
|---|---|
| Zone | `fr-par-1` (Paris — proche du point d'entrée européen H, `agp.eu.hcompany.ai`) |
| Type | **PRO2-S** — gamme CPU généraliste, 8 vCPU / 32 Go (large marge : le serveur est léger) |
| Image | **Ubuntu 24.04 LTS (Noble Numbat)** |
| Volume | 40 Go (défaut) |
| Réseau | IPv4 publique (routée) attachée |
| Clé SSH | la clé publique du poste opérateur |

Connexion une fois l'instance démarrée : `ssh root@IP_PUBLIQUE` (les images Ubuntu Scaleway
acceptent `root` avec la clé SSH du compte).

## 2. Groupe de sécurité — 22 et 443 uniquement (interdit fiche : jamais 4310)

- **Politique entrante : rejeter par défaut.** Deux règles « accepter » :
  - TCP **22** — si possible restreint à l'IP du poste opérateur ;
  - TCP **443** — depuis `0.0.0.0/0` (le navigateur du client peut être n'importe où).
- **Politique sortante : accepter** (apt, NodeSource, GitHub, Let's Encrypt, API H).
- Ne pas ouvrir 80 : Caddy obtient le certificat par défi **TLS-ALPN sur 443**.
- Ne **jamais** ouvrir 4310 : le serveur Node reste lié à `127.0.0.1`, seul Caddy est exposé.
- Le blocage SMTP par défaut de Scaleway peut rester actif (rien n'envoie de courrier).

## 3. Utilisateur de service

`install.sh` crée l'utilisateur **système `paxhotel`** (shell `nologin`, home `/var/lib/pax-hotel`) :
propriétaire de `/opt/pax-hotel`, il exécute le service systemd. Durcissement dans l'unité :
`ProtectSystem=strict` — seuls `out/` (artefacts de runs) et `data/` (inventaire, presets) sont
inscriptibles. La clé API n'apparaît que dans `/etc/pax-hotel.env` (root:root, 600), lu par systemd.

## 4. Ordre d'installation

1. **Depuis le poste** — copier le script :
   `scp deploy/install.sh root@IP_PUBLIQUE:/root/`
2. **Sur l'instance** — `bash /root/install.sh` (relançable ; réinstalle rien d'inutile, n'écrase ni
   `/etc/pax-hotel.env` ni un Caddyfile déjà personnalisé).
   Dépôt privé : `REPO_URL="https://JETON@github.com/pgadet-wq/pax-hotel.git" bash /root/install.sh`
   avec un jeton **lecture seule** saisi au clavier — jamais écrit dans un fichier ni dans l'historique
   (précéder la commande d'une espace si `HISTCONTROL=ignorespace`).
3. **Sur l'instance** — saisir les valeurs : `nano /etc/pax-hotel.env` (`HAI_API_KEY` ; le fichier est
   déjà en 600 avec le point d'entrée EU pré-rempli).
4. **Sur l'instance** — mot de passe de démo : `caddy hash-password`, puis `nano /etc/caddy/Caddyfile`
   (adresse du site : domaine ou IP publique ; coller le hachage bcrypt), puis `systemctl reload caddy`.
5. **Sur l'instance** — `systemctl restart pax-hotel`.

Domaine (recommandé pour une séance client) : un enregistrement `A` → IP publique, posé avant
l'étape 4 ; certificat Let's Encrypt automatique. Sans domaine : adresse `https://IP` et `tls internal`
(certificat auto-signé, avertissement navigateur à accepter une fois).

## 5. Vérifications (critères fiche phase 7)

```
journalctl -u pax-hotel -n 20 --no-pager     # ligne « Démo v2 — http://127.0.0.1:4310 … verrouillés — INV-8 »
systemctl restart pax-hotel && sleep 2 && systemctl is-active pax-hotel    # → active (Restart=always)
ls -l /etc/pax-hotel.env                     # → -rw------- root root
```

Depuis le poste opérateur :

- `https://HOTE/` sans identifiants → **401** ; avec `demo` + mot de passe → l'UI de démo.
- SSE à travers Caddy (pas de mise en tampon, `flush_interval -1`) :
  `curl -sNu demo:MDP https://HOTE/api/events` ouvert pendant un run simulé lancé du navigateur
  → les événements défilent en direct (ajouter `-k` si `tls internal`).
- Run simulé distant complet ; fermeture/réouverture de l'onglet → snapshot.
- Run réel distant : **uniquement après accord explicite dans la conversation** (INV-8) —
  décommenter `DEMO_ALLOW_PAID=1` dans `/etc/pax-hotel.env`, `systemctl restart pax-hotel`,
  jouer le run, puis **recommenter et redémarrer**. Mesures consignées dans
  `docs/recette-demo-v2.md` §4.

## 6. Alternative sans exposition : tunnel SSH

Pour répéter sans HTTPS public (443 peut rester fermé) :
`ssh -N -L 4310:127.0.0.1:4310 root@HOTE` puis `http://127.0.0.1:4310` sur le poste.
L'accès est limité au porteur du tunnel ; l'auth Caddy ne s'applique pas.

## 7. Sauvegarde avant la démo

Depuis le poste : `bash deploy/backup.sh root@HOTE` — rapatrie `out/` et `data/inventaire/`
par rsync (variante `scp` pour Windows en commentaire du script). Les sorties contenant des
données passagers restent hors git (CDC §11).
