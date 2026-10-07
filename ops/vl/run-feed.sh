#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.4 — el que ejecuta cada carril del cron. Uso: run-feed.sh <etiqueta> <cmd...>
#
# Hace tres cosas que el crontab por sí solo no puede:
#
# 1. CARGA EL ENV DESDE EL ARCHIVO. `crond` de busybox NO hereda el entorno del
#    contenedor en los jobs — sólo pasa un PATH mínimo. Si el env viniera del
#    `environment:` del compose, los jobs correrían SIN credenciales y fallarían
#    en silencio. Se lee de /secrets/feeds.env, que es la fuente única.
#
# 2. ⛔ SERIALIZA CON `flock`. El Programador de Windows tenía `IgnoreNew` (si la
#    corrida anterior sigue viva, no lanza otra). `crond` NO tiene equivalente: sin
#    esto, `receipts` y `contpaqi` —que corren cada minuto y a veces tardan más—
#    se apilarían hasta tumbar la caja. `-n` = si está tomado, NO espera: se saltea
#    esta corrida y lo dice, que es exactamente el comportamiento del Programador.
#
# 3. Rotula la salida con la etiqueta y la hora, para que `docker compose logs`
#    de un solo contenedor con 11 carriles siga siendo legible.
# ─────────────────────────────────────────────────────────────────────────────
set -u
LABEL="$1"; shift
LOCK="/tmp/feed-${LABEL}.lock"

say() { echo "[$(date '+%F %T %Z')] [$LABEL] $*"; }

# El env se carga acá y no antes: así cada job ve exactamente lo mismo, venga del
# cron o de una corrida a mano con `docker exec`.
if [ -r /secrets/feeds.env ]; then
  set -a; . /secrets/feeds.env; set +a
else
  say "✖ no se puede leer /secrets/feeds.env — abortando (un feed sin credenciales escribe a la nada)"
  exit 1
fi

# ⛔ `cd /app` NO es cosmético. `crond` lanza los jobs desde $HOME (= /root), y
# `run-prod-feeds.js` invoca sus pasos hijos con rutas RELATIVAS al CWD → todos
# mueren con `Cannot find module '/root/database/importers/...'`.
# Medido el 2026-09-11: el mismo comando daba "2/2 OK" por `docker exec` (CWD=/app,
# el WORKDIR de la imagen) y "0/2" desde cron. La prueba manual NO reproduce el
# entorno de cron: el CWD es parte de ese entorno.
cd /app || { say "✖ no existe /app"; exit 1; }

# ⚠️ El lock se toma sobre un DESCRIPTOR, no con `flock -c`. Con `-c`, flock
# devuelve 1 tanto si el lock está tomado como si el comando falló con 1 — y
# busybox flock no tiene `-E` para desambiguar (verificado: su usage es
# `flock [-sxun] FD | { FILE [-c] PROG ARGS }`). La versión anterior reportaba
# "SALTEADA por lock" cuando en realidad el carril había FALLADO, que es la peor
# clase de bug: disfrazaba un fallo de estado benigno.
exec 9>"$LOCK" || { say "✖ no se pudo abrir el lock $LOCK"; exit 1; }
if ! flock -n 9; then
  say "· SALTEADA: la corrida anterior sigue viva (lock)"
  exit 0
fi

t0=$(date +%s)
sh -c "$*"
rc=$?
dt=$(( $(date +%s) - t0 ))
if [ "$rc" = 0 ]; then say "✓ ok en ${dt}s"; else say "✖ terminó con código $rc tras ${dt}s"; fi
exit "$rc"
