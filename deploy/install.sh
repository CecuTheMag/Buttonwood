#!/usr/bin/env bash
# Run ON THE SERVER as your normal user (not root). Safe to run again.
# Installs Node.js if needed, installs dependencies, and sets Buttonwood up as a
# systemd service: it starts at boot, and restarts automatically if it crashes.
set -euo pipefail

if [[ $EUID -eq 0 ]]; then echo "Run this as your normal user, not root. It will use sudo when needed." >&2; exit 1; fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$APP_DIR/apps/bot"
RUN_USER="$(id -un)"

node_ok() {
  command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=6)?0:1)'
}

if ! node_ok; then
  echo "→ Node.js 20.6+ not found. Installing Node.js 22…"
  if command -v apt-get >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v pacman >/dev/null; then
    sudo pacman -S --needed --noconfirm nodejs npm
  elif command -v dnf >/dev/null; then
    sudo dnf install -y nodejs npm
  else
    echo "Please install Node.js 20.6 or newer yourself, then run this again." >&2; exit 1
  fi
  node_ok || { echo "Installed Node.js is still too old ($(node -v))." >&2; exit 1; }
fi
NODE_BIN="$(command -v node)"
echo "→ Using Node $(node -v) at $NODE_BIN"

echo "→ Installing dependencies"
cd "$BOT_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p "$BOT_DIR/data"
[[ -f .env ]] || { echo "Missing $BOT_DIR/.env (copy .env.example)." >&2; exit 1; }
chmod 600 .env

echo "→ Writing /etc/systemd/system/buttonwood.service"
sudo tee /etc/systemd/system/buttonwood.service >/dev/null <<UNIT
[Unit]
Description=Buttonwood Telegram trading companion
# Wait for the network so Telegram and Solana are reachable on boot
Wants=network-online.target
After=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$BOT_DIR
ExecStart=$NODE_BIN --env-file=.env --import tsx src/index.ts
Restart=always
RestartSec=10
# Give the bot time to save its state on shutdown
TimeoutStopSec=20

# Hardening: the bot can only write to its own data folder
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$BOT_DIR/data

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable buttonwood >/dev/null
sudo systemctl restart buttonwood
sleep 5
systemctl --no-pager status buttonwood | head -n 12 || true
echo
echo "✅ Buttonwood is installed and starts automatically at boot."
echo "   Live logs:  journalctl -u buttonwood -f"
