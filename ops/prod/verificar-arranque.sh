#!/bin/sh
# `[RES.1]` Verificador de arranque: qué volvió DE VERDAD después de una caída.
#
# ⭐ Por qué existe. El 2026-10-12 `md` se cayó tres veces en cinco días hábiles (07-oct 08:22,
#    08-oct 15:34, 12-oct 12:41), las tres SIN apagarse — ninguna señal de shutdown en el último
#    minuto de vida, y `EXT4-fs: orphan cleanup` al montar. Todo volvió solo en ~8 min, y ESE es
#    el problema: **nadie se enteró**. La caída la reportó una persona media hora después.
#
# ⭐ Mide ENTREGA, no "el proceso corre" — hereda ADR-053. Un pod `Running` con 0/1 listo no sirve
#    a nadie, y un carril de ingesta que arrancó pero no shipea una fila está caído aunque su
#    contenedor esté verde. Por eso cada bloque pregunta por el RESULTADO: la API contesta, los
#    deployments tienen sus réplicas, la base responde con sus migraciones, los carriles latieron.
#
# ⭐ NO toca nada. No reinicia, no reaplica, no repara. Mide y avisa. Un verificador que además
#    arregla no se puede leer: cuando llega el correo ya no sabés qué estaba roto.
#
# ⚠️ Lo que no se puede medir se DECLARA `NO MEDIDO`, nunca se dibuja verde (ADR-056). Es el
#    `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional a tres matvistas.
#
# ⛔ Limitación declarada: si `md` NO vuelve, este script no corre y no llega correo. Cubre el
#    caso medido (las 3 caídas volvieron solas), no el apagón largo. Para eso hace falta un
#    vigilante FUERA de esta máquina — queda como deuda, ver `[RES.3]`.
#
# Uso:  sh verificar-arranque.sh            (mide y manda correo)
#       sh verificar-arranque.sh --seco     (mide e imprime, sin correo)

set -u

SECO=no
[ "${1:-}" = "--seco" ] && SECO=si

ENV_FILE="${ENV_FILE:-$HOME/secrets/prod.env}"
PARA="${RES_ALERTA_PARA:-sistemas@megadulces.com.mx}"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# Cuánto esperamos a que el sistema termine de levantar antes de declarar. Medido: el 12-oct los
# 20 pods tardaron ~8 min desde el boot. 15 min da margen sin colgarse para siempre.
ESPERA_MAX="${RES_ESPERA_MAX:-900}"

ok=0; mal=0; nomedido=0
LINEAS=""

anota() {  # anota <estado> <texto>
  LINEAS="${LINEAS}$1  $2
"
  case "$1" in
    'OK  ') ok=$((ok+1)) ;;
    'FALLA') mal=$((mal+1)) ;;
    *)      nomedido=$((nomedido+1)) ;;
  esac
}

# ── 0. contexto ──────────────────────────────────────────────────────────────
ARRANQUE=$(uptime -s 2>/dev/null || echo 'desconocido')
HOSTN=$(hostname)
# ¿El arranque anterior fue sucio? Es la diferencia entre "alguien reinició" y "se cortó la luz".
# ⚠️ `grep -c` con `|| echo 0` devuelve DOS líneas cuando no hay coincidencias (el 0 del grep y
#    el del echo), y `[ "$x" -gt 0 ]` revienta con «Illegal number». El `head -1` es el arreglo.
SUCIO=$(journalctl -b --no-pager -k 2>/dev/null | grep -ciE 'orphan cleanup|recovery required|unclean' | head -1)
ORDENADO=$(journalctl -b -1 --no-pager 2>/dev/null | tail -40 | grep -ciE 'Starting Reboot|Starting Power-Off|systemd-shutdown' | head -1)
SUCIO=${SUCIO:-0}; ORDENADO=${ORDENADO:-0}
if [ "$ORDENADO" -gt 0 ]; then
  CAUSA="reinicio ORDENADO (alguien lo pidió)"
elif [ "$SUCIO" -gt 0 ]; then
  CAUSA="apagado SUCIO — corte de energía o reset (sin señal de shutdown, con limpieza de huérfanos)"
else
  CAUSA="NO MEDIDO (sin journal del arranque anterior)"
fi

# ── 1. esperar a que termine de levantar ─────────────────────────────────────
# No medimos a los 10 segundos del boot: daría rojo en todo y enseñaría a ignorar el correo.
INICIO=$(date +%s)
while :; do
  listos=$(kubectl -n prod get deploy api -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo '')
  [ -n "$listos" ] && [ "$listos" -ge 1 ] 2>/dev/null && break
  [ $(( $(date +%s) - INICIO )) -ge "$ESPERA_MAX" ] && break
  sleep 15
