# --- Stage 1: Build Stage ---
FROM node:20 AS builder
WORKDIR /app

# Configuración de Nx y NPM para ahorrar memoria y evitar errores de red
ENV NX_DAEMON=false \
    CI=true \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs"

# Copiamos archivos de dependencias y configuraciones base
COPY package*.json .npmrc tsconfig.base.json nx.json load-compiler.mjs ./

# Instalamos dependencias
RUN npm install

# Copiamos el resto del código fuente
COPY . .

# Compilamos las aplicaciones (NestJS y Angular)
# No usamos plugins en nx.json para mayor estabilidad en Docker
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

# El comando de inicio es un solo proceso de Node.js
CMD ["node", "dist/apps/api/main.js"]
