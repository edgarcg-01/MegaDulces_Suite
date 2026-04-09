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

# ─── Seeds (only on FIRST deploy / empty DB) ─────────────────────────────────
# Check if the users table already has data; if so, skip seeding to protect
# production data from being wiped on every re-deploy.
USER_COUNT=$(node -e "
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const knex = require('knex')(require('./database/knexfile.js').production);
knex('users').count('id as count').first()
  .then(r => { process.stdout.write(String(r.count)); return knex.destroy(); })
  .catch(() => { process.stdout.write('0'); process.exit(0); });
" 2>/dev/null || echo "0")

if [ "$USER_COUNT" = "0" ]; then
  echo "Running Seeds (empty DB detected)..."
  npx knex seed:run --knexfile database/knexfile.js
else
  echo "Skipping seeds — DB already has $USER_COUNT users. Running migrations only."
fi

# ─── Start backend ────────────────────────────────────────────────────────────
echo "Starting Backend..."
node dist/apps/api/main.js &
BACKEND_PID=$!

# ─── Start Nginx ──────────────────────────────────────────────────────────────
echo "Starting Nginx on port $PORT..."
nginx -g "daemon off;"

# If Nginx stops, also stop the backend
kill $BACKEND_PID
