BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SET LOCAL enable_mergejoin = off;
SELECT 'sysid', system_identifier FROM pg_control_system();
WITH
canc AS MATERIALIZED (
 SELECT DISTINCT m.sucursal, m.c1, m.c10, m.c4, m.c5, m.c6 FROM kepler_ods.kdm1 m
 WHERE m.c3='D' AND m.c4 IN (25,26,40,45,55,60) AND m.c43='C' AND btrim(m.c1)=m.sucursal),
apl AS MATERIALIZED (
 SELECT x.sucursal, btrim(x.c2) acr, x.c7 t, x.c8 s, btrim(x.c9) f,
   sum(x.c10) aplicado,
   sum(x.c10) FILTER (WHERE x.c4 IN (25,26)) dinero,
   (max(x.c3) FILTER (WHERE x.c4 IN (25,26)))::date ult_pago,
   (min(x.c3) FILTER (WHERE x.c4 IN (25,26)))::date pri_pago
 FROM kepler_ods.kdxf x
 WHERE btrim(x.c1)=x.sucursal AND x.c3 >= '2025-11-01'
   AND NOT EXISTS (SELECT 1 FROM canc WHERE canc.sucursal=x.sucursal AND canc.c1=x.c1 AND canc.c10=x.c2 AND canc.c4=x.c4 AND canc.c5=x.c5 AND canc.c6=x.c6)
 GROUP BY 1,2,3,4,5),
nom AS MATERIALIZED (SELECT DISTINCT ON (btrim(c2)) btrim(c2) acr, btrim(c3) nombre FROM kepler_ods.kdxd ORDER BY btrim(c2), (sucursal<>'00'), sucursal),
kx AS MATERIALIZED (
 SELECT e.sucursal, btrim(e.c2) acr, e.c4, e.c5, btrim(e.c6) folio, e.c7::date f, e.c10::date venc, e.c11 imp, btrim(e.c16) ref,
   coalesce(a.aplicado,0) aplicado, coalesce(a.dinero,0) dinero, a.ult_pago, a.pri_pago,
   e.c11 - coalesce(a.aplicado,0) pendiente,
   row_number() OVER (ORDER BY e.sucursal, e.c4, e.c5, e.c6, e.c2) kid
 FROM kepler_ods.kdxe e
 LEFT JOIN apl a ON a.sucursal=e.sucursal AND a.acr=btrim(e.c2) AND a.t=e.c4 AND a.s=e.c5 AND a.f=btrim(e.c6)
 WHERE btrim(e.c1)=e.sucursal AND e.c3='A' AND e.c4 IN (10,20) AND e.c7 >= '2025-11-15' AND e.c7 < '2026-11-23'
   AND btrim(e.c2) NOT LIKE 'TI%' AND btrim(e.c2) <> 'CL005' AND e.c11 > 0.005),
cf AS MATERIALIZED (
 SELECT c.uuid, c.emisor_rfc, c.emisor_nombre, (c.fecha AT TIME ZONE 'America/Mexico_City')::date f,
   c.total*coalesce(CASE WHEN c.moneda='USD' THEN c.tipo_cambio END,1) tot, c.metodo_pago mp, c.estatus_sat est, c.serie, c.folio cfolio
 FROM fiscal.cfdis c WHERE c.tenant_id='00000000-0000-0000-0000-00000000d01c' AND c.rol='recibidas' AND c.tipo_comprobante='I'
   AND c.fecha >= '2025-10-01' AND c.fecha < '2026-11-24'),
rm AS MATERIALIZED (
 SELECT DISTINCT proveedor_code acr, rfc FROM analytics.v_supplier_rfc WHERE rfc IS NOT NULL AND proveedor_code <> 'CL005'
 -- [anexo CL] Aquí el análisis del 2026-11-23 agregó con UNION ~27 pares (acreedor, RFC) corregidos por la evidencia
 -- de sus propios CFDI (nombre parecido >= 0.33). NO se publican: incluyen RFC de personas físicas. Se rearman
 -- comparando el RFC de v_supplier_rfc con el emisor de los CFDI que casan por importe con sus facturas.
),
rset AS MATERIALIZED (SELECT DISTINCT rfc FROM rm),
kr AS MATERIALIZED (SELECT kx.kid, kx.f, kx.imp, rm.rfc, floor(kx.imp)::bigint + d b FROM kx JOIN rm USING (acr), generate_series(-1,1) d),
cb AS MATERIALIZED (SELECT cf.*, floor(cf.tot)::bigint b FROM cf),
p0 AS MATERIALIZED (
 SELECT kr.kid, cf.uuid, abs(cf.tot-kr.imp) da, (cf.f-kr.f) dd,
   abs(cf.tot-kr.imp)*5 + abs(cf.f-kr.f) + CASE WHEN cf.est='cancelado' THEN 1000 ELSE 0 END cost
 FROM kr JOIN cb cf ON cf.emisor_rfc=kr.rfc AND cf.b=kr.b WHERE cf.tot BETWEEN kr.imp-1 AND kr.imp+1 AND cf.f BETWEEN kr.f-45 AND kr.f+45),
