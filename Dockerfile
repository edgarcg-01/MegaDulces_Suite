# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Trade Marketing — Dockerfile multi-stage
#
# Pipeline:
#   1. deps      → instala TODAS las deps (con devDeps) para compilar
#   2. builder   → reutiliza node_modules de `deps`, compila view + api
#   3. prod-deps → reusa node_modules y le aplica npm prune (sin re-descargar)
#   4. runner    → imagen final: nginx-light + node + dist + node_modules de prod
#                  Corre como user `node` (UID 1000), NO root.
#
# BuildKit es requerido por los `--mount=type=cache`. Railway exige que el
# `id` esté hardcodeado (no acepta interpolación de ARGs) y siga el formato
# `s/<service-id>-<target>`. Service ID actual: 69f64078-1678-40f4-a266-a18b61a20cde.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Dependencias completas (capa cacheable) ────────────────────────
# slim ahorra ~700MB de pull en builds frescos vs `bookworm` completo.
# Angular 18 + esbuild + nx no necesitan los extras (git, python build tools)
# que trae el bookworm full.
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# ENV (no ARG) porque npm los lee como env vars en el process. ARG no se
# expone automáticamente al RUN — el cambio a ARG hacía que npm ignorara
# loglevel/fund/audit. Persisten en la imagen del stage, no en `runner`.
ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true \
    PUPPETEER_SKIP_DOWNLOAD=true

# Solo los archivos que afectan a `npm ci`: el resto del código no debe
# invalidar esta capa.
COPY package*.json .npmrc ./

# `npm ci` requiere lockfile (lo tenemos). NO usamos `--prefer-offline`:
# en Railway la cache de BuildKit no se reusa entre builds (por el formato
# custom de id) y prefer-offline solo añade lógica extra para decidir entre
# cache parcial y registry. Las opciones de retry vienen de .npmrc.
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-npm,target=/root/.npm \
    npm ci

# ── Stage 2: Compilación de view + api ──────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

ENV NX_DAEMON=false \
    CI=true \
    NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Reutilizamos node_modules ya resuelto en `deps` — evita reinstalar.
COPY --from=deps /app/node_modules ./node_modules

# COPY granular: cualquier archivo que NO sea código fuente o build config no
# debe invalidar el cache del bundle. Antes `COPY . .` rebuildeaba el bundle
# completo de Angular (~1 min) por un cambio en README o tests.
COPY nx.json package.json package-lock.json tsconfig*.json .npmrc load-compiler.mjs ./
COPY apps ./apps
COPY libs ./libs
COPY database ./database

# Angular v18 con esbuild requiere @angular/compiler cargado en el proceso de
# Node (load-compiler.mjs). El `--max-old-space-size=4096` da margen al heap
# del compilador en builds grandes. `--configuration=production` reemplaza el
# alias deprecated `--prod` (deja warning en Angular 18, error en futuros).
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build view --configuration=production && \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build api --configuration=production

# ── Stage 3: Dependencias solo de producción ────────────────────────────────
# Reusamos el node_modules ya resuelto en `deps` y solo quitamos las
# devDependencies con `npm prune`. Sin red, ~3-5s.
#
# OJO: NO usar `npm dedupe` acá. En monorepos Nx el árbol ya viene plano
# (npm hoistea por default desde v7) y dedupe NO encuentra qué eliminar →
# se la pasa caminando el árbol completo y toma 5-7 minutos para ahorrar
# <1MB. Ya nos pasó en CI de Railway (build 6m59s casi todo en dedupe).
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

COPY package*.json .npmrc ./
COPY --from=deps /app/node_modules ./node_modules

RUN npm prune --omit=dev --ignore-scripts

# ── Stage 4: Imagen final ───────────────────────────────────────────────────
FROM node:20-slim AS runner

# nginx-light → SPA serving + reverse proxy, ~30MB menos que nginx full.
# tini        → PID 1 que reapeha zombies y propaga SIGTERM al script.
# gettext     → envsubst para inyectar $PORT en nginx.conf en runtime.
# tzdata      → fija la TZ del contenedor a MX (alinea con `mx-date.ts` del API).
#
# Cache mounts: BuildKit preserva /var/cache/apt y /var/lib/apt entre builds.
# NO borrar `/var/lib/apt/lists` con `rm -rf` con cache mount activo —
# el mount mismo ya queda fuera de la capa final.
# `docker-clean` borrado para que apt no auto-elimine del cache.
#
# Permisos para non-root nginx:
#   - pid → /tmp/nginx.pid (sed del default `/run/nginx.pid`).
#   - logs → /var/log/nginx (chown a `node`).
#   - cache/temp dirs → /var/lib/nginx (chown a `node`).
#   - sites-available/default → chown porque start.sh lo reescribe con envsubst.
#   - /usr/share/nginx/html → chown (nginx leerá los assets como node).
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-apt-lists,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        nginx-light \
        gettext-base \
        tini \
        tzdata \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available

WORKDIR /app
RUN chown node:node /app

# PORT lo inyecta Railway (≈10000); API_PORT es interno fijo. NO deben coincidir.
# PUPPETEER_EXECUTABLE_PATH apunta al chromium del SO (apt-get install -y chromium).
# Evita que puppeteer intente descargar chrome a ~/.cache/puppeteer en runtime
# (que ni siquiera tendría permisos como user `node`).
ENV NODE_ENV=production \
    API_PORT=3333 \
    API_PREFIX=api \
    PORT=10000 \
    TZ=America/Mexico_City \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

# Artefactos de los stages previos.
#   - dist/apps/api → corre con node (start.sh).
#   - database/    → knex migrate:latest en boot lo lee.
#   - node_modules → solo prod, ya prune-eado.
#   - dist/apps/view → directo a /usr/share/nginx/html (un layer menos vs
#     el `RUN mkdir + cp -r` previo).
# `--chown=node:node` para que el user non-root pueda leerlo todo sin
# necesidad de un `chown -R` post-copy (que duplicaría todos los inodes).
COPY --from=builder  --chown=node:node /app/dist/apps/api ./dist/apps/api
COPY --from=builder  --chown=node:node /app/database     ./database
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# Bundle del SPA → /usr/share/nginx/html. Solo nginx lo sirve. NestJS YA
# NO usa ServeStaticModule (removido por bug del exclude pattern en
# Express 5: el fallback static interceptaba TODO request no-API y tiraba
# ENOENT con 404 JSON. nginx hace el SPA serving en el puerto $PORT;
# NestJS solo recibe /api/* proxy desde nginx).
COPY --from=builder  --chown=node:node /app/dist/apps/view /usr/share/nginx/html

# Config de nginx + script de arranque.
# `--chmod=755` evita una layer extra de `chmod +x`.
COPY --chown=node:node              nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755  start.sh   ./start.sh

# OCI labels — facilitan tracking en el registry.
LABEL org.opencontainers.image.title="Trade Marketing" \
      org.opencontainers.image.description="Mega Dulces B2B + trade marketing platform" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.vendor="Mega Dulces"

EXPOSE 10000

# Sin HEALTHCHECK explícito. Railway monitorea el container vía el proxy
# edge (si nginx no responde, marca down).

# tini envía SIGTERM al script y de ahí a node/nginx → graceful shutdown.
STOPSIGNAL SIGTERM

# Non-root. UID 1000 viene en la imagen `node:*`. Vital para defense-in-depth:
# si una RCE llega via la API o nginx, el atacante no tiene root en el container.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
