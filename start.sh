#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# start.sh — arranque del contenedor (Railway / Render).
#
# Orden:
#   1. Aplica migraciones pendientes (knex migrate:latest). Idempotente y
#      protegido por knex_migrations_lock (safe en restarts concurrentes).
#   2. Lanza la API NestJS en background sobre $API_PORT (interno, fijo).
#   3. Espera a que /api/health responda 200 antes de levantar nginx.
#   4. Renderiza nginx.conf inyectando $PORT (dinámico de Railway).
#   5. Arranca nginx en foreground (PID 1 lo gestiona tini, ver Dockerfile).
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
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "[start] SKIP_MIGRATIONS=1 — saltando knex migrate:latest"
else
  echo "[start] Running knex migrate:latest..."
  NODE_ENV=production npx knex migrate:latest --knexfile database/knexfile.js
  echo "[start] Migrations applied."
fi

echo "[start] Starting NestJS API on port ${API_PORT}..."
NODE_ENV=production node dist/apps/api/main.js &
API_PID=$!

# Poll /api/health en lugar de sleep fijo. Si en 60s no responde, abortamos
# (el contenedor sale unhealthy y la plataforma reintenta).
echo "[start] Waiting for API health (max 60s)..."
i=0
until wget -q --spider "http://127.0.0.1:${API_PORT}/${API_PREFIX}/health" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[start] API failed to become healthy in 60s, aborting."
    kill -TERM "$API_PID" 2>/dev/null || true
    exit 1
  fi
  # Si el proceso de la API ya murió, no tiene sentido seguir esperando.
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "[start] API process died during boot."
    exit 1
  fi
  sleep 1
done
echo "[start] API is up."

echo "[start] Configuring Nginx on port ${PORT}..."
envsubst '$PORT' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

echo "[start] Starting Nginx on port ${PORT}..."
# nginx en foreground — tini lo recibe como hijo directo y propaga SIGTERM.
nginx -g 'daemon off;'
