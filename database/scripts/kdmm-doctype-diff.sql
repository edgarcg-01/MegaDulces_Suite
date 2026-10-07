-- ============================================================================
-- Comparación del CATÁLOGO DE DOCUMENTOS de Kepler (kdmm) entre los 9 servidores
-- ----------------------------------------------------------------------------
-- Para qué: homologar la configuración de documentos desde un servidor patrón.
-- Fuente:   kepler_ods.kdmm (derive-no-copy sobre el ODS; cero importers).
--           Verificado 2026-09-29: los conteos del ODS coinciden fila por fila
--           con las 9 réplicas md.kdmm en pgvector-md (:5433).
-- Cómo:     ssh superoot@192.168.0.222 \
--             'docker exec -i pg-prod psql -U postgres -d railway -f -' \
--             < database/scripts/kdmm-doctype-diff.sql
--
-- Decode probado (no adivinado) — ver docs/IMPLEMENTACION/AUDITORIA_KDMM_HOMOLOGACION.md:
--   c1..c4  = género · naturaleza · grupo · tipo   (la PK del doctype)
--   c5      = descripción
--   c6      = Afectación BD → Contabilidad  (S genera póliza; probado: 11/33 con 'S'
--             generaron póliza en ago-2026 y 0/138 con 'N')
--   c7      = Afectación BD → CXC/CXP      (probado contra kdue)
--   c8      = Afectación BD → Inventario
--   c15/c16/c33 = Retención ISR% / IVA% / IVA Ret.%   (c16 ∈ {0,16,99}; 99 = del renglón)
--   c17     = Archivo de folio (KFXD2001)
--   c18     = Tipo de póliza (D=Diario · E=Egresos · I=Ingresos)
--   c19/c20 = Cuenta cargo / Cuenta abono
--   c21/c22 = Cuenta IVA / Cuenta IEPS-Retención
--   c25/c26 = Campo de kdm1 a añadir a la cuenta principal / secundaria
--             (45 y 47 = banco origen / banco destino → resuelve la subcuenta 102-XXXX)
--   c55     = Documento revisado y validado
--   c56..c61= AUDITORÍA (fecha/usuario/hora de última modificación) → SE EXCLUYEN
-- ============================================================================

\pset format aligned
\pset border 2
\timing off

\echo '### 1. Doctypes que NO existen en las 9 sucursales'
WITH b AS (
  SELECT sucursal, c1||'-'||c2||'-'||trim(to_char(c3,'999'))||'-'||trim(to_char(c4,'999')) AS doc, c5
  FROM kepler_ods.kdmm
)
SELECT doc, count(*) AS sucs, string_agg(sucursal, ',' ORDER BY sucursal) AS presente_en,
       string_agg(DISTINCT btrim(c5), ' | ') AS descripcion
FROM b GROUP BY doc HAVING count(*) <> (SELECT count(DISTINCT sucursal) FROM kepler_ods.kdmm)
ORDER BY count(*), doc;

\echo ''
\echo '### 2. Campos que divergen (excluye auditoría c56-c61)'
WITH b AS (
  SELECT sucursal, c1||'-'||c2||'-'||trim(to_char(c3,'999'))||'-'||trim(to_char(c4,'999')) AS doc,
         to_jsonb(k) - 'sucursal' AS j
  FROM kepler_ods.kdmm k
), kv AS (
  SELECT b.sucursal, b.doc, e.key AS campo, btrim(coalesce(e.value,'')) AS valor
  FROM b, jsonb_each_text(b.j) e
  WHERE e.key NOT IN ('c56','c57','c58','c59','c60','c61')
), div AS (
  SELECT doc, campo FROM kv GROUP BY doc, campo HAVING count(DISTINCT valor) > 1
), nom AS (
  SELECT DISTINCT ON (doc) doc, nombre FROM (
    SELECT sucursal,
           c1||'-'||c2||'-'||trim(to_char(c3,'999'))||'-'||trim(to_char(c4,'999')) AS doc,
           btrim(c5) AS nombre
    FROM kepler_ods.kdmm) z ORDER BY doc, sucursal
)
SELECT d.doc, n.nombre, d.campo,
       max(kv.valor) FILTER (WHERE kv.sucursal='00') AS s00,
       max(kv.valor) FILTER (WHERE kv.sucursal='01') AS s01,
       max(kv.valor) FILTER (WHERE kv.sucursal='02') AS s02,
       max(kv.valor) FILTER (WHERE kv.sucursal='03') AS s03,
       max(kv.valor) FILTER (WHERE kv.sucursal='04') AS s04,
       max(kv.valor) FILTER (WHERE kv.sucursal='05') AS s05,
       max(kv.valor) FILTER (WHERE kv.sucursal='06') AS s06,
       max(kv.valor) FILTER (WHERE kv.sucursal='07') AS s07,
       max(kv.valor) FILTER (WHERE kv.sucursal='08') AS s08
FROM div d JOIN kv USING (doc, campo) JOIN nom n ON n.doc = d.doc
GROUP BY d.doc, n.nombre, d.campo ORDER BY d.campo, d.doc;

\echo ''
\echo '### 3. Impacto: volumen real de cada doctype divergente (12 meses)'
WITH div AS (
  SELECT DISTINCT c1||'-'||c2||'-'||trim(to_char(c3,'999'))||'-'||trim(to_char(c4,'999')) AS doc
  FROM kepler_ods.kdmm k
  WHERE EXISTS (
    SELECT 1 FROM kepler_ods.kdmm k2
    WHERE (k2.c1,k2.c2,k2.c3,k2.c4)=(k.c1,k.c2,k.c3,k.c4)
      AND (btrim(k2.c5),btrim(k2.c6),btrim(k2.c7),btrim(k2.c8),btrim(k2.c16),btrim(k2.c18),
           btrim(k2.c19),btrim(k2.c20),btrim(k2.c21),btrim(k2.c22),k2.c25,k2.c26,btrim(k2.c41))
       IS DISTINCT FROM
          (btrim(k.c5),btrim(k.c6),btrim(k.c7),btrim(k.c8),btrim(k.c16),btrim(k.c18),
           btrim(k.c19),btrim(k.c20),btrim(k.c21),btrim(k.c22),k.c25,k.c26,btrim(k.c41)))
)
SELECT d.doc,
       count(m.*) FILTER (WHERE m.sucursal='00') AS s00,
       count(m.*) FILTER (WHERE m.sucursal='01') AS s01,
       count(m.*) FILTER (WHERE m.sucursal='02') AS s02,
       count(m.*) FILTER (WHERE m.sucursal='03') AS s03,
       count(m.*) FILTER (WHERE m.sucursal='04') AS s04,
       count(m.*) FILTER (WHERE m.sucursal='05') AS s05,
       count(m.*) FILTER (WHERE m.sucursal='06') AS s06,
       count(m.*) FILTER (WHERE m.sucursal='07') AS s07,
       count(m.*) FILTER (WHERE m.sucursal='08') AS s08,
       count(m.*) AS total_12m
FROM div d
LEFT JOIN kepler_ods.kdm1 m
  ON m.c2||'-'||m.c3||'-'||trim(to_char(m.c4,'999'))||'-'||trim(to_char(m.c5,'999')) = d.doc
 AND m.c68 >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY d.doc ORDER BY total_12m DESC;
