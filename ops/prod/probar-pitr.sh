#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# [VL.9.11] EL ENSAYO DE RECUPERACIÓN — porque un respaldo que nunca se restauró
# es una hipótesis.
#
#   sh ~/ops/prod/probar-pitr.sh
#
# Prueba que pgBackRest puede devolver la base a UN MOMENTO ELEGIDO, no sólo que
# `pgbackrest info` diga `status: ok`. Ese `ok` sólo afirma que el repositorio es
# coherente consigo mismo; no dice nada sobre si de ahí sale una base que arranca.
#
# ── CÓMO PRUEBA DE VERDAD ───────────────────────────────────────────────────
# No alcanza con restaurar y ver que Postgres levante: eso lo lograría un respaldo
# que se quedó a mitad. El ensayo escribe DOS marcas con un instante en medio:
#
#     marca A  ──►  T_objetivo  ──►  marca B
#
# y restaura a `T_objetivo`. La recuperación es correcta **sólo si A está y B NO**.
# Si aparecen las dos, el punto en el tiempo no se respetó; si no aparece ninguna,
# no se recuperó nada. Un solo resultado de los tres pasa.
#
# ⛔ NO TOCA `pg-prod`. Restaura a un directorio aparte y levanta un Postgres
# temporal en el puerto 5436. La copia que sirve a la app sigue intacta.
#
# ⚠️ El clúster temporal arranca con `archive_mode=off`. Sin eso empujaría WAL de
# una línea de tiempo nueva al MISMO repositorio y lo ensuciaría — el ensayo
# contaminaría justo lo que vino a verificar.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DESTINO=/home/superoot/pitr-test
PUERTO=5436
CONT=pitr-test
MARCA=analytics.pitr_probe
fallas=0

di()  { echo "[$(date '+%F %T %Z')] $*"; }
mal() { echo "   ✗ $*"; fallas=$((fallas+1)); }
ok()  { echo "   ✓ $*"; }

limpiar() {
  docker rm -f "$CONT" >/dev/null 2>&1
  docker run --rm -v /home/superoot:/h alpine:3 sh -c "rm -rf /h/$(basename $DESTINO)" >/dev/null 2>&1
  docker exec pg-prod psql -U postgres -d railway -q -c "DROP TABLE IF EXISTS $MARCA" >/dev/null 2>&1
}
trap 'di "interrumpido — limpiando"; limpiar; exit 130' INT TERM

di "── 0. espacio (la base son ~20 GB) ──"
libres=$(df -BG / | awk 'NR==2{gsub("G","",$4); print $4}')
echo "   $libres GB libres"
[ "$libres" -ge 40 ] || { di "FALLO: hacen falta 40 GB y hay $libres"; exit 1; }

limpiar

di "── 1. marca A, instante objetivo, marca B ──"
docker exec pg-prod psql -U postgres -d railway -q -c \
  "CREATE TABLE IF NOT EXISTS $MARCA (marca text primary key, cuando timestamptz default now())" || {
    di "FALLO: no se pudo crear la tabla de marcas"; exit 1; }
docker exec pg-prod psql -U postgres -d railway -q -c "INSERT INTO $MARCA (marca) VALUES ('A')"
# El objetivo se toma del RELOJ DE LA BASE, no del host: si difieren, la recuperación
# apuntaría a un instante que no existe en su línea de tiempo.
OBJ=$(docker exec pg-prod psql -U postgres -d railway -At -c "SELECT now()")
sleep 2
docker exec pg-prod psql -U postgres -d railway -q -c "INSERT INTO $MARCA (marca) VALUES ('B')"
# ⚠️ Forzar el cambio de segmento: con `archive_timeout=300` el WAL que contiene estas
# marcas puede tardar hasta 5 minutos en archivarse, y lo que no se archivó no se recupera.
docker exec pg-prod psql -U postgres -d railway -q -c "SELECT pg_switch_wal()" >/dev/null
echo "   objetivo: $OBJ   (A antes, B después)"
sleep 3

