#!/bin/sh
# Candado de `vigia-disco.sh` (2026-10-19). Un vigía sin prueba negativa es una intención: este
# archivo corre el guion REAL en modo simulación (sin df, kubectl, latido ni escalada) y exige el
# rojo donde tiene que estar. Los números imitan a `md`: 492 GB, umbral de desalojo 5 % = 24 GB.
#
# Uso:  sh ops/prod/test-vigia-disco.sh
set -u
AQUI=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
T=1760000000; fallas=0

hist() { # hist <archivo> <libre hace 72h> <libre hace 24h>
  printf '%s %s\n%s %s\n' "$((T - 72*3600))" "$2" "$((T - 24*3600))" "$3" > "$1"
}
caso() { # caso <nombre> <esperado> <libre> <presion> <hist>
  out=$(VIGIA_SIMULAR=1 VIGIA_AHORA=$T VIGIA_TOTAL_GB=492 VIGIA_LIBRE_GB="$3" VIGIA_PRESION="$4" \
        VIGIA_HIST="$5" sh "$AQUI/vigia-disco.sh" 2>&1)
  got=$(echo "$out" | sed -n 's/^ESTADO=//p')
  if [ "$got" = "$2" ]; then echo "✔ $1 → $got"
  else echo "✘ $1 → esperaba $2, dio '${got}'"; echo "$out" | sed 's/^/    /'; fallas=$((fallas + 1)); fi
}

hist "$TMP/plano" 170 170;      caso "disco plano con 170 GB libres"                 ok    170 False "$TMP/plano"
hist "$TMP/libera" 120 150;     caso "el disco se LIBERÓ (no proyecta mejora)"       ok    170 False "$TMP/libera"
: > "$TMP/vacio";               caso "sin historial: ritmo NO MEDIDO, margen holgado" ok    170 False "$TMP/vacio"
# ── negativos: cada uno tiene que dar rojo ──
hist "$TMP/rapido" 200 185;     caso "consume 15 GB/día con 146 de margen (~9.7 d)"  ok    170 False "$TMP/rapido"
hist "$TMP/rapidisimo" 230 200; caso "consume 30 GB/día → ~4.9 días (< 7)"           error 170 False "$TMP/rapidisimo"
hist "$TMP/sierra" 170 120;     caso "24h plano pero 72h cae ~16.7 GB/día → ~5.7 d (peor ventana)" error 120 False "$TMP/sierra"
hist "$TMP/plano2" 70 70;       caso "margen 46 GB < 60 aunque esté plano"           error 70  False "$TMP/plano2"
hist "$TMP/plano3" 170 170;     caso "el nodo YA está en DiskPressure"               error 170 True  "$TMP/plano3"

[ "$fallas" = 0 ] && echo "OK — 8 casos" || { echo "ROJO — $fallas casos fallaron"; exit 1; }
