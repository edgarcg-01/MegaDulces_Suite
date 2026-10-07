\pset border 2
WITH u AS (
  SELECT 'h00' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h00."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h10' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h10."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h42' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h42."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h40' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h40."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h44' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h44."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h54' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h54."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h50' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h50."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h32' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h32."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
  UNION ALL
  SELECT 'h30' AS sc, "_dataset" ds, extract(year from to_date(left("Fecha",8),'MM/DD/YY'))::int AS anio, count(*) n
    FROM h30."MaestroMovAlmacen" WHERE "Tipo"='V' GROUP BY 1,2,3
)
SELECT ds AS corte,
       sum(n) FILTER (WHERE anio = 2000) AS centinela_2000,
       sum(n) FILTER (WHERE anio > 2026) AS futuro,
       sum(n) FILTER (WHERE anio BETWEEN 2009 AND 2026 AND ds ~ '^[0-9]{4}$' AND anio <> left(ds,4)::int) AS de_OTRO_anio,
       sum(n) FILTER (WHERE anio BETWEEN 2009 AND 2026 AND ds ~ '^[0-9]{4}$' AND anio =  left(ds,4)::int) AS de_SU_anio,
       sum(n) AS total
FROM u GROUP BY ds ORDER BY ds;
