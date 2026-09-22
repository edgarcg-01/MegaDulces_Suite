#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.6.4] RESPALDO DIARIO DE PRODUCCIÓN — corre en `md`, no en una laptop.
#
#   backup-prod.sh              # el respaldo de verdad
#   backup-prod.sh --prueba     # ejercita TODAS las compuertas en ~2 min, sin
#                               # volcar datos y sin tocar el latido backup_prod
#
# Reemplaza a `scripts/backup-db.ps1` + la tarea `TradeMarketing-DailyBackup` del
# Programador de Windows. La agenda está en `ops/prod/crontab.backup`.
#
# ── POR QUÉ SE MUDÓ, MEDIDO EL 2026-09-22 ───────────────────────────────────
# No fue "Linux es mejor". Se midió el cable con el MISMO comando desde las dos
# máquinas —100 MB generados en prod hacia /dev/null— y dan casi igual: 218 MB/min
# desde `SISTEMAS`, 260 MB/min desde `md`. El enlace no era el problema. Lo que
# decide son otras cuatro cosas:
#
#   · La tarea de Windows es `Interactive`: no corre si nadie inició sesión. Ya
#     está medido que eso pasa (2026-09-11: `WincajaSyncActual` no corrió tras un
#     reinicio nocturno y dejó su pierna del sell-out 3 días atrás). `md` arranca
#     sus contenedores sin sesión — verificado con un reinicio real.
#   · El cliente. `md` trae pg_dump 18.6, la MISMA minor que el servidor; la
#     laptop trae 18.4. Funciona, pero "funciona" no es "es el mismo".
#   · Toda una clase de fallo desaparece. El respaldo estuvo 12 días sin producir
#     un archivo por un ParserError de PowerShell: los dos puntos pegados al
#     nombre hacen que se lea la variable como calificada por unidad, y un
#     ParserError no falla esa línea — impide que el archivo COMPILE. El script
#     no ejecutaba ni su primera instrucción.
#   · Es el ensayo del corte. El restore del corte ocurre en `md`; tomar acá el
#     volcado cada noche es ensayar ese camino todas las noches en vez de
#     estrenarlo el día que importa.
#
# ── EL NÚMERO QUE CORRIGE AL PLAN ───────────────────────────────────────────
# El plan de VL.9 proyectaba 6.1 h de volcado a partir de 6.22 MB/min. Está mal:
# esa tasa se midió DURANTE el cuelgue del socket muerto, o sea midiendo un
# proceso que no transfería. Los cuatro respaldos reales que existen dicen otra
# cosa (nombre del archivo = hora de inicio, mtime = fin):
#     08-sep 13:23 → 14:31   2003 MB    68 min
#     08-sep 17:00 → 18:09   2005 MB    69 min
#     09-sep 17:00 → 18:29   2161 MB    89 min
#     10-sep 17:00 → 18:14   2171 MB    74 min
# ⇒ ~30 MB/min comprimidos, ~75 min. Los de 236 MB del 1 al 6 de septiembre NO
#   cuentan: son de la base equivocada, el bug que el propio script de PowerShell
#   dice haber cerrado el 08-sep. ⇒ Un corte por volcado+restore es ~75 min +
#   ~73 min ≈ 2.5 h. Sigue sin caber en día hábil, pero deja de EXIGIR
#   `wal_level=logical` como única salida.
#
# ⚠️ El catálogo cuesta 121 s ANTES del primer byte de datos: 1,251 tablas/vistas,
#    2,527 índices, 27,290 columnas, y 149 ms de ida y vuelta a Railway. Una sonda
#    de 90 s da 0 bytes y parece un cuelgue. No lo es.
# ─────────────────────────────────────────────────────────────────────────────
set -u

PRUEBA=0
[ "${1:-}" = "--prueba" ] && PRUEBA=1

