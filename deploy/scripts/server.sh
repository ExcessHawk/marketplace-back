#!/usr/bin/env bash
# Despliega desde los clones que ya viven en el servidor. Se corre AQUÍ, en el
# VPS, no desde tu máquina.
#
#   cd ~/portafolio/marketplace-back
#   bash deploy/scripts/server.sh            # todo: git pull, sitios y API
#   bash deploy/scripts/server.sh --web      # solo los dos sitios estáticos
#   bash deploy/scripts/server.sh --api      # solo la API
#   bash deploy/scripts/server.sh --tls      # nginx y certificados (necesita root)
#   bash deploy/scripts/server.sh --seed     # siembra la demostración
#   bash deploy/scripts/server.sh --no-pull  # usa lo que ya está clonado
#
# Espera esta vecindad, que es como quedaron los clones:
#   ~/portafolio/
#     marketplace-back/   <- este repo
#     marketplace-front/
#     portafolio-v2/

set -euo pipefail

BACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$(dirname "$BACK")"
FRONT="${FRONT_DIR:-$BASE/marketplace-front}"
PORTAFOLIO="${PORTAFOLIO_DIR:-$BASE/portafolio-v2}"

PORTFOLIO_DOMAIN="${PORTFOLIO_DOMAIN:-alfredomejia.com.mx}"
DEMO_WEB="${DEMO_WEB:-https://demo.alfredomejia.com.mx}"
DEMO_API="${DEMO_API:-https://api.veloce-ts.com}"
EMAIL="${CERT_EMAIL:-mejia_alfredo@outlook.com}"

COMPOSE=(docker compose --env-file "$BACK/.env" -f "$BACK/deploy/docker-compose.prod.yml")

do_web=false do_api=false do_tls=false do_seed=false do_pull=true
if [ $# -eq 0 ]; then
  do_web=true; do_api=true
fi
for arg in "$@"; do
  case "$arg" in
    --web)     do_web=true ;;
    --api)     do_api=true ;;
    --tls)     do_tls=true ;;
    --seed)    do_seed=true ;;
    --all)     do_web=true; do_api=true ;;
    --no-pull) do_pull=false ;;
    *) echo "opción desconocida: $arg"; exit 1 ;;
  esac
done

say() { printf '\n==> %s\n' "$1"; }

falta() {
  echo "No encontré $1."
  echo "Si los clones están en otro lado, dímelo con FRONT_DIR= y PORTAFOLIO_DIR=."
  exit 1
}

[ -d "$FRONT" ] || falta "$FRONT"
[ -d "$PORTAFOLIO" ] || falta "$PORTAFOLIO"

if ! command -v bun >/dev/null 2>&1; then
  echo "Falta bun. Instálalo con: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if $do_pull; then
  say "trayendo lo último de GitHub"
  for repo in "$BACK" "$FRONT" "$PORTAFOLIO"; do
    printf '  %-22s ' "$(basename "$repo")"
    git -C "$repo" pull --ff-only --quiet && echo "$(git -C "$repo" rev-parse --short HEAD)"
  done
fi

if $do_web; then
  say "construyendo el portafolio"
  ( cd "$PORTAFOLIO" && bun install --silent && PUBLIC_DEMO_API="$DEMO_API" PUBLIC_DEMO_WEB="$DEMO_WEB" bun run build )

  say "construyendo el frontend del marketplace"
  ( cd "$FRONT" && bun install --silent && bun run build )

  say "publicando los sitios"
  sudo mkdir -p /var/www/portafolio /var/www/marketplace
  sudo rsync -a --delete "$PORTAFOLIO/dist/" /var/www/portafolio/ 2>/dev/null ||
    { sudo rm -rf /var/www/portafolio/*; sudo cp -r "$PORTAFOLIO/dist/." /var/www/portafolio/; }
  sudo rsync -a --delete "$FRONT/dist/" /var/www/marketplace/ 2>/dev/null ||
    { sudo rm -rf /var/www/marketplace/*; sudo cp -r "$FRONT/dist/." /var/www/marketplace/; }
  echo "  portafolio:  $(find /var/www/portafolio -type f | wc -l) archivos"
  echo "  marketplace: $(find /var/www/marketplace -type f | wc -l) archivos"
fi

if $do_api; then
  [ -f "$BACK/.env" ]     || { echo "Falta $BACK/.env (usuario y contraseña de Postgres). Lo genera bootstrap.sh."; exit 1; }
  [ -f "$BACK/api.env" ]  || { echo "Falta $BACK/api.env (secretos de la API). Lo genera bootstrap.sh."; exit 1; }

  say "levantando los contenedores"
  "${COMPOSE[@]}" build api
  "${COMPOSE[@]}" up -d

  say "esperando a que la API responda"
  for i in $(seq 1 30); do
    if curl -fsS -m 5 http://127.0.0.1:3102/health/ready >/dev/null 2>&1; then
      echo "  lista"
      break
    fi
    [ "$i" -eq 30 ] && { echo "  no respondió; mira los logs con: ${COMPOSE[*]} logs api"; exit 1; }
    sleep 2
  done

  say "migraciones"
  "${COMPOSE[@]}" exec -T api bun run db:migrate
fi

if $do_tls; then
  [ "$(id -u)" -eq 0 ] || { echo "--tls necesita root. Corre: sudo -E bash deploy/scripts/server.sh --tls"; exit 1; }

  say "nginx"
  cp "$BACK"/deploy/nginx/*.conf /etc/nginx/sites-available/
  for site in portafolio marketplace api; do
    ln -sf "/etc/nginx/sites-available/$site.conf" "/etc/nginx/sites-enabled/$site.conf"
  done
  nginx -t
  systemctl reload nginx

  say "certificados"
  # Un certificado por sitio, y solo para los nombres que apuntan AQUÍ. No
  # basta con que resuelvan: un dominio recién comprado resuelve al parking
  # del registrador, y el reto se serviría desde otra máquina.
  MI_IP=$(curl -sS -m 10 https://api.ipify.org || hostname -I | awk '{print $1}')
  echo "  este servidor es $MI_IP"

  resuelve() {
    local ips
    ips=$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u)
    [ -n "$ips" ] || return 1
    echo "$ips" | grep -qx "$MI_IP"
  }

  emitir() {
    local args=()
    for host in "$@"; do
      if resuelve "$host"; then
        args+=(-d "$host")
      else
        echo "  saltando $host: todavía no apunta a este servidor"
      fi
    done
    [ ${#args[@]} -gt 0 ] || { echo "  nada que certificar"; return 0; }
    certbot --nginx --non-interactive --agree-tos --redirect -m "$EMAIL" "${args[@]}"
  }

  emitir "$PORTFOLIO_DOMAIN" "www.$PORTFOLIO_DOMAIN"
  emitir demo.alfredomejia.com.mx
  emitir api.veloce-ts.com

  nginx -t
  systemctl reload nginx
fi

if $do_seed; then
  say "sembrando la demostración"
  "${COMPOSE[@]}" exec -T api bun run demo:seed
fi

say "comprobando"
for url in "https://$PORTFOLIO_DOMAIN/" "$DEMO_WEB/" "$DEMO_API/health/ready"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "$url" 2>/dev/null || echo 000)
  printf '  %-45s %s\n' "$url" "$code"
done

echo
echo "Listo."