done
ESPERADO=$(( $(date +%s) - INICIO ))

# ── 2. los deployments y SUS RÉPLICAS ────────────────────────────────────────
ESPERADOS='api caddy worker pg-prod portal vendor'
for d in $ESPERADOS; do
  r=$(kubectl -n prod get deploy "$d" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo '')
  q=$(kubectl -n prod get deploy "$d" -o jsonpath='{.spec.replicas}'       2>/dev/null || echo '')
  if [ -z "$q" ]; then
    anota 'NO M.' "deployment $d — no se pudo consultar a k3s"
  elif [ "${r:-0}" -lt "$q" ] 2>/dev/null; then
    anota 'FALLA' "deployment $d — ${r:-0}/$q réplicas listas"
  else
    anota 'OK  ' "deployment $d — $r/$q réplicas"
  fi
done

# ── 3. la API contesta de verdad (puerta pública, no el pod) ─────────────────
# El 401 del login ES la respuesta correcta: la puerta contesta. Un 200 en /health también sirve.
COD=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://megadulcessuite.com/api/health 2>/dev/null || echo '000')
case "$COD" in
  200|401) anota 'OK  ' "la API pública contesta (http $COD)" ;;
  000)     anota 'FALLA' "la API pública NO contesta (sin respuesta en 20 s)" ;;
  *)       anota 'FALLA' "la API pública responde http $COD" ;;
esac

# ── 4. la base: responde y conserva su ledger ────────────────────────────────
POD=$(kubectl -n prod get pod -l app=pg-prod -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo '')
if [ -z "$POD" ]; then
  anota 'NO M.' 'base de datos — no se encontró el pod pg-prod'
else
  MIG=$(kubectl -n prod exec "$POD" -c postgres -- psql -U postgres -d railway -At \
        -c 'SELECT count(*) FROM public.knex_migrations' 2>/dev/null | tr -d '\r' || echo '')
  if [ -z "$MIG" ]; then
    anota 'FALLA' 'base de datos — no contesta'
  else
    anota 'OK  ' "base de datos contesta — $MIG migraciones en el ledger"
  fi
  # ⚠️ Bloques corruptos: lo que un apagado sucio puede dejar. Si el log no alcanza, se DECLARA.
  CORR=$(kubectl -n prod logs "$POD" -c postgres --tail=300 2>/dev/null \
         | grep -ciE 'invalid page|could not read block|checksum|PANIC' | head -1)
  if [ -z "$CORR" ]; then
    anota 'NO M.' 'integridad de la base — no se pudo leer el log del pod'
  elif [ "$CORR" -gt 0 ]; then
    anota 'FALLA' "integridad de la base — $CORR señal(es) de página corrupta en el log"
  else
    anota 'OK  ' 'integridad de la base — sin señales de corrupción en el log'
  fi
fi

# ── 5. la ingesta ENTREGA (no "el contenedor corre") ─────────────────────────
# Mide `analytics.cron_runs`, que es el latido de entrega de ADR-053.
#
# ⛔ Acá hubo un error de diseño que el primer ensayo destapó, y queda escrito para que nadie lo
#    reponga: la versión original marcaba FALLA si algún carril llevaba >90 min sin entregar.
#    Dio **51 carriles en rojo** y era un falso positivo completo — `feed_catalog` es SEMANAL
#    (59 h es su estado sano), `feed_nightly` corre de noche (9 h), y `prueba_no_usar` no es un
#    carril. **Un umbral inventado acá compite con `CRON_JOBS`, que es donde la cadencia y el
#    umbral de cada carril YA están registrados** (ADR-053/056). Duplicarlo garantiza que un día
#    los dos digan cosas distintas.
#
# ⭐ Lo que sí es inequívoco después de un reinicio, sin saber la cadencia de nadie:
#    (a) cuántos carriles entregaron DESPUÉS del arranque — prueba de que la ingesta retomó;
#    (b) cuáles se declaran en `error` — eso lo dice el carril de sí mismo, no un umbral mío.
if [ -n "$POD" ]; then
  q() { kubectl -n prod exec "$POD" -c postgres -- psql -U postgres -d railway -At -c "$1" 2>/dev/null | tr -d '\r' | head -1; }

  DESDE=$(q "SELECT count(*) FROM analytics.cron_runs WHERE last_finish >= (SELECT pg_postmaster_start_time())")
  if [ -z "$DESDE" ]; then
    anota 'NO M.' 'ingesta — no se pudo leer analytics.cron_runs'
  elif [ "$DESDE" -eq 0 ] 2>/dev/null; then
    anota 'FALLA' 'ingesta — NINGÚN carril entregó desde que arrancó la base'
  else
    anota 'OK  ' "ingesta — $DESDE carril(es) entregaron desde el arranque"
  fi

  ERR=$(q "SELECT count(*) FROM analytics.cron_runs WHERE status = 'error'")
  if [ -z "$ERR" ]; then
    anota 'NO M.' 'carriles en error — no se pudo consultar'
  elif [ "$ERR" -gt 0 ] 2>/dev/null; then
    QUIEN=$(q "SELECT string_agg(job_key, ', ') FROM (SELECT job_key FROM analytics.cron_runs WHERE status = 'error' ORDER BY last_finish DESC LIMIT 5) t")
    anota 'FALLA' "carriles que se declaran en ERROR: $ERR — $QUIEN"
  else
    anota 'OK  ' 'ningún carril se declara en error'
  fi
