# syntax=docker/dockerfile:1.7
# ═════════════════════════════════════════════════════════════════════════════════════════════
# Trade Marketing — UN grafo, CUATRO destinos  (`[VL.20.1]`, 2026-09-24)
#
#   docker build --target runner-api    -t trade-prod-api:<commit>    .
#   docker build --target runner-worker -t trade-prod-worker:<commit> .
#   docker build --target runner-portal -t trade-prod-portal:<commit> .
#   docker build --target runner-vendor -t trade-prod-vendor:<commit> .
#
# Lo construye `ops/prod/deploy.sh` (y `ops/prod/auto-deploy.sh` para api/worker). ⭐ El ORDEN
# importa: `api` PRIMERO, porque es quien materializa `deps`/`src`/`build-api`; los otros tres
# son casi todo caché de capa.
#
# ── Por qué un solo archivo ──────────────────────────────────────────────────────────────────
# Hasta hoy esto eran CUATRO Dockerfiles (`Dockerfile`, `Dockerfile.worker`,
# `apps/portal/Dockerfile`, `apps/vendor/Dockerfile`) porque Railway exige uno por servicio, y
# porque allá un `--mount=type=cache` lleva el Service ID adentro: es **por servicio**, así que
# ningún servicio podía ver el caché de otro. Producción se mudó a `md` el 2026-09-22 y Railway
# ya no construye nada, así que la restricción murió — pero su precio seguía vivo. MEDIDO el
# 2026-09-24 sobre 7 despliegues reales del carril:
#
#   · `api` 3m31–4m46 · `worker` 1m34–1m54 · total ~5m20 por despliegue de backend.
#
#   ⭐ Y el desperdicio con nombre: **el worker recompilaba `nx build api`, la MISMA tarea que
#     la imagen de api acababa de compilar 3 minutos antes, en la misma máquina, del mismo
#     commit**. Acá los dos destinos comen del mismo `build-api`.
#
#   · 7 registros de caché de `npm ci` de ~3 GB cada uno (uno por cada forma distinta del `RUN`)
#     y 3 copias de `node_modules` de 2.85 GB. Ahora hay UN `deps` y UN `src`.
#
# ── El grafo ─────────────────────────────────────────────────────────────────────────────────
#   deps ──► src ──┬─► build-api ──┬─► prod-deps ──┐
#      │           │  (view + api) │               ├─► runner-api      (chromium + nginx)
#      │           │               └───────────────┴─► runner-worker   (chromium)
#      │           ├─► build-portal ─────────────────► runner-portal   (nginx)
#      │           └─► build-vendor ─────────────────► runner-vendor   (nginx)
#      └─ npm ci UNA vez
#
# ⚠️ Este refactor es EQUIVALENTE EN COMPORTAMIENTO. Lo único que cambia en el artefacto es el
# sello de portal/vendedor, que deja de llevar un reloj de pared (ver `build-portal`). Las
# divergencias reales entre los runners —la directiva `user` de nginx, los symlinks de log a
# stdout— se conservan como una línea propia en cada destino, NO se unifican: unificar el
# logging es una decisión de producto, no un efecto colateral de un refactor de construcción.
#
# ⛔ NO se paraleliza. `nx run-many --parallel=1` se queda. El motivo escrito antes era la RAM
# del contenedor de Railway; el motivo vigente es mejor: acá la construcción **comparte máquina
# con producción** (el propio `auto-deploy.sh` documenta "carga 14 sobre 8 hilos").
# ═════════════════════════════════════════════════════════════════════════════════════════════


# ═══ 1. deps — `npm ci` UNA vez para las cuatro imágenes ═════════════════════════════════════
# slim ahorra ~700MB de pull en builds frescos vs `bookworm` completo. El binario nativo de
# @swc/core (la api compila con swc) es glibc → funciona en bookworm, NO en alpine/musl.
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# ENV (no ARG) porque npm los lee como variables de entorno del proceso. Con ARG, npm ignora
# loglevel/fund/audit. Persisten en la imagen de la etapa, no en los runners.
ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true \
    PUPPETEER_SKIP_DOWNLOAD=true

# Sólo los archivos que afectan a `npm ci`: el resto del código no debe invalidar esta capa.
COPY package*.json .npmrc ./

