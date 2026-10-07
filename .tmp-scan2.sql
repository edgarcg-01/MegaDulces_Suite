WITH etiquetado AS (
  -- los 535 documentos cuyo origen YA sabemos por Wincaja (la etiqueta)
  SELECT k.folio, k.doc_serie, r.ramas AS origen_real
    FROM (
      SELECT m.c6 folio, m.c5 doc_serie,
             CASE WHEN length(substring(upper(regexp_replace(m.c24,'[^0-9A-Za-z]','','g')) from 'T([0-9]+)'))=9
                  THEN 'T'||substring(upper(regexp_replace(m.c24,'[^0-9A-Za-z]','','g')) from 'T([0-9]+)')
                  WHEN length(substring(upper(regexp_replace(m.c24,'[^0-9A-Za-z]','','g')) from 'T([0-9]+)')) BETWEEN 3 AND 8
                  THEN 'T'||substring(substring(upper(regexp_replace(m.c24,'[^0-9A-Za-z]','','g')) from 'T([0-9]+)'),1,2)
                       ||lpad(substring(substring(upper(regexp_replace(m.c24,'[^0-9A-Za-z]','','g')) from 'T([0-9]+)'),3),7,'0')
             END AS ticket
        FROM kepler_ods.kdm1 m
       WHERE m.sucursal='00' AND m.c2='U' AND m.c3='D' AND m.c4=41 AND COALESCE(m.c24,'')<>''
    ) k
    JOIN LATERAL (
      SELECT string_agg(DISTINCT w.source_branch, ',' ORDER BY w.source_branch) AS ramas
        FROM wincaja.maestro_mov_almacen w
        JOIN wincaja.detalles_mov_almacen d
          ON d.tenant_id=w.tenant_id AND d.source_branch=w.source_branch
         AND d.source_dataset=w.source_dataset AND d.consecutivo=w.consecutivo
       WHERE w.documento = k.ticket
         AND EXISTS (SELECT 1 FROM kepler_ods.kdm2 l
                      WHERE l.sucursal='00' AND l.c2='U' AND l.c3='D' AND l.c4=41
                        AND l.c6=k.folio AND l.c5=k.doc_serie
                        AND l.c8=d.articulo AND abs(round(l.c9::numeric,2)-round(abs(d.cantidad_regular)::numeric,2))<0.01)
    ) r ON r.ramas IS NOT NULL AND r.ramas NOT LIKE '%,%'
), doc AS (
  SELECT e.origen_real, to_jsonb(m) - 'sucursal' - 'imported_at' - '_row_hash' - 'c24' AS j
    FROM kepler_ods.kdm1 m
    JOIN etiquetado e ON e.folio=m.c6 AND e.doc_serie=m.c5
   WHERE m.sucursal='00' AND m.c2='U' AND m.c3='D' AND m.c4=41
), kv AS (
  SELECT d.origen_real, e.key, e.value::text AS val FROM doc d, jsonb_each(d.j) e
   WHERE e.value::text NOT IN ('""','0','0.00','null','"1800-01-01T06:36:36"')
), stat AS (
  SELECT key, val, origen_real, count(*)::int n,
         row_number() OVER (PARTITION BY key, val ORDER BY count(*) DESC) rk,
         sum(count(*)) OVER (PARTITION BY key, val) tot
    FROM kv GROUP BY 1,2,3
), pureza AS (
  SELECT key, sum(n) FILTER (WHERE rk=1)::int aciertos, sum(n)::int total,
         count(DISTINCT val)::int valores
    FROM stat GROUP BY key
)
SELECT key AS columna, valores, total AS filas,
       round(100.0*aciertos/total,1)::text AS pureza_pct
  FROM pureza
 WHERE valores BETWEEN 2 AND 60 AND total >= 400
 ORDER BY 100.0*aciertos/total DESC LIMIT 12
