#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
# `[OPS.DISCO.3]` EL VIGÍA DEL DISCO DE `md` — avisa con DÍAS de anticipación, y si no alcanza, actúa.
#
# ── Por qué existe, medido el 2026-10-19 ────────────────────────────────────────────────────
# Segunda caída por disco en 11 días (la primera, el 8-oct). El kubelet marcó `DiskPressure`,
# desalojó TODO —`pg-prod` incluido, ~30 intentos de arranque— y el respaldo completo del domingo
# abortó con [057] porque le mataron la base a mitad de camino. Sin completo nuevo, pgBackRest no
# expira WAL, así que el disco no bajaba: un círculo que sólo se rompe a mano.
#
# ⛔ Lo que había no avisaba:
#   · `podar-disco.sh` (el freno del 8-oct) mira caché e imágenes de Docker — no los 160 GB de WAL
#     ni los 34 GB del registro — y sólo corre al DESPLEGAR: su último latido era del 16-oct.
#   · Ese último latido decía `libre 63→65GB` en VERDE. Era la advertencia y se pintó como ok.
#   · Desalojar pods NO libera disco cuando lo que ocupa son respaldos fuera de los pods: el kubelet
#     desaloja uno tras otro hasta vaciar el nodo. La presión de disco aquí es puro daño.
#
# ── Qué hace ────────────────────────────────────────────────────────────────────────────────
#   1. Mide el libre y lo guarda en un historial (un renglón cada corrida, ~4 días).
#   2. Calcula el ritmo de consumo a 24 h y a 72 h (un ciclo completo de respaldos) y toma el PEOR:
#      el diente de sierra de pgBackRest hace que una sola ventana pueda verse plana.
#   3. Días hasta el umbral de desalojo del kubelet (`nodefs.available<5%` — medido en el evento:
#      «Threshold quantity: 26391807164», el 5 % de los 491.6 GiB).
#   4. ERROR si: el nodo ya tiene DiskPressure, o el margen sobre el umbral es < MARGEN_GB, o
#      faltan < DIAS_AVISO días al ritmo actual. Late SIEMPRE (ok o error) en `analytics.cron_runs`
#      con job_key `vigia_disco`: un vigía sin latido es indistinguible de uno que no corre.
#   5. Si el margen es < MARGEN_GB, ESCALA (máximo una vez cada ENFRIAR_H horas):
#        a. `podar-disco.sh`             — caché de build e imágenes de Docker
#        b. respaldo completo de pgBackRest — expira el completo más viejo y su WAL (hoy: 82 GB)
#      Se detiene en cuanto el margen se recupera. El (b) acorta la ventana de recuperación a un
#      punto en el tiempo; es el precio aceptado frente a que el kubelet tire la base.
#      ⚠️ PENDIENTE: el registro de imágenes (34.5 GB, 101–136 etiquetas por imagen, nadie lo poda)
#         no entra en la escalada todavía — su poda necesita autorización aparte (OPS.DISCO.4).
#
# ⚠️ El aviso hoy llega SÓLO al tablero (Salud BD → `vigia_disco`) — decisión de Edgar el
#    2026-10-19. No hay canal que salga del edificio (deuda OBS.0.2). Por eso existe el paso 5.
#
#   cron (superoot):  */10 * * * * /bin/sh $HOME/ops/prod/vigia-disco.sh >> $HOME/ops/prod/vigia-disco.log 2>&1
#   simular:          VIGIA_SIMULAR=1 VIGIA_LIBRE_GB=.. VIGIA_TOTAL_GB=.. VIGIA_HIST=archivo sh vigia-disco.sh
#   prueba:           sh ops/prod/test-vigia-disco.sh
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -u

MARGEN_GB="${VIGIA_MARGEN_GB:-60}"      # GB por ENCIMA del umbral de desalojo; debajo, se escala
DIAS_AVISO="${VIGIA_DIAS_AVISO:-7}"     # menos días que esto al ritmo actual = rojo
UMBRAL_PCT="${VIGIA_UMBRAL_PCT:-5}"     # eviction-hard nodefs.available del kubelet de k3s
ENFRIAR_H="${VIGIA_ENFRIAR_H:-12}"      # una escalada cada N horas como máximo
HIST="${VIGIA_HIST:-$HOME/ops/prod/vigia-disco.hist}"
MARCA_ESCALA="${VIGIA_MARCA_ESCALA:-$HOME/ops/prod/vigia-disco.escalo}"
SIMULAR="${VIGIA_SIMULAR:-0}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"

di() { echo "[$(date '+%F %T')] $*"; }

