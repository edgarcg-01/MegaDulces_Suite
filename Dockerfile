# --- Stage 1: Build Stage ---
FROM node:20 AS builder
WORKDIR /app

# Configuración de Nx y NPM para ahorrar memoria y evitar errores de red
ENV NX_DAEMON=false \
    CI=true \
    NODE_OPTIONS="--max-old-space-size=4096"

# Copiamos archivos de configuración de dependencias (incluye el nuevo .npmrc)
COPY package*.json .npmrc ./
COPY apps/view/package*.json ./apps/view/

# Instalamos TODAS las dependencias (el .npmrc se encarga de legacy-peer-deps)
RUN npm install

# Copiamos el resto del código
COPY . .

# Compilamos las aplicaciones (NestJS y Angular)
RUN npm run build

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
# Copiamos la carpeta dist completa (contiene api y view)
COPY --from=builder /app/dist ./dist
# Copiamos las dependencias de producción
COPY --from=prod-deps /app/node_modules ./node_modules

# Exponemos el puerto 80 (el puerto que el hosting suele esperar)
EXPOSE 80

# El comando de inicio ahora es un solo proceso de Node.js
# El backend sirve automáticamente el frontend gracias a @nestjs/serve-static
CMD ["node", "dist/apps/api/main.js"]
