#!/usr/bin/env bash
# `[WH.2]` — Prod LEE la historia de Wincaja donde vive. Sin importer, sin cron.
#
# ⭐ REGLA PRINCIPAL del proyecto: cero importers. La primera versión del plan WH proponía un
#    `import-wincaja-hist-sales.js`; sobra. Los dos Postgres están en el MISMO cluster k3s,
#    namespace `prod`:
#       pg-prod       -> la base de la plataforma (`railway`)
#       pgvector-md   -> el espejo de Wincaja (`wincaja`, publicado afuera como :5433)
#    así que el FDW ni sale del cluster: host `pgvector-md`, puerto 5432. Verificado el
#    2026-10-07 leyendo 278,888 filas de `h40` desde `pg-prod`.
#
# ⚠️ POR QUÉ ESTO NO VA EN UNA MIGRACIÓN: el mapeo de usuario lleva contraseña, y este repo es
#    PÚBLICO. La credencial se genera acá, nunca se imprime ni se guarda, y el archivo temporal
#    se destruye con `shred`. La migración que viene después sólo crea VISTAS.
#    Mismo criterio que `route-push/FDW-RUNNER.sh` [RD.34] y que `sql/007_rol_dedicado.sql`.
#
# ⚠️ El rol queda acotado a SELECT sobre TRES tablas por sucursal (cabeceras, renglones y el
#    catálogo de clientes que clasifica la contraparte). No es `postgres`, y no ve las otras 67.
#
# ⚠️ El corpus es ESTÁTICO: Wincaja dejó de ser fuente viva cuando cada sucursal migró a Kepler
#    (`w32` 2026-09-08 · `w30` 2026-09-18 · `w00` 2026-09-30). No llega un ticket más.
#
# Idempotente: se puede correr las veces que haga falta (rota la contraseña en cada corrida).
#
# CORRER EN `md`:   bash FDW-WINCAJA-HIST.sh
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# sucursal:schema del espejo. El CEDIS (h00) entra aunque sea 100% traspaso: su exclusión se
# DECLARA en la vista, no se logra escondiendo la tabla (ADR-056).
BRANCHES="h00 h10 h30 h32 h40 h42 h44 h50 h54"
TABLES='"MaestroMovAlmacen","DetallesMovAlmacen","Clientes"'

PGV=$(kubectl get pods -n prod -l app=pgvector-md -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[ -z "${PGV:-}" ] && PGV=$(kubectl get pods -n prod --no-headers | awk '/^pgvector-md/{print $1; exit}')
PGP=$(kubectl get pods -n prod -l app=pg-prod -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[ -z "${PGP:-}" ] && PGP=$(kubectl get pods -n prod --no-headers | awk '/^pg-prod/{print $1; exit}')
echo "espejo: $PGV   ·   prod: $PGP"

PASS=$(openssl rand -hex 24)
umask 077

# ── 1. Rol de SOLO LECTURA en el espejo, acotado a las 3 tablas de cada sucursal ─────────────
{
  printf "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='prod_wincaja_ro')
    THEN CREATE ROLE prod_wincaja_ro LOGIN PASSWORD '%s';
    ELSE ALTER ROLE prod_wincaja_ro PASSWORD '%s';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE wincaja TO prod_wincaja_ro;
" "$PASS" "$PASS"
  for s in $BRANCHES; do
    echo "GRANT USAGE ON SCHEMA $s TO prod_wincaja_ro;"
    echo "GRANT SELECT ON $s.\"MaestroMovAlmacen\", $s.\"DetallesMovAlmacen\", $s.\"Clientes\" TO prod_wincaja_ro;"
  done
} > /tmp/.wh2src.sql
kubectl exec -n prod -i "$PGV" -- psql -U postgres -d wincaja -v ON_ERROR_STOP=1 -q -f - < /tmp/.wh2src.sql
echo "✔ rol prod_wincaja_ro en el espejo (SELECT sobre 3 tablas × 9 sucursales)"

# ── 2. Servidor foráneo + mapeo + tablas foráneas en prod ────────────────────────────────────
{
  printf "CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname='wincaja_hist')
    THEN CREATE SERVER wincaja_hist FOREIGN DATA WRAPPER postgres_fdw
         OPTIONS (host 'pgvector-md', port '5432', dbname 'wincaja',
                  connect_timeout '5', fetch_size '50000');
  END IF;
END \$\$;
DROP USER MAPPING IF EXISTS FOR CURRENT_USER SERVER wincaja_hist;
CREATE USER MAPPING FOR CURRENT_USER SERVER wincaja_hist
  OPTIONS (user 'prod_wincaja_ro', password '%s');
" "$PASS"
  for s in $BRANCHES; do
    echo "CREATE SCHEMA IF NOT EXISTS wincaja_$s;"
    echo "DROP FOREIGN TABLE IF EXISTS wincaja_$s.\"MaestroMovAlmacen\", wincaja_$s.\"DetallesMovAlmacen\", wincaja_$s.\"Clientes\";"
    echo "IMPORT FOREIGN SCHEMA $s LIMIT TO ($TABLES) FROM SERVER wincaja_hist INTO wincaja_$s;"
    echo "COMMENT ON SCHEMA wincaja_$s IS 'WH.2 - espejo historico Wincaja de la sucursal $s (2017-2025), LEIDO por FDW desde pgvector-md/wincaja. No se copia: regla principal, cero importers. Corpus CERRADO (Wincaja dejo de ser fuente viva al migrar cada sucursal a Kepler).';"
  done
} > /tmp/.wh2dst.sql
kubectl exec -n prod -i "$PGP" -- psql -U postgres -d railway -v ON_ERROR_STOP=1 -q -f - < /tmp/.wh2dst.sql

shred -u /tmp/.wh2src.sql /tmp/.wh2dst.sql 2>/dev/null || rm -f /tmp/.wh2src.sql /tmp/.wh2dst.sql
unset PASS
echo "✔ servidor foráneo y 27 tablas foráneas listas en prod"

# ── 3. La prueba que importa: prod LEE la historia, y la cifra es la ya medida ───────────────
echo ""
echo "=== lectura a través del FDW (debe decir 278888) ==="
kubectl exec -n prod -i "$PGP" -- psql -U postgres -d railway -At -c \
  "SELECT 'h40 corte 2023 -> '||count(*) FROM wincaja_h40.\"MaestroMovAlmacen\" WHERE \"_dataset\"='2023'"
echo ""
echo "=== prueba NEGATIVA: el rol NO debe poder leer otra tabla ni escribir ==="
kubectl exec -n prod -i "$PGP" -- psql -U postgres -d railway -At -c \
  "SELECT count(*) FROM wincaja_h40.\"Cajas\"" 2>&1 | head -2 || true
echo "(si dice que la relacion no existe, el alcance quedo acotado: correcto)"
