#!/usr/bin/env bash
#
# Ship the session relay to the server.
#
#   ./infra/deploy.sh
#
# Deliberately *not* a copy of the monorepo. Only the two packages the relay
# needs go across, under a minimal workspace root, so `npm install` on a 2 GB
# box pulls one dependency instead of React and Three.js.

set -euo pipefail

HOST="${ISAAC_HOST:-subrata@172.234.157.52}"
REMOTE_DIR="${ISAAC_REMOTE_DIR:-/srv/isaac-session}"
SERVICE=isaac-session
DOMAIN="${ISAAC_DOMAIN:-api.isaacoptics.com}"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- staging ---
say "Staging"
mkdir -p "$stage/packages" "$stage/apps"
cp -R "$repo/packages/session-protocol" "$stage/packages/"
cp -R "$repo/apps/session-server"       "$stage/apps/"
rm -rf "$stage/packages/session-protocol/node_modules" "$stage/apps/session-server/node_modules"

cat > "$stage/package.json" <<'EOF'
{
  "name": "isaac-session-deploy",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"]
}
EOF

# ------------------------------------------------------------------ upload ---
say "Uploading to $HOST:$REMOTE_DIR"
ssh "$HOST" "sudo install -d -o \$USER -g \$USER '$REMOTE_DIR'"
rsync -az --delete "$stage/" "$HOST:$REMOTE_DIR/"

# ---------------------------------------------------------------- install ---
say "Installing"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"; . "\$NVM_DIR/nvm.sh"
cd '$REMOTE_DIR'
npm install --omit=dev --silent
REMOTE

# The node path is resolved here, not written into the unit file: nvm's
# directory carries the version number, and a bumped Node would otherwise leave
# a unit pointing at a binary that no longer exists.
node_bin="$(ssh "$HOST" 'bash -lc ". \$HOME/.nvm/nvm.sh; nvm which default"')"
remote_user="${HOST%%@*}"

# Who may connect, from the gitignored deploy file. The unit already reads
# /etc/isaac-session.env, so this is the only place the secret has to land.
say "Access"
# shellcheck disable=SC1091
[ -f "$repo/infra/.env.deploy" ] && . "$repo/infra/.env.deploy"
# The API key goes across in the same breath and by the same route. It is
# piped, never echoed and never passed as an argument — an argument is visible
# in `ps` to everyone on the box.
printf 'ISAAC_ORIGINS=%s\nISAAC_TOKEN=%s\nANTHROPIC_API_KEY=%s\nISAAC_HELP_MODEL=%s\nISAAC_HELP_DAILY_LIMIT=%s\n' \
    "${ISAAC_ORIGINS:-}" "${VITE_SESSION_TOKEN:-}" "${ANTHROPIC_API_KEY:-}" \
    "${ISAAC_HELP_MODEL:-}" "${ISAAC_HELP_DAILY_LIMIT:-}" \
  | ssh "$HOST" "sudo tee /etc/isaac-session.env >/dev/null && sudo chmod 600 /etc/isaac-session.env"
if [ -n "${VITE_SESSION_TOKEN:-}" ]; then
  echo "  a token is required, and origins are ${ISAAC_ORIGINS:-any}"
else
  echo "  open to anyone (no infra/.env.deploy)"
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  help answers with ${ISAAC_HELP_MODEL:-claude-opus-5}, up to ${ISAAC_HELP_DAILY_LIMIT:-300} questions a day"
else
  echo "  help is off (no ANTHROPIC_API_KEY in infra/.env.deploy)"
fi

say "Service"
sed -e "s|__NODE__|$node_bin|" -e "s|__USER__|$remote_user|" \
    "$repo/infra/systemd/$SERVICE.service" \
  | ssh "$HOST" "sudo tee /etc/systemd/system/$SERVICE.service >/dev/null"

say "nginx"
scp -q "$repo/infra/nginx/websocket-upgrade.conf" "$HOST:/tmp/"
scp -q "$repo/infra/nginx/api.isaacoptics.com.conf" "$HOST:/tmp/"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
sudo mv /tmp/websocket-upgrade.conf /etc/nginx/conf.d/
sudo mv /tmp/api.isaacoptics.com.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/api.isaacoptics.com.conf \
            /etc/nginx/sites-enabled/api.isaacoptics.com.conf
# certbot's edits live in the default site; ours replaces it entirely.
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
REMOTE

say "Starting"
ssh "$HOST" "sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE && sudo systemctl restart $SERVICE"

# ----------------------------------------------------------------- verify ---
say "Verifying"
sleep 2
ssh "$HOST" "systemctl is-active $SERVICE" >/dev/null || {
  ssh "$HOST" "sudo journalctl -u $SERVICE -n 30 --no-pager"
  exit 1
}

# The smoke test runs from *here*, over the public URL, because that is the path
# a browser takes. A check run on the server would miss DNS, the certificate and
# the proxy — which is most of what a deploy can break.
scp -q "$repo/infra/smoke.mjs" "$HOST:$REMOTE_DIR/"
smoke_url="wss://$DOMAIN/"
[ -n "${VITE_SESSION_TOKEN:-}" ] && smoke_url="wss://$DOMAIN/?t=$VITE_SESSION_TOKEN"
if ! node "$repo/infra/smoke.mjs" "$smoke_url"; then
  echo "  (falling back to running it on the server)"
  ssh "$HOST" "bash -lc '. \$HOME/.nvm/nvm.sh && cd $REMOTE_DIR && node smoke.mjs \"$smoke_url\"'"
fi

# The help endpoint gets its own check, and it asks a real question — the only
# way to know the key is right, the model name is real and the answer comes
# back. It costs about a penny per deploy, which is the cheapest possible way
# to find out that help has been broken since Tuesday.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ISAAC_TOKEN="${VITE_SESSION_TOKEN:-}" ISAAC_ORIGIN="https://isaacoptics.com" \
    node "$repo/infra/smoke-help.mjs" "https://$DOMAIN/help" || exit 1
fi
