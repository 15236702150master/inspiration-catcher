set -euo pipefail
SRC='/mnt/d/Data/01_Projects/2026/explore/inspiration-catcher/'
DEST='cloud-op:/home/op/apps/inspiration-catcher/'
rsync -az --delete \
  --exclude '.env' --exclude '.private/' --exclude 'data/' --exclude 'covers/' --exclude 'backups/' --exclude 'node_modules/' --exclude '.git/' \
  "$SRC" "$DEST"
ssh cloud-op 'cd /home/op/apps/inspiration-catcher && systemctl --user restart inspiration-catcher.service && sleep 1 && systemctl --user is-active inspiration-catcher.service && curl -fsS http://127.0.0.1:4173/api/health'