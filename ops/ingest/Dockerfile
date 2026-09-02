# ─────────────────────────────────────────────────────────────────────────────
# Carriles de ingesta del ODS (OBS.4, ADR-053) — replica local :5433 → prod kepler_ods.
#
# Por qué un contenedor y no una tarea programada ni PM2:
#   · Task Scheduler quedó descartado (Edgar).
#   · PM2 corre en la sesión `Console` del usuario → se muere al cerrar sesión, y el 2026-09-02
#     reportó `online` para dos carriles cuyo batch nunca se ejecutó (falso verde).
#   · Docker en esta box ya sostiene pgvector-md, redis-md, api y view con días de uptime, el motor
#     corre como servicio (sin sesión), y `HEALTHCHECK` permite reiniciar por **falta de entrega**,
#     no sólo por muerte del proceso. Eso es lo que ningún supervisor anterior podía dar.
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
RUN apk add --no-cache tini

WORKDIR /app

# Capa de dependencias primero (cachea mientras package.json no cambie).
COPY ops/ingest/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Código. Las rutas replican la estructura del repo para no romper los requires relativos.
COPY database/importers ./database/importers
COPY services/feeds-ingest ./services/feeds-ingest
COPY ops/ingest/health.js ./ops/ingest/health.js

ENV NODE_ENV=production

# El healthcheck mide ENTREGA (latido en prod), no que el PID exista. Ver ops/ingest/health.js.
HEALTHCHECK --interval=60s --timeout=20s --start-period=180s --retries=3 \
  CMD node /app/ops/ingest/health.js

ENTRYPOINT ["/sbin/tini", "--"]
# El comando concreto lo pone cada servicio del compose (un carril por servicio).
CMD ["node", "database/importers/kepler/replicate-ods-live.js", "--apply", "--watch=15"]
