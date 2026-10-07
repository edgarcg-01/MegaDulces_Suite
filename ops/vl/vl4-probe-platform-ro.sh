#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VL.4 — ¿el servidor nuevo puede leer las ramas 00-05 con `platform_ro`?
#
# El hermano de vl2-probe-publishers.sh, para el OTRO rol. Conexión NORMAL, no de
# replicación: `platform_ro` es de sólo lectura, no tiene REPLICATION.
#
# Por qué existe: `kepler-branches.js` resuelve las ramas **00-05 contra el POS
# remoto con `platform_ro`** (06 y 07 leen del replica local). Los carriles que se
# mudan en VL.4 y lo usan incluyen `import-branch-stock-live` (tarea `Stock`, @15
# min) y `live-tickets-poller` (@25 s) — además de import-sales-by-channel,
# concentrate-kepler, import-catalog-bulk e import-kepler-vecinal-routes.
#
# Medido 2026-09-10: bloqueado en las MISMAS 5 que `ods_repl` (00,02,03,04,05).
# Por eso el `pg_hba` de cada sucursal necesita **DOS renglones**, no uno — el
# RUNBOOK_REPLICACION_LOGICA ya lo advertía: "el segundo se olvida siempre".
#
# Uso: generar las conninfo desde kepler-branches.js y pasarlas por STDIN.
# ─────────────────────────────────────────────────────────────────────────────
ok=0; fail=0
while IFS='|' read -r tag conn; do
  [ -z "$tag" ] && continue
  host=$(printf '%s' "$conn" | grep -oE 'host=[^ ]+' | cut -d= -f2)
  db=$(printf '%s' "$conn" | grep -oE 'dbname=[^ ]+' | cut -d= -f2)
  out=$(psql "$conn connect_timeout=8" -tAc "select 1" 2>&1 </dev/null | head -1)
  if [ "$out" = "1" ]; then printf "  OK     %-8s %-16s %s\n" "$tag" "$host" "$db"; ok=$((ok+1))
  else printf "  FALLA  %-8s %-16s %-8s %s\n" "$tag" "$host" "$db" "$(printf '%s' "$out" | tr -d '\n' | sed 's/.*FATAL: *//' | cut -c1-75)"; fail=$((fail+1)); fi
done
echo "  ─────────────────────────"
echo "  OK: $ok · FALLA: $fail"
