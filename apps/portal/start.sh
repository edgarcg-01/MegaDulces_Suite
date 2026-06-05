#!/bin/sh
# Arranque del contenedor del Portal B2B (SPA estático servido por nginx).
# No corre API ni migraciones: solo sirve el bundle y proxya /api + el socket
# al backend (servicio principal) vía $API_UPSTREAM.
set -e

PORT="${PORT:-10000}"
: "${API_UPSTREAM:?[portal] API_UPSTREAM no seteado. Ej: https://<app-principal>.up.railway.app}"

echo "[portal] nginx en :${PORT} — API_UPSTREAM=${API_UPSTREAM}"

# Solo sustituimos $PORT y $API_UPSTREAM; las demás ($host, $remote_addr, ...)
# son variables de runtime de nginx y deben quedar intactas.
envsubst '$PORT $API_UPSTREAM' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

nginx -g 'daemon off;'
