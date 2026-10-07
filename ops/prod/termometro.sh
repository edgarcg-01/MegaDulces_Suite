#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[SEG.2]` LA CAJA NEGRA DE `md` — para que la próxima caída se pueda explicar.
#
# ── Por qué existe ──────────────────────────────────────────────────────────────────────────
# El 2026-09-24 a las 14:54:35 `md` se detuvo en seco: sin secuencia de apagado, sin panic, sin
# OOM, sin *hung task*. El diario simplemente **corta**. Y no fue la primera vez — medido:
#
#     arranque -1 (hoy)   0 marcadores de apagado   terminó 24-sep 14:54:35
#     arranque -2         0 marcadores de apagado   terminó 21-sep 15:49:02
#     arranque -3         7 marcadores (limpio)     terminó 11-sep 16:37:42
#
# Dos muertes abruptas en tres días, las dos por la tarde.
#
# ⛔ **El problema es que los dos sospechosos principales NO DEJAN RASTRO.** Un corte térmico por
# hardware (el CPU se apaga solo al llegar a Tjmax) y un corte de energía (la máquina **no tiene
# UPS** — deuda VL.8, abierta) terminan exactamente igual: el último renglón del diario es un
# mensaje rutinario y después nada. Ninguna cantidad de análisis del log los distingue, porque el
# log se corta ANTES de que pase lo que hay que explicar.
#
# Y lo que había para medirlo no medía: Netdata lleva corriendo desde las 11:23 del mismo día,
# pero su colector de sensores no publica ninguna serie de temperatura (`sensors.*` sólo expone
# un histograma vacío). O sea que a la hora de la muerte **no existía ni un dato de temperatura**.
#
# ── Qué hace ────────────────────────────────────────────────────────────────────────────────
# Escribe UN renglón por minuto con lo que hace falta para separar las hipótesis. Como la caída es
# instantánea, **el último renglón del archivo es la foto del segundo anterior**:
#
#   · CPU cerca de 90 °C subiendo  → corte térmico (crítico medido en este equipo: 94.85 °C)
#   · CPU tibio y carga normal     → energía o falla de hardware; el calor queda descartado
#   · swap al tope y memoria en 0  → agotamiento de memoria pese a que el kernel no alcanzó a
#                                    escribir el OOM
#
# ⚠️ Es una caja negra, no una alarma: no avisa, deja constancia. Avisar exige un canal que salga
#    del edificio, y `SMTP_*` sigue sin configurar (deuda OBS.0.2). Se declara en vez de fingir
#    que esto vigila algo.
#
# ⚠️ Lee `/sys` y escribe en el home: **no necesita sudo**, que es lo que lo hace instalable hoy.
#
#   instalar:  agregar a la crontab de superoot →  * * * * * /bin/sh $HOME/ops/prod/termometro.sh
#   leer:      tail -n 20 ~/ops/prod/termometro.log
#   tras una caída:  tail -n 30 ~/ops/prod/termometro.log   ← los últimos minutos con vida
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

LOG="${TERMOMETRO_LOG:-$HOME/ops/prod/termometro.log}"

# Sin logrotate para un usuario sin sudo. 20,000 renglones ≈ 14 días a un renglón por minuto.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 20000 ]; then
  tail -n 10000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# ── Las lecturas, todas de /sys ─────────────────────────────────────────────────────────────
# Se busca por NOMBRE de hwmon y no por número: los hwmonN se renumeran entre arranques según el
# orden en que cargan los módulos, así que `hwmon2` puede ser el CPU hoy y el NVMe mañana —
# y el registro quedaría comparando dos cosas distintas sin que se note.
leer() { # leer <nombre-hwmon> <etiqueta|temp1>
  for h in /sys/class/hwmon/hwmon*; do
    [ "$(cat "$h/name" 2>/dev/null)" = "$1" ] || continue
    for t in "$h"/temp*_input; do
      [ -f "$t" ] || continue
      _l=$(cat "${t%_input}_label" 2>/dev/null)
      if [ "$2" = "${_l:-temp1}" ] || [ "$2" = "cualquiera" ]; then
        _v=$(cat "$t" 2>/dev/null); [ -n "$_v" ] && { echo $((_v / 1000)); return; }
      fi
    done
  done
  echo NA
}

cpu=$(leer k10temp Tctl)
nvme=$(leer nvme Composite)
carga=$(awk '{print $1}' /proc/loadavg 2>/dev/null)
# `MemAvailable` y no `MemFree`: free ignora la caché reclamable y siempre parece alarmante.
mem=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
swt=$(awk '/SwapTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
swf=$(awk '/SwapFree/  {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
swu=$((${swt:-0} - ${swf:-0}))
up=$(awk '{printf "%d", $1/60}' /proc/uptime 2>/dev/null)

printf '%s cpu=%sC nvme=%sC carga=%s mem_libre=%sMB swap_usado=%sMB up=%smin\n' \
  "$(date '+%F %T')" "$cpu" "$nvme" "${carga:-NA}" "${mem:-NA}" "$swu" "${up:-NA}" >> "$LOG"
