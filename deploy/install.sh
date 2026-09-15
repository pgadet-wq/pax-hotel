#!/usr/bin/env bash
# Installation de la démo pax-hotel v2 sur une instance Scaleway Ubuntu 24.04 (phase 7, CDC §17).
# À lancer en root sur l'instance : bash install.sh
# Relançable : n'écrase ni /etc/pax-hotel.env ni un Caddyfile déjà personnalisé.
# AUCUN secret ici (interdit fiche) : /etc/pax-hotel.env est créé en mode 600 avec des
# valeurs À SAISIR À LA MAIN par l'opérateur.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/pgadet-wq/pax-hotel.git}"
APP_DIR=/opt/pax-hotel
SVC_USER=paxhotel
ENV_FILE=/etc/pax-hotel.env

[ "$(id -u)" -eq 0 ] || { echo "Lancer en root : sudo bash install.sh" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/7 Paquets de base =="
apt-get update -y
apt-get install -y ca-certificates curl git rsync

echo "== 2/7 Node >= 22 (NodeSource) =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "   node $(node --version) · npm $(npm --version)"

echo "== 3/7 Utilisateur de service ${SVC_USER} =="
id "$SVC_USER" >/dev/null 2>&1 \
  || useradd --system --create-home --home-dir /var/lib/pax-hotel --shell /usr/sbin/nologin "$SVC_USER"

echo "== 4/7 Dépôt -> ${APP_DIR} =="
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$SVC_USER" git -C "$APP_DIR" fetch origin
  sudo -u "$SVC_USER" git -C "$APP_DIR" reset --hard origin/main
else
  sudo -u "$SVC_USER" git clone "$REPO_URL" "$APP_DIR"
fi
sudo -u "$SVC_USER" mkdir -p "$APP_DIR/out"

echo "== 5/7 npm ci sous hai-admin-mcp/ =="
sudo -u "$SVC_USER" env HOME=/var/lib/pax-hotel bash -c "cd '$APP_DIR/hai-admin-mcp' && npm ci"

echo "== 6/7 ${ENV_FILE} (600) + service systemd =="
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# /etc/pax-hotel.env — secrets et réglages (CDC §17), à remplir À LA MAIN.
# Jamais dans git, jamais dans un script. Fichier en mode 600, lu par systemd (EnvironmentFile).
# Clé Agents API H Company (INV-4) :
HAI_API_KEY=A_SAISIR
# Point d'entrée européen H : ORIGINE sans /api/v2 (relevé phase 0 ; c'est déjà le défaut du SDK).
HAI_API_BASE_URL=https://agp.eu.hcompany.ai
PORT=4310
BIND=127.0.0.1
# Sessions payantes (INV-8) : décommenter UNIQUEMENT le temps d'un run réel convenu dans la
# conversation, puis recommenter et `systemctl restart pax-hotel`.
# DEMO_ALLOW_PAID=1
EOF
  chmod 600 "$ENV_FILE" && chown root:root "$ENV_FILE"
  echo "   -> créé avec des valeurs à saisir : nano ${ENV_FILE}"
else
  echo "   -> ${ENV_FILE} existe déjà, non touché"
fi
install -m 644 "$APP_DIR/deploy/pax-hotel.service" /etc/systemd/system/pax-hotel.service
systemctl daemon-reload
systemctl enable --now pax-hotel
systemctl --no-pager --lines=3 status pax-hotel || true

echo "== 7/7 Caddy (HTTPS automatique + auth basique) =="
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
if ! grep -q pax-hotel /etc/caddy/Caddyfile 2>/dev/null; then
  [ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist
  install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  echo "   -> /etc/caddy/Caddyfile posé (adresse + hachage à renseigner)"
else
  echo "   -> /etc/caddy/Caddyfile déjà personnalisé, non touché"
fi

echo
echo "Installation terminée. Restent À LA MAIN (deploy/scaleway.md §4) :"
echo "  1. nano ${ENV_FILE}            # HAI_API_KEY (mode 600 déjà posé)"
echo "  2. caddy hash-password          # hachage bcrypt du mot de passe de démo"
echo "  3. nano /etc/caddy/Caddyfile    # domaine (ou IP + tls internal) + hachage"
echo "     puis : systemctl reload caddy"
echo "  4. systemctl restart pax-hotel && journalctl -u pax-hotel -n 10 --no-pager"
