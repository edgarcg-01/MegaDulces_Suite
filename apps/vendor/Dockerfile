# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Mega Dulces — App Vendedor (campo). App Nx Angular del monorepo Trade_marketing.
# Se construye DESDE el monorepo (`nx build vendor`) y se sirve con nginx estático
# que proxya /api y el WebSocket al backend (servicio principal) vía $API_UPSTREAM
# (mismo origen para el browser → sin CORS).
#
# Build context = RAÍZ del monorepo. En Railway: RAILWAY_DOCKERFILE_PATH=apps/vendor/Dockerfile.
# Sin BuildKit cache mounts (Railway exige id=s/<service-id>-...). Para acelerar,
# agregá --mount=type=cache,id=s/<ID>-npm con el Service ID real una vez creado.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# PUPPETEER_SKIP_DOWNLOAD: el monorepo tiene puppeteer (deps del api). Sin esto,
# `npm ci` intenta bajar Chrome (~120MB) y puede colgarse/fallar en el build.
ENV NPM_CONFIG_LOGLEVEL=warn NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false CI=true PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json .npmrc ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV CI=true NX_DAEMON=false NPM_CONFIG_LOGLEVEL=warn NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# --import load-compiler.mjs: Angular v18 + esbuild en Node 20 necesita
# @angular/compiler cargado antes de la CLI de Nx (mismo patrón que el Dockerfile raíz).
RUN NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build vendor --configuration=production

FROM node:20-slim AS runner
RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx-light gettext-base tini tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    sed -i '/^user /d' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available && \
    # Railway solo captura stdout/stderr; el nginx de Debian escribe a archivos.
    # Symlinkeamos (como nginx:alpine) para que access/error logs salgan en Railway.
    ln -sf /dev/stdout /var/log/nginx/access.log && \
    ln -sf /dev/stderr /var/log/nginx/error.log

# API_UPSTREAM SIN default: si falta, start.sh aborta con mensaje claro (no 502 silencioso).
ENV PORT=10000 \
    TZ=America/Mexico_City

WORKDIR /app
RUN chown node:node /app

COPY --from=builder --chown=node:node /app/dist/apps/vendor/browser /usr/share/nginx/html
COPY --chown=node:node             apps/vendor/nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755 apps/vendor/start.sh   ./start.sh

LABEL org.opencontainers.image.title="Mega Dulces — App Vendedor" \
      org.opencontainers.image.vendor="Mega Dulces" \
      org.opencontainers.image.licenses="UNLICENSED"

EXPOSE 10000
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
