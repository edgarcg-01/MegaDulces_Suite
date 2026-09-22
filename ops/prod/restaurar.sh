#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.9.5] RESTAURAR la copia de prod en `md` desde el volcado del día.
#
#   ops/prod/restaurar.sh                    # el volcado más nuevo de /home/superoot/backups
#   ops/prod/restaurar.sh <ruta.dump>        # uno en particular
#   ops/prod/restaurar.sh --revisar          # sólo las compuertas, no toca la base
#
# ⛔ DESTRUYE la base `railway` de `pg-prod` y la reconstruye. Es una COPIA — pero es la
#    copia contra la que se está verificando la app, así que no se corre por accidente:
#    exige un volcado que pase las tres compuertas de abajo.
#
# ── POR QUÉ EXISTE ──────────────────────────────────────────────────────────
# Medido el 2026-09-22: «restaurar un volcado viejo y migrar hacia adelante» **no reproduce
# prod**. Falló tres veces, y dos de esas fallas son estructurales — hay migraciones que
# dependen de datos editados a mano desde la UI (`20260915130000` aborta con *"No existe la
# persona aaron_alejo"*, que en realidad se llama `aaronalejo`). El estado de prod es
# *esquema + datos editados a mano*, y sólo la primera mitad vive en el repo.
# ⇒ La copia fiel sale de un volcado FRESCO. Este guion es el que lo aplica, y de paso es el
#   ensayo del corte: el mismo camino, la misma máquina, los mismos pasos.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DEST_DIR="${BACKUP_DIR:-/home/superoot/backups}"
PGH=127.0.0.1
PGP=5434
PGU=postgres
DB=railway
HILOS="${JOBS:-4}"
# Los pisos son variables para poder ROMPERLOS a propósito y ver el rojo. Una compuerta con
# el umbral incrustado no se puede probar, y una compuerta sin prueba negativa es una intención.
PISO_TABLAS="${MIN_TABLES:-400}"
PISO_ACL="${MIN_ACL:-100}"
MAX_EDAD_H="${MAX_EDAD_H:-30}"

REVISAR=0
ARCHIVO=""
for a in "$@"; do
  case "$a" in
    --revisar) REVISAR=1 ;;
    -*) echo "opción desconocida: $a"; exit 2 ;;
    *) ARCHIVO="$a" ;;
  esac
done

di() { echo "[$(date '+%F %T %Z')] $*"; }
morir() { di "FALLO: $*"; exit 1; }

[ -n "${PGPASSWORD:-}" ] || {
  # La contraseña del superusuario de `pg-prod` vive en el env del compose, no en el repo.
  if [ -r /home/superoot/secrets/prod-compose.env ]; then
    # shellcheck disable=SC1091
    PGPASSWORD=$(grep -m1 '^PGPROD_SUPERPASS=' /home/superoot/secrets/prod-compose.env | cut -d= -f2-)
    export PGPASSWORD
  fi
}
[ -n "${PGPASSWORD:-}" ] || morir "sin PGPASSWORD (ni PGPROD_SUPERPASS en prod-compose.env)"

# ── Elegir el volcado ────────────────────────────────────────────────────────
if [ -z "$ARCHIVO" ]; then
  ARCHIVO=$(ls -1t "$DEST_DIR"/trade_marketing_*.dump 2>/dev/null | head -1)
  [ -n "$ARCHIVO" ] || morir "no hay ningún volcado en $DEST_DIR"
fi
[ -r "$ARCHIVO" ] || morir "no puedo leer $ARCHIVO"
edad_h=$(( ( $(date +%s) - $(stat -c %Y "$ARCHIVO") ) / 3600 ))
mb=$(( $(stat -c %s "$ARCHIVO") / 1048576 ))
di "volcado: $ARCHIVO — ${mb} MB, ${edad_h} h de antigüedad"

# ── Compuerta 1: abre y trae datos ───────────────────────────────────────────
toc=$(pg_restore --list "$ARCHIVO" 2>/dev/null)
[ -n "$toc" ] || morir "pg_restore --list no devolvió nada: el volcado no abre"
tablas=$(echo "$toc" | grep -c 'TABLE DATA' || true)
di "TOC: $tablas tablas con datos"
[ "$tablas" -ge "$PISO_TABLAS" ] || morir "sólo $tablas tablas con datos (piso $PISO_TABLAS): esto no es prod"

# ── Compuerta 2: ⭐ ¿trae los GRANT? ─────────────────────────────────────────
# El respaldo de PowerShell usaba `--no-privileges`, y por eso la copia de hoy quedó con la
# app devolviendo 500 (`aclcheck_error`) hasta que se extrajeron 1,304 GRANT a mano de otro
# volcado. Restaurar otra vez sin permisos repetiría exactamente ese día.
acl=$(echo "$toc" | grep -c 'ACL ' || true)
di "entradas ACL (permisos) en el volcado: $acl"
if [ "$acl" -lt "$PISO_ACL" ]; then
  morir "el volcado trae $acl entradas ACL: se tomó con --no-privileges. La app va a arrancar y devolver 500 por permisos, en runtime y no en el restore. Usá uno de los que toma prod-backup, que ya los incluye."
