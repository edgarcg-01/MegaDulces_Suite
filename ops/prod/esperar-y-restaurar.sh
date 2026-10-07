#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.9.5] Espera a que el respaldo de la noche termine y restaura la copia.
#
#   nohup sh ops/prod/esperar-y-restaurar.sh > ~/restore-nocturno.log 2>&1 &
#
# Existe porque el respaldo arranca a las 22:00 y tarda ~75 min, o sea que la hora
# exacta en que termina no se sabe de antemano. ⛔ Un `sleep` calculado a ojo es
# justamente el error que este proyecto ya pagó: si el volcado tarda 20 min más,
# el restore agarra el archivo A MEDIO ESCRIBIR — y `pg_restore --list` abre un
# archivo truncado sin quejarse, así que la copia saldría incompleta EN VERDE.
#
# En vez de eso espera una SEÑAL de que terminó, que son dos cosas juntas:
#   · existe un volcado más nuevo que la hora de arranque, y
#   · su tamaño dejó de crecer entre dos vueltas (el archivo está cerrado).
#
# ⚠️ No sobrevive a un reinicio de la máquina. Es de un solo uso, a propósito: un
#    restore que se repite solo cada noche BORRARÍA la copia todas las noches.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DEST_DIR="${BACKUP_DIR:-/home/superoot/backups}"
DESDE=$(date +%s)
# ⚠️ 12 h, no "lo que tarda el respaldo". El primer intento se lanzó a las 14:01 con 5.5 h y
# se habría rendido a las 19:31 — ANTES de que el respaldo arrancara a las 22:00. La espera
# se cuenta desde que se LANZA esto, no desde la hora del respaldo, y las dos cosas no tienen
# por qué estar cerca.
MAX_ESPERA_MIN="${MAX_ESPERA_MIN:-720}"
PASO=300                                   # revisar cada 5 min

di() { echo "[$(date '+%F %T %Z')] $*"; }

di "esperando el volcado de la noche en $DEST_DIR (hasta ${MAX_ESPERA_MIN} min)"
prev_size=-1
fin=$(( DESDE + MAX_ESPERA_MIN * 60 ))

while [ "$(date +%s)" -lt "$fin" ]; do
  arch=$(find "$DEST_DIR" -maxdepth 1 -name 'trade_marketing_*.dump' -newermt "@$DESDE" 2>/dev/null | sort | tail -1)
  if [ -n "$arch" ]; then
    size=$(stat -c %s "$arch" 2>/dev/null || echo 0)
    if [ "$size" -gt 0 ] && [ "$size" = "$prev_size" ]; then
      di "volcado listo y estable: $arch ($(( size / 1048576 )) MB)"
      di "── arrancando el restore ──"
      sh "$(dirname "$0")/restaurar.sh" "$arch"
      rc=$?
      di "restaurar.sh terminó con código $rc"
      exit "$rc"
    fi
    di "creciendo: $(( size / 1048576 )) MB — espero"
    prev_size=$size
  fi
  sleep "$PASO"
done

di "FALLO: pasaron ${MAX_ESPERA_MIN} min y no apareció un volcado estable."
di "       Revisá el latido backup_prod en analytics.cron_runs: dice por qué."
exit 1