# `--prefer-offline` reusa el tarball del cache mount sin revalidar contra el registry cuando ya
# está; con el caché frío cae al registry normal. Los reintentos vienen de `.npmrc`.
# ⭐ El id ya NO lleva el prefijo `s/<service-id>-` que exigía Railway: es un nombre legible y,
# sobre todo, es UNO SOLO — antes había cuatro cachés de npm que no se veían entre sí.
RUN --mount=type=cache,id=trade-npm,target=/root/.npm \
    npm ci --prefer-offline


# ═══ 2. src — el árbol de fuentes, UNA vez ═══════════════════════════════════════════════════
# COPY granular a propósito: un `COPY . .` invalida el bundle de Angular por un cambio en un
# README. (`apps/portal/Dockerfile` y `apps/vendor/Dockerfile` hacían justamente `COPY . .`.)
#
# ⛔ `vitest.shared.ts` NO es opcional, aunque la imagen nunca corra pruebas. Los 7
# `vitest.config.ts` de `apps/`+`libs/` lo importan, y el plugin `@nx/vitest` CARGA cada uno de
# esos archivos para construir el grafo de proyectos — en CUALQUIER comando de Nx, `build`
# incluido. Sin el archivo: `NX Failed to process project graph. 7 errors occurred while
# processing files for the @nx/vitest plugin`, y el build ni empieza (`[NX.3]`).
#
# Regla general: un archivo de la RAÍZ del que dependa un config de proyecto tiene que estar en
# este COPY. El candado es `scripts/check-docker-context.js`, que corre en `npm run check`.
# ⭐ Ese candado SALTA los Dockerfiles con `COPY . .`, así que hasta hoy no vigilaba a portal ni
# a vendor. Con este archivo pasa a cubrir los cuatro destinos.
#
# `eslint.config.js` entra porque está en `nx.json → namedInputs.sharedGlobals`: sin él, el hash
# de Nx dentro del contenedor no es el mismo que el de afuera. (Lo traía el `COPY . .` de
# portal/vendor; a `view`/`api` les faltaba.)
FROM node:20-bookworm-slim AS src
WORKDIR /app

# `[NX.11]` ⛔ ACÁ NO VA `CI=true`. Medido el 2026-09-21 con un 2×2 sobre un target trivial YA
# CACHEADO (o sea: cero compilación, cero bytes que subir), 3-6 corridas por celda:
#
#                    sin CI        CI=true
#   daemon ON     4.7–7.9 s     75.7–88.6 s
#   daemon OFF    5.5–6.2 s     50.1–55.7 s
#   sin Nx Cloud  4.8–8.0 s      4.8–8.0 s
#
# El peaje de ~45–80 s POR CORRIDA aparece SÓLO en la intersección `CI=true` × Nx Cloud — ni el
# uno ni el otro por separado. Y el daemon no es la variable (con `CI` hasta empeora), así que
# `NX_DAEMON=false` se queda: es la celda más barata y evita el proceso residente.
# `CI=true` sigue puesto en `deps` y `prod-deps`, que es donde de verdad hace falta (npm no
# interactivo). Verificado: NADA de nuestro código lee `process.env.CI`.
#
# ⭐ `NX_NO_CLOUD=true` (`[VL.20.6]`): `nx.json` declara `nxCloudId` y on-prem NO se pasa ningún
# token, así que cada corrida de Nx intentaba hablar con la nube y fallaba con 401 — la latencia
# del caché remoto sin el caché remoto. Acá el caché compartido es el cache mount `trade-nx`,
# que es disco local de `md`: más rápido y sin red. Si algún día vuelve a haber varias máquinas
# construyendo, esta línea es lo que hay que revisar primero.
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true \
    NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

COPY --from=deps /app/node_modules ./node_modules
COPY nx.json package.json package-lock.json tsconfig*.json .npmrc load-compiler.mjs vitest.shared.ts eslint.config.js ./
COPY apps ./apps
COPY libs ./libs
COPY database ./database


