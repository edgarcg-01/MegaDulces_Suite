# --- Stage 1: Build Stage ---
FROM node:20 AS builder
WORKDIR /app

# Configuración base para Nx y NPM (sin el cargador aún)
ENV NX_DAEMON=false \
    CI=true \
    NODE_OPTIONS="--max-old-space-size=4096"

# Copiamos archivos de dependencias y configuraciones base
COPY package*.json .npmrc tsconfig.base.json nx.json load-compiler.mjs ./

# Instalamos dependencias (esto corre sin el cargador para evitar ERR_MODULE_NOT_FOUND)
RUN npm install

# Copiamos el resto del código fuente
COPY . .

# Compilamos las aplicaciones usando el cargador global SOLO en este paso
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" npx nx build view --prod && \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" npx nx build api --prod

# --- Stage 2: Production dependencies ---
FROM node:20 AS prod-deps
WORKDIR /app
COPY package*.json .npmrc ./
# Instalamos solo dependencias de producción
RUN npm install --omit=dev

# --- Stage 3: Final Image (Ultra Optimized) ---
FROM node:20-slim AS runner

# Instalamos nginx y dependencias mínimas requeridas para el despliegue
RUN apt-get update && apt-get install -y nginx && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Variables de entorno para producción
ENV NODE_ENV=production \
    PORT=3000 \
    API_PREFIX=api

# Copiamos todo lo necesario desde los stages previos
COPY --from=builder /app/database ./database
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules

# Copiamos configuración de Nginx y script de inicio
# Nota: La ruta de Nginx en debian-slim suele ser /etc/nginx/sites-available/default o /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/sites-available/default
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

# Aseguramos que el frontend se sirve desde la ruta configurada en nginx.conf
# Angular v17+ compila usualmente a dist/apps/view/browser
RUN mkdir -p /usr/share/nginx/html && \
    cp -r dist/apps/view/browser/* /usr/share/nginx/html/ || \
    cp -r dist/apps/view/* /usr/share/nginx/html/

# Exponemos el puerto 80 (Nginx)
EXPOSE 80

# El comando de inicio coordina migraciones, seeds, api y nginx
CMD ["sh", "./start.sh"]