DEST="${BACKUP_DIR:-/backups}"
RETENER_DIAS="${RETAIN_DAYS:-30}"
DIARIOS_DIAS="${KEEP_DAILY_DAYS:-7}"
PISO_TABLAS="${MIN_TABLES:-400}"
PISO_ODS="${MIN_ODS_TABLES:-200}"
PISO_GB="${MIN_FREE_GB:-15}"
TENANT="${CRON_TENANT_ID:-00000000-0000-0000-0000-00000000d01c}"
JOB="backup_prod"
# En modo prueba el latido SÍ se escribe, sobre su propia llave. Antes se salteaba "para no
# pisar el renglón real" — y el efecto era que la prueba quedaba ciega al único camino que
# nunca se había corrido: el 2026-09-22 el primer volcado REAL descubrió que el latido no se
# escribía (psql no interpola con `-c`), algo que `--prueba` no podía ver por diseño.
# La llave aparte da aislamiento; saltear el código da una prueba que no prueba. La fila se
# borra al terminar, así que no queda basura en el tablero.
[ "$PRUEBA" = 1 ] && JOB="backup_prod_prueba"
YO="md-backup"

di() { echo "[$(date '+%F %T %Z')] $*"; }
morir() { di "FALLO: $*"; latido_fin error "$*"; exit 1; }

# ── El puntero a prod ────────────────────────────────────────────────────────
# Se reusa `ODS_HB_URL` de `~/secrets/ingest.env`, que ya es el puntero a prod en
# esta máquina. NO se crea un archivo de secretos nuevo a propósito: duplicar una
# credencial es multiplicar lo que hay que rotar el día que se filtre, y en este
# proyecto ya hay una filtrada sin rotar.
if [ -r /secrets/ingest.env ]; then
  set -a; . /secrets/ingest.env; set +a
else
  di "FALLO: no se puede leer /secrets/ingest.env"; exit 1
fi
URL="${ODS_HB_URL:-}"
[ -n "$URL" ] || { di "FALLO: ODS_HB_URL vacía"; exit 1; }

# Keepalives. Sin esto un corte del otro lado CUELGA el volcado para siempre:
# medido el 2026-09-22, el proxy de Railway cerró la conexión a mitad y pg_dump
# esperó 93 minutos sobre un socket muerto, con CERO CPU, sin error y sin salir.
# libpq no reintenta ni vence solo; hay que pedirle al SO que sondee el socket.
case "$URL" in *\?*) SEP='&';; *) SEP='?';; esac
case "$URL" in
  *keepalives=*) URLK="$URL" ;;
  *) URLK="${URL}${SEP}keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=3&connect_timeout=15" ;;
esac

q() { psql "$URLK" -At -q -c "$1" 2>/dev/null; }

# ── Latido ───────────────────────────────────────────────────────────────────
# Mismo contrato que `database/importers/lib/cron-heartbeat.js`: mismas columnas,
# mismo ON CONFLICT, misma tabla — el trigger `trg_cron_run_log` archiva la
# corrida solo. Va en SQL plano y no en node porque este contenedor no tiene el
# repo; lo que no puede cambiar es la FORMA, o el tablero lee dos dialectos.
# Nunca aborta el respaldo: un latido que rompe lo que vigila es peor que no tenerlo.
# ⚠️ EL SQL VA POR ENTRADA ESTÁNDAR (`-f -`), NO POR `-c`. psql **no interpola sus
# variables** (`:'t'`) en un `-c`: lo manda tal cual al servidor, que responde
# `syntax error at or near ":"`. Medido el 2026-09-22 — el primer volcado real avisó
# «el latido de inicio no se pudo escribir» y el respaldo quedó MUDO en el tablero,
# que es justo lo que este latido existe para evitar. Con `-f -` sí interpola, y las
# variables `-v` siguen citando bien el texto (que trae acentos y `·`).
latido_ini() {
  psql "$URLK" -q -v t="$TENANT" -v j="$JOB" -v h="$YO" -f - <<'SQL' >/dev/null 2>&1 \
    || di "aviso: el latido de inicio no se pudo escribir"
INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, status, host, updated_at)
VALUES (:'t', :'j', 'Respaldo diario de prod (pg_dump, desde md)', now(), 'running', :'h', now())
ON CONFLICT (tenant_id, job_key) DO UPDATE
  SET label = EXCLUDED.label, last_start = now(), status = 'running',
      host = EXCLUDED.host, updated_at = now();
