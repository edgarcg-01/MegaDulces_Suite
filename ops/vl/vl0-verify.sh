#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VL.0 — LA COMPUERTA: ¿este servidor alcanza todo lo que la ingesta necesita?
#
# Se corre ANTES de mover un byte (Fase VL, riesgo R3: los 8 publicadores viven
# en 8 subredes distintas y hoy los alcanza `.249` por ruteo/VPN — que el server
# nuevo herede esa alcanzabilidad NO se supone, se prueba).
#
#   bash ops/vl/vl0-verify.sh              # la compuerta
#   bash ops/vl/vl0-verify.sh --negative   # rompe una rama a propósito y exige el rojo
#
# NO MUTA NADA. Es de sólo lectura y se puede correr todas las veces que quieras.
# `pg_isready` NO necesita credenciales: pregunta si el servidor acepta conexiones.
#
# Tres estados a propósito (ADR-056): OK · FALLA · NO MEDIDO.
# Lo que no se pudo medir NO cuenta como verde — es la regla que existe porque un
# `cfg ? classify : 'ok'` daba verde incondicional a sensores sin umbral.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ── Los 8 publicadores Kepler (de pg_subscription, verificado 2026-09-10) ──
PUBLICADORES=(
  "md_00:192.168.9.95:5432"
  "md_01:192.168.10.10:1977"
  "md_02:192.168.42.42:5432"
  "md_03:192.168.40.40:5432"   # sub_pilot
  "md_04:192.168.44.44:5432"
  "md_05:192.168.54.54:5432"
  "md_06:192.168.50.50:1977"
  "md_07:192.168.32.32:1977"
)
CONSOLIDACION="245:192.168.0.245:5432"
FUENTE_ACTUAL="249-replicas:192.168.0.249:5433"   # VL.2a lee de acá hasta VL.2b
PROD_HOST="${PROD_HOST:-trolley.proxy.rlwy.net}"
PROD_PORT="${PROD_PORT:-39023}"
FEEDS_URL="${FEEDS_INGEST_URL:-https://feeds-ingest-production.up.railway.app}"
CIFS_MOUNT="${CIFS_MOUNT:-/mnt/wincaja}"          # el share D: de .245 (ex `Z:`)

if [[ "${1:-}" == "--negative" ]]; then
  PUBLICADORES+=("ROTA-A-PROPOSITO:192.168.222.222:5432")
  echo "▶ MODO NEGATIVO: se agregó una rama inexistente. Si el script termina en"
  echo "  verde, la compuerta no sirve — un gate sin prueba negativa es una intención."
  echo
fi

ok=0; falla=0; nomedido=0
linea() { printf '  %-9s %-22s %s\n' "$1" "$2" "$3"; }

tiene() { command -v "$1" >/dev/null 2>&1; }

chequear_pg() {  # nombre host puerto
  local n=$1 h=$2 p=$3
  if ! tiene pg_isready; then
    linea "NO MEDIDO" "$n" "falta pg_isready → apt install postgresql-client-18"; ((nomedido++)); return
  fi
  local t0 t1 out ms
  # ⚠️ `date +%%s%%3N` NO truncó a 3 dígitos acá: devolvía nanosegundos completos y la
  # resta se publicaba rotulada "ms" — 170562626 ms son 47 horas. Se mide en ns y se
  # convierte explícito. La unidad de un número no se hereda de su fuente: se prueba.
  t0=$(date +%s%N)
  if out=$(pg_isready -h "$h" -p "$p" -t 5 2>&1); then
    t1=$(date +%s%N); ms=$(( (t1 - t0) / 1000000 ))
    linea "OK" "$n" "$h:$p acepta conexiones (${ms} ms)"; ((ok++))
  else
    linea "FALLA" "$n" "$h:$p → ${out##*- }"; ((falla++))
  fi
}

echo "═══ VL.0 · alcanzabilidad desde $(hostname) ($(date '+%F %T %Z')) ═══"
echo
echo "1) Los 8 publicadores Kepler (fuente de la replicación lógica)"
for e in "${PUBLICADORES[@]}"; do IFS=: read -r n h p <<<"$e"; chequear_pg "$n" "$h" "$p"; done

echo
echo "2) Cajas de la LAN"
IFS=: read -r n h p <<<"$CONSOLIDACION"; chequear_pg "$n" "$h" "$p"
IFS=: read -r n h p <<<"$FUENTE_ACTUAL";  chequear_pg "$n" "$h" "$p"

echo
echo "3) Salida hacia prod (destino del latido y de las filas)"
chequear_pg "prod" "$PROD_HOST" "$PROD_PORT"
if tiene curl; then
  code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$FEEDS_URL" 2>/dev/null || echo "000")
  if [[ "$code" != "000" ]]; then linea "OK" "feeds-ingest" "HTTP $code desde $FEEDS_URL"; ((ok++))
  else linea "FALLA" "feeds-ingest" "sin respuesta de $FEEDS_URL"; ((falla++)); fi
else
  linea "NO MEDIDO" "feeds-ingest" "falta curl"; ((nomedido++))
fi

echo
echo "4) El share de .245 con los .mdb de Wincaja (ex \`Z:\`)"
# ⚠️ Trampa de WR: 4 días de rezago silencioso con el proceso vivo porque el mount
# había desaparecido. Por eso NO alcanza `mountpoint`: hay que LEER un archivo.
if ! mountpoint -q "$CIFS_MOUNT" 2>/dev/null; then
  linea "NO MEDIDO" "cifs" "$CIFS_MOUNT no está montado (normal hasta VL.5)"; ((nomedido++))
elif ls "$CIFS_MOUNT" >/dev/null 2>&1 && [[ -n "$(ls -A "$CIFS_MOUNT" 2>/dev/null)" ]]; then
  linea "OK" "cifs" "$CIFS_MOUNT montado y LEGIBLE ($(ls -1 "$CIFS_MOUNT" | wc -l) entradas)"; ((ok++))
else
  linea "FALLA" "cifs" "$CIFS_MOUNT montado pero NO se puede leer — la trampa de WR"; ((falla++))
fi

echo
echo "5) Reloj (la frescura se juzga comparando timestamps contra prod)"
if tiene timedatectl; then
  tz=$(timedatectl show -p Timezone --value 2>/dev/null)
  sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
  if [[ "$tz" == "America/Mexico_City" && "$sync" == "yes" ]]; then
    linea "OK" "reloj" "TZ=$tz · NTP sincronizado"; ((ok++))
  else
    linea "FALLA" "reloj" "TZ=$tz · NTP=$sync (se espera America/Mexico_City + yes)"; ((falla++))
  fi
else
  linea "NO MEDIDO" "reloj" "falta timedatectl"; ((nomedido++))
fi

echo
echo "─────────────────────────────────────────────────────────────"
printf '  OK: %d   ·   FALLA: %d   ·   NO MEDIDO: %d\n' "$ok" "$falla" "$nomedido"
if (( falla > 0 )); then
  echo "  ⛔ COMPUERTA CERRADA — no seguir a VL.2 hasta resolver lo que falla."
  exit 1
fi
if (( nomedido > 0 )); then
  echo "  ⚠️  COMPUERTA ABIERTA CON RESERVAS — hay chequeos NO MEDIDOS, que no son verdes."
  exit 2
fi
echo "  ✅ COMPUERTA ABIERTA — todo medido y en verde."
