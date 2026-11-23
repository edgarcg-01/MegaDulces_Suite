BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SELECT 'sysid', system_identifier FROM pg_control_system();
WITH ab AS MATERIALIZED (
  SELECT e.sucursal s, e.c1, e.c2, btrim(e.c2) prov, e.c4, e.c5, e.c6, btrim(e.c6) af, e.c7::date fe, e.c11 imp, e.c20 rem_kepler, btrim(e.c22::text) cta, btrim(e.c16) ref
  FROM kepler_ods.kdxe e WHERE btrim(e.c1)=e.sucursal AND e.c3='D' AND e.c4 IN (25,26,40,55,60) AND btrim(e.c2) NOT LIKE 'TI%' AND e.c11 > 0
    AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3='D' AND m.c43='C' AND btrim(m.c1)=m.sucursal AND m.sucursal=e.sucursal AND m.c1=e.c1 AND m.c10=e.c2 AND m.c4=e.c4 AND m.c5=e.c5 AND m.c6=e.c6)),
apl AS MATERIALIZED (SELECT x.sucursal s, x.c2, x.c4, x.c5, x.c6, sum(x.c10) apl FROM kepler_ods.kdxf x WHERE btrim(x.c1)=x.sucursal GROUP BY 1,2,3,4,5),
r AS MATERIALIZED (SELECT ab.*, coalesce(apl.apl,0) apl, ab.imp - coalesce(apl.apl,0) rem FROM ab LEFT JOIN apl ON apl.s=ab.s AND apl.c2=ab.c2 AND apl.c4=ab.c4 AND apl.c5=ab.c5 AND apl.c6=ab.c6)
SELECT 'ab', prov, c4, s, af, fe, round(rem,2), coalesce(cta,'') FROM r WHERE rem>1 AND fe >= '2024-01-01';
ROLLBACK;