# ═══ 3a. build-api — `view` + `api`. Lo comen runner-api Y runner-worker ═════════════════════
# Angular con esbuild necesita @angular/compiler en el proceso de Node (`load-compiler.mjs`); el
# heap de 4096 le da margen al compilador. La api compila con SWC (`apps/api/.swcrc`) → mucho
# más liviano; el pico de memoria lo marca el bundle de Angular, no la api.
#
# `--parallel=1`: SERIE, a propósito. `--max-old-space-size` es por PROCESO y Nx le da uno a cada
# proyecto, así que con parallel=2 el techo real son 2×4GB. Ahí no muere V8 con "heap out of
# memory" (que se ve en el log) sino el contenedor con OOM-kill: el proceso se corta seco y el
# log queda a media compilación, sin ninguna línea de error. Ese modo de falla es intermitente
# porque depende de en qué instante coinciden los dos picos. Y acá, además, la construcción
# compite con producción por los mismos 8 hilos.
#
# El cache mount de Nx es lo que hace que un commit que sólo toca backend NO recompile Angular:
# `.nx/cache` no sobrevive entre builds de Docker sin él. ⭐ `id=trade-nx` es COMPARTIDO por los
# tres destinos que compilan — antes sólo existía en este archivo, y por eso el worker y las dos
# apps de Angular recompilaban siempre desde cero.
FROM src AS build-api
RUN --mount=type=cache,id=trade-nx,target=/app/.nx/cache,sharing=locked \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx run-many -t build -p view,api --configuration=production --parallel=1


# ═══ 3b. build-portal ════════════════════════════════════════════════════════════════════════
# ⭐ `[VL.20.2]` EL SELLO ES DETERMINISTA POR COMMIT. Antes esta línea metía `date -u`, un reloj
# de pared, dentro de `apps/portal/src/index.html` y `public/assets/version.json` — los dos bajo
# `{projectRoot}/**/*`, o sea dentro del hash de `build`. El propio comentario viejo lo declaraba:
# **este target no acertaba el caché NUNCA, por diseño**, ni siquiera recompilando el mismo
# commit. Ahora el sello es función del commit, así que un rollback o un reintento del carril
# aciertan.
#
# ⛔ El sello va ANTES del build, no después: el service worker (ngsw) hashea los bytes FINALES
# de `index.html` y de `assets/**`, y los dos están en los assetGroups de `ngsw-config.json`.
# Mutarlos post-build deja `ngsw.json` desfasado → el SW entra en loop de re-fetch
# (`index.html?ngsw-cache-bust`). Sellando acá, los bytes servidos == los hasheados.
#
# ⚠️ `GIT_COMMIT_ISO` lo calcula `deploy.sh`, y ahí hay una trampa medida: `git show
# --date=format:` **NO respeta `TZ`** (usa la zona del commit), así que rotulaba `Z` una hora
# local. Va `--date=format-local:` con `TZ=UTC`. Detalle en `ops/prod/deploy.sh`.
FROM src AS build-portal
ARG GIT_COMMIT_SHA=
ARG GIT_COMMIT_ISO=
RUN COMMIT=$(printf '%s' "${GIT_COMMIT_SHA:-unknown}" | cut -c1-7); \
    TS=$(printf '%s' "${GIT_COMMIT_ISO:-unknown}"); \
    sed -i "s|BUILD_COMMIT_PLACEHOLDER|$COMMIT|g; s|BUILD_TS_PLACEHOLDER|$TS|g" \
      apps/portal/src/index.html apps/portal/public/assets/version.json
RUN --mount=type=cache,id=trade-nx,target=/app/.nx/cache,sharing=locked \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build portal --configuration=production


# ═══ 3c. build-vendor ════════════════════════════════════════════════════════════════════════
# Mismo criterio que `build-portal`. Acá el sello se lee en un solo lugar: la sonda de
# diagnóstico de `vendor-shell.component.ts` (`__BUILD_TIMESTAMP__`), al lado de
# `__BUILD_VERSION__` —el commit— que ya identifica el build sin ambigüedad.
FROM src AS build-vendor
ARG GIT_COMMIT_SHA=
ARG GIT_COMMIT_ISO=
RUN COMMIT=$(printf '%s' "${GIT_COMMIT_SHA:-unknown}" | cut -c1-7); \
    TS=$(printf '%s' "${GIT_COMMIT_ISO:-unknown}"); \
    sed -i "s|BUILD_COMMIT_PLACEHOLDER|$COMMIT|g; s|BUILD_TS_PLACEHOLDER|$TS|g" \
      apps/vendor/src/index.html apps/vendor/public/assets/version.json
