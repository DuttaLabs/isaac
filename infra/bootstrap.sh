#!/usr/bin/env bash
#
# Provision the Isaac server from a fresh Ubuntu 24.04 image.
#
#   ssh root@<host> 'bash -s' < infra/bootstrap.sh
#
# Idempotent: safe to run again on a box that is already set up. The point is
# that this file, not anybody's memory, is what the server is made of — destroy
# the box, run this, and you have the same machine back.

set -euo pipefail

ADMIN_USER="${ADMIN_USER:-subrata}"
NODE_MAJOR="${NODE_MAJOR:-22}"
HOSTNAME_WANTED="${HOSTNAME_WANTED:-isaac-server}"
SWAPFILE_GB="${SWAPFILE_GB:-2}"

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a          # don't prompt about restarting services

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- packages ---
say "Updating the system"
hostnamectl set-hostname "$HOSTNAME_WANTED"
apt-get update -qq
apt-get -y -qq upgrade
apt-get -y -qq install curl git ufw nginx certbot python3-certbot-nginx \
                       unattended-upgrades fail2ban

# ------------------------------------------------------------------- user ---
# A non-root account to own the application. Root stays for administration
# only, and in a moment will stop being reachable over SSH at all.
say "Creating $ADMIN_USER"
if ! id -u "$ADMIN_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"

# Copy root's authorized keys across, so the key that opened this session also
# opens the new account.
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" \
        /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"

# Passwordless sudo: the deploy script runs non-interactively over SSH, and a
# password prompt there would hang rather than fail.
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"

# --------------------------------------------------------------- ssh lock ---
# GUARD: refuse to disable password login unless the new account actually has a
# key. Getting this wrong is how a fresh box becomes unreachable.
say "Hardening SSH"
if [ ! -s "/home/$ADMIN_USER/.ssh/authorized_keys" ]; then
  echo "REFUSING: $ADMIN_USER has no authorized_keys; would lock you out." >&2
  exit 1
fi

# sshd takes the FIRST value it sees for each keyword, and the main config
# includes this directory near the top — so a low number wins over anything
# cloud-init writes later.
cat > /etc/ssh/sshd_config.d/00-isaac-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF

mkdir -p /run/sshd                # sshd -t refuses to run without it
sshd -t                              # refuse to apply a config that won't parse
systemctl restart ssh.socket 2>/dev/null || systemctl restart ssh

# --------------------------------------------------------------- firewall ---
# Mirrors the Linode cloud firewall. Two layers, deliberately: this one also
# protects against anything that binds to 0.0.0.0 by mistake.
say "Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'               # 80 and 443
ufw --force enable

# ---------------------------------------------------------------- patches ---
say "Automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ------------------------------------------------------------------- swap ---
# 2 GB of RAM is enough to run the server and tight for building on it.
say "Swap"
if [ ! -f /swapfile ]; then
  fallocate -l "${SWAPFILE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# ------------------------------------------------------------------- node ---
# nvm, per-user, rather than a system package: the version Isaac needs is a
# property of the application, not of the machine.
say "Node $NODE_MAJOR"
sudo -u "$ADMIN_USER" -H bash <<EOF
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
if [ ! -d "\$NVM_DIR" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "\$NVM_DIR/nvm.sh"
nvm install $NODE_MAJOR >/dev/null
nvm alias default $NODE_MAJOR >/dev/null
EOF

NODE_BIN="$(sudo -u "$ADMIN_USER" -H bash -lc '. "$HOME/.nvm/nvm.sh"; nvm which default')"

# ---------------------------------------------------------------- summary ---
say "Done"
cat <<EOF

  host      $(hostname)
  user      $ADMIN_USER   (sudo, key-only)
  node      $("$NODE_BIN" -v)   at $NODE_BIN
  nginx     $(nginx -v 2>&1 | sed 's|nginx version: ||')
  swap      $(free -m | awk '/Swap:/ {print $2" MB"}')
  ssh       root login disabled, passwords disabled

  Put that node path in the systemd unit's ExecStart — systemd does not read
  shell profiles, so nvm's shims are invisible to it.

EOF
