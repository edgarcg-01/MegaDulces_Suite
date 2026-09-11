#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# VL.2b — ¿el servidor nuevo puede SUSCRIBIRSE a los 8 publicadores Kepler?
#
# ⚠️ ESTO NO LO PRUEBA `vl0-verify.sh`. Ese usa `pg_isready`, que sólo confirma que
# el postmaster responde en el puerto — NO autentica y NO consulta `pg_hba.conf`.
# El 2026-09-10, con la compuerta de VL.0 en 13 OK / 0 FALLA, este probe encontró
# que **5 de las 8 sucursales rechazan a `md`**:
#
#   FATAL: no hay una línea en pg_hba.conf para «192.168.0.222»,
#          usuario «ods_repl», base de datos «md_00», sin cifrado
#
# Habría explotado DENTRO de la ventana de mantenimiento, con las réplicas ya
# movidas y sin poder retomar de los slots.
#
# Uso (los conninfo salen de `pg_subscription`, que sólo lee un superusuario):
#   docker exec pgvector-md psql -U postgres -tAc #     "select subname||'|'||subconninfo from pg_subscription order by subname;" #     | ssh superoot@192.168.0.222 'bash /tmp/vl2-probe-publishers.sh'
#
# ⚠️ El script se copia al servidor y los conninfo se pasan por STDIN a propósito:
# llevan la contraseña de `ods_repl` y no deben aparecer en la línea de comandos
# (de ahí los verían `ps` y el historial).
#
# ⛔ NO invocar como `ssh ... 'bash -s' <<< datos`: `bash -s` lee el SCRIPT de stdin
# y el `while read` de abajo se come el propio script. Ya pasó.
#
# IDENTIFY_SYSTEM es el handshake exacto del suscriptor y no toca ningún slot.
# ─────────────────────────────────────────────────────────────────────────────
ok=0; fail=0
while IFS='|' read -r sub conn; do
  [ -z "$sub" ] && continue
  host=$(printf '%s' "$conn" | grep -oE 'host=[^ ]+' | cut -d= -f2)
  db=$(printf '%s' "$conn" | grep -oE 'dbname=[^ ]+' | cut -d= -f2)
  out=$(psql "$conn replication=database connect_timeout=8" -tAc "IDENTIFY_SYSTEM" 2>&1 </dev/null | head -1)
  if printf '%s' "$out" | grep -qE '^[0-9]{15,25}\|'; then
    printf "  OK     %-12s %-16s %-8s sysid %s\n" "$sub" "$host" "$db" "$(printf '%s' "$out" | cut -d'|' -f1)"
    ok=$((ok+1))
  else
    printf "  FALLA  %-12s %-16s %-8s %s\n" "$sub" "$host" "$db" "$(printf '%s' "$out" | tr -d '\n' | cut -c1-95)"
    fail=$((fail+1))
  fi
done
echo "  ──────────────────────────────────────"
echo "  OK: $ok · FALLA: $fail"
[ "$fail" -gt 0 ] && echo "  ⛔ Alguna sucursal NO acepta a md: hay que tocar su pg_hba.conf ANTES del corte." || echo "  ✅ md puede suscribirse a las 8. El pg_hba no está atado a la IP de .249."
