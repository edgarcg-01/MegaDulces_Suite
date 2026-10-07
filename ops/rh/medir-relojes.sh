#!/usr/bin/env bash
# Fase RH · [RH.0.3] — ¿El servidor alcanza los relojes checadores?
#
# Se corre EN `md` (o donde vaya a vivir el lector), antes de mudar el lector de relojes de la
# laptop al servidor ([RH.1.3]). Mide, no cambia nada.
#
#   ./medir-relojes.sh ping 192.168.0.153 192.168.10.2 ...     # en cualquier momento
#   ./medir-relojes.sh tcp  192.168.0.153 192.168.10.2 ...     # SÓLO fuera de horario
#
# ── Por qué dos pasos ──
# `ping` no toca al reloj: no abre sesión, se puede correr con el agente de producción leyendo.
# `tcp` abre y cierra el puerto 4370 (sin mandar un solo comando ZK). Un ZKTeco atiende UNA
# sesión: si coincide con la del agente de la laptop, la lectura de ese minuto puede fallar (el
# agente reintenta). Por eso se niega a correr de 07:00 a 21:00 hora de México salvo FORZAR=1, y
# va de uno en uno con una pausa.
#
# Que el servidor ya replique las bases de varias sucursales prueba que HAY RUTA a esas subredes,
# no que el firewall deje pasar el 4370: eso es justo lo que mide el paso `tcp`.
set -u

modo="${1:-}"; shift || true
if [ -z "$modo" ] || [ "$#" -eq 0 ]; then
  echo "uso: $0 ping|tcp IP [IP ...]" >&2; exit 2
fi

case "$modo" in
  ping)
    printf '%-16s %-8s %s\n' IP PÉRDIDA RTT
    for ip in "$@"; do
      out=$(ping -c 3 -W 2 "$ip" 2>&1)
      perdida=$(printf '%s' "$out" | grep -oE '[0-9.]+% packet loss' | cut -d' ' -f1)
      rtt=$(printf '%s' "$out" | grep -oE '= [0-9./]+ ms' | cut -d' ' -f2 | cut -d/ -f2)
      printf '%-16s %-8s %s\n' "$ip" "${perdida:-?}" "${rtt:+${rtt} ms}"
    done
    ;;
  tcp)
    # UTC−6 fijo (México no tiene horario de verano desde 2022). NO `TZ=America/Mexico_City`: sin
    # tzdata (Alpine, Git Bash) se ignora en silencio y da la hora UTC — ya pasó en este proyecto.
    hora=$(( (10#$(date -u +%H) + 18) % 24 ))
    if [ "${FORZAR:-0}" != "1" ] && [ "$hora" -ge 7 ] && [ "$hora" -lt 21 ]; then
      echo "Son las ${hora}h en México: el agente de producción está leyendo. Córrelo después de las 21:00 (o FORZAR=1)." >&2
      exit 3
    fi
    printf '%-16s %s\n' IP '4370/tcp'
    for ip in "$@"; do
      inicio=$(date +%s%3N)
      if timeout 4 bash -c "exec 3<>/dev/tcp/$ip/4370" 2>/dev/null; then
        printf '%-16s abre (%s ms)\n' "$ip" "$(( $(date +%s%3N) - inicio ))"
      else
        printf '%-16s NO abre\n' "$ip"
      fi
      sleep 2
    done
    ;;
  *)
    echo "modo desconocido: $modo (ping|tcp)" >&2; exit 2 ;;
esac