SQL
}
latido_fin() {
  _st="$1"; _detalle="$2"
  if [ "$_st" = ok ]; then _nota="$_detalle"; _err=''; else _nota=''; _err="$_detalle"; fi
  psql "$URLK" -q -v t="$TENANT" -v j="$JOB" -v s="$_st" -v n="$_nota" -v e="$_err" -f - <<'SQL' >/dev/null 2>&1 \
    || di "aviso: el latido de fin no se pudo escribir"
UPDATE analytics.cron_runs
   SET last_finish = now(), status = :'s',
       note  = NULLIF(:'n',''), error = NULLIF(:'e',''),
       duration_ms = CASE WHEN last_start IS NOT NULL
                          THEN (EXTRACT(EPOCH FROM (now() - last_start))*1000)::bigint END,
       updated_at = now()
 WHERE tenant_id = :'t' AND job_key = :'j';
SQL
}

if [ "$PRUEBA" = 1 ]; then di "── respaldo de prod desde md (MODO PRUEBA) ──"; else di "── respaldo de prod desde md ──"; fi
latido_ini

# ── Compuerta 1: ¿esto ES prod? ──────────────────────────────────────────────
# Se clasifica por CONTENIDO, no por el nombre del host. Dos razones medidas:
#   · El bug del 08-sep fue respaldar la base de desarrollo durante cinco días con
#     la tarea EN VERDE. Lo que lo delataba no era el host — era que traía 1 tabla
#     de `kepler_ods` donde prod tiene 226, y 236 MB donde el heap son 15.9 GB.
#   · Una regla por host ("no puede ser la LAN") se rompe sola EL DÍA DEL CORTE,
#     cuando prod pase a ser `pg-prod` en esta misma máquina. Una regla por
#     contenido sobrevive al corte, que es justo cuando más falta hace.
ods=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='kepler_ods' and c.relkind in ('r','p')")
tot=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and c.relkind in ('r','p')")
[ -n "$ods" ] || morir "no se pudo consultar el destino (credencial o red)"
di "destino: $ods tablas en kepler_ods, $tot en total."
if [ "$ods" -lt "$PISO_ODS" ]; then
  morir "el destino trae $ods tablas de kepler_ods y el piso es $PISO_ODS: NO parece prod. Un respaldo de la base equivocada es peor que no tener respaldo, porque la tarea queda en verde."
fi

# ── Compuerta 2: espacio ─────────────────────────────────────────────────────
mkdir -p "$DEST"
libres=$(df -BG "$DEST" | awk 'NR==2{gsub("G","",$4); print $4}')
di "espacio libre en $DEST: ${libres} GB."
[ "$libres" -ge "$PISO_GB" ] || morir "hacen falta $PISO_GB GB y hay $libres. Un pg_dump sin disco deja un archivo truncado que pg_restore --list igual abre."

sello=$(date '+%Y-%m-%d_%H%M')
archivo="$DEST/trade_marketing_${sello}.dump"
errlog="$DEST/trade_marketing_${sello}.log"

# ── El volcado ───────────────────────────────────────────────────────────────
# SIN `--no-privileges`, a diferencia del script de PowerShell. Medido hoy: el
# restore de un dump sin privilegios dejó la app devolviendo 500 (`aclcheck_error`)
# y hubo que extraer 1,304 GRANT a mano de un dump aparte. Prod tiene 325 políticas
# RLS que nombran `app_runtime`; los permisos no son adorno del respaldo, son parte
# de lo que hay que restaurar. `--no-owner` SÍ se conserva: el destino crea todo
# como `postgres` y el dueño es ruido.
if [ "$PRUEBA" = 1 ]; then
  di "MODO PRUEBA: --schema-only (ejercita catálogo, keepalives, TOC y compuertas; no transfiere datos)"
  modo="--schema-only"
else
  modo=""
fi
di "volcando hacia $archivo"
t0=$(date +%s)
# shellcheck disable=SC2086
pg_dump --dbname="$URLK" --format=custom --compress=6 --no-owner --verbose $modo --file="$archivo" 2>"$errlog"
rc=$?
dt=$(( $(date +%s) - t0 ))
if [ "$rc" != 0 ]; then
  rm -f "$archivo"
  morir "pg_dump salió con $rc tras ${dt}s — $(tail -1 "$errlog" 2>/dev/null)"
fi
mb=$(( $(stat -c %s "$archivo") / 1048576 ))
di "volcado OK: ${mb} MB en ${dt}s ($(awk -v m=$mb -v s=$dt 'BEGIN{printf "%.1f", m/(s/60)}') MB/min)."

