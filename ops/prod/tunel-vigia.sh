#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[SEG.3]` EL TÚNEL — la única puerta por donde entra TODO el tráfico de usuarios, y la única
# pieza de `md` que no tenía ni vigilancia ni brazo.
#
# ── El incidente que la obliga (2026-09-24) ─────────────────────────────────────────────────
# `prod-cloudflared` escribió su última línea a las **14:32:44** y después **33 minutos de
# silencio absoluto** — ni un error, ni una reconexión. La siguiente línea fue `Starting tunnel`,
# o sea el reinicio manual. El contenedor decía **`Up`** todo ese tiempo.
#
# Medido, y es lo que lo vuelve grave: en esa misma ventana `ods-live-hot` escribió **441** líneas
# y `prod-api` **15**. El host estaba sano y sirviendo. **Sólo el túnel estaba muerto**, así que
# por dentro todo respondía y por fuera Cloudflare devolvía **error 1033**.
#
# ⛔ **Nadie se enteró, y no por casualidad — no había con qué:**
#   · Docker: `prod-cloudflared` **no tiene `HEALTHCHECK`**, así que su estado era `Up` a secas.
#   · `ods-autoheal`: ya cura a **8** contenedores por la etiqueta `autoheal`… y el túnel **no la
#     tiene**. Justo la pieza por la que entra todo quedó fuera de la red de seguridad.
#   · `db-health`: el túnel no tenía latido, así que no figuraba en ningún tablero.
# El único detector fue una persona viendo el 1033.
#
# ── Por qué un script y no un `HEALTHCHECK` de Docker ───────────────────────────────────────
# Porque **no se puede**: la imagen de `cloudflared` es *distroless* — no trae `sh`, ni `curl`, ni
# `wget`. Un `HEALTHCHECK` corre DENTRO del contenedor y ahí no hay con qué ejecutarlo, así que
# tampoco sirve `ods-autoheal`, que se guía por el estado de salud de Docker.
#
# Lo que SÍ hay: `cloudflared` publica `/ready` en su puerto de métricas, y **el host alcanza la
# IP del contenedor directo**. Verificado en vivo:
#
#     curl http://172.19.0.13:20241/ready
#     {"status":200,"readyConnections":4,"connectorId":"4c69…"}
#
# ⭐ `readyConnections` es la señal exacta: son las conexiones REGISTRADAS contra el borde de
# Cloudflare. Si son 0, el túnel existe pero no lo sostiene nadie — que es precisamente lo que
# pasó hoy, y lo que `Up` no distingue.
#
# ── Qué hace, en este orden ─────────────────────────────────────────────────────────────────
#   1. Mide. Late a `analytics.cron_runs` (`tunel_cloudflared`) SIEMPRE — ok o error, con el
#      número de conexiones. Es lo que hacía falta para que el tablero pueda decirlo.
#   2. Cura, pero sólo tras `FALLOS_PARA_CURAR` lecturas malas seguidas. Una sola lectura mala es
#      un reinicio del propio túnel o un segundo de red; reiniciar por eso corta a los usuarios
#      por nada (ADR-053: el veredicto necesita brazo, pero el brazo necesita paciencia).
#   3. ⚠️ **Nunca reinicia dos veces seguidas sin dejar pasar `ESPERA_TRAS_CURAR`.** Un bucle de
#      reinicios sobre la puerta de entrada es peor que la puerta caída: al menos la caída se nota.
#
#   instalar:  * * * * * /bin/sh $HOME/ops/prod/tunel-vigia.sh >> $HOME/ops/prod/tunel-vigia.log 2>&1
#   ver:       tail -n 20 ~/ops/prod/tunel-vigia.log
#   tablero:   Salud BD → job_key = 'tunel_cloudflared'
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

