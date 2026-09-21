# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Trade Marketing — Dockerfile multi-stage
#
# Pipeline:
#   1. deps      → instala TODAS las deps (con devDeps) para compilar
#   2. builder   → reutiliza node_modules de `deps`, compila view + api
#   3. prod-deps → instala SOLO lo que el bundle de la api requiere, desde el
#                  manifiesto podado que el propio build emite (no el de la raíz)
#   4. runner    → imagen final: nginx-light + node + dist + node_modules de prod
#                  Corre como user `node` (UID 1000), NO root.
#
# BuildKit es requerido por los `--mount=type=cache`. Railway exige que el
# `id` esté hardcodeado (no acepta interpolación de ARGs) y siga el formato
# `s/<service-id>-<target>`. Service ID actual: 69f64078-1678-40f4-a266-a18b61a20cde.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Dependencias completas (capa cacheable) ────────────────────────
# slim ahorra ~700MB de pull en builds frescos vs `bookworm` completo.
# Angular 22 + esbuild + nx no necesitan los extras (git, python build tools)
# que trae el bookworm full. El binario nativo de @swc/core (api con compiler
# swc) es glibc → funciona en bookworm (NO en alpine/musl).
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

# `npm ci` requiere lockfile (lo tenemos). `--prefer-offline` reusa el tarball
# del cache mount sin revalidar contra el registry cuando ya está presente; si
# el cache está frío cae al registry normal (safe en ambos casos). El id
# `s/<service>-npm` persiste entre builds en Railway. Retries vienen de .npmrc.
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-npm,target=/root/.npm \
    npm ci --prefer-offline

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
# ⛔ `vitest.shared.ts` NO es opcional acá, aunque la imagen nunca corra pruebas. Los 7
# `vitest.config.ts` de `apps/`+`libs/` lo importan, y el plugin `@nx/vitest` CARGA cada uno de
# esos archivos para construir el grafo de proyectos — en CUALQUIER comando de Nx, `build`
# incluido. Sin el archivo: `NX Failed to process project graph. 7 errors occurred while
# processing files for the @nx/vitest plugin` y el build ni empieza. MEDIDO reproduciendo la
# condición del contenedor en local (`[NX.3]`).
#
# Regla general: un archivo de la RAÍZ del que dependa un config de proyecto tiene que estar en
# este COPY. Es el mismo motivo por el que ya está `load-compiler.mjs`.
# El candado es `scripts/check-docker-context.js`, que corre en `npm run check`.
COPY nx.json package.json package-lock.json tsconfig*.json .npmrc load-compiler.mjs vitest.shared.ts ./
COPY apps ./apps
COPY libs ./libs
COPY database ./database

# Angular 22 con esbuild necesita @angular/compiler en el proceso de Node
# (load-compiler.mjs); el heap 4096 le da margen al compilador. La api compila
# con SWC (apps/api/.swcrc) → mucho más rápido y liviano que tsc; el pico de
# memoria lo sigue marcando el bundle de Angular, no la api.
# Cache mount de Nx: `build` es cacheable (nx.json) pero `.nx/cache` no
# sobrevive entre builds de Docker → sin esto recompila todo cada deploy. Con
# el mount, un commit que solo toca backend saca `view` del cache (restaura
# dist/ sin recompilar Angular) y viceversa.
# `run-many --parallel=1`: SERIE, a propósito.
# `--max-old-space-size` es por PROCESO, y Nx le da uno a cada proyecto: con
# parallel=2 el techo real son 2×4GB = 8GB, justo la RAM del contenedor. Ahí no
# muere V8 con "heap out of memory" (que se ve en el log) sino el contenedor con
# OOM-kill: el proceso se corta seco y el log queda a media compilación, sin
# ninguna línea de error. Ese modo de falla es intermitente porque depende de en
# qué instante coinciden los dos picos.
# El paralelismo casi no compra nada acá: gracias al cache mount de Nx, un deploy
# normal toca UN solo proyecto y el otro se restaura del cache. Los dos compilan
# a la vez únicamente cuando ambos son cache-miss — que es exactamente el caso en
# el que la memoria se duplica. Serializar quita el riesgo justo donde existe, y
# cuesta wall-clock sólo en ese caso.
# Una sola instancia Nx coordina el cache; NO usar `&` de shell (dos procesos
# nx se pisarían el cache).
#
# `[NX.4]` El cache mount de arriba es la PRIMERA capa (rápida, local al servicio). El token de
# abajo suma la SEGUNDA: el caché remoto de Nx Cloud, que es la única compartida entre
# servicios y entre máquinas — un mount de Railway lleva el Service ID adentro y por definición
# no lo ve nadie más. Acá eso importa porque `api:build` también lo compila `Dockerfile.worker`.
# Si el token falta o está mal, Nx avisa y sigue con el mount local (medido: exit 0).
# ⛔ Por `ENV` en línea propia, NO adentro del `RUN`: BuildKit imprime cada `RUN` con los ARG ya
# expandidos y publicaría el token en el log de build (pasó de verdad el 2026-09-18). Detalle y
# control negativo en `Dockerfile.worker`.
ARG NX_CLOUD_ACCESS_TOKEN=
ENV NX_CLOUD_ACCESS_TOKEN=${NX_CLOUD_ACCESS_TOKEN}
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-nx2,target=/app/.nx/cache,sharing=locked \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx run-many -t build -p view,api --configuration=production --parallel=1