# ── Compuerta 3: abre, y se PARECE a prod ────────────────────────────────────
# "Abre bien" no es "trajo lo que hay": el volcado del 6-sep abría perfecto y le
# faltaban 225 tablas de kepler_ods.
toc=$(pg_restore --list "$archivo" 2>/dev/null)
[ -n "$toc" ] || { rm -f "$archivo"; morir "pg_restore --list no devolvió contenido: volcado posiblemente corrupto"; }
tablas=0; ods_d=0
if [ "$PRUEBA" = 1 ]; then
  n=$(echo "$toc" | grep -c 'TABLE ' || true)
  di "TOC legible: $n entradas TABLE. (En modo prueba NO hay TABLE DATA: es --schema-only.)"
else
  tablas=$(echo "$toc" | grep -c 'TABLE DATA' || true)
  ods_d=$(echo "$toc" | grep -c 'TABLE DATA kepler_ods ' || true)
  di "contenido: $tablas tablas con datos ($ods_d de kepler_ods)."
  if [ "$tablas" -lt "$PISO_TABLAS" ]; then
    rm -f "$archivo"
    morir "el volcado trae $tablas tablas y el piso es $PISO_TABLAS: no se conserva un respaldo que no pueda afirmar que está completo"
  fi
fi

# ── Retención GFS ────────────────────────────────────────────────────────────
# Todo lo de los últimos $DIARIOS_DIAS días se queda; entre eso y $RETENER_DIAS,
# sólo el del DOMINGO; más viejo, se borra. Con ~2.2 GB por volcado, "30 días de
# diarios" serían ~66 GB.
borrados=0
ahora=$(date +%s)
for f in "$DEST"/trade_marketing_*.dump "$DEST"/trade_marketing_*.log; do
  [ -e "$f" ] || continue
  m=$(stat -c %Y "$f")
  edad=$(( (ahora - m) / 86400 ))
  dow=$(date -d "@$m" +%u)   # 7 = domingo
  if [ "$edad" -gt "$RETENER_DIAS" ]; then
    rm -f "$f"; borrados=$((borrados+1))
  elif [ "$edad" -gt "$DIARIOS_DIAS" ] && [ "$dow" != 7 ]; then
    rm -f "$f"; borrados=$((borrados+1))
  fi
done
quedan=$(ls -1 "$DEST"/trade_marketing_*.dump 2>/dev/null | wc -l)
ocupado=$(du -sm "$DEST" 2>/dev/null | awk '{printf "%.1f", $1/1024}')
di "retención: $borrados borrados, quedan $quedan volcados, ${ocupado} GB."

# El latido reporta ENTREGA, no "el script corrió": tamaño real, tablas que trajo,
# y cuánto ocupa la carpeta. Si mañana dice "0 tablas" o el tamaño se desploma, se
# ve en el tablero sin abrir un log.
if [ "$PRUEBA" = 1 ]; then
  rm -f "$archivo" "$errlog"
  latido_fin ok "prueba de compuertas"
  # La prueba negativa DEL PROPIO LATIDO: que el comando no haya fallado no significa que la
  # fila esté. Se comprueba leyéndola, y si no está se sale con error — un respaldo mudo en el
  # tablero es el modo de falla que este carril existe para cerrar.
  escrito=$(psql "$URLK" -At -q -v j="$JOB" -f - <<'SQL'
SELECT count(*) FROM analytics.cron_runs WHERE job_key = :'j';
SQL
)
  psql "$URLK" -q -v j="$JOB" -f - >/dev/null 2>&1 <<'SQL'
DELETE FROM analytics.cron_runs WHERE job_key = :'j';
SQL
  if [ "$escrito" = 1 ]; then
    di "latido: escrito y verificado sobre la llave de prueba (y borrado)"
  else
    di "FALLO: el latido NO se escribió — el respaldo quedaría MUDO en el tablero"
    exit 1
  fi
  di "PRUEBA OK — todas las compuertas pasaron. El latido backup_prod NO se tocó."
else
  latido_fin ok "${mb} MB en ${dt}s · $tablas tablas ($ods_d de kepler_ods) · quedan $quedan, ${ocupado} GB"
  di "respaldo terminado."
fi
exit 0
