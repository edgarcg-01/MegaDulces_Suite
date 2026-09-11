#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.10 — abre el cluster de réplicas de `md` a DESARROLLO, en sólo lectura.
#
#   ./dev-ro-setup.sh --permisos                 # (re)aplica los grants en las 9 bases
#   ./dev-ro-setup.sh --alta edgar               # crea/rota a una persona
#   ./dev-ro-setup.sh --baja edgar               # la saca
#   ./dev-ro-setup.sh --lista                    # quién tiene acceso hoy
#
# Se corre EN `md`, como el usuario que puede hacer `docker exec` (superoot).
#
# ⛔ LAS CONTRASEÑAS NO SE IMPRIMEN NUNCA. Se generan acá, se guardan en
# ~/secrets/dev-ro/<usuario>.txt con permisos 600, y el alta sólo dice dónde
# quedó el archivo. Tampoco se pasan por línea de comandos: irían al `ps` de
# cualquiera que esté en la máquina en ese segundo. Se escriben a un archivo
# temporal con 600 que se borra al salir.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

CONTENEDOR="${DEV_RO_CONTAINER:-pgvector-md}"
DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETOS="$HOME/secrets/dev-ro"

# Las bases que se exponen. `postgres` queda fuera a propósito: es la base de
# mantenimiento del cluster, no tiene dato de negocio.
BASES="kepler_md_00 kepler_md_01 kepler_md_02 kepler_md_03 kepler_md_04 kepler_md_05 kepler_md_06 kepler_md_07 kepler_consolidado"

psqlq() { docker exec -i "$CONTENEDOR" psql -U postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
psqld() { docker exec -i "$CONTENEDOR" psql -U postgres -v ON_ERROR_STOP=1 -P pager=off "$@"; }

permisos() {
  echo "── Aplicando permisos de lectura (dev_ro) ──"
  for db in $BASES; do
    printf '  %-20s ' "$db"
    # El script viaja por stdin: así no hace falta copiarlo adentro del contenedor.
    if out=$(psqld -d "$db" -f - < "$DIR/sql/dev-ro-grants.sql" 2>&1); then
      echo "$out" | grep -o 'NOTICE:.*' | head -1 | sed 's/NOTICE:  //' || echo "ok"
    else
      echo "✖ FALLA"; echo "$out" | tail -5; exit 1
    fi
  done
}

alta() {
  usuario="$1"
  case "$usuario" in
    *[!a-z0-9_]*|'') echo "✖ nombre inválido '$usuario' (sólo a-z, 0-9, _)"; exit 2 ;;
  esac
  mkdir -p "$SECRETOS"; chmod 700 "$SECRETOS"

  # 24 bytes de aleatoriedad real. Se filtran los caracteres que complican las
  # cadenas de conexión (`/`, `+`, `=`, `:`, `@`) para que nadie tenga que
  # url-encodear nada y termine con una credencial mal pegada.
  clave=$(openssl rand -base64 36 | tr -d '/+=:@\n' | cut -c1-28)
  [ ${#clave} -ge 20 ] || { echo "✖ no se pudo generar contraseña"; exit 1; }

  tmp=$(mktemp); chmod 600 "$tmp"
  trap 'rm -f "$tmp"' EXIT INT TERM
  {
    printf "\\\\set usuario %s\n" "$usuario"
    printf "\\\\set clave '%s'\n" "$clave"
    cat "$DIR/sql/dev-ro-persona.sql"
  } > "$tmp"

  psqld -d postgres -f - < "$tmp" > /dev/null
  rm -f "$tmp"; trap - EXIT INT TERM

  umask 077
  cat > "$SECRETOS/$usuario.txt" <<CRED
# VL.10 — lectura de desarrollo sobre las réplicas Kepler de md.
# Sólo lectura: la sesión arranca con default_transaction_read_only=on.
host=192.168.0.222
port=5433
usuario=$usuario
clave=$clave

# Ejemplo (una base por sucursal; 03 = 8 Esquinas):
# postgresql://$usuario:$clave@192.168.0.222:5433/kepler_md_03
CRED
  chmod 600 "$SECRETOS/$usuario.txt"

  echo "✓ alta de '$usuario' hecha."
  echo "  credencial en: $SECRETOS/$usuario.txt  (600 — NO la pegues en un chat)"
  echo "  verificá con:  $DIR/dev-ro-verify.sh $usuario"
}

baja() {
  usuario="$1"
  # `DROP ROLE` falla si el rol es dueño de algo o tiene permisos en alguna base.
  # Como este rol es sólo de lectura no debería tener nada, pero se limpian los
  # permisos base por base igual: si en el futuro alguien le otorga algo a mano,
  # la baja sigue funcionando en vez de fallar con un mensaje críptico.
  for db in $BASES; do
    psqlq -d "$db" -c "DROP OWNED BY $usuario" >/dev/null 2>&1 || true
  done
  psqlq -d postgres -c "DROP ROLE IF EXISTS $usuario"
  rm -f "$SECRETOS/$usuario.txt"
  echo "✓ '$usuario' dado de baja (rol borrado y credencial eliminada)."
}

lista() {
  echo "── Personas con lectura de desarrollo (miembros de dev_ro) ──"
  psqld -d postgres -c "
    SELECT m.rolname                                   AS usuario,
           m.rolconnlimit                              AS conexiones,
           COALESCE(array_to_string(m.rolconfig, ' · '), '⚠️ SIN GUARDAS') AS guardas
      FROM pg_roles m
      JOIN pg_auth_members am ON am.member = m.oid
      JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = 'dev_ro'
     ORDER BY 1;"
  echo "── Sesiones abiertas ahora ──"
  psqld -d postgres -c "
    SELECT usename, datname, client_addr, state,
           to_char(now() - query_start, 'HH24:MI:SS') AS corriendo
      FROM pg_stat_activity
     WHERE usename IN (SELECT m.rolname FROM pg_roles m
                        JOIN pg_auth_members am ON am.member = m.oid
                        JOIN pg_roles g ON g.oid = am.roleid AND g.rolname = 'dev_ro')
     ORDER BY query_start;"
}

case "${1:-}" in
  --permisos) permisos ;;
  --alta)     [ $# -ge 2 ] || { echo "uso: $0 --alta <usuario>"; exit 2; }; alta "$2" ;;
  --baja)     [ $# -ge 2 ] || { echo "uso: $0 --baja <usuario>"; exit 2; }; baja "$2" ;;
  --lista)    lista ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