libre_gb() { [ -n "${VIGIA_LIBRE_GB:-}" ] && { echo "$VIGIA_LIBRE_GB"; return; }
  df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9'; }
total_gb() { [ -n "${VIGIA_TOTAL_GB:-}" ] && { echo "$VIGIA_TOTAL_GB"; return; }
  df -BG --output=size / 2>/dev/null | tail -1 | tr -dc '0-9'; }
presion() { [ -n "${VIGIA_PRESION:-}" ] && { echo "$VIGIA_PRESION"; return; }
  kubectl get node md -o jsonpath='{.status.conditions[?(@.type=="DiskPressure")].status}' 2>/dev/null || echo "?"; }
ahora() { [ -n "${VIGIA_AHORA:-}" ] && { echo "$VIGIA_AHORA"; return; }; date +%s; }

latir() { # latir <ok|error> <nota>
  [ "$SIMULAR" = 1 ] && return 0
  _n=$(printf '%s' "$2" | sed "s/'/''/g")
  sh "$HOME/ops/prod/pgprod.sh" -q >/dev/null 2>&1 <<SQL || di "aviso: no se pudo escribir el latido"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
VALUES ('$TENANT', 'vigia_disco', 'Vigía del disco de md (días hasta DiskPressure)', now(), now(), '$1', '$_n', 'md', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET label = EXCLUDED.label, last_finish = now(), status = EXCLUDED.status, note = EXCLUDED.note,
      host = EXCLUDED.host, updated_at = now();
SQL
}

T=$(ahora); L=$(libre_gb); TOT=$(total_gb); P=$(presion)
if [ -z "$L" ] || [ -z "$TOT" ]; then
  di "FALLO: no se pudo medir el disco"
  latir error "NO MEDIDO: df no devolvió el libre o el total"
  exit 1
fi
UMBRAL=$(( TOT * UMBRAL_PCT / 100 ))
MARGEN=$(( L - UMBRAL ))

# Historial: se agrega la muestra y se conservan ~4 días. En simulación el archivo lo trae la prueba.
if [ "$SIMULAR" != 1 ]; then
  echo "$T $L" >> "$HIST"
  _tmp="$HIST.tmp"; awk -v c="$((T - 4*86400))" '$1 >= c' "$HIST" > "$_tmp" 2>/dev/null && mv "$_tmp" "$HIST"
fi

# Consumo en GB/día contra la muestra más vieja que tenga al menos <horas> de antigüedad.
# Si el disco se LIBERÓ en la ventana, el consumo es 0 (no se proyecta una mejora). Sin muestra
# suficientemente vieja: «?» — se declara, no se inventa un ritmo.
ritmo() { # ritmo <horas>
  awk -v t="$T" -v l="$L" -v h="$1" '
    $1 <= t - h*3600 { ts=$1; lv=$2 }
    END { if (ts == "") { print "?"; exit }
          d=(t-ts)/86400; r=(lv-l)/d; if (r < 0) r=0; printf "%.1f", r }' "$HIST" 2>/dev/null || echo "?"
}
R24=$(ritmo 24); R72=$(ritmo 72)
RITMO=$(printf '%s %s\n' "$R24" "$R72" | awk '{m=-1; for(i=1;i<=NF;i++) if ($i!="?" && $i+0>m) m=$i+0; if (m<0) print "?"; else printf "%.1f", m}')
if [ "$RITMO" = "?" ]; then DIAS="?"
else DIAS=$(awk -v m="$MARGEN" -v r="$RITMO" 'BEGIN{ if (r <= 0.05) print "inf"; else printf "%.1f", m/r }'); fi

NOTA="libre ${L}GB · umbral desalojo ${UMBRAL}GB · margen ${MARGEN}GB · consumo ${RITMO}GB/día (24h ${R24}, 72h ${R72}) · días hasta DiskPressure: ${DIAS} · DiskPressure=${P}"
ESTADO=ok; MOTIVO=""
if [ "$P" = "True" ]; then ESTADO=error; MOTIVO="el nodo YA está en DiskPressure"
elif [ "$MARGEN" -lt "$MARGEN_GB" ]; then ESTADO=error; MOTIVO="margen ${MARGEN}GB < ${MARGEN_GB}GB"
elif [ "$DIAS" != "?" ] && [ "$DIAS" != "inf" ] && awk -v d="$DIAS" -v a="$DIAS_AVISO" 'BEGIN{exit !(d < a)}'; then
  ESTADO=error; MOTIVO="a este ritmo faltan ${DIAS} días (< ${DIAS_AVISO})"
fi
[ -n "$MOTIVO" ] && NOTA="⛔ $MOTIVO — $NOTA"

# ── Escalada: sólo si el margen ya es corto (no por pronóstico), y con enfriamiento ─────────
ESCALAR=0
if [ "$P" = "True" ] || [ "$MARGEN" -lt "$MARGEN_GB" ]; then ESCALAR=1; fi
if [ "$ESCALAR" = 1 ] && [ "$SIMULAR" != 1 ]; then
  ult=$(cat "$MARCA_ESCALA" 2>/dev/null || echo 0)
  if [ $(( T - ult )) -lt $(( ENFRIAR_H * 3600 )) ]; then
    NOTA="$NOTA · escalada en enfriamiento (última hace $(( (T - ult) / 60 )) min) — revisar a mano"
  else
    echo "$T" > "$MARCA_ESCALA"
    paso() { # paso <rótulo> <comando…> — corre si el margen sigue corto
      _m=$(( $(libre_gb) - UMBRAL ))
      [ "$_m" -ge "$MARGEN_GB" ] && return 0
      di "margen ${_m}GB < ${MARGEN_GB}GB — escalando: $1"; shift
      "$@" >> "$HOME/ops/prod/vigia-disco.log" 2>&1 || di "aviso: el paso falló"
      di "   libre ahora: $(libre_gb)GB"
    }
    paso "podar-disco (caché de build e imágenes)" sh "$HOME/ops/prod/podar-disco.sh"
    paso "respaldo completo de pgBackRest (expira el WAL más viejo)" docker exec prod-backup /usr/local/bin/pgbackrest-run.sh full
    L2=$(libre_gb)
    NOTA="$NOTA · ESCALÓ: libre ${L}→${L2}GB"
    [ $(( L2 - UMBRAL )) -lt "$MARGEN_GB" ] && NOTA="$NOTA — SIGUE CORTO tras escalar todo: lo que ocupa no es basura, revisar a mano"
  fi
fi

di "$ESTADO · $NOTA"
echo "ESTADO=$ESTADO"
latir "$ESTADO" "$NOTA"
[ "$ESTADO" = ok ]