# ── Stage 3: Dependencias solo de producción ────────────────────────────────
# `npm ci --omit=dev` fresco, NO `npm prune` sobre el node_modules de `deps`.
# Prune copia el árbol completo y luego borra ~60% de los inodes (devDeps de
# Nx/Angular/jest/karma/playwright) en overlayfs; el unlink masivo de archivos
# pequeños tarda ~5min. `npm ci` escribe solo las prod deps en capa limpia,
# reusando los tarballs que `deps` ya bajó al cache mount (mismo id) → sin red.
# `--ignore-scripts`: puppeteer no baja Chromium y sharp usa sus binarios
# precompilados @img/* (no necesitan build script).
# NO usar `npm dedupe`: en monorepos Nx el árbol ya viene plano y dedupe camina
# todo el árbol 5-7min para ahorrar <1MB (build Railway 6m59s).
#
# `[NX.10]` ⭐ El manifiesto es el PODADO que emite el propio build, no el de la raíz.
# ---------------------------------------------------------------------------
# El `package.json` de la raíz declara 116 deps de producción porque ahí viven
# juntas la api y las tres apps de Angular. Pero la imagen final sólo corre DOS
# cosas: `node dist/apps/api/main.js` y `npx knex migrate:latest`. Instalar el
# manifiesto de la raíz metía en el runner todo el stack de front —medido en el
# árbol local: `@imgly` 184MB, `@angular` 64MB, `@zxing` 29MB, PrimeNG+temas+
# iconos 26MB, chart.js/leaflet/gsap/dexie/capacitor/ngrx/zone.js— que el bundle
# de la api nunca requiere.
#
# `apps/api/webpack.config.js` ya emite `generatePackageJson: true`, o sea que
# el build escribe en `dist/apps/api/` un `package.json` con las 64 deps que el
# grafo de imports REALMENTE usa, más su `package-lock.json` podado del lock de
# la raíz. Esa es la lista correcta y es DERIVADA, no mantenida a mano.
#
# Esto NO se paga en tiempo de instalación: el `RUN` se cachea por el contenido
# de los dos archivos copiados, y el manifiesto de la api sólo cambia cuando
# cambia su grafo de dependencias — bastante más raro que "cambió código".
#
# ⚠️ El modo de falla que abre: un `require(variable)` no queda en el grafo de
# webpack → no entra al manifiesto → no se instala → `MODULE_NOT_FOUND` recién
# en el arranque de prod. Por eso el stage `runner` corre
# `scripts/check-bundle-externals.js`, que exige que cada `require("...")`
# literal del bundle resuelva contra ESTE árbol. El candado vive abajo.
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

