#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# migrate.sh — aplica migraciones pendientes (knex migrate:latest).
#
# Corre como `preDeployCommand` de Railway (ver railway.api.json), NO en el boot
# de la app. Motivo: si una migración falla (p.ej. "migration directory is
# corrupt"), el deploy nuevo se marca FAILED y Railway MANTIENE el deploy
# anterior sirviendo tráfico — sin crash loop ni downtime. Antes esto vivía en
# start.sh con `set -e`, así que un fallo de migración tumbaba el contenedor y
# Railway reintentaba el mismo error 10 veces (crash loop, prod caído).
#
# Idempotente y protegido por knex_migrations_lock (safe en corridas
# concurrentes). Skip opcional via SKIP_MIGRATIONS=1 (solo debugging).
#
# Cuando ENABLE_MULTITENANT=true (post-cutover) corre migrations-newdb/ contra
# la nueva DB (knexfile-newdb.js); si no, el legacy. Nunca los dos juntos, o
# knex_migrations mezcla entries de ambos dirs → "directory corrupt".
# ─────────────────────────────────────────────────────────────────────────────
set -e

if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "[migrate] SKIP_MIGRATIONS=1 — saltando knex migrate:latest"
  exit 0
fi

if [ "${ENABLE_MULTITENANT:-false}" = "true" ]; then
  echo "[migrate] ENABLE_MULTITENANT=true — corriendo migraciones nuevas (migrations-newdb/)..."
  NODE_ENV=production npx knex migrate:latest --knexfile database/knexfile-newdb.js
  echo "[migrate] Migrations (nueva DB multi-tenant) aplicadas."
else
  echo "[migrate] Running knex migrate:latest (legacy DB)..."
  NODE_ENV=production npx knex migrate:latest --knexfile database/knexfile.js
  echo "[migrate] Migrations applied."
fi