r1 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p0 p) z WHERE rk=1 AND rc=1),
p1 AS MATERIALIZED (SELECT * FROM p0 WHERE kid NOT IN (SELECT kid FROM r1) AND uuid NOT IN (SELECT uuid FROM r1)),
r2 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p1 p) z WHERE rk=1 AND rc=1),
p2 AS MATERIALIZED (SELECT * FROM p1 WHERE kid NOT IN (SELECT kid FROM r2) AND uuid NOT IN (SELECT uuid FROM r2)),
r3 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p2 p) z WHERE rk=1 AND rc=1),
p3 AS MATERIALIZED (SELECT * FROM p2 WHERE kid NOT IN (SELECT kid FROM r3) AND uuid NOT IN (SELECT uuid FROM r3)),
r4 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p3 p) z WHERE rk=1 AND rc=1),
p4 AS MATERIALIZED (SELECT * FROM p3 WHERE kid NOT IN (SELECT kid FROM r4) AND uuid NOT IN (SELECT uuid FROM r4)),
r5 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p4 p) z WHERE rk=1 AND rc=1),
p5 AS MATERIALIZED (SELECT * FROM p4 WHERE kid NOT IN (SELECT kid FROM r5) AND uuid NOT IN (SELECT uuid FROM r5)),
r6 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p5 p) z WHERE rk=1 AND rc=1),
p6 AS MATERIALIZED (SELECT * FROM p5 WHERE kid NOT IN (SELECT kid FROM r6) AND uuid NOT IN (SELECT uuid FROM r6)),
r7 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM p6 p) z WHERE rk=1 AND rc=1),
p7 AS MATERIALIZED (SELECT * FROM p6 WHERE kid NOT IN (SELECT kid FROM r7) AND uuid NOT IN (SELECT uuid FROM r7)),
m1 AS MATERIALIZED (SELECT kid, uuid FROM r1 UNION ALL SELECT kid, uuid FROM r2 UNION ALL SELECT kid, uuid FROM r3 UNION ALL SELECT kid, uuid FROM r4 UNION ALL SELECT kid, uuid FROM r5 UNION ALL SELECT kid, uuid FROM r6 UNION ALL SELECT kid, uuid FROM r7),
uk1 AS MATERIALIZED (SELECT kx.kid, kx.f, kx.imp, rm.rfc, ltrim(substring(kx.ref from '([0-9]+)\s*$'),'0') d
  FROM kx JOIN rm USING (acr) WHERE NOT EXISTS (SELECT 1 FROM m1 WHERE m1.kid=kx.kid)),
uc1 AS MATERIALIZED (SELECT cf.uuid, cf.emisor_rfc, cf.f, cf.tot, cf.est, regexp_replace(coalesce(cf.cfolio,''),'\D','','g') cd
  FROM cf WHERE NOT EXISTS (SELECT 1 FROM m1 WHERE m1.uuid=cf.uuid)),
q0 AS MATERIALIZED (SELECT uk1.kid, uc1.uuid, abs(ln(uc1.tot/uk1.imp))*100 + abs(uc1.f-uk1.f)/10.0 + CASE WHEN uc1.est='cancelado' THEN 1000 ELSE 0 END cost
  FROM uk1 JOIN uc1 ON uc1.emisor_rfc=uk1.rfc
  WHERE length(uk1.d) >= 3 AND right(uc1.cd, length(uk1.d)) = uk1.d AND abs(uc1.f-uk1.f) <= 60 AND uc1.tot BETWEEN uk1.imp*0.75 AND uk1.imp*1.33),
