#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.9.10] El carril de respaldos de pgBackRest — con latido.
#
#   pgbackrest-run.sh full     # completo (semanal)
#   pgbackrest-run.sh diff     # diferencial (diario)
#
# ── POR QUÉ HAY QUE AGENDARLO ───────────────────────────────────────────────
# pgBackRest expira el WAL atado a los RESPALDOS: mientras exista un solo completo,
# el WAL archivado desde entonces **no se borra nunca**. Medido el 2026-09-22: el
# repositorio pasó de 4 GB a 12 GB en tres horas (el restore generó ~8 GB de WAL) y
# sin un completo nuevo ese crecimiento no tiene tope — en el mismo disco donde
# viven los 9 contenedores de la ingesta.
#
# ── DÓNDE CORRE, Y POR QUÉ ACÁ ──────────────────────────────────────────────
# pgBackRest necesita DOS cosas a la vez: leer `PGDATA` y hablar con Postgres. Y la
# conexión sólo la sabe hacer por SOCKET UNIX local — no acepta un host TCP. Había
# tres formas y se eligió la tercera:
#   · dentro de `pg-prod`: su imagen es la oficial de Postgres, cuyo entrypoint corre
#     postgres como PID 1; meterle un segundo proceso es frágil.
#   · darle a este contenedor el socket de Docker para hacer `docker exec`: eso es
#     **root en el host**, y este contenedor ya tiene la credencial de la base.
#   · ⭐ COMPARTIR LOS DOS RECURSOS: el volumen de datos montado **de sólo lectura**
#     y el directorio del socket compartido con `pg-prod`. Cero privilegio nuevo.
#
# Lo lanza cron como ROOT (para poder leer el archivo de secretos) y baja a `postgres`
# (uid 999, el mismo de `pg-prod`) sólo para el comando de respaldo: así la autenticación
# `peer` del socket funciona y puede leer `PGDATA`.
# ─────────────────────────────────────────────────────────────────────────────
set -u

TIPO="${1:-diff}"
case "$TIPO" in full|diff|incr) ;; *) echo "uso: pgbackrest-run.sh full|diff|incr"; exit 2 ;; esac

TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
JOB=pgbackrest_backup
YO="md-backup"

di() { echo "[$(date '+%F %T %Z')] $*"; }

if [ -r /secrets/ingest.env ]; then
  set -a; . /secrets/ingest.env; set +a
else
  di "FALLO: no se puede leer /secrets/ingest.env"; exit 1
fi
URL="${ODS_HB_URL:-}"
[ -n "$URL" ] || { di "FALLO: ODS_HB_URL vacía"; exit 1; }
case "$URL" in *\?*) SEP='&';; *) SEP='?';; esac
URLK="${URL}${SEP}connect_timeout=15"

# El latido vive en la base de PRODUCCIÓN, igual que el del volcado: es el mismo tablero
# que mira Administración. ⚠️ Por stdin, NO con `-c`: psql no interpola sus variables en un
# `-c` y el latido quedaría mudo (medido el 2026-09-22 en el carril del volcado).
latido() {
  _st="$1"; _nota="$2"; _err="$3"
  psql "$URLK" -q -v t="$TENANT" -v j="$JOB" -v h="$YO" -v s="$_st" -v n="$_nota" -v e="$_err" -f - >/dev/null 2>&1 <<'SQL'
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, error, host, updated_at)
VALUES (:'t', :'j', 'Respaldo pgBackRest (completo/diferencial)', now(), now(), :'s', NULLIF(:'n',''), NULLIF(:'e',''), :'h', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET label = EXCLUDED.label, last_finish = now(), status = EXCLUDED.status,
      note = EXCLUDED.note, error = EXCLUDED.error, host = EXCLUDED.host, updated_at = now();
SQL
}

# ⭐ ROOT LEE EL SECRETO, `postgres` HACE EL RESPALDO. Los dos usuarios son necesarios y
# ninguno alcanza solo:
#   · `/secrets/ingest.env` es de `superoot` en el host y llega con sus permisos: uid 999
#     NO puede leerlo (medido — el primer intento murió acá).
#   · pgBackRest SE NIEGA a correr como root, y además necesita leer PGDATA, que es de 999.
# Por eso el guion corre como root (así lo lanza cron), carga el entorno, y baja a `postgres`
# sólo para el comando de respaldo.
di "── pgbackrest --type=$TIPO ──"

# ⚠️ ¿EL LATIDO CAE EN LA BASE QUE MIRA EL TABLERO? pgBackRest siempre respalda el
# clúster LOCAL (socket + PGDATA montado), así que el respaldo no puede equivocarse
# de base. El latido SÍ: viaja por `ODS_HB_URL`, que es un archivo montado y puede
# quedar desfasado. Pasó el 2026-09-23 — este carril corrió bien seis noches y su
# latido aterrizaba en la base VIEJA de Railway, así que en el tablero de `md` el
# renglón `pgbackrest_backup` NO EXISTÍA: el respaldo que da PITR se veía como si
# nunca hubiera corrido. (Causa: bind de archivo resuelto por inodo; ver la
# compuerta 1-bis de `backup-prod.sh`.) Se compara la IDENTIDAD del clúster, no su
# forma: las dos bases son la misma restaurada y por forma son indistinguibles.
id_loc=$(su -s /bin/sh postgres -c \
  'psql -h /var/run/postgresql -U postgres -d postgres -At -qc "select system_identifier from pg_control_system()"' 2>/dev/null)
id_hb=$(psql "$URLK" -At -qc "select system_identifier from pg_control_system()" 2>/dev/null)
if [ -n "$id_loc" ] && [ -n "$id_hb" ] && [ "$id_loc" != "$id_hb" ]; then
  di "⚠ AVISO: el latido va a OTRO clúster ($id_hb) distinto del que se respalda ($id_loc) — el tablero de prod NO va a ver este carril. Recrear el contenedor para que relea /secrets/ingest.env."
fi

t0=$(date +%s)
salida=$(su -s /bin/sh postgres -c "pgbackrest --stanza=prod --type=$TIPO backup" 2>&1)
rc=$?
dt=$(( $(date +%s) - t0 ))
echo "$salida" | tail -4

if [ "$rc" != 0 ]; then
  di "FALLO: pgbackrest salió con $rc tras ${dt}s"
  latido error "" "$(echo "$salida" | grep -iE 'ERROR' | head -1 | cut -c1-300)"
  exit 1
fi

# El latido reporta ENTREGA, no "el comando corrió": cuántos respaldos hay y cuánto pesa el
# repositorio. Si mañana el repositorio se dispara o el conteo no sube, se ve sin abrir un log.
n_resp=$(su -s /bin/sh postgres -c "pgbackrest --stanza=prod info" 2>/dev/null | grep -cE '^ +(full|diff|incr) backup:')
repo=$(du -sh /var/lib/pgbackrest 2>/dev/null | cut -f1)
di "OK en ${dt}s · $n_resp respaldos en el repositorio · $repo"
latido ok "$TIPO en ${dt}s · $n_resp respaldos · repositorio $repo" ""
exit 0
