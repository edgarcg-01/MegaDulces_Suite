# --- Stage 1: Build Stage ---
FROM node:20 AS builder
WORKDIR /app

# Configuración de Nx y NPM para ahorrar memoria y evitar errores de red
ENV NX_DAEMON=false \
    CI=true \
    NODE_OPTIONS="--max-old-space-size=4096"

# Copiamos archivos de configuración de dependencias (incluye el .npmrc)
COPY package*.json .npmrc ./
COPY apps/view/package*.json ./apps/view/

# Instalamos TODAS las dependencias (el .npmrc se encarga de legacy-peer-deps)
RUN npm install

# Copiamos el resto del código
COPY . .

# Compilamos las aplicaciones explícitamente una por una
# Usamos un solo comando para evitar problemas de capas si uno falla
# Primero el View (Angular) que es el más propenso a errores de compilador
RUN npx nx build view --prod && npx nx build api --prod

# --- Stage 2: Production dependencies ---
FROM node:20 AS prod-deps
WORKDIR /app
COPY package*.json .npmrc ./
# Instalamos solo dependencias de producción
RUN npm install --omit=dev

# --- Stage 3: Final Image (Ultra Optimized) ---
FROM node:20-slim AS runner

WORKDIR /app

# Variables de entorno para producción
ENV NODE_ENV=production \
    PORT=80 \
    API_PREFIX=api

# Copiamos todo lo necesario desde el builder y prod-deps
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules

# Exponemos el puerto 80
EXPOSE 80

# El backend sirve automáticamente el frontend gracias a @nestjs/serve-static
CMD ["node", "dist/apps/api/main.js"]
