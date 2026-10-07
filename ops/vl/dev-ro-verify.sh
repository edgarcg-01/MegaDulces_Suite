#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.10 — LA COMPUERTA. Comprueba que "sólo lectura" sea un hecho, no una intención.
#
#   ./dev-ro-verify.sh <usuario>
#
# Un permiso que no se rompió a propósito una vez es una suposición. Este script
# se conecta COMO LA PERSONA e intenta hacer daño: escribir, borrar, crear,
# elevarse, y llegar a las cajas de las sucursales. Cada intento TIENE QUE
# FALLAR; si alguno pasa, el script sale distinto de cero y dice cuál.
#
# Tres estados, nunca dos (ADR-056): OK · FALLA · NO MEDIDO. Lo que no se pudo
# comprobar se declara — no se pinta de verde por no haber podido mirar.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

CONTENEDOR="${DEV_RO_CONTAINER:-pgvector-md}"
USUARIO="${1:-}"
[ -n "$USUARIO" ] || { echo "uso: $0 <usuario>"; exit 2; }
CRED="$HOME/secrets/dev-ro/$USUARIO.txt"
[ -r "$CRED" ] || { echo "✖ no encuentro la credencial $CRED"; exit 2; }
CLAVE=$(sed -n 's/^clave=//p' "$CRED")
[ -n "$CLAVE" ] || { echo "✖ la credencial no tiene clave"; exit 2; }

ok=0; falla=0; nomedido=0
linea() { printf '  %-9s %-46s %s\n' "[$1]" "$2" "$3"; }

# Se conecta por la red (no por el socket local), igual que lo haría la persona.
# `-h 127.0.0.1` desde adentro del contenedor entra por `trust`, así que NO
# probaría la autenticación real: se usa la IP del host.
corre() {
  db="$1"; sql="$2"
  docker exec -i -e PGPASSWORD="$CLAVE" "$CONTENEDOR" \
    psql -h 192.168.0.222 -p 5433 -U "$USUARIO" -d "$db" -qtA -v ON_ERROR_STOP=1 -c "$sql" 2>&1
}

# ⭐ Igual que `corre`, pero APAGANDO PRIMERO el cinturón `default_transaction_read_only`
# en una transacción aparte. Es la prueba que de verdad importa, porque ese ajuste
# es un GUC de SESIÓN y cualquiera puede apagarlo: si lo único que impidiera
# escribir fuera el cinturón, "sólo lectura" duraría hasta el primer `SET`.
#
# ⚠️ Y ojo con cómo se prueba, que la primera vez me dio un falso verde: con un
# solo `-c "SET ...; DELETE ..."` psql manda TODO en una transacción implícita, y
# el modo lectura de una transacción se fija al abrirla — o sea que el DELETE
# fallaba por "read-only transaction" y parecía que el cinturón aguantaba, sin
# haber probado nada. Hacen falta `-c` SEPARADOS: misma sesión, transacciones
# distintas, y ahí sí el SET ya tuvo efecto.
corre_sin_cinturon() {
  db="$1"; sql="$2"
  docker exec -i -e PGPASSWORD="$CLAVE" "$CONTENEDOR" \
    psql -h 192.168.0.222 -p 5433 -U "$USUARIO" -d "$db" -qtA -v ON_ERROR_STOP=1 \
      -c "SET default_transaction_read_only = off" -c "$sql" 2>&1
}

debe_fallar_sin_cinturon() {
  etiqueta="$1"; db="$2"; sql="$3"
  if salida=$(corre_sin_cinturon "$db" "$sql"); then
    linea "FALLA" "$etiqueta" "⛔ ESCRIBIÓ con el cinturón apagado — el permiso no protege"
    falla=$((falla + 1))
  else
    motivo=$(echo "$salida" | grep -oiE 'permission denied[^"]*' | head -1)
    if [ -n "$motivo" ]; then
      linea "OK" "$etiqueta" "rechazado por PERMISO: $motivo"
      ok=$((ok + 1))
    else
      # Se rechazó, pero NO por permiso → el único que protege es el cinturón.
      linea "FALLA" "$etiqueta" "rechazado, pero NO por permiso: $(echo "$salida" | grep -i error | head -1)"
      falla=$((falla + 1))
    fi
  fi
}

# Debe FALLAR. Si pasa, es un agujero.
debe_fallar() {
  etiqueta="$1"; db="$2"; sql="$3"
  if salida=$(corre "$db" "$sql"); then
    linea "FALLA" "$etiqueta" "⛔ FUNCIONÓ y no debía: ${salida%%$(printf '\n')*}"
    falla=$((falla + 1))
  else
    linea "OK" "$etiqueta" "rechazado: $(echo "$salida" | grep -oiE '(permission denied|read-only|must be owner|denegado|solo lectura|de sólo lectura)[^\"]*' | head -1)"
    ok=$((ok + 1))
  fi
}

