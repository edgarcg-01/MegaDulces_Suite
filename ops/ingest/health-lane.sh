#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.6.1 — envoltorio del healthcheck para los carriles que NO son del ODS.
#
# Existe porque los contenedores reciben el destino del latido por caminos
# distintos, y el healthcheck corre como un proceso APARTE que sólo ve el
# entorno del contenedor:
#   · `feeds-cron` monta `/secrets/feeds.env` como archivo (a propósito: busybox
#     `crond` no hereda el entorno, así que los carriles lo cargan desde el
#     archivo). Su entorno de contenedor está casi vacío.
#   · `feeds-livefast` y `store-poller` usan `env_file:`, así que las variables
#     sí están en el entorno.
# Este script cubre los dos: si el archivo está, lo carga; si no, usa lo que haya
# en el entorno.
#
# ⚠️ `ODS_HB_URL` no existe en `feeds.env` — el handle de prod verificado ahí es
# `FLEET_DB_URL` (GOTCHAS §17: `DATABASE_URL_NEW` significa tres cosas distintas
# según el carril, y en varios de estos apunta al contenedor de réplicas, no a
# prod). Un latido leído del lugar equivocado es peor que no leerlo: diría
# "sano" mirando una tabla que nadie escribe.
#
# ⛔ Si NO se puede resolver el destino, se sale 1 — enfermo. La alternativa
# (salir 0 diciendo "no se evalúa") es el falso verde que dejó a estos tres
# contenedores en `healthy` incondicional desde que se crearon.
# ─────────────────────────────────────────────────────────────────────────────
set -u

if [ -r /secrets/feeds.env ]; then
  set -a; . /secrets/feeds.env; set +a
fi

: "${ODS_HB_URL:=${FLEET_DB_URL:-}}"
export ODS_HB_URL

if [ -z "$ODS_HB_URL" ]; then
  echo "health: no se pudo resolver ODS_HB_URL (ni FLEET_DB_URL) — no se puede afirmar que este carril entregue"
  exit 1
fi
if [ -z "${ODS_HB_KEY:-}" ]; then
  echo "health: falta ODS_HB_KEY — el servicio del compose tiene que declarar qué carril vigila"
  exit 1
fi

exec node /app/ops/ingest/health.js
