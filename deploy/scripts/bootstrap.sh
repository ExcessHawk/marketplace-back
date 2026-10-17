#!/usr/bin/env bash
# Prepara el VPS desde cero. Se corre UNA vez, como root.
#
#   ssh root@2.25.75.147 'bash -s' < deploy/scripts/bootstrap.sh
#
# Deja instalado: Docker, nginx, certbot, ufw y un usuario `deploy` sin sudo
# para los archivos del sitio. No despliega nada todavía: eso es release.sh.

set -euo pipefail

SSH_PORT="${SSH_PORT:-22}"
APP_DIR="${APP_DIR:-$HOME/portafolio/marketplace-back}"
WEB_DIR=/var/www

echo "==> paquetes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync ufw fail2ban nginx

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
bun --version

echo "==> certbot"
apt-get install -y -qq certbot python3-certbot-nginx

echo "==> usuario deploy"
# El usuario deploy no tiene contraseña: solo se entra con llave. Si no hay
# ninguna, release.sh no podría conectarse nunca. Por eso se pasa la pública
# desde la máquina de desarrollo:
#   ssh root@IP "AUTHORIZED_KEY='$(cat ~/.ssh/id_ed25519.pub)' bash -s" < bootstrap.sh
AUTHORIZED_KEY="${AUTHORIZED_KEY:-}"

if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' deploy
  usermod -aG docker deploy
fi

install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -d -m 700 /root/.ssh

if [ -n "$AUTHORIZED_KEY" ]; then
  for f in /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys; do
    touch "$f"
    grep -qxF "$AUTHORIZED_KEY" "$f" || echo "$AUTHORIZED_KEY" >> "$f"
    chmod 600 "$f"
  done
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  echo "    llave instalada para root y deploy"
elif [ -s /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
  echo "    deploy hereda las llaves de root"
else
  echo
  echo "  !! No pasaste AUTHORIZED_KEY y root no tiene llaves."
  echo "     El usuario deploy no tiene contraseña, así que nadie puede entrar"
  echo "     con él y release.sh va a fallar. Vuelve a correr esto así:"
  echo
  echo "       ssh root@IP \"AUTHORIZED_KEY='\\\$(cat ~/.ssh/id_ed25519.pub)' bash -s\" < bootstrap.sh"
  echo
fi

echo "==> carpetas"
mkdir -p "$WEB_DIR/portafolio" "$WEB_DIR/marketplace"
chown -R deploy:deploy "$WEB_DIR/portafolio" "$WEB_DIR/marketplace"

echo "==> secretos de la API"
if [ ! -f "$APP_DIR/api.env" ]; then
  umask 077
  cat > "$APP_DIR/api.env" <<EOF
PORT=3102
NODE_ENV=production
LOG_LEVEL=info

JWT_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)
JWT_ACCESS_EXPIRES=1h
JWT_REFRESH_EXPIRES=30d

PAYMENT_WEBHOOK_SECRET=$(openssl rand -base64 36)

CORS_ORIGINS=https://alfredomejia.com.mx,https://www.alfredomejia.com.mx,https://demo.alfredomejia.com.mx
TRUST_PROXY_HOPS=1

RATE_LIMIT_MAX=100
AUTH_RATE_LIMIT_MAX=10

PLATFORM_COMMISSION_BPS=1000
PAYOUT_HOLD_DAYS=0

DEMO_MODE=true
EOF
  chown deploy:deploy "$APP_DIR/api.env"
  chmod 600 "$APP_DIR/api.env"
  echo "    api.env generado con secretos nuevos"
else
  echo "    api.env ya existía, no lo toco"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  umask 077
  cat > "$APP_DIR/.env" <<EOF
POSTGRES_USER=marketplace
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
POSTGRES_DB=marketplace
EOF
  chown deploy:deploy "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    .env de Postgres generado"
fi

echo "==> firewall"
# Importante: se permite SSH ANTES de encender ufw, o te quedas fuera.
ufw allow "$SSH_PORT"/tcp comment 'ssh'
ufw allow 80/tcp  comment 'http'
ufw allow 443/tcp comment 'https'
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status verbose

systemctl enable --now fail2ban

echo "==> nginx arriba, sin sitios todavía"
rm -f /etc/nginx/sites-enabled/default
systemctl enable --now nginx

echo
echo "Listo. Los secretos quedaron en:"
echo "  $APP_DIR/.env      (usuario y contraseña de Postgres)"
echo "  $APP_DIR/api.env   (JWT y webhooks)"
echo
echo "Lo que sigue, desde el repo del backend:"
echo "  bash deploy/scripts/server.sh"
echo "  sudo -E bash deploy/scripts/server.sh --tls"
echo "  bash deploy/scripts/server.sh --seed"
