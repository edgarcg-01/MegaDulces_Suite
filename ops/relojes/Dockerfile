# ops/relojes/Dockerfile — `[OPS.ING.1]` el lector de relojes checadores, en su propia imagen.
#
# ⛔ POR QUÉ NO VA EN `trade-ingest`: el lector sostiene UNA sesión TCP por reloj (un ZKTeco no
# acepta dos) y los carriles del ODS sostienen la réplica de Kepler. En la misma imagen, cambiar
# una línea del lector reiniciaba los diez carriles del ODS, y cambiar un importer del ODS le
# cortaba la sesión a los doce relojes.
#
# La construye el CI (`.github/workflows/imagenes.yml`) y `md` sólo la descarga
# (`ops/prod/desplegar-ingesta.sh`). La etiqueta que corre en el clúster es el hash de lo que este
# archivo copia (`ops/prod/etiqueta-imagen.sh`): si nada de eso cambió, el pod no se toca.
FROM node:20-alpine
RUN apk add --no-cache tini tzdata
ENV TZ=America/Mexico_City
WORKDIR /app
COPY ops/relojes/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
# La misma ruta que en el repo: el manifiesto corre `node database/importers/checadores/agente/index.js`.
COPY database/importers/checadores/agente ./database/importers/checadores/agente
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "database/importers/checadores/agente/index.js"]
