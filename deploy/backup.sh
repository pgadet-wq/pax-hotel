#!/usr/bin/env bash
# Sauvegarde des sorties de la démo vers le poste de l'opérateur (phase 7, CDC §17) :
# rapatrie out/ (plans, rapports, messages, captures — les données passagers restent hors git,
# CDC §11) et data/inventaire/ depuis l'instance. À lancer DEPUIS LE POSTE de l'opérateur.
#
#   bash deploy/backup.sh root@demo.exemple.fr [dossier-destination]
#
# Windows sans rsync (PowerShell, OpenSSH intégré), variante scp équivalente :
#   scp -r root@HOTE:/opt/pax-hotel/out sauvegarde-pax-hotel\out
#   scp -r root@HOTE:/opt/pax-hotel/data/inventaire sauvegarde-pax-hotel\inventaire
set -euo pipefail

HOTE="${1:?usage : backup.sh <utilisateur@hote> [destination]}"
DEST="${2:-sauvegarde-pax-hotel/$(date +%Y%m%d-%H%M%S)}"
APP_DIR=/opt/pax-hotel

mkdir -p "$DEST/out" "$DEST/data/inventaire"
rsync -avz "$HOTE:$APP_DIR/out/" "$DEST/out/"
rsync -avz "$HOTE:$APP_DIR/data/inventaire/" "$DEST/data/inventaire/"
echo "Sauvegarde terminée : $DEST"