fi

# ── Compuerta 3: frescura ────────────────────────────────────────────────────
# «restore viejo + migrate» ya se descartó por medición. Un volcado de hace días vuelve a
# meter la copia en ese camino sin que nadie lo note.
if [ "$edad_h" -gt "$MAX_EDAD_H" ]; then
  di "⚠️  el volcado tiene ${edad_h} h. Un volcado viejo NO se arregla migrando hacia adelante"
  di "    (medido: hay migraciones que dependen de datos editados a mano desde la UI)."
  [ "${FORZAR_VIEJO:-0}" = 1 ] || morir "abortado. Si de verdad querés ese volcado: FORZAR_VIEJO=1"
fi

if [ "$REVISAR" = 1 ]; then
  di "--revisar: las tres compuertas pasaron. No se tocó la base."
  exit 0
fi

# ── Bajar lo que escribe ─────────────────────────────────────────────────────
# ⛔ No se puede borrar una base con sesiones abiertas, y `api`/`worker` reconectan solos:
# pararlos es parte del procedimiento, no higiene.
di "parando api, worker, portal y vendor"
docker stop prod-api prod-worker prod-portal prod-vendor >/dev/null 2>&1

psql -h $PGH -p $PGP -U $PGU -d postgres -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid()" >/dev/null 2>&1

di "recreando la base $DB"
psql -h $PGH -p $PGP -U $PGU -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB" \
  -c "CREATE DATABASE $DB" || morir "no se pudo recrear la base"

# ⭐ EL PLANIFICADOR, ANTES DEL RESTORE. Medido el 2026-09-22: `pg_restore` reconstruye las
# vistas materializadas del sell-out con un `REFRESH`, y con el planificador por defecto
# tardan **más de 70 minutos** — estima 7 filas donde hay 24,397, elige nested loop y hace un
# index scan por cada una de 178k filas. Con `enable_nestloop=off` bajan a **9.7 s y 29.6 s**.
# Se pone en la BASE porque `pg_restore` abre sus propias sesiones y no acepta un `SET` suelto.
# ⚠️ Se REVIERTE al final: dejarlo puesto degradaría las consultas normales de la app.
di "enable_nestloop=off durante el restore (las matvistas pasan de >70 min a <1 min)"
psql -h $PGH -p $PGP -U $PGU -d postgres -q -c "ALTER DATABASE $DB SET enable_nestloop = off" || true

di "restaurando con $HILOS hilos — esto tarda ~70 min"
# ⛔ `--jobs` NO puede leer de la entrada estándar (necesita saltar por el archivo), así que el
# volcado se pasa por RUTA. El `< archivo.dump` que uno escribe por reflejo fuerza un solo hilo.
# `--no-owner` sí: el destino crea todo como `postgres`. Los PERMISOS se conservan (compuerta 2).
t0=$(date +%s)
pg_restore -h $PGH -p $PGP -U $PGU -d $DB --no-owner --jobs="$HILOS" "$ARCHIVO" 2>/tmp/restore.err
rc=$?
dt=$(( ($(date +%s) - t0) / 60 ))
di "pg_restore terminó con código $rc tras ${dt} min"
# ⚠️ Un `rc` distinto de 0 NO es necesariamente fatal: `pg_restore` cuenta como error cosas
# benignas (extensiones que ya existen, comentarios sobre objetos del sistema). Lo que decide
# es la verificación de abajo, no el código de salida.
if [ "$rc" != 0 ]; then
  di "hubo errores; los 5 primeros:"
  head -5 /tmp/restore.err | sed 's/^/     /'
fi

di "revirtiendo enable_nestloop"
psql -h $PGH -p $PGP -U $PGU -d postgres -q -c "ALTER DATABASE $DB RESET enable_nestloop" || true

# ── Verificación: datos, no rótulos ──────────────────────────────────────────
di "── verificación ──"
psql -h $PGH -p $PGP -U $PGU -d $DB -q -c "
  SELECT n.nspname AS schema, count(*) AS tablas
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
   GROUP BY 1 ORDER BY 2 DESC LIMIT 12"
psql -h $PGH -p $PGP -U $PGU -d $DB -At -c "
  SELECT 'matvistas: '||count(*) FILTER (WHERE ispopulated)||' pobladas de '||count(*)
    FROM pg_matviews
  UNION ALL
  SELECT 'permisos de app_runtime: '||count(*)
    FROM information_schema.role_table_grants WHERE grantee='app_runtime'
  UNION ALL
  SELECT 'políticas RLS: '||count(*) FROM pg_policy
  UNION ALL
  SELECT 'migraciones aplicadas: '||count(*) FROM public.knex_migrations"

di "levantando la app"
docker start prod-api prod-worker prod-portal prod-vendor >/dev/null 2>&1

di "⚠️ El veredicto NO es que los contenedores arranquen. Pedile DATOS:"
di "     curl -s localhost:8080/api/health"
di "     curl -s localhost:8080/api/sucursales | head -c 200"
exit 0