COPY .npmrc ./
COPY --from=builder /app/dist/apps/api/package.json      ./package.json
COPY --from=builder /app/dist/apps/api/package-lock.json ./package-lock.json

# El `chown` va ACÁ y no en el `COPY --from=prod-deps` del runner. Con
# `--chown`, BuildKit tiene que crear un inodo nuevo por archivo al copiar entre
# stages (no puede reusar los del snapshot origen); sobre un node_modules eso
# son decenas de miles de archivos chicos y en el build de prod del 2026-09-21
# ese solo paso midió **1m 30s** — el 28% del build entero. Hecho acá queda
# dentro de una capa que se cachea, y el runner copia preservando el owner.
RUN --mount=type=cache,id=s/69f64078-1678-40f4-a266-a18b61a20cde-npm,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --prefer-offline && \
    chown -R node:node /app/node_modules

# `[NX.10.1]` El candado corre ACÁ, no en `runner`. `prod-deps` es sólo fuente de un
# `COPY --from`: sus capas NUNCA se exportan a la imagen, así que el candado sale gratis del
# `exporting`. En el stage final, en cambio, un `RUN` después del `COPY` de node_modules obliga a
# BuildKit a snapshotear y diffear un filesystem con ~60k archivos recién copiados para
# materializar esa capa — trabajo que NO aparece en el renglón del `RUN` (reportaba 1s) sino en
# `exporting`.
#
# ⚠️ NO ATRIBUIDO: en el deploy del 2026-09-21 16:10 `exporting` subió de 1m 13s a **1m 38s**
# mientras el `COPY` bajaba de 1m 30s a 52s y el push de 633 MB a 428 MB. El `RUN` en el stage
# final es UN candidato; el otro es el estado de la caché de capas del builder de Railway, que no
# controlo. Tengo n=1 de cada lado y la medición local no sirve de árbitro (ahí el build viejo
# escribió TODAS las capas y el nuevo reusó `deps`/`builder`). Se mueve igual porque acá es
# estrictamente más barato y cuesta cero — elimina un candidato, no prueba la causa.
#
# Las dos líneas van DESPUÉS del `npm ci` a propósito: `main.js` cambia en cada build, y copiarlo
# antes invalidaría la instalación entera en cada deploy.
COPY --from=builder /app/dist/apps/api/main.js ./main.js
COPY scripts/check-bundle-externals.js ./check-bundle-externals.js
RUN node ./check-bundle-externals.js ./main.js /app/node_modules && rm -f ./main.js ./check-bundle-externals.js

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
# SIN `--chown`: ya viene con owner `node` desde `prod-deps` (ver el comentario
# de ese stage). `--chown` acá costaba 1m 30s de reescritura de inodos, medido.
# ⚠️ Pensarlo dos veces antes de agregar un `RUN` después de esta línea: el diff de esa capa
# camina un filesystem con ~60k archivos recién copiados y el costo aparece en `exporting`, no en
# el renglón del `RUN`. El candado del árbol podado vive en `prod-deps` por eso (`[NX.10.1]`).
COPY --from=prod-deps /app/node_modules ./node_modules
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
# migrate.sh corre como preDeployCommand de Railway (migraciones fuera del boot).
COPY --chown=node:node --chmod=755  migrate.sh ./migrate.sh

# OCI labels — facilitan tracking en el registry.
LABEL org.opencontainers.image.title="Trade Marketing" \
      org.opencontainers.image.description="Mega Dulces B2B + trade marketing platform" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.vendor="Mega Dulces"

EXPOSE 10000

# Sin HEALTHCHECK de Docker. El healthcheck de deploy lo define Railway en
# railway.api.json (healthcheckPath=/api/health): si no responde 200 dentro
# del timeout, el deploy nuevo queda unhealthy y el anterior sigue sirviendo.

# tini envía SIGTERM al script y de ahí a node/nginx → graceful shutdown.
STOPSIGNAL SIGTERM

# Non-root. UID 1000 viene en la imagen `node:*`. Vital para defense-in-depth:
# si una RCE llega via la API o nginx, el atacante no tiene root en el container.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]
