\pset border 2
WITH u AS (
  SELECT '00' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h00."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '01' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h10."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '02' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h42."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '03' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h40."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '04' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h44."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '05' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h54."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '06' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h50."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '07' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h32."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
  UNION ALL
  SELECT '08' sc, "_dataset" ds, "Documento" doc, "Caja" cj, left("Fecha",8) f
    FROM h30."MaestroMovAlmacen" WHERE "Tipo"='V'
     AND "_dataset" NOT IN ('Actuales','Concentradas')
)
SELECT sc AS sucursal,
       count(*) AS filas,
       count(DISTINCT (doc,cj,f)) AS tickets_unicos,
       count(*) - count(DISTINCT (doc,cj,f)) AS repetidos_entre_cortes,
       round(100.0*(count(*)-count(DISTINCT (doc,cj,f)))/NULLIF(count(*),0),2) AS pct
FROM u GROUP BY sc ORDER BY sc;