RUN --mount=type=cache,id=trade-nx,target=/app/.nx/cache,sharing=locked \
    NODE_OPTIONS="--max-old-space-size=4096 --import file:///app/load-compiler.mjs" \
    npx nx build vendor --configuration=production


# ═══ 4. prod-deps — sólo lo que el bundle de la api requiere ═════════════════════════════════
# `npm ci --omit=dev` fresco, NO `npm prune` sobre el node_modules de `deps`. Prune copia el
# árbol completo y luego borra ~60% de los inodes en overlayfs; el unlink masivo de archivos
# chicos tarda ~5min. `npm ci` escribe sólo las prod deps en capa limpia, reusando los tarballs
# que `deps` ya bajó al MISMO cache mount → sin red.
# `--ignore-scripts`: puppeteer no baja Chromium y sharp usa sus binarios precompilados @img/*.
# NO usar `npm dedupe`: en monorepos Nx el árbol ya viene plano y dedupe camina todo el árbol
# 5-7min para ahorrar <1MB.
#
# `[NX.10]` ⭐ El manifiesto es el PODADO que emite el propio build, no el de la raíz.
# El `package.json` de la raíz declara 116 deps de producción porque ahí viven juntas la api y
# las tres apps de Angular. Pero estas imágenes sólo corren DOS cosas: `node
# dist/apps/api/main.js` y `npx knex migrate:latest`. Instalar el manifiesto de la raíz metía
# todo el stack de front —`@imgly` 184MB, `@angular` 64MB, `@zxing` 29MB, PrimeNG+temas+iconos
# 26MB, chart.js/leaflet/gsap/dexie/capacitor/ngrx/zone.js— que el bundle de la api nunca pide.
#
# `apps/api/webpack.config.js` emite `generatePackageJson: true`, o sea que el build escribe en
# `dist/apps/api/` un `package.json` con las 64 deps que el grafo de imports REALMENTE usa, más
# su `package-lock.json` podado. Esa lista es DERIVADA, no mantenida a mano.
#
# ⚠️ El modo de falla que abre: un `require(variable)` no queda en el grafo de webpack → no entra
# al manifiesto → no se instala → `MODULE_NOT_FOUND` recién en el arranque de prod. Por eso el
# candado de abajo.
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app

ENV NPM_CONFIG_LOGLEVEL=warn \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    CI=true

COPY .npmrc ./
COPY --from=build-api /app/dist/apps/api/package.json      ./package.json
COPY --from=build-api /app/dist/apps/api/package-lock.json ./package-lock.json

# El `chown` va ACÁ y no en el `COPY --from=prod-deps` de los runners. Con `--chown`, BuildKit
# tiene que crear un inodo nuevo por archivo al copiar entre etapas (no puede reusar los del
# snapshot origen); sobre un node_modules eso son decenas de miles de archivos chicos y en el
# build de prod del 2026-09-21 ese solo paso midió **1m 30s** — el 28% del build entero. Hecho
# acá queda dentro de una capa que se cachea, y los runners copian preservando el owner.
RUN --mount=type=cache,id=trade-npm,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --prefer-offline && \
    chown -R node:node /app/node_modules

# `[NX.10.1]` El candado corre ACÁ, no en los runners. `prod-deps` es sólo fuente de un
# `COPY --from`: sus capas NUNCA se exportan a una imagen, así que el candado sale gratis del
# `exporting`. En una etapa final, en cambio, un `RUN` después del `COPY` de node_modules obliga
# a BuildKit a snapshotear y diffear un filesystem con ~60k archivos recién copiados para
# materializar esa capa — trabajo que NO aparece en el renglón del `RUN` sino en `exporting`.
#
# Las dos líneas van DESPUÉS del `npm ci` a propósito: `main.js` cambia en cada build, y copiarlo
# antes invalidaría la instalación entera en cada deploy.
COPY --from=build-api /app/dist/apps/api/main.js ./main.js
COPY scripts/check-bundle-externals.js ./check-bundle-externals.js
RUN node ./check-bundle-externals.js ./main.js /app/node_modules && rm -f ./main.js ./check-bundle-externals.js


