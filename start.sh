#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — arranque del contenedor (Railway / Render).
#
# Orden:
#   1. Aplica migraciones pendientes (knex migrate:latest). Idempotente y
#      protegido por knex_migrations_lock (safe en restarts concurrentes).
#   2. Lanza la API NestJS en background sobre $API_PORT (interno, fijo).
#   3. Espera un margen de boot y confirma que el proceso sigue vivo.
#   4. Renderiza nginx.conf inyectando $PORT y arranca nginx en background.
#   5. Supervisa ambos: si cualquiera muere, sale 1 → Railway reinicia.
#      (Sin healthcheck HTTP: Railway monitorea el contenedor + esta supervisión.)
#
# Si la API muere o las migraciones fallan, `set -e` aborta el boot y la
# plataforma reintenta. Mejor fallar fuerte que correr con esquema sucio.
# ─────────────────────────────────────────────────────────────────────────────
set -e

API_PORT="${API_PORT:-3333}"
API_PREFIX="${API_PREFIX:-api}"
PORT="${PORT:-10000}"

# ── 1. Migraciones de base de datos ─────────────────────────────────────────
# Skip opcional via SKIP_MIGRATIONS=1 (útil para debugging o para deployar el
# código sin tocar el esquema). En condiciones normales NO debe usarse.
#
# Cuando ENABLE_MULTITENANT=true (post-cutover), corremos las migraciones
# del directorio `migrations-newdb/` apuntando a la nueva DB (`DATABASE_URL_NEW`)
# en lugar del legacy `migrations/`. Sin este branch knex_migrations contendría
# entries de los 2 directorios y daría "directory corrupt".
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "[start] SKIP_MIGRATIONS=1 — saltando knex migrate:latest"
elif [ "${ENABLE_MULTITENANT:-false}" = "true" ]; then
  echo "[start] ENABLE_MULTITENANT=true — corriendo migraciones nuevas (migrations-newdb/)..."
  NODE_ENV=production npx knex migrate:latest --knexfile database/knexfile-newdb.js
  echo "[start] Migrations (nueva DB multi-tenant) aplicadas."
else
  echo "[start] Running knex migrate:latest (legacy DB)..."
  NODE_ENV=production npx knex migrate:latest --knexfile database/knexfile.js
  echo "[start] Migrations applied."
fi

echo "[start] Starting NestJS API on port ${API_PORT}..."
NODE_ENV=production node dist/apps/api/main.js &
API_PID=$!

# Esperamos un tiempo prudencial para que NestJS bindeé el puerto. No usamos
# poll a un endpoint /health (lo eliminamos del API) — el riesgo de levantar
# nginx un poco antes que la API está acotado: los primeros requests verán
# 502 brevemente hasta que la API termine de inicializar. Mejor que matar el
# contenedor por un falso negativo del healthcheck.
echo "[start] Waiting 10s for API to bind port ${API_PORT}..."
sleep 10

# Confirmamos al menos que el proceso de la API sigue vivo. Si murió durante
# el sleep, no tiene sentido seguir.
if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "[start] API process died during boot."
  exit 1
fi
echo "[start] API process alive (PID ${API_PID})."

echo "[start] Configuring Nginx on port ${PORT}..."
envsubst '$PORT' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

echo "[start] Starting Nginx on port ${PORT}..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# Propagar SIGTERM/SIGINT a ambos hijos para un shutdown limpio en redeploys de
# Railway (el `trap` corre cuando tini reenvía la señal a este script).
trap 'echo "[start] señal recibida — terminando API+nginx"; kill -TERM "$API_PID" "$NGINX_PID" 2>/dev/null; exit 0' TERM INT

# Supervisión post-boot: si CUALQUIERA de los dos muere, tumbamos el contenedor
# para que Railway lo reinicie. Antes el API corría sin supervisión → si crasheaba
# después del boot, nginx seguía "sano" sirviendo 502 indefinidamente y el
# contenedor nunca reiniciaba. `kill -0` solo testea que el PID siga vivo.
# (Poll POSIX porque /bin/sh es dash en Debian slim → no hay `wait -n`.)
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 5
done

echo "[start] Un proceso gestionado murió (API_PID=${API_PID} NGINX_PID=${NGINX_PID}) — deteniendo contenedor para que Railway reinicie."
kill -TERM "$API_PID" "$NGINX_PID" 2>/dev/null || true
exit 1
