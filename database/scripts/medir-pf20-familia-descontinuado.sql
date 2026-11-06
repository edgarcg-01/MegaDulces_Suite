-- ============================================================================
--  [PF.20] / [PF.21] Compras › Catálogo — lo que hay que medir en PROD antes de
--  construir «Familia» (Línea / Tipo / Grupo) y de soltar «Descontinuado» y el
--  selector «Precios de».
-- ============================================================================
--
--  SOLO LECTURA. La primera línea lo vuelve una garantía del motor: cualquier
--  escritura que se cuele aborta.
--
--  Por qué existe: en la base local (sólo la sucursal 02 completa) se midió
--  2026-11-04: Tipo asignado 43.0 %, Grupo 42.5 % (el resto '00001' = NO APLICA),
--  Línea 99.3 % pero con '999' como el valor más común, y las tablas de NOMBRES
--  (kdig / kdie / kdif) VACÍAS — o sea que en local no se puede saber si un código
--  encuentra su nombre. 654 fichas «* DESCONTINUADO» en la 02, 44 en nuestro
--  catálogo, 16 pintadas «Activo».
--
--  Cómo correrlo (desde la máquina de trabajo, prod vive en k3s):
--      ssh superoot@192.168.0.222 "sh ~/ops/prod/pgprod.sh -q -f -" \
--        < database/scripts/medir-pf20-familia-descontinuado.sql
--
--  Ventana: lecturas acotadas sobre kdii (~10 mil fichas × 9 sucursales). Cabe en
--  horario hábil; aun así va detrás de statement_timeout.
-- ============================================================================

SET default_transaction_read_only = on;
SET statement_timeout = '60s';
SET lock_timeout = '2s';

\echo '── 0. CONTROL: ¿es prod? (system_identifier) y el universo de kdii por sucursal'
SELECT system_identifier FROM pg_control_system();
SELECT sucursal, count(*) AS fichas FROM kepler_ods.kdii GROUP BY 1 ORDER BY 1;

\echo '── 1. Descontinuado: fichas con la marca, cuántas están en nuestro catálogo y cuántas decimos «Activo»'
-- Patrón = PATRON_DESCONTINUADO_PG de libs/contracts/src/http/producto-descontinuado.contract.ts
SELECT count(DISTINCT btrim(i.c1)) AS skus_marcados_en_kepler,
       count(DISTINCT p.id)        AS en_nuestro_catalogo,
       count(DISTINCT p.id) FILTER (WHERE p.activo) AS que_pintamos_activo
  FROM kepler_ods.kdii i
  LEFT JOIN catalog.products p ON btrim(p.sku) = btrim(i.c1) AND p.deleted_at IS NULL
 WHERE i.c2 ~* '\*+\s*DESCONTINUAD[OA]S?\y';
SELECT count(*) FILTER (WHERE nombre ~* '\*+\s*DESCONTINUAD[OA]S?\y') AS catalogo_nombre_marcado,
       count(*) FILTER (WHERE nombre ~* '\*+\s*DESCONTINUAD[OA]S?\y' AND activo) AS y_activo
  FROM catalog.products WHERE deleted_at IS NULL;

\echo '── 2. Familia: ¿asignada de verdad? (sin vacío ni 00001) y ¿el código encuentra su NOMBRE?'
SELECT i.sucursal, count(*) AS fichas,
       round(100.0 * count(*) FILTER (WHERE nullif(nullif(btrim(i.c3), ''), '00001') IS NOT NULL) / count(*), 1) AS pct_linea,
       round(100.0 * count(*) FILTER (WHERE nullif(nullif(btrim(i.c4), ''), '00001') IS NOT NULL) / count(*), 1) AS pct_tipo,
       round(100.0 * count(*) FILTER (WHERE nullif(nullif(btrim(i.c5), ''), '00001') IS NOT NULL) / count(*), 1) AS pct_grupo,
       round(100.0 * count(lg.c2) / count(*), 1) AS pct_linea_con_nombre,
       round(100.0 * count(te.c2) / count(*), 1) AS pct_tipo_con_nombre,
       round(100.0 * count(gf.c2) / count(*), 1) AS pct_grupo_con_nombre
  FROM kepler_ods.kdii i
  LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = i.sucursal AND btrim(lg.c1) = btrim(i.c3)
  LEFT JOIN kepler_ods.kdie te ON te.sucursal = i.sucursal AND btrim(te.c1) = btrim(i.c4)
  LEFT JOIN kepler_ods.kdif gf ON gf.sucursal = i.sucursal AND btrim(gf.c1) = btrim(i.c5)
 GROUP BY 1 ORDER BY 1;

\echo '── 3. ¿Qué es la línea 999 (y las más comunes)? Si el nombre dice «sin línea», es otro 00001'
SELECT btrim(i.c3) AS linea, min(btrim(lg.c2)) AS nombre, count(*) AS fichas
  FROM kepler_ods.kdii i
  LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = i.sucursal AND btrim(lg.c1) = btrim(i.c3)
 GROUP BY 1 ORDER BY 3 DESC LIMIT 15;
SELECT btrim(i.c4) AS tipo, min(btrim(te.c2)) AS nombre, count(*) AS fichas
  FROM kepler_ods.kdii i
  LEFT JOIN kepler_ods.kdie te ON te.sucursal = i.sucursal AND btrim(te.c1) = btrim(i.c4)
 GROUP BY 1 ORDER BY 3 DESC LIMIT 15;

\echo '── 4. La misma ficha, ¿misma familia en todas las sucursales? (si no, ¿cuál se muestra?)'
SELECT count(*) AS skus,
       count(*) FILTER (WHERE n_linea > 1) AS linea_distinta_entre_sucursales,
       count(*) FILTER (WHERE n_tipo > 1)  AS tipo_distinto_entre_sucursales
  FROM (SELECT btrim(c1) sku,
               count(DISTINCT nullif(nullif(btrim(c3), ''), '00001')) n_linea,
               count(DISTINCT nullif(nullif(btrim(c4), ''), '00001')) n_tipo
          FROM kepler_ods.kdii GROUP BY 1) x;

\echo '── 5. [PF.20] ¿El cliente externo (customer_b2b) tiene permiso de ver el catálogo? Si sí, el candado de costo importa'
SELECT lower(role_name) AS rol, permissions -> 'COMMERCIAL_PRODUCTS_VER' AS ver_catalogo,
       permissions -> 'COMPRAS_COSTO_ESTANDAR_VER' AS ver_costo
  FROM identity.role_permissions WHERE lower(role_name) = 'customer_b2b';

\echo '── 6. [PF.21] Quién pierde la sucursal 01 por omisión: roles que ven el catálogo con alcance de sucursal'
SELECT lower(rp.role_name) AS rol, rs.mode AS alcance_sucursal
  FROM identity.role_permissions rp
  JOIN identity.role_scopes rs ON lower(rs.role_name) = lower(rp.role_name) AND rs.dimension = 'warehouse'
 WHERE (rp.permissions -> 'COMMERCIAL_PRODUCTS_VER') = 'true'::jsonb
 ORDER BY 1;