CONTENEDOR="${TUNEL_CONTENEDOR:-prod-cloudflared}"
PUERTO="${TUNEL_PUERTO:-20241}"
ESTADO="${TUNEL_ESTADO:-$HOME/ops/prod/.tunel-vigia.estado}"
FALLOS_PARA_CURAR="${TUNEL_FALLOS:-3}"
ESPERA_TRAS_CURAR="${TUNEL_ESPERA_SEG:-600}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"

di() { echo "[$(date '+%F %T')] $*"; }

latir() { # latir <ok|error> <nota>
  _n=$(printf '%s' "$2" | sed "s/'/''/g")
  docker exec -i pg-prod psql -U postgres -q -d railway >/dev/null 2>&1 <<SQL || di "aviso: no se pudo escribir el latido"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'tunel_cloudflared', 'Túnel Cloudflare (entrada de usuarios)', now(), now(), '$1', '$_n', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note, host = EXCLUDED.host, updated_at = now();
SQL
}

# ── La medición ─────────────────────────────────────────────────────────────────────────────
# La IP se relee en CADA pasada: Docker se la reasigna al recrear el contenedor, y cachearla haría
# que el vigía midiera una IP muerta y declarara caído un túnel sano — una alarma falsa que
# enseña a ignorar el tablero.
ip=$(docker inspect "$CONTENEDOR" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)
corriendo=$(docker inspect "$CONTENEDOR" -f '{{.State.Running}}' 2>/dev/null)

if [ "$corriendo" != "true" ] || [ -z "$ip" ]; then
  conexiones=-1
  motivo="el contenedor $CONTENEDOR no está corriendo"
else
  r=$(curl -s --max-time 5 "http://$ip:$PUERTO/ready" 2>/dev/null)
  conexiones=$(printf '%s' "$r" | jq -r '.readyConnections // -1' 2>/dev/null)
  case "$conexiones" in ''|*[!0-9-]*) conexiones=-1 ;; esac
  motivo="/ready devolvió '${r:-nada}'"
fi

fallos=$(cat "$ESTADO" 2>/dev/null | head -1)
case "$fallos" in ''|*[!0-9]*) fallos=0 ;; esac

if [ "$conexiones" -gt 0 ] 2>/dev/null; then
  [ "$fallos" -gt 0 ] && di "recuperado: $conexiones conexión(es) — se reinicia el contador"
  echo 0 > "$ESTADO"
  latir ok "$conexiones conexión(es) registradas con el borde"
  exit 0
fi

# ── Falla ───────────────────────────────────────────────────────────────────────────────────
fallos=$((fallos + 1))
echo "$fallos" > "$ESTADO"
di "FALLA $fallos/$FALLOS_PARA_CURAR — $motivo"
latir error "sin conexiones al borde ($fallos/$FALLOS_PARA_CURAR) · $motivo"

[ "$fallos" -ge "$FALLOS_PARA_CURAR" ] || exit 0

# ⚠️ El freno anti-bucle. Se compara contra la marca del último reinicio, no contra un contador:
# un contador se pierde si el script muere a mitad, y entonces el freno deja de frenar.
MARCA="$ESTADO.ultima-cura"
ahora=$(date +%s)
ultima=$(cat "$MARCA" 2>/dev/null); case "$ultima" in ''|*[!0-9]*) ultima=0 ;; esac
if [ $((ahora - ultima)) -lt "$ESPERA_TRAS_CURAR" ]; then
  di "NO se reinicia: ya se curó hace $((ahora - ultima))s (espera $ESPERA_TRAS_CURAR s)."
  latir error "sin conexiones y en espera tras un reinicio previo — REVISAR A MANO"
  exit 1
fi

di "CURANDO: reiniciando $CONTENEDOR"
echo "$ahora" > "$MARCA"
if docker restart "$CONTENEDOR" >/dev/null 2>&1; then
  echo 0 > "$ESTADO"
  di "reiniciado."
  latir error "túnel sin conexiones — REINICIADO por el vigía"
else
  di "FALLO: no se pudo reiniciar $CONTENEDOR"
  latir error "túnel sin conexiones y el reinicio FALLÓ — intervención manual"
  exit 1
fi
