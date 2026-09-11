# ─────────────────────────────────────────────────────────────────────────────
# Carriles de ingesta del ODS (OBS.4, ADR-053) — replica local :5433 → prod kepler_ods.
#
# Por qué un contenedor y no una tarea programada ni PM2:
#   · Task Scheduler quedó descartado (Edgar).
#   · PM2 corre en la sesión `Console` del usuario → se muere al cerrar sesión, y el 2026-09-02
#     reportó `online` para dos carriles cuyo batch nunca se ejecutó (falso verde).
#   · Docker en esta box ya sostiene pgvector-md, redis-md, api y view con días de uptime, el motor
#     corre como servicio (sin sesión), y `HEALTHCHECK` permite DETECTAR la **falta de entrega**,
#     no sólo la muerte del proceso. Eso es lo que ningún supervisor anterior podía dar.
#
# ⚠️ EL `HEALTHCHECK` NO REINICIA NADA POR SÍ SOLO. En Docker standalone `restart: unless-stopped`
# reacciona a que el proceso MUERA; `unhealthy` es sólo un rótulo (reiniciar por salud lo hace Swarm,
# no el motor suelto). Este comentario decía lo contrario y esa creencia costó 15 h: el 2026-09-04
# `ods-live-hot` quedó colgado con el proceso vivo y CPU 0.00 %, el healthcheck lo vio, y nadie actuó.
# El brazo que ejecuta el veredicto es el servicio `autoheal` del compose. Si algún día se corre esta
# imagen SIN ese servicio, el healthcheck vuelve a ser decorativo.
#
# Imagen AUTOCONTENIDA (mismo criterio que services/feeds-ingest): se copia el código que hace falta
# en vez de montar el repo del host. Grafo de requires real:
#   database/importers/kepler/replicate-ods-live.js
#     → ../lib/sink.js
#         → ../../../services/feeds-ingest/apply-handlers.js
#             → ./sales-daily-projection · ./movements-projection · ./label-compute
#             → ./barcode-compute · ./ods-derived
# `sink.js` requiere apply-handlers en el TOPE del módulo, así que hace falta incluso con sink=http.
#
# Los secretos NO viven acá: entran por `env_file` (fuera del repo). El `require('dotenv')` de los
# scripts busca /app/.env, que no existe en la imagen — es inocuo y deliberado.
#
# Build (desde la RAÍZ del repo, que es el contexto):
#   docker build -f ops/ingest/Dockerfile -t trade-ingest:latest .
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine

# tini: reaper de PID 1 para que SIGTERM llegue al proceso node y el ciclo cierre limpio.
#
# ⚠️ tzdata NO es opcional (VL.4, 2026-09-11). Alpine NO trae la base de zonas
# horarias, así que `TZ=America/Mexico_City` se ignora **en silencio** y el
# contenedor queda en UTC. Medido: `date` devolvía UTC con la TZ puesta en el
# compose. Dos consecuencias, ninguna visible:
#   · el `nightly` del crontab (`0 3 * * *`, pensado 3 AM MX) correría 3 AM UTC =
#     21:00 MX — 6 h corrido, la trampa que [[feedback_cron_timezone_mx_container]]
#     ya documentó para prod;
#   · los importers calculan ventanas de fecha con la hora local, así que después
#     de las 18:00 MX un contenedor en UTC ya está "en mañana".
# El Dockerfile de prod fija `ENV TZ=America/Mexico_City`: acá se hace igual.
RUN apk add --no-cache tini tzdata
ENV TZ=America/Mexico_City

WORKDIR /app

# Capa de dependencias primero (cachea mientras package.json no cambie).
COPY ops/ingest/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Código. Las rutas replican la estructura del repo para no romper los requires relativos.
COPY database/importers ./database/importers
COPY services/feeds-ingest ./services/feeds-ingest
COPY ops/ingest/health.js ./ops/ingest/health.js

# VL.4 — `database/scripts` entra por UN archivo: `fleet-poll-onprem.js`, el carril
# del GPS de la flota (@1 min), que no vive en `database/importers`. Y `ops/vl`
# trae la agenda de los feeds (crontab + wrapper), que a partir de VL.4 vive en el
# repo y no en el Programador de Windows.
COPY database/scripts ./database/scripts
COPY ops/vl/run-feed.sh ops/vl/crontab.feeds ./ops/vl/
RUN chmod +x ./ops/vl/run-feed.sh

# ⛔ `target-guard.js` — el ÚNICO archivo de `libs/` que la imagen necesita, y el que
# más cuesta descubrir. `run-prod-feeds.js:349` lo requiere **por path computado**
# (`require(path.join(__dirname, '../../../libs/...'))`) y **sólo dentro del
# `if (APPLY)`**, así que:
#   · un grep de `require('...')` literal NO lo encuentra — buscar requires
#     computados también, o el grafo de dependencias sale incompleto;
#   · una prueba en SECO no lo ejercita — el dry-run nunca entra a esa rama.
# Medido el 2026-09-11: los carriles corrían perfecto en seco y morían con
# MODULE_NOT_FOUND en cuanto se les puso --apply. La ruta relativa se preserva
# porque el require sube tres niveles desde database/importers/kepler.
COPY libs/platform-core/src/lib/provenance/target-guard.js ./libs/platform-core/src/lib/provenance/target-guard.js

ENV NODE_ENV=production

# El healthcheck mide ENTREGA (latido en prod), no que el PID exista. Ver ops/ingest/health.js.
HEALTHCHECK --interval=60s --timeout=20s --start-period=180s --retries=3 \
  CMD node /app/ops/ingest/health.js

ENTRYPOINT ["/sbin/tini", "--"]
# El comando concreto lo pone cada servicio del compose (un carril por servicio).
CMD ["node", "database/importers/kepler/replicate-ods-live.js", "--apply", "--watch=15"]
