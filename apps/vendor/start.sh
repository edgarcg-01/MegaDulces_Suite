#!/bin/sh
# Arranque del contenedor de la App Vendedor (SPA estático servido por nginx).
# No corre API ni migraciones: solo sirve el bundle y proxya /api + el socket
# al backend (servicio principal) vía $API_UPSTREAM.
set -e

PORT="${PORT:-10000}"
: "${API_UPSTREAM:?[vendor] API_UPSTREAM no seteado. Ej: https://<app-principal>.up.railway.app}"

# nginx proxy_pass exige scheme (http/https). Si la var vino solo como dominio,
# anteponemos https:// para no romper boot.
case "$API_UPSTREAM" in
  http://*|https://*) ;;
  *) API_UPSTREAM="https://$API_UPSTREAM" ;;
esac

echo "[vendor] nginx en :${PORT} — API_UPSTREAM=${API_UPSTREAM}"

# Solo sustituimos $PORT y $API_UPSTREAM; las demás ($host, $remote_addr, ...)
# son variables de runtime de nginx y deben quedar intactas.
envsubst '$PORT $API_UPSTREAM' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

# ── Sello de versión (diagnóstico deploy-vs-cache) ───────────────────────────
# Inyecta el commit (Railway lo provee en runtime como RAILWAY_GIT_COMMIT_SHA) y
# la hora de arranque del contenedor en los archivos NO hasheados: index.html
# (no-cache) y assets/version.json (no-store). El overlay del app los muestra →
# si el device enseña un commit/hora viejos, el build servido NO es el actual.
# NB: nunca toca los bundles hasheados (main.<hash>.js), solo texto re-leído.
HTML_DIR="/usr/share/nginx/html"
BUILD_COMMIT_SHORT=$(printf '%s' "${RAILWAY_GIT_COMMIT_SHA:-unknown}" | cut -c1-7)
BUILD_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for f in "$HTML_DIR/index.html" "$HTML_DIR/assets/version.json"; do
  if [ -f "$f" ]; then
    sed -i "s|BUILD_COMMIT_PLACEHOLDER|${BUILD_COMMIT_SHORT}|g; s|BUILD_TS_PLACEHOLDER|${BUILD_TS}|g" "$f"
  fi
done
echo "[vendor] build ${BUILD_COMMIT_SHORT} @ ${BUILD_TS}"

exec nginx -g 'daemon off;'
