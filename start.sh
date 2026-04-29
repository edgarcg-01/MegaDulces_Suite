#!/bin/sh

set -e

# Ejecutar migración de productos primero
echo "Running product migration..."
npx knex migrate:latest --knexfile database/knexfile-products.js --env production || echo "Migration may have already run or failed, continuing..."

# Iniciar la API NestJS en el puerto API_PORT (3333)
echo "Starting NestJS API on port $API_PORT..."
NODE_ENV=production node dist/apps/api/main.js &

# Esperar a que la API esté lista
sleep 5

# Configurar Nginx para usar el puerto PORT (inyectado por Railway)
echo "Configuring Nginx on port $PORT..."
export PORT=${PORT:-10000}
envsubst '$PORT' < /etc/nginx/sites-available/default > /tmp/nginx.conf
mv /tmp/nginx.conf /etc/nginx/sites-available/default

# Iniciar Nginx
echo "Starting Nginx on port $PORT..."
nginx -g 'daemon off;'
