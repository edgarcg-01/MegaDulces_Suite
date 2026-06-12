#!/bin/sh
# Arranque del contenedor del Portal B2B (SPA estático servido por nginx).
# No corre API ni migraciones: solo sirve el bundle y proxya /api + el socket
# al backend (servicio principal) vía $API_UPSTREAM.
set -e

PORT="${PORT:-10000}"
: "${API_UPSTREAM:?[portal] API_UPSTREAM no seteado. Ej: https://<app-principal>.up.railway.app}"

# nginx proxy_pass exige scheme (http/https). Si la var vino solo como dominio
# (caso típico al pegarla en Railway), anteponemos https:// para no romper boot.
case "$API_UPSTREAM" in
  http://*|https://*) ;;
  *) API_UPSTREAM="https://$API_UPSTREAM" ;;
esac

echo "[portal] nginx en :${PORT} — API_UPSTREAM=${API_UPSTREAM}"

# Solo sustituimos $PORT y $API_UPSTREAM; las demás ($host, $remote_addr, ...)
# son variables de runtime de nginx y deben quedar intactas.
envsubst '$PORT $API_UPSTREAM' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

# exec → nginx reemplaza a sh y queda como hijo directo de tini, así recibe
# SIGTERM sin intermediario (shutdown limpio en redeploys de Railway).
exec nginx -g 'daemon off;'
