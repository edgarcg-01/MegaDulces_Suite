#!/bin/sh

echo "Running Migrations..."
npx knex migrate:latest --knexfile database/knexfile.js

echo "Running Seeds..."
npx knex seed:run --knexfile database/knexfile.js

echo "Starting Backend..."
# Start the backend in the background and log to stdout
node dist/apps/api/main.js &
BACKEND_PID=$!

echo "Starting Nginx..."
# Start Nginx in the foreground
nginx -g "daemon off;"

# If Nginx stops, also stop the backend
kill $BACKEND_PID
