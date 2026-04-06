# --- Stage 1: Build Stage ---
FROM node:20 AS builder
WORKDIR /app

# Configuración de Nx y NPM para ahorrar memoria y evitar errores de red
ENV NX_DAEMON=false \
    CI=true \
    NODE_OPTIONS="--max-old-space-size=4096"

# Copiamos archivos de dependencias y configuraciones base vitales para Nx
COPY package*.json .npmrc tsconfig.base.json nx.json ./

# Usamos 'npm install' para instalar las dependencias
RUN npm install

# Copiamos el resto del código fuente
COPY . .

# Limpiamos la caché de Nx (por si acaso) y compilamos.
# Mantenemos el --verbose en view para ver la traza exacta si NgRx vuelve a fallar.
RUN npx nx reset && npx nx build view --prod --verbose && npx nx build api --prod

# --- Stage 2: Production dependencies ---
FROM node:20 AS prod-deps
WORKDIR /app

# Copiamos solo los archivos de dependencias
COPY package*.json .npmrc ./

# Usamos 'npm install' nuevamente, ignorando dependencias de desarrollo
RUN npm install --omit=dev

# --- Stage 3: Final Image (Ultra Optimized) ---
FROM node:20-slim AS runner
WORKDIR /app

# Variables de entorno para producción
ENV NODE_ENV=production \
    PORT=80 \
    API_PREFIX=api

# Copiamos los binarios construidos y las dependencias de producción
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules

# Exponemos el puerto 80
EXPOSE 80

# El backend sirve automáticamente el frontend gracias a @nestjs/serve-static
CMD ["node", "dist/apps/api/main.js"]