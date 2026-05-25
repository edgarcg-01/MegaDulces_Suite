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
# nginx en foreground — tini lo recibe como hijo directo y propaga SIGTERM.
nginx -g 'daemon off;'
