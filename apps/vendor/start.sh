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
# ── [VL.9.12] LAS DOS CABECERAS QUE FUERZAN HTTPS, CONDICIONALES ────────────────
# `Strict-Transport-Security` y el `upgrade-insecure-requests` del CSP son CORRECTAS
# detrás de TLS: en Railway lo termina la plataforma. Servido por HTTP plano —que es
# como queda on-prem hasta que exista el tunel— vuelven la app INUSABLE en un
# navegador: el CSP reescribe cada recurso a https:// y el puerto no habla TLS, asi
# que todo muere con ERR_SSL_PROTOCOL_ERROR. Medido el 2026-09-22 abriendo
# http://192.168.0.222:8080.
#
# El default es `true` = el comportamiento de SIEMPRE, para que Railway no cambie.
# Solo el compose on-prem pone `TLS_TERMINADO=false`, y tiene que volver a `true`
# el dia que el tunel de Cloudflare termine TLS adelante.
#
# ⚠️ Y hay un efecto que sobrevive al arreglo: el navegador YA guardo la politica
# HSTS de ese host y la va a respetar hasta un anio. Se borra en
# chrome://net-internals/#hsts -> "Delete domain security policies".
if [ "${TLS_TERMINADO:-true}" = "false" ]; then
  HSTS_LINE=""
  CSP_UPGRADE=""
  echo "[start] TLS_TERMINADO=false -> sin HSTS y sin upgrade-insecure-requests (servido por HTTP plano)"
else
  HSTS_LINE='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
  CSP_UPGRADE="upgrade-insecure-requests"
fi
export HSTS_LINE CSP_UPGRADE

envsubst '$PORT $API_UPSTREAM $NGINX_RESOLVER $HSTS_LINE $CSP_UPGRADE' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

# ── `[CD.23]` EL SELLO DE VERSIÓN SE ESCRIBE ACÁ, NO EN EL BUILD ───────────────────
# `assets/version.json` ya no sale de `public/`: lo escribe este arranque con lo que la
# imagen horneó en `GIT_COMMIT_SHA`/`GIT_COMMIT_ISO`. Así el bundle de Angular es idéntico
# entre commits y Nx acierta su caché — el `sed` que vivía en el Dockerfile costaba 34-49 s
# por despliegue, en el 100% de los despliegues (medido sobre 6, el 2026-10-06).
#
# ⛔ `index.html` NO se toca, ni acá ni en el build: ngsw hashea sus bytes finales y los de
#    `assets/**`; mutarlos deja `ngsw.json` desfasado → loop de re-fetch del service worker.
#    (El comentario que había en `index.html` afirmaba que este guion ya sellaba en runtime.
#    No era cierto: sellaba el Dockerfile. Ahora sí es cierto, y por otra vía.)
#    Este archivo es seguro porque ngsw NO lo construyó: no está en su tabla de hashes.
#
# ⚠️ No es fatal: el vendedor en campo prefiere una app sin sello a una app que no arranca.
SELLO_SHA="$(printf '%s' "${GIT_COMMIT_SHA:-unknown}" | cut -c1-7)"
mkdir -p /usr/share/nginx/html/assets 2>/dev/null || true
if printf '{"commit":"%s","timestamp":"%s","app":"vendor"}\n' "$SELLO_SHA" "${GIT_COMMIT_ISO:-unknown}" \
     > /usr/share/nginx/html/assets/version.json 2>/dev/null; then
  echo "[vendor] build $SELLO_SHA (${GIT_COMMIT_ISO:-sin fecha}) → /assets/version.json"
else
  echo "[vendor] ⚠️  no pude escribir /assets/version.json — queda SIN sello; sigo arrancando"
fi

exec nginx -g 'daemon off;'
