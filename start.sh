#!/bin/sh
# Abort immediately if any command fails
set -e

# ─── Inject $PORT into nginx config ──────────────────────────────────────────
# Render injects PORT at runtime. We stored ${PORT} as a placeholder in nginx.conf.
export PORT="${PORT:-10000}"
envsubst '${PORT}' < /etc/nginx/sites-available/default > /tmp/nginx-rendered.conf
cp /tmp/nginx-rendered.conf /etc/nginx/sites-available/default

# Verify nginx config is valid before starting
nginx -t

# ─── Database migrations ──────────────────────────────────────────────────────
echo "Running database migrations from: $(pwd)/database/migrations"
if ! npx knex migrate:latest --knexfile database/knexfile.js; then
  echo "DB Setup failed: Migration error"
  exit 2
fi

# ─── Seeds ──────────────────────────────────────────────────────────────────
# Seeds are now idempotent - they check existence before inserting
# This allows incremental seeding without wiping existing data
# 000_cleanup.js is protected and skips in production
# 00a_zones.js, 00_roles.js, 02_brands.js, 03_products.js check existence before inserting
# 01_users.js and others only run on fresh installs

echo "Running database seeds (idempotent mode)..."
npx knex seed:run --knexfile database/knexfile.js || echo "Warning: Some seeds may have failed, continuing..."

# ─── Start backend ────────────────────────────────────────────────────────────
echo "Starting Backend..."
node dist/apps/api/main.js &
BACKEND_PID=$!

# ─── Start Nginx ──────────────────────────────────────────────────────────────
echo "Starting Nginx on port $PORT..."
nginx -g "daemon off;"

# If Nginx stops, also stop the backend
kill $BACKEND_PID