di "── 2. restaurando a ese instante, en $DESTINO ──"
mkdir -p "$DESTINO"
docker run --rm -v "$DESTINO":/d alpine:3 sh -c 'chown 999:1000 /d && chmod 0700 /d'
t0=$(date +%s)
docker run --rm -u postgres \
  -v /home/superoot/pgbackrest:/var/lib/pgbackrest \
  -v /home/superoot/pgbackrest-log:/var/log/pgbackrest \
  -v "$DESTINO":/restore \
  --entrypoint pgbackrest trade-prod-backup:latest \
    --stanza=prod --pg1-path=/restore --type=time --target="$OBJ" \
    --target-action=promote --log-level-console=warn restore
rc=$?
di "   pg_restore de pgBackRest: código $rc en $(( $(date +%s) - t0 ))s"
[ "$rc" = 0 ] || { mal "la restauración falló"; limpiar; exit 1; }

di "── 3. levantando un Postgres temporal en :$PUERTO ──"
docker run -d --name "$CONT" \
  -v "$DESTINO":/var/lib/postgresql/18/docker \
  -v /home/superoot/pgbackrest:/var/lib/pgbackrest \
  -e PGDATA=/var/lib/postgresql/18/docker \
  -p "$PUERTO":5432 \
  trade-prod-pg:latest \
  postgres -c archive_mode=off -c hot_standby=on >/dev/null || { mal "no arrancó el contenedor"; limpiar; exit 1; }

# Esperar a que termine la recuperación. Se consulta al propio Postgres en vez de dormir
# un tiempo fijo: cuánto tarda depende de cuánto WAL haya que reproducir.
listo=0
i=0
while [ "$i" -lt 60 ]; do
  if docker exec "$CONT" pg_isready -U postgres -q 2>/dev/null; then listo=1; break; fi
  i=$((i+1)); sleep 5
done
[ "$listo" = 1 ] || { mal "el clúster restaurado no llegó a aceptar conexiones en 5 min"; docker logs "$CONT" 2>&1 | tail -10; limpiar; exit 1; }
ok "el clúster restaurado acepta conexiones"

di "── 4. EL VEREDICTO: ¿A sí y B no? ──"
hayA=$(docker exec "$CONT" psql -U postgres -d railway -At -c "SELECT count(*) FROM $MARCA WHERE marca='A'" 2>/dev/null)
hayB=$(docker exec "$CONT" psql -U postgres -d railway -At -c "SELECT count(*) FROM $MARCA WHERE marca='B'" 2>/dev/null)
echo "   marca A: ${hayA:-?}   ·   marca B: ${hayB:-?}"
if [ "${hayA:-0}" = 1 ] && [ "${hayB:-0}" = 0 ]; then
  ok "recuperación a un punto en el tiempo CORRECTA: quedó lo de antes del objetivo y nada de después"
else
  mal "el punto en el tiempo NO se respetó (A=${hayA:-?}, B=${hayB:-?}) — con A=1 y B=1 recuperó de más; con A=0 no recuperó nada"
fi

# Y que la base restaurada sea una base de verdad, no un esqueleto que arranca.
t=$(docker exec "$CONT" psql -U postgres -d railway -At -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='kepler_ods' AND c.relkind IN ('r','p')" 2>/dev/null)
[ "${t:-0}" -ge 200 ] && ok "y trae datos: $t tablas en kepler_ods" || mal "sólo ${t:-?} tablas en kepler_ods — restauró algo incompleto"

di "── 5. limpiando ──"
limpiar
docker exec pg-prod psql -U postgres -d railway -At -c "SELECT 'pg-prod sigue sirviendo: '||count(*)||' tablas en kepler_ods' FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='kepler_ods' AND c.relkind IN ('r','p')" 2>/dev/null | sed 's/^/   /'

echo
if [ "$fallas" = 0 ]; then
  echo "   ✅ ENSAYO SUPERADO — el respaldo deja de ser una hipótesis."
  exit 0
fi
echo "   ❌ $fallas falla(s) — el respaldo NO está probado."
exit 1
