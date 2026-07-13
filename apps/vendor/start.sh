#!/bin/sh
# Arranque del contenedor de la App Vendedor (SPA estático servido por nginx).
# No corre API ni migraciones: solo sirve el bundle y proxya /api + el socket
# al backend (servicio principal) vía $API_UPSTREAM.
set -e

PORT="${PORT:-10000}"
: "${API_UPSTREAM:?[vendor] API_UPSTREAM no seteado. Ej: https://<app-principal>.up.railway.app}"

# nginx proxy_pass exige scheme (http/https). Si la var vino solo como dominio,
# anteponemos el scheme correcto: la red privada de Railway (*.railway.internal)
# NO tiene TLS → http; el resto https.
case "$API_UPSTREAM" in
  http://*|https://*) ;;
  *railway.internal*) API_UPSTREAM="http://$API_UPSTREAM" ;;
  *) API_UPSTREAM="https://$API_UPSTREAM" ;;
esac

# DNS del proxy: si el upstream vive en la red privada de Railway, solo el DNS
# interno (fd12::10) resuelve *.railway.internal (a IPv6, tráfico NO facturado).
# Para upstream público seguimos con DNS público. Override vía NGINX_RESOLVER.
if [ -z "${NGINX_RESOLVER:-}" ]; then
  case "$API_UPSTREAM" in
    *railway.internal*) NGINX_RESOLVER="[fd12::10]" ;;
    *) NGINX_RESOLVER="1.1.1.1 8.8.8.8" ;;
  esac
fi
export NGINX_RESOLVER

echo "[vendor] nginx en :${PORT} — API_UPSTREAM=${API_UPSTREAM} (resolver ${NGINX_RESOLVER})"

# Solo sustituimos $PORT, $API_UPSTREAM y $NGINX_RESOLVER; las demás ($host,
# $remote_addr, ...) son variables de runtime de nginx y deben quedar intactas.
envsubst '$PORT $API_UPSTREAM $NGINX_RESOLVER' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

# El sello de versión (index.html / assets/version.json) se inyecta en BUILD-TIME
# (ver Dockerfile), NO acá: mutar esos archivos en runtime rompe los hashes de
# ngsw → loop de re-fetch del service worker. Acá solo lo logueamos.
echo "[vendor] build $(printf '%s' "${RAILWAY_GIT_COMMIT_SHA:-unknown}" | cut -c1-7)"

exec nginx -g 'daemon off;'
