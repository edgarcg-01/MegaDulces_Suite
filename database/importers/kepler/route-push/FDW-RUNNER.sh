#!/usr/bin/env bash
# `[RD.34]` — Prod LEE la foto de existencia del runner. Sin importer, sin cron.
#
# ⭐ REGLA PRINCIPAL del proyecto: cero importers. `import-route-stock.js` copia
#    `mart.existencias_ruta` (runner) -> `commercial.route_counts` (prod) y hay que agendarlo;
#    si deja de correr, la tabla se queda vieja y NADIE se entera. Es exactamente como
#    `analytics.customer_receivables` termino vacia en prod en la Fase CXC.
#
# Esto lo reemplaza por una tabla FORANEA: prod lee la foto donde vive.
#
#   · los dos Postgres estan en el MISMO cluster k3s, namespace `prod`:
#       pg-prod       -> la base de la plataforma (`railway`)
#       pgvector-md   -> el runner (`kepler_consolidado`, publicado afuera como :5433)
#     asi que el FDW ni sale del cluster: host `pgvector-md`, puerto 5432.
#   · `postgres_fdw` YA estaba instalado en prod (1.2) y no habia ni un servidor foraneo.
#
# ⚠️ POR QUE ESTO NO VA EN UNA MIGRACION: el mapeo de usuario lleva contrasena, y este repo es
#    PUBLICO. La credencial se genera aca y nunca se imprime ni se guarda; la migracion que
#    viene despues sólo crea vistas. Mismo criterio que `sql/007_rol_dedicado.sql`.
#
# ⚠️ El rol del runner queda acotado a SELECT sobre UNA tabla. No es `postgres`.
#
# CORRER EN `md`:   bash FDW-RUNNER.sh
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

PGV=$(kubectl get pods -n prod -l app=pgvector-md -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[ -z "${PGV:-}" ] && PGV=$(kubectl get pods -n prod --no-headers | awk '/^pgvector-md/{print $1; exit}')
PGP=$(kubectl get pods -n prod -l app=pg-prod -o jsonpath='{.items[0].metadata.name}')
echo "runner: $PGV   ·   prod: $PGP"

PASS=$(openssl rand -hex 24)
umask 077

# ── 1. Rol de SOLO LECTURA en el runner, acotado a la foto ──────────────────────────────────
printf "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='prod_fdw_ro')
    THEN CREATE ROLE prod_fdw_ro LOGIN PASSWORD '%s';
    ELSE ALTER ROLE prod_fdw_ro PASSWORD '%s';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE kepler_consolidado TO prod_fdw_ro;
GRANT USAGE ON SCHEMA mart TO prod_fdw_ro;
GRANT SELECT ON mart.existencias_ruta TO prod_fdw_ro;
" "$PASS" "$PASS" > /tmp/.rd34r.sql
kubectl exec -n prod -i "$PGV" -- psql -U postgres -d kepler_consolidado -v ON_ERROR_STOP=1 -q -f - < /tmp/.rd34r.sql
echo "✔ rol prod_fdw_ro en el runner (solo SELECT sobre mart.existencias_ruta)"

# ── 2. Servidor foraneo + mapeo + tabla foranea en prod ─────────────────────────────────────
printf "CREATE EXTENSION IF NOT EXISTS postgres_fdw;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname='runner_rutas')
    THEN CREATE SERVER runner_rutas FOREIGN DATA WRAPPER postgres_fdw
         OPTIONS (host 'pgvector-md', port '5432', dbname 'kepler_consolidado', connect_timeout '5');
  END IF;
END \$\$;
DROP USER MAPPING IF EXISTS FOR CURRENT_USER SERVER runner_rutas;
CREATE USER MAPPING FOR CURRENT_USER SERVER runner_rutas
  OPTIONS (user 'prod_fdw_ro', password '%s');
CREATE SCHEMA IF NOT EXISTS runner;
DROP FOREIGN TABLE IF EXISTS runner.existencias_ruta;
IMPORT FOREIGN SCHEMA mart LIMIT TO (existencias_ruta) FROM SERVER runner_rutas INTO runner;
COMMENT ON FOREIGN TABLE runner.existencias_ruta IS
  'La foto de existencia que cada camioneta empuja cada 15 min. Vive en pgvector-md/kepler_consolidado. Aca se LEE, no se copia -- regla principal: cero importers. [RD.34]';
" "$PASS" > /tmp/.rd34p.sql
kubectl exec -n prod -i "$PGP" -- psql -U postgres -d railway -v ON_ERROR_STOP=1 -q -f - < /tmp/.rd34p.sql

shred -u /tmp/.rd34r.sql /tmp/.rd34p.sql 2>/dev/null || rm -f /tmp/.rd34r.sql /tmp/.rd34p.sql
unset PASS
echo "✔ servidor foraneo y tabla foranea listos en prod"

# ── 3. La prueba que importa: prod LEE la foto ──────────────────────────────────────────────
echo "=== lectura a traves del FDW ==="
kubectl exec -n prod -i "$PGP" -- psql -U postgres -d railway -At -c \
  "select 'camiones '||count(distinct truck)||'   renglones '||count(*)||'   importe '||round(sum(importe),2)
     from runner.existencias_ruta where fecha = current_date"
echo ""
echo "Si dice 10 camiones y ~\$507,805 -> listo. Avisar para aplicar la migracion de las vistas."
