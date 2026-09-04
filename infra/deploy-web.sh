#!/usr/bin/env bash
#
# Build the Isaac app and put it on the server.
#
#   ./infra/deploy-web.sh
#
# Reads infra/.env.deploy (gitignored) for the shared relay token, if there is
# one. The first run also obtains the certificate; later runs just ship files.

set -euo pipefail

HOST="${ISAAC_HOST:-subrata@172.234.157.52}"
DOMAIN="${ISAAC_WEB_DOMAIN:-isaacoptics.com}"
REMOTE_DIR="${ISAAC_WEB_DIR:-/srv/isaac-web}"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# shellcheck disable=SC1091
[ -f "$repo/infra/.env.deploy" ] && . "$repo/infra/.env.deploy"

# ------------------------------------------------------------------- build ---
say "Building"
# The token is compiled *into* the bundle, so a change of token is a rebuild.
VITE_SESSION_URL="${VITE_SESSION_URL:-wss://api.$DOMAIN/}" \
VITE_SESSION_TOKEN="${VITE_SESSION_TOKEN:-}" \
  npm run build --workspace @isaac/web --silent
dist="$repo/apps/web/dist"
[ -f "$dist/index.html" ] || { echo "no build output in $dist" >&2; exit 1; }
printf '  %s\n' "$(du -sh "$dist" | cut -f1) in $(find "$dist" -type f | wc -l | tr -d ' ') files"

# --------------------------------------------------------------- first run ---
# Nginx will not start with a config naming a certificate that is not there, so
# the certificate has to come first — and certbot needs a server answering on
# port 80 to prove the domain. Hence the plain HTTP config, once.
say "Certificate"
# Let's Encrypt proves every name on the certificate, so asking for one that
# does not resolve fails the *whole* request — including the name that does.
# `www` is therefore included only if it exists.
CERT_DOMAINS="-d $DOMAIN"
if host "www.$DOMAIN" >/dev/null 2>&1; then
  CERT_DOMAINS="$CERT_DOMAINS -d www.$DOMAIN"
  echo "  covering $DOMAIN and www.$DOMAIN"
else
  echo "  covering $DOMAIN only — no DNS record for www.$DOMAIN"
fi
export CERT_DOMAINS

if ! ssh "$HOST" "sudo test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  echo "  none yet — obtaining one"
  ssh "$HOST" "sudo install -d -o \$USER -g \$USER '$REMOTE_DIR' /var/www/html"
  ssh "$HOST" "CERT_DOMAINS='$CERT_DOMAINS' bash -s" <<REMOTE
set -euo pipefail
printf 'server {\n listen 80;\n listen [::]:80;\n server_name $DOMAIN www.$DOMAIN;\n root /var/www/html;\n}\n' \
  | sudo tee /etc/nginx/sites-available/$DOMAIN.bootstrap.conf >/dev/null
sudo ln -sf /etc/nginx/sites-available/$DOMAIN.bootstrap.conf /etc/nginx/sites-enabled/$DOMAIN.bootstrap.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html \
  $CERT_DOMAINS \
  --non-interactive --agree-tos -m "${CERTBOT_EMAIL:-subratinho@gmail.com}"
sudo rm -f /etc/nginx/sites-enabled/$DOMAIN.bootstrap.conf
REMOTE
else
  echo "  already held"
fi

# ------------------------------------------------------------------ upload ---
say "Uploading to $HOST:$REMOTE_DIR"
ssh "$HOST" "sudo install -d -o \$USER -g \$USER '$REMOTE_DIR'"
rsync -az --delete "$dist/" "$HOST:$REMOTE_DIR/"

say "nginx"
scp -q "$repo/infra/nginx/$DOMAIN.conf" "$HOST:/tmp/"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
sudo mv /tmp/$DOMAIN.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/$DOMAIN.conf /etc/nginx/sites-enabled/$DOMAIN.conf
sudo nginx -t
sudo systemctl reload nginx
REMOTE

# ------------------------------------------------------------------ verify ---
say "Verifying"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/")
echo "  https://$DOMAIN/ -> HTTP $code"
[ "$code" = "200" ] || { echo "  not serving; check: ssh $HOST 'sudo nginx -t'" >&2; exit 1; }

# The two headers that decide whether a deploy is visible or a blank page.
echo "  index.html:  $(curl -sI "https://$DOMAIN/" | grep -i '^cache-control' | tr -d '\r')"
asset=$(curl -s "https://$DOMAIN/" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$asset" ] && echo "  $asset:  $(curl -sI "https://$DOMAIN$asset" | grep -i '^cache-control' | tr -d '\r')"
echo
