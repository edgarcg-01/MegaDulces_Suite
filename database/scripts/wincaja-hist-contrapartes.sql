\pset border 2
WITH todo AS (
  SELECT '00_CEDIS' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h00."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h00."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h00."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '01_PH' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h10."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h10."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h10."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '02_LPA' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h42."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h42."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h42."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '03_8ESQ' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h40."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h40."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h40."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '04_YUR' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h44."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h44."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h44."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '05_ZAM' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h54."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h54."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h54."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '06_CAN' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h50."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h50."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h50."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '07_MAD' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h32."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h32."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h32."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
  UNION ALL
  SELECT '08_ABA' AS sucursal, t.ter, t.nom, count(DISTINCT (t.ds,t.cns)) AS tickets, sum(d."ValorVenta") AS vv, min(t.ds) AS desde, max(t.ds) AS hasta
  FROM (SELECT m."Tercero" ter, upper(coalesce(cl."Nombre",'(sin catalogo)')) nom, m."Consecutivo" cns, m."_dataset" ds
          FROM h30."MaestroMovAlmacen" m
          LEFT JOIN (SELECT DISTINCT ON ("Cliente") "Cliente" c, "Nombre" FROM h30."Clientes" ORDER BY "Cliente","_dataset" DESC) cl ON cl.c = m."Tercero"
         WHERE m."Tipo"='V' AND m."_dataset" IN ('2017','2018','2019','2020','2021','2022','2023','2024','2025')) t
  JOIN h30."DetallesMovAlmacen" d ON d."Consecutivo"=t.cns AND d."_dataset"=t.ds
  WHERE abs(d."ValorVenta") < 1000000 GROUP BY 1,2,3
)
, marcado AS (SELECT *, round(vv/NULLIF(tickets,0)) AS por_ticket,
   (nom ~ '(ALMACEN|CEDIS|SUCURSAL|BODEGA|TRASPAS|RUTA|^SUC |^RD )') AS parece_interno,
   row_number() OVER (PARTITION BY sucursal ORDER BY vv DESC) AS rk FROM todo)
SELECT sucursal, ter AS tercero, left(nom,32) AS nombre, tickets, round(vv) AS valorventa, por_ticket,
       CASE WHEN parece_interno THEN 'INTERNO?' ELSE '' END AS senal, desde||'..'||hasta AS vigencia
FROM marcado WHERE parece_interno OR rk <= 5 ORDER BY sucursal, vv DESC;
