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
# Esto inyecta @angular/compiler necesario para resolver ActionsSubject durante el build
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
COPY --from=builder /app/database ./database
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules

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
