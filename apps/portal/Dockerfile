# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Mega Dulces — Portal B2B (tienda) — imagen estática independiente y optimizada.
#
# Mismas optimizaciones que el Dockerfile principal (trade), adaptadas a un SPA
# estático:
#   1. deps    → npm ci con cache mount BuildKit (capa cacheable).
#   2. builder → reusa node_modules de `deps`, compila SOLO el portal.
#   3. runner  → nginx-light estático, non-root. SIN node/api/node_modules/db
#                (más liviano que trade: el backend vive en el servicio principal).
#
# BuildKit requerido por los `--mount=type=cache`. Railway exige que el `id`
# del cache esté hardcodeado y siga el formato `s/<service-id>-<target>`.
#
# ⚠️ REEMPLAZAR `PORTAL_SERVICE_ID` por el Service ID real del servicio del
#    portal en Railway (UUID) una vez creado — sin eso el cache NO se reusa
#    entre builds en Railway (igual buildea, solo más lento).
#
# Build context = raíz del monorepo:
#   docker build -f apps/portal/Dockerfile -t megadulces-portal .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps (npm ci cacheable) ─────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true
COPY package*.json .npmrc ./
RUN --mount=type=cache,id=s/PORTAL_SERVICE_ID-npm,target=/root/.npm \
    npm ci

# ── Stage 2: build del portal ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NX_DAEMON=false \
    CI=true \
    NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY --from=deps /app/node_modules ./node_modules
# COPY granular: solo lo que afecta al bundle invalida esta capa.
COPY nx.json package.json package-lock.json tsconfig*.json .npmrc load-compiler.mjs ./
COPY apps ./apps
COPY libs ./libs
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build portal --configuration=production

# ── Stage 3: runner (nginx estático, non-root) ───────────────────────────────
FROM node:20-slim AS runner
RUN --mount=type=cache,id=s/PORTAL_SERVICE_ID-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=s/PORTAL_SERVICE_ID-apt-lists,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends nginx-light gettext-base tini tzdata && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available

# PORT lo inyecta Railway. API_UPSTREAM lo seteás vos (URL del backend principal).
ENV PORT=10000 \
    API_UPSTREAM=http://localhost:3333 \
    TZ=America/Mexico_City

WORKDIR /app
RUN chown node:node /app

# Application builder → output en dist/apps/portal/browser.
COPY --from=builder --chown=node:node /app/dist/apps/portal/browser /usr/share/nginx/html
COPY --chown=node:node             apps/portal/nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755 apps/portal/start.sh   ./start.sh

LABEL org.opencontainers.image.title="Mega Dulces — Portal B2B" \
      org.opencontainers.image.description="Tienda B2B (SPA estático, deploy aparte)" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.vendor="Mega Dulces"

EXPOSE 10000
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
