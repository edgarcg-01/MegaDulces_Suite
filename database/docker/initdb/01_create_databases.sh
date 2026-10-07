#!/bin/bash
# Init script de Postgres 18 — corre una sola vez al crear el volumen.
# Crea las 2 DBs que Trade Marketing necesita: legacy + multi-tenant.
#
# La DB megadulces_logistica ya la crea POSTGRES_DB del entorno.
# Acá agregamos postgres_platform y el rol app_runtime.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE postgres_platform;
  CREATE ROLE app_runtime WITH LOGIN PASSWORD 'app_runtime';
EOSQL

# Cargar pgvector extension en ambas DBs (opcional — el matcher la espera).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres_platform <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname megadulces_logistica <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOSQL

echo "════════════════════════════════════════════════════"
echo " Trade Marketing — dev DBs ready"
echo "  • megadulces_logistica  (legacy)"
echo "  • postgres_platform     (multi-tenant)"
echo "  • role app_runtime      (password: app_runtime)"
echo ""
echo " Next: npm run migrate:latest && npm run migrate:new"
echo "════════════════════════════════════════════════════"
