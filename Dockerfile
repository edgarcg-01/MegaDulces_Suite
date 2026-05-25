# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Trade Marketing — Dockerfile multi-stage
#
# Pipeline:
#   1. deps      → instala TODAS las deps (con devDeps) para compilar
#   2. builder   → reutiliza node_modules de `deps`, compila view + api
#   3. prod-deps → instala SOLO deps de producción (slim, sin scripts)
#   4. runner    → imagen final: nginx + node + dist + node_modules de prod
#
# BuildKit es requerido por los `--mount=type=cache`. Railway exige que el
# `id` esté hardcodeado (no acepta interpolación de ARGs) y siga el formato
# `s/<service-id>-<target>`. Service ID actual: 69f64078-1678-40f4-a266-a18b61a20cde.
# Si se migra a otro servicio de Railway, reemplazar el UUID en ambos RUN.
# Local: el id es solo la clave del cache, así que el literal funciona igual
# en BuildKit estándar (no comparte cache entre máquinas).
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Dependencias completas (capa cacheable) ────────────────────────
FROM node:20-bookworm AS deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

# Solo los archivos que afectan a `npm ci`: el resto del código no debe
# invalidar esta capa.
COPY package*.json .npmrc ./

# `npm ci` requiere lockfile (lo tenemos). NO usamos `--prefer-offline`:
# en Railway la cache de BuildKit no se reusa entre builds (por el formato
# custom de id) y prefer-offline solo añade lógica extra para decidir entre
# cache parcial y registry. Las opciones de retry vienen de .npmrc.
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-/root/.npm,target=/root/.npm \
    npm ci

# ── Stage 2: Compilación de view + api ──────────────────────────────────────
FROM node:20-bookworm AS builder
WORKDIR /app

ENV NX_DAEMON=false \
    CI=true \
    NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Reutilizamos node_modules ya resuelto en `deps` — evita reinstalar.
COPY --from=deps /app/node_modules ./node_modules

# Resto del código fuente (filtrado por .dockerignore).
COPY . .

# Angular v18 con esbuild requiere @angular/compiler cargado en el proceso de
# Node (load-compiler.mjs). El `--max-old-space-size=4096` da margen al heap
# del compilador en builds grandes.
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build view --prod && \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build api --prod

# ── Stage 3: Dependencias solo de producción ────────────────────────────────
FROM node:20-bookworm AS prod-deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

COPY package*.json .npmrc ./

# `--ignore-scripts` evita husky/postinstall en imagen final (no aplican en
# runtime). No usamos `npm cache clean` porque el cache mount no escribe a la
# capa final (BuildKit lo mantiene fuera), así que limpiar es redundante
# y además falla con ENOTEMPTY al ser un mount externo.
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-/root/.npm,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ── Stage 4: Imagen final ───────────────────────────────────────────────────
FROM node:20-slim AS runner

# tini    → PID 1 que reapeha zombies y propaga SIGTERM al script (graceful
#           shutdown cuando Railway/Render reinician).
# nginx   → sirve el SPA + reverse proxy a la API.
# gettext → envsubst para inyectar $PORT en nginx.conf en runtime.
# tzdata  → fija la TZ del contenedor a MX (alinea con `mx-date.ts` del API).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        nginx \
        gettext-base \
        tini \
        tzdata && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PORT lo inyecta Railway (≈10000); API_PORT es interno fijo. NO deben coincidir.
ENV NODE_ENV=production \
    API_PORT=3333 \
    API_PREFIX=api \
    PORT=10000 \
    TZ=America/Mexico_City

# Artefactos de los stages previos.
COPY --from=builder  /app/database     ./database
COPY --from=builder  /app/dist         ./dist
COPY --from=prod-deps /app/node_modules ./node_modules

# Config de nginx + script de arranque.
COPY nginx.conf /etc/nginx/sites-available/default
COPY start.sh   ./start.sh
RUN chmod +x ./start.sh

# El executor `@nx/angular:browser-esbuild` emite directamente en
# `dist/apps/view/` (sin subcarpeta `browser/`). Si en el futuro se migra al
# builder application-builder de Angular, este path cambiará a `.../browser/`.
RUN mkdir -p /usr/share/nginx/html && \
    cp -r dist/apps/view/. /usr/share/nginx/html/

EXPOSE 10000

# Sin HEALTHCHECK explícito. Railway monitorea el container vía el proxy
# edge (si nginx no responde, marca down). Tener un HEALTHCHECK custom
# contra un endpoint específico solo añadía falsos negativos sin beneficio
# real — el endpoint /api/health se eliminó por las mismas razones.

# tini como PID 1 → señales se entregan al script y de ahí a node/nginx.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
