# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Mega Dulces — Portal B2B (tienda) — imagen estática independiente.
#
# Solo nginx sirviendo el SPA `apps/portal` + reverse-proxy de /api y del
# WebSocket de alertas hacia el backend (servicio principal) via $API_UPSTREAM.
# NO incluye la API ni migraciones — eso vive en el servicio principal.
#
# Build context = raíz del monorepo. Build:
#   docker build -f apps/portal/Dockerfile -t megadulces-portal .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_LOGLEVEL=warn NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false CI=true
COPY package*.json .npmrc ./
RUN npm ci

# ── Stage 2: build del portal ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NX_DAEMON=false CI=true NPM_CONFIG_LOGLEVEL=warn NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY --from=deps /app/node_modules ./node_modules
COPY nx.json package.json package-lock.json tsconfig*.json .npmrc load-compiler.mjs ./
COPY apps ./apps
COPY libs ./libs
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build portal --configuration=production

# ── Stage 3: runner (nginx estático, non-root) ───────────────────────────────
FROM node:20-slim AS runner
RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx-light gettext-base tini tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available

# PORT lo inyecta Railway. API_UPSTREAM lo seteás vos (URL del backend principal).
ENV PORT=10000 \
    API_UPSTREAM=http://localhost:3333 \
    TZ=America/Mexico_City

# El builder application output queda en dist/apps/portal/browser.
COPY --from=builder --chown=node:node /app/dist/apps/portal/browser /usr/share/nginx/html
COPY --chown=node:node             apps/portal/nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755 apps/portal/start.sh   ./start.sh

WORKDIR /app
EXPOSE 10000
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
