#!/usr/bin/env bash
# Copy Buttonwood from this computer to the server and restart it.
#
#   ./deploy/push.sh             # update code (no sudo needed after the first install)
#   ./deploy/push.sh --install   # first time: also installs the systemd service (asks for sudo password)
#
# Server address: put DEPLOY_HOST=user@your-server in deploy/.env (git-ignored),
# or pass it inline: DEPLOY_HOST=user@your-server ./deploy/push.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f deploy/.env ]] && source deploy/.env
HOST="${DEPLOY_HOST:?Set DEPLOY_HOST=user@your-server in deploy/.env or the environment}"
REMOTE_DIR="${DEPLOY_DIR:-buttonwood}"   # relative to the server user's home

echo "→ Copying files to $HOST:~/$REMOTE_DIR"
# Never copies node_modules, git history, the bot's memory and wallet (data/), or .env:
# the server keeps its own .env (wallet passphrase, rotated token) and it must not be overwritten.
tar czf - --exclude=node_modules --exclude=.git --exclude=apps/bot/data --exclude=apps/bot/.env . \
  | ssh "$HOST" "mkdir -p ~/$REMOTE_DIR && tar xzf - -C ~/$REMOTE_DIR"

# First deploy only: the server has no .env yet, so send this computer's copy.
if ! ssh "$HOST" "test -f ~/$REMOTE_DIR/apps/bot/.env"; then
  if [[ ! -f apps/bot/.env ]]; then
    echo "apps/bot/.env is missing. Copy apps/bot/.env.example and fill it in first." >&2
    exit 1
  fi
  echo "→ Server has no .env yet: copying yours"
  ssh "$HOST" "umask 077 && cat > ~/$REMOTE_DIR/apps/bot/.env" < apps/bot/.env
fi

if [[ "${1:-}" == "--install" ]]; then
  echo "→ Installing service (you'll be asked for the server's sudo password)"
  ssh -t "$HOST" "bash ~/$REMOTE_DIR/deploy/install.sh"
  exit 0
fi

echo "→ Installing dependencies and restarting"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd ~/$REMOTE_DIR/apps/bot
npm ci --omit=dev --no-audit --no-fund
pid=\$(systemctl show -p MainPID --value buttonwood 2>/dev/null || echo 0)
if [[ "\$pid" != "0" && -n "\$pid" ]]; then
  kill -TERM "\$pid"   # systemd (Restart=always) starts the new version within ~10s
  echo "Restarting. Telegram will say when I'm back online."
else
  echo "Service not installed or not running yet. Run: ./deploy/push.sh --install"
fi
REMOTE