# ═══ 5. Los tiempos de ejecución, en rama para compartir lo caro ═════════════════════════════
# Cache mounts de apt: BuildKit preserva /var/cache/apt y /var/lib/apt entre builds.
# ⛔ NO borrar `/var/lib/apt/lists` con `rm -rf` teniendo el cache mount activo — el mount ya
# queda fuera de la capa final. `docker-clean` se borra para que apt no auto-elimine del caché.
# (Los tres Dockerfiles viejos de worker/portal/vendor NO tenían estos mounts: cada build
# re-descargaba chromium, ~230 MB de closure, dos veces por release.)

FROM node:20-slim AS rt-base
RUN --mount=type=cache,id=trade-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=trade-apt-lists,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends tzdata && \
    ln -sf /usr/share/zoneinfo/America/Mexico_City /etc/localtime
ENV TZ=America/Mexico_City

# ── chromium: lo comparten `api` y `worker` ──────────────────────────────────────────────────
# Cinco servicios usan Puppeteer (informes, anexo de venta, etiquetas…). `fonts-noto-color-emoji`
# porque sin él los PDF salen con cuadraditos.
FROM rt-base AS rt-chromium
RUN --mount=type=cache,id=trade-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=trade-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

# ── nginx para las dos apps estáticas (portal, vendedor) ─────────────────────────────────────
# nginx-light → ~30MB menos que nginx full. tini → PID 1 que reapea zombies y propaga SIGTERM.
# gettext → envsubst para inyectar $PORT en runtime.
# Permisos para nginx non-root: pid a /tmp, logs y cache/temp a `node`, y `sites-available`
# porque `start.sh` lo reescribe con envsubst.
FROM rt-base AS rt-nginx
RUN --mount=type=cache,id=trade-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=trade-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends nginx-light gettext-base tini && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    sed -i '/^user /d' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available && \
    ln -sf /dev/stdout /var/log/nginx/access.log && \
    ln -sf /dev/stderr /var/log/nginx/error.log
ENV PORT=10000
WORKDIR /app
RUN chown node:node /app


# ═══ 6a. runner-api — nginx (SPA + proxy) + node + chromium ══════════════════════════════════
FROM rt-chromium AS runner-api

# El nginx del api NO comparte `rt-nginx` a propósito: su config difiere en dos cosas medidas —
# conserva la directiva `user` y NO symlinkea los logs a stdout. Unificarlas mandaría el
# access.log de la app principal al log del contenedor (tope 20m×3 en el compose), que es una
# decisión de producto y no un efecto colateral de este refactor. Se deja como estaba.
RUN --mount=type=cache,id=trade-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=trade-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends nginx-light gettext-base tini && \
    sed -i 's|pid /run/nginx.pid;|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf && \
    chown -R node:node /var/log/nginx /var/lib/nginx /usr/share/nginx/html /etc/nginx/sites-available

WORKDIR /app
RUN chown node:node /app

# PORT lo escucha nginx (10000); API_PORT es interno de NestJS. NO deben coincidir.
ENV NODE_ENV=production \
    API_PORT=3333 \
    API_PREFIX=api \
    PORT=10000

# `--chown=node:node` para que el usuario non-root pueda leerlo todo sin un `chown -R` post-copy
# (que duplicaría todos los inodos).
COPY --from=build-api  --chown=node:node /app/dist/apps/api ./dist/apps/api
COPY --from=build-api  --chown=node:node /app/database      ./database
# SIN `--chown`: ya viene con owner `node` desde `prod-deps` (ver ese stage: 1m 30s medidos).
# ⚠️ Pensarlo dos veces antes de agregar un `RUN` después de esta línea: el diff de esa capa
# camina un filesystem con ~60k archivos recién copiados y el costo aparece en `exporting`.
COPY --from=prod-deps /app/node_modules ./node_modules
# El bundle del SPA lo sirve SÓLO nginx. NestJS ya no usa ServeStaticModule (el fallback estático
# interceptaba todo request no-API y tiraba ENOENT con 404 JSON en Express 5).
COPY --from=build-api  --chown=node:node /app/dist/apps/view /usr/share/nginx/html