fi

# ── 6. el respaldo sigue corriendo ───────────────────────────────────────────
# ⚠️ Un respaldo que falla en silencio es peor que no tenerlo: da confianza falsa. El carril de
#    las 22:00 llevaba 11 fallos cuando se escribió esto, y su propio latido tampoco se escribía.
ULT=$(find "$HOME/pgbackrest" -name 'backup.info' -newermt '-36 hours' 2>/dev/null | head -1)
if [ -d "$HOME/pgbackrest" ]; then
  if [ -n "$ULT" ]; then
    anota 'OK  ' 'respaldo — el repositorio de pgbackrest se escribió en las últimas 36 h'
  else
    anota 'FALLA' 'respaldo — pgbackrest no escribió nada en 36 h'
  fi
else
  anota 'NO M.' 'respaldo — no se encontró el repositorio de pgbackrest'
fi

# ── 7. armar y mandar ────────────────────────────────────────────────────────
if [ "$mal" -gt 0 ]; then
  VEREDICTO="ALGO NO VOLVIÓ — $mal falla(s)"
elif [ "$nomedido" -gt 0 ]; then
  VEREDICTO="volvió, con $nomedido punto(s) SIN MEDIR"
else
  VEREDICTO='todo volvió'
fi

CUERPO="$HOSTN arrancó el $ARRANQUE

Causa del arranque: $CAUSA
Veredicto: $VEREDICTO
Esperé $ESPERADO s a que levantara.

$LINEAS
Resumen: $ok bien · $mal mal · $nomedido sin medir

--
[RES.1] verificar-arranque.sh — mide entrega, no arranque. No repara nada.
Si este correo llegó, la máquina se reinició. Si la máquina NO vuelve, este correo NO llega:
esa es la limitación declarada, y la cubre un vigilante externo ([RES.3], pendiente)."

echo "$CUERPO"

[ "$SECO" = 'si' ] && exit 0

# Credenciales: se leen del env, NUNCA se imprimen ni se escriben al log.
if [ ! -r "$ENV_FILE" ]; then
  echo "AVISO: no puedo leer $ENV_FILE — el correo no sale." >&2
  exit 0   # no fallar: un aviso que no salió no puede tumbar el arranque
fi
SMTP_HOST=$(grep -E '^SMTP_HOST=' "$ENV_FILE" | head -1 | cut -d= -f2-)
SMTP_PORT=$(grep -E '^SMTP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2-)
SMTP_USER=$(grep -E '^SMTP_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
SMTP_PASS=$(grep -E '^SMTP_PASS=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ] && {
  echo 'AVISO: SMTP sin configurar — el correo queda apagado (no-op, no crash).' >&2
  exit 0
}

ASUNTO="[$HOSTN] arranque: $VEREDICTO"
TMP=$(mktemp)
{
  printf 'From: %s\r\n' "$SMTP_USER"
  printf 'To: %s\r\n' "$PARA"
  printf 'Subject: %s\r\n' "$ASUNTO"
  printf 'Content-Type: text/plain; charset=UTF-8\r\n'
  printf '\r\n'
  printf '%s\r\n' "$CUERPO"
} > "$TMP"

if curl -s --max-time 45 --url "smtp://${SMTP_HOST}:${SMTP_PORT:-587}" --ssl-reqd \
     --mail-from "$SMTP_USER" --mail-rcpt "$PARA" \
     --user "${SMTP_USER}:${SMTP_PASS}" --upload-file "$TMP" >/dev/null 2>&1; then
  echo "correo enviado a $PARA"
else
  echo "AVISO: el correo no salió (el verificador NO falla por eso)" >&2
fi
rm -f "$TMP"
exit 0