debe_pasar() {
  etiqueta="$1"; db="$2"; sql="$3"
  if salida=$(corre "$db" "$sql"); then
    linea "OK" "$etiqueta" "$(echo "$salida" | head -1)"
    ok=$((ok + 1))
  else
    linea "FALLA" "$etiqueta" "no pudo: $(echo "$salida" | head -1)"
    falla=$((falla + 1))
  fi
}

echo "═══ VL.10 — verificación de '$USUARIO' contra 192.168.0.222:5433 ═══"

echo
echo "LO QUE SÍ TIENE QUE PODER"
debe_pasar "leer una réplica"          kepler_md_03       "SELECT count(*) FROM md.kdii"
debe_pasar "leer el estado del CDC"    kepler_md_03       "SELECT count(*) FROM ods.ctl"
debe_pasar "leer el consolidado"       kepler_consolidado "SELECT count(*) FROM mart.ventas"
debe_pasar "leer una vista de mart"    kepler_consolidado "SELECT count(*) FROM mart.ventas_enriched"

echo
echo "LO QUE NO TIENE QUE PODER (si alguna de éstas dice OK del lado equivocado, hay un agujero)"
debe_fallar "escribir en una réplica"   kepler_md_03       "DELETE FROM md.kdii WHERE false"
debe_fallar "tocar el estado del CDC"   kepler_md_03       "UPDATE ods.ctl SET last_run_at = now()"
debe_fallar "crear una tabla"           kepler_md_03       "CREATE TABLE md.zz_prueba_dev_ro (i int)"
debe_fallar "crear un schema"           kepler_md_03       "CREATE SCHEMA zz_prueba_dev_ro"
debe_fallar "escribir en el consolidado" kepler_consolidado "DELETE FROM mart.ventas WHERE false"
debe_fallar "crear un rol"              postgres           "CREATE ROLE zz_prueba_dev_ro"
debe_fallar "leer la caja de una sucursal (foránea)" kepler_consolidado "SELECT count(*) FROM md_03.kdii"
debe_fallar "leer una vista sobre foráneas"          kepler_consolidado "SELECT count(*) FROM dic.productos"

echo
echo "⭐ CON EL CINTURÓN APAGADO (lo que separa un permiso de un ajuste de sesión)"
debe_fallar_sin_cinturon "escribir tras SET read_only=off"  kepler_md_03       "DELETE FROM md.kdii WHERE false"
debe_fallar_sin_cinturon "crear tabla tras SET read_only=off" kepler_md_03     "CREATE TABLE md.zz_prueba_dev_ro (i int)"
debe_fallar_sin_cinturon "escribir el consolidado tras SET"  kepler_consolidado "DELETE FROM mart.ventas WHERE false"

echo
echo "GUARDAS DE SESIÓN"
# ⚠️ Los valores esperados son los NORMALIZADOS por Postgres, no los que se
# escribieron: se configura `statement_timeout = '120s'` y `SHOW` responde
# `2min`. Comparar contra '120s' daba FALLA sobre una configuración correcta —
# una compuerta que grita en falso enseña a ignorarla, igual que una que calla.
for par in "default_transaction_read_only|on" "statement_timeout|2min" "idle_in_transaction_session_timeout|1min" "lock_timeout|5s"; do
  p=${par%%|*}; esperado=${par##*|}
  if v=$(corre kepler_md_03 "SHOW $p"); then
    if [ "$v" = "$esperado" ]; then linea "OK" "$p" "$v"; ok=$((ok + 1))
    else linea "FALLA" "$p" "es '$v', se esperaba '$esperado'"; falla=$((falla + 1)); fi
  else
    linea "NO MEDIDO" "$p" "no se pudo consultar"; nomedido=$((nomedido + 1))
  fi
done

echo
echo "─────────────────────────────────────────────────────────────────────"
echo "  OK $ok · FALLA $falla · NO MEDIDO $nomedido"
if [ "$falla" -gt 0 ]; then
  echo "  ⛔ HAY AGUJEROS: no le pases la credencial a nadie hasta cerrarlos."
  exit 1
fi
if [ "$nomedido" -gt 0 ]; then
  echo "  ⚠️  Pasó lo que se pudo medir, pero quedó algo SIN MEDIR (ver arriba)."
  exit 0
fi
echo "  ✓ '$USUARIO' puede leer lo que debe y no puede nada más."
