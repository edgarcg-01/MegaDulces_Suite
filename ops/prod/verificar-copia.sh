#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# VL.9 — ¿la copia de `md` se parece a prod? Compara ESTRUCTURA, no filas.
#
#   ssh superoot@192.168.0.222 'bash -s' < ops/prod/verificar-copia.sh
#
# ── Por qué estructura y no filas ───────────────────────────────────────────
# La copia se restaura de un `.dump` con fecha. Comparar conteos de filas contra
# prod diría "distinto" en TODAS las tablas vivas, que es correcto y no informa
# nada: la ingesta escribe a prod cada 15 segundos. Lo que sí tiene que coincidir
# es el ESQUELETO — tablas, vistas, matvistas, índices, políticas RLS, funciones,
# secuencias — porque ahí es donde un restore incompleto se nota.
#
# ⚠️ Y una diferencia de esqueleto NO es automáticamente un error: entre la fecha
# del dump y hoy pudieron aplicarse migraciones. Por eso esto **imprime el diff y
# no dictamina**. El veredicto lo pone un humano mirando si lo que falta cuadra
# con las migraciones de esos días. Un script que dijera ✅/❌ acá estaría
# fingiendo una certeza que no tiene.
#
# ⛔ Lo que este script NO puede ver, y hay que tener presente: los GRANT. El
# respaldo diario corre con `--no-privileges`, así que la copia nace sin ellos y
# ninguna de estas consultas lo nota. Se ve en runtime como `permission denied`.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

set -a
. "$HOME/secrets/ingest.env"     # ODS_HB_URL = PROD (Railway)
set +a

CENSO="
SELECT 'tablas'     AS que, table_schema AS ambito, count(*)::text AS n
  FROM information_schema.tables
 WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
 GROUP BY 2
UNION ALL
SELECT 'vistas', table_schema, count(*)::text
  FROM information_schema.views
 WHERE table_schema NOT IN ('pg_catalog','information_schema')
 GROUP BY 2
UNION ALL
SELECT 'matvistas', schemaname, count(*)::text FROM pg_matviews GROUP BY 2
UNION ALL
SELECT 'indices', schemaname, count(*)::text FROM pg_indexes
 WHERE schemaname NOT IN ('pg_catalog','information_schema') GROUP BY 2
UNION ALL
SELECT 'politicas_rls', schemaname, count(*)::text FROM pg_policies GROUP BY 2
UNION ALL
SELECT 'secuencias', sequence_schema, count(*)::text
  FROM information_schema.sequences GROUP BY 2
ORDER BY 1,2;
"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "── censo de PROD (Railway) ──"
psql "$ODS_HB_URL" -tAF'|' -c "$CENSO" | sort > "$tmp/prod.txt"
wc -l < "$tmp/prod.txt" | sed 's/^/   renglones: /'

echo "── censo de la COPIA (pg-prod en md) ──"
docker exec pg-prod psql -U postgres -d railway -tAF'|' -c "$CENSO" | sort > "$tmp/copia.txt"
wc -l < "$tmp/copia.txt" | sed 's/^/   renglones: /'

echo
echo "── DIFERENCIAS (qué · ámbito · prod -> copia) ──"
# join por las dos primeras columnas para poder mostrar el par, y listar también
# lo que existe de un solo lado (que es la diferencia que más importa).
awk -F'|' 'NR==FNR{p[$1"|"$2]=$3; next}
           { c[$1"|"$2]=$3 }
           END{
             n=0
             for (k in p) if (!(k in c)) { split(k,a,"|"); printf "   %-14s %-22s %6s -> AUSENTE\n", a[1], a[2], p[k]; n++ }
             for (k in c) if (!(k in p)) { split(k,a,"|"); printf "   %-14s %-22s %6s <- SOLO EN LA COPIA\n", a[1], a[2], c[k]; n++ }
             for (k in p) if ((k in c) && p[k] != c[k]) { split(k,a,"|"); printf "   %-14s %-22s %6s -> %s\n", a[1], a[2], p[k], c[k]; n++ }
             if (n==0) print "   (ninguna: el esqueleto coincide exacto)"
           }' "$tmp/prod.txt" "$tmp/copia.txt" | sort

echo
echo "── tamaño y versión de cada lado ──"
printf "   prod   "; psql "$ODS_HB_URL" -tAc "SELECT current_database()||' · '||pg_size_pretty(pg_database_size(current_database()))||' · '||split_part(version(),' on ',1);"
printf "   copia  "; docker exec pg-prod psql -U postgres -d railway -tAc "SELECT current_database()||' · '||pg_size_pretty(pg_database_size(current_database()))||' · '||split_part(version(),' on ',1);"

echo
echo "── roles que la copia necesita (el dump NO los trae) ──"
docker exec pg-prod psql -U postgres -d railway -tAF'|' -c \
  "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('app_runtime','fdw_verificador_ro') ORDER BY 1;" \
  | sed 's/^/   /'

echo
echo "⚠️  Una diferencia NO es por sí sola un error: entre la fecha del dump y hoy"
echo "   pudieron aplicarse migraciones. Contrastá lo que falta contra los batches"
echo "   de esos días antes de concluir nada."
echo "⛔ Y esto NO mira los GRANT — el respaldo diario corre con --no-privileges."