COPY --chown=node:node              nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755  start.sh   ./start.sh
COPY --chown=node:node --chmod=755  migrate.sh ./migrate.sh

# ── `[VL.11.C]` EL COMMIT SE HORNEA EN LA IMAGEN ─────────────────────────────────────────────
# Va acá a propósito, DESPUÉS de todos los COPY pesados: cambiar de commit invalida sólo estas
# dos capas de bytes, no las ~60k de `node_modules`.
# ⛔ Antes el commit viajaba SÓLO como prefijo de entorno en `deploy.sh recrear()`, así que
# cualquier `docker compose up` que no pasara por ahí dejaba `/api/health` diciendo `""`. Pasó
# DOS VECES el 2026-09-22, la segunda al levantar el túnel (`cloudflared` declara
# `depends_on: [api, portal, vendor]` y Compose recreó `api` sin la variable). Una imagen sabe de
# qué commit salió; preguntárselo al entorno era pedirle la verdad a quien la arranca.
ARG GIT_COMMIT_SHA=
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

LABEL org.opencontainers.image.title="Trade Marketing" \
      org.opencontainers.image.description="Mega Dulces B2B + trade marketing platform" \
      org.opencontainers.image.licenses="UNLICENSED" \
      org.opencontainers.image.vendor="Mega Dulces" \
      org.opencontainers.image.revision="${GIT_COMMIT_SHA}"

EXPOSE 10000
# Sin HEALTHCHECK de Docker: el veredicto de despliegue lo da `deploy.sh` contra
# `/api/health` + el humo del login (`[VL.15.D]`, `[VL.16.D2]`).
STOPSIGNAL SIGTERM
# Non-root. UID 1000 viene en la imagen `node:*`. Defense-in-depth: si una RCE llega por la API
# o por nginx, el atacante no tiene root en el contenedor.
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]


# ═══ 6b. runner-worker — el MISMO código, sin HTTP ═══════════════════════════════════════════
# `WORKER=true` (env del servicio) → `bootstrapWorker()` en main.ts: crons + cola pg-boss, sin
# HTTP/WS/nginx. Come de `build-api`, que es lo que mata la doble compilación.
FROM rt-chromium AS runner-worker
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build-api  --chown=node:node /app/dist/apps/api ./dist/apps/api
COPY --from=build-api  --chown=node:node /app/database      ./database
# SIN `--chown`: ya viene con owner `node` desde `prod-deps`.
COPY --from=prod-deps /app/node_modules ./node_modules

# El worker NO tiene endpoint de salud, así que acá el commit equivocado no lo ve nadie — razón
# de más para hornearlo.
ARG GIT_COMMIT_SHA=
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
LABEL org.opencontainers.image.revision="${GIT_COMMIT_SHA}"

STOPSIGNAL SIGTERM
USER node
# El heap se capa por `NODE_OPTIONS` en el compose.
CMD ["node", "dist/apps/api/main.js"]


# ═══ 6c. runner-portal — Portal B2B (estático + proxy a la API) ══════════════════════════════
# nginx proxya /api y el WebSocket al backend vía $API_UPSTREAM → mismo origen para el browser,
# sin CORS. `API_UPSTREAM` va SIN default: si falta, `start.sh` aborta con mensaje claro en vez
# de un 502 silencioso.
FROM rt-nginx AS runner-portal
COPY --from=build-portal --chown=node:node /app/dist/apps/portal/browser /usr/share/nginx/html
COPY --chown=node:node             apps/portal/nginx.conf /etc/nginx/sites-available/default
COPY --chown=node:node --chmod=755 apps/portal/start.sh   ./start.sh

LABEL org.opencontainers.image.title="Mega Dulces — Portal B2B" \
      org.opencontainers.image.vendor="Mega Dulces" \
      org.opencontainers.image.licenses="UNLICENSED"

EXPOSE 10000
STOPSIGNAL SIGTERM
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "./start.sh"]


# ═══ 6d. runner-vendor — App Vendedor (campo) ════════════════════════════════════════════════
FROM rt-nginx AS runner-vendor
COPY --from=build-vendor --chown=node:node /app/dist/apps/vendor/browser /usr/share/nginx/html
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