s1 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM q0 p) z WHERE rk=1 AND rc=1),
q1 AS MATERIALIZED (SELECT * FROM q0 WHERE kid NOT IN (SELECT kid FROM s1) AND uuid NOT IN (SELECT uuid FROM s1)),
s2 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM q1 p) z WHERE rk=1 AND rc=1),
q2 AS MATERIALIZED (SELECT * FROM q1 WHERE kid NOT IN (SELECT kid FROM s2) AND uuid NOT IN (SELECT uuid FROM s2)),
s3 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM q2 p) z WHERE rk=1 AND rc=1),
m12 AS MATERIALIZED (SELECT kid, uuid, 'importe' via FROM m1 UNION ALL SELECT kid, uuid, 'folio' FROM s1 UNION ALL SELECT kid, uuid, 'folio' FROM s2 UNION ALL SELECT kid, uuid, 'folio' FROM s3),
uk2 AS MATERIALIZED (SELECT kr.* FROM kr WHERE NOT EXISTS (SELECT 1 FROM m12 WHERE m12.kid=kr.kid)),
uc2 AS MATERIALIZED (SELECT cb.* FROM cb WHERE NOT EXISTS (SELECT 1 FROM m12 WHERE m12.uuid=cb.uuid)),
t0 AS MATERIALIZED (SELECT uk2.kid, uc2.uuid, abs(uc2.tot-uk2.imp)*5 + abs(uc2.f-uk2.f) + CASE WHEN uc2.est='cancelado' THEN 1000 ELSE 0 END cost FROM uk2 JOIN uc2 ON uc2.emisor_rfc=uk2.rfc AND uc2.b=uk2.b WHERE abs(uc2.tot-uk2.imp)<=1 AND abs(uc2.f-uk2.f)<=180),
u1 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM t0 p) z WHERE rk=1 AND rc=1),
t1 AS MATERIALIZED (SELECT * FROM t0 WHERE kid NOT IN (SELECT kid FROM u1) AND uuid NOT IN (SELECT uuid FROM u1)),
u2 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM t1 p) z WHERE rk=1 AND rc=1),
t2 AS MATERIALIZED (SELECT * FROM t1 WHERE kid NOT IN (SELECT kid FROM u2) AND uuid NOT IN (SELECT uuid FROM u2)),
u3 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM t2 p) z WHERE rk=1 AND rc=1),
m123 AS MATERIALIZED (SELECT * FROM m12 UNION ALL SELECT kid, uuid, 'tardio' FROM u1 UNION ALL SELECT kid, uuid, 'tardio' FROM u2 UNION ALL SELECT kid, uuid, 'tardio' FROM u3),
uk3 AS MATERIALIZED (SELECT DISTINCT kid, f, imp, rfc FROM kr WHERE NOT EXISTS (SELECT 1 FROM m123 WHERE m123.kid=kr.kid)),
uc3 AS MATERIALIZED (SELECT cf.* FROM cf WHERE NOT EXISTS (SELECT 1 FROM m123 WHERE m123.uuid=cf.uuid)),
v0 AS MATERIALIZED (SELECT uk3.kid, uc3.uuid, abs(ln(uc3.tot/uk3.imp))*1000 + abs(uc3.f-uk3.f) + CASE WHEN uc3.est='cancelado' THEN 1000 ELSE 0 END cost FROM uk3 JOIN uc3 ON uc3.emisor_rfc=uk3.rfc WHERE uc3.tot BETWEEN uk3.imp*0.97 AND uk3.imp*1.03 AND abs(uc3.f-uk3.f)<=20),
w1 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM v0 p) z WHERE rk=1 AND rc=1),
v1 AS MATERIALIZED (SELECT * FROM v0 WHERE kid NOT IN (SELECT kid FROM w1) AND uuid NOT IN (SELECT uuid FROM w1)),
w2 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM v1 p) z WHERE rk=1 AND rc=1),
v2 AS MATERIALIZED (SELECT * FROM v1 WHERE kid NOT IN (SELECT kid FROM w2) AND uuid NOT IN (SELECT uuid FROM w2)),
w3 AS MATERIALIZED (SELECT kid, uuid FROM (SELECT p.*, row_number() OVER (PARTITION BY kid ORDER BY cost, uuid) rk, row_number() OVER (PARTITION BY uuid ORDER BY cost, kid) rc FROM v2 p) z WHERE rk=1 AND rc=1),
m AS MATERIALIZED (SELECT * FROM m123 UNION ALL SELECT kid, uuid, 'cercano' FROM w1 UNION ALL SELECT kid, uuid, 'cercano' FROM w2 UNION ALL SELECT kid, uuid, 'cercano' FROM w3),
rep AS MATERIALIZED (SELECT upper(l.docto_uuid) u, count(*) n, sum(l.imp_pagado) pagado, min(l.fecha_pago) f1, max(l.fecha_pago) f2
  FROM fiscal.cfdi_payment_links l JOIN fiscal.cfdis r ON r.uuid=l.rep_uuid AND r.tenant_id=l.tenant_id AND r.rol='recibidas' AND r.estatus_sat <> 'cancelado'
  WHERE l.tenant_id='00000000-0000-0000-0000-00000000d01c' GROUP BY 1),
km AS MATERIALIZED (SELECT kx.*, n.nombre, m.uuid, m.via, cf.f cf_f, cf.tot cf_tot, cf.mp, cf.est, (kx.acr IN (SELECT acr FROM rm)) con_rfc
  FROM kx LEFT JOIN m USING (kid) LEFT JOIN cf USING (uuid) LEFT JOIN nom n USING (acr)),
cm AS MATERIALIZED (SELECT cf.*, m.kid, m.via, (cf.emisor_rfc IN (SELECT rfc FROM rset)) es_acr FROM cf LEFT JOIN m USING (uuid))
