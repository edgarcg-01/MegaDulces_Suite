BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '300s';
SELECT 'sysid', system_identifier FROM pg_control_system();
WITH
v AS MATERIALIZED (SELECT sucursal s, proveedor prov, proveedor_nombre nom, doc_tipo t, doc_sub sb, folio f, fecha fe, vencimiento ve, importe imp, pendiente pend, dias_vencido dv, anterior_al_corte ac, referencia ref
   FROM analytics.v_supplier_payables WHERE proveedor NOT LIKE 'TI%' AND vencido),
rfc AS MATERIALIZED (SELECT DISTINCT ON (proveedor_code) proveedor_code prov, upper(btrim(rfc)) rfc FROM analytics.v_supplier_rfc WHERE rfc IS NOT NULL ORDER BY proveedor_code, (sucursal<>'00')),
cf AS MATERIALIZED (SELECT upper(btrim(emisor_rfc)) rfc, total, (fecha AT TIME ZONE 'America/Mexico_City')::date fe, estatus_sat est FROM fiscal.cfdis WHERE rol='recibidas' AND tipo_comprobante='I' AND fecha >= '2024-12-01'),
kc AS MATERIALIZED (SELECT sucursal s, btrim(c10) prov, c4 t, c5 sb, btrim(c6) f FROM kepler_ods.kdm1 WHERE btrim(c1)=sucursal AND c3='A' AND c4 IN (10,20) AND c43='C' AND c7 >= '2024-12-01'),
car AS MATERIALIZED (
  SELECT sucursal s, btrim(c2) prov, c4 t, c5 sb, btrim(c6) f, c7::date fe, c11 imp, NULLIF(btrim(c16),'') ref
  FROM kepler_ods.kdxe WHERE btrim(c1)=sucursal AND c3='A' AND c4 IN (10,20) AND c7 >= '2026-01-01' AND btrim(c2) NOT LIKE 'TI%' AND c11 >= 1),
gk AS MATERIALIZED (SELECT prov, imp, fe, t FROM car GROUP BY 1,2,3,4 HAVING count(*)>=2),
dgc AS MATERIALIZED (SELECT c.* FROM car c JOIN gk USING (prov, imp, fe, t)),
ap AS MATERIALIZED (
  SELECT x.sucursal s, btrim(x.c2) prov, x.c7 t, x.c8 sb, btrim(x.c9) f,
    coalesce(sum(x.c10) FILTER (WHERE x.c4 IN (25,26)),0) din, coalesce(sum(x.c10),0) tot
  FROM kepler_ods.kdxf x
  WHERE btrim(x.c1)=x.sucursal AND x.c7 IN (10,20) AND x.c3 >= '2026-01-01'
    AND (x.sucursal, btrim(x.c2), x.c7, x.c8, btrim(x.c9)) IN (SELECT s, prov, t, sb, f FROM dgc)
    AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3='D' AND m.c43='C' AND btrim(m.c1)=m.sucursal AND m.sucursal=x.sucursal AND m.c1=x.c1 AND m.c10=x.c2 AND m.c4=x.c4 AND m.c5=x.c5 AND m.c6=x.c6)
  GROUP BY 1,2,3,4,5),
dg AS MATERIALIZED (SELECT c.*, coalesce(a.din,0) din, c.imp - coalesce(a.tot,0) pend, regexp_replace(coalesce(c.ref,''),'\D','','g') rd FROM dgc c LEFT JOIN ap a USING (s,prov,t,sb,f)),
esp AS MATERIALIZED (SELECT DISTINCT a.prov, a.imp, a.fe, a.t FROM dg a JOIN dg b USING (prov, imp, fe, t) WHERE a.s<>b.s AND ltrim(b.f,'0')<>'' AND a.rd ~ ('0*'||ltrim(b.f,'0')||'$')),
gs AS MATERIALIZED (SELECT prov, imp, fe, t, count(*) nk, count(DISTINCT s) ns, count(DISTINCT nullif(rd,'')) nref, count(*) FILTER (WHERE rd='') nsinref, count(*) FILTER (WHERE pend>1) nopen,
    min(s||f) FILTER (WHERE s='00') ced, min(s||f) prim FROM dg GROUP BY 1,2,3,4),
gs2 AS MATERIALIZED (SELECT gs.*, (esp.prov IS NOT NULL) espejo,
    (SELECT count(*) FROM cf WHERE cf.rfc=r.rfc AND cf.total BETWEEN gs.imp-1 AND gs.imp+1 AND cf.fe BETWEEN gs.fe-10 AND gs.fe+3 AND cf.est='vigente') ncf
   FROM gs LEFT JOIN esp USING (prov, imp, fe, t) LEFT JOIN rfc r USING (prov)),
dupdoc AS MATERIALIZED (
  SELECT d.s, d.prov, d.t, d.sb, d.f, CASE WHEN g.espejo THEN 'espejo' WHEN g.ncf>=1 AND g.ncf<g.nk THEN 'sat' ELSE 'misma_ref' END dclase
  FROM dg d JOIN gs2 g USING (prov, imp, fe, t)
  WHERE d.pend>1 AND (g.espejo OR (g.ncf>=1 AND g.ncf<g.nk) OR (g.ncf=0 AND g.ns>1 AND g.nref=1 AND g.nsinref=0))
    AND ( EXISTS (SELECT 1 FROM dg o WHERE o.prov=d.prov AND o.imp=d.imp AND o.fe=d.fe AND o.t=d.t AND (o.s,o.f)<>(d.s,d.f) AND o.din >= o.imp-1)
       OR (g.nopen=g.nk AND d.s||d.f <> coalesce(CASE WHEN g.espejo THEN g.ced END, g.prim)) )),
L AS (
  SELECT v.*, r.rfc,
   EXISTS (SELECT 1 FROM cf WHERE cf.rfc=r.rfc AND cf.total BETWEEN v.imp-1 AND v.imp+1 AND cf.fe BETWEEN v.fe-10 AND v.fe+3 AND cf.est='vigente') m_vig,
   EXISTS (SELECT 1 FROM cf WHERE cf.rfc=r.rfc AND cf.total BETWEEN v.imp-1 AND v.imp+1 AND cf.fe BETWEEN v.fe-10 AND v.fe+3 AND cf.est='cancelado') m_can,
   EXISTS (SELECT 1 FROM cf WHERE cf.rfc=r.rfc AND cf.total BETWEEN v.imp+99 AND v.imp+101 AND cf.fe BETWEEN v.fe-10 AND v.fe+3 AND cf.est='cancelado') m_can100,
   EXISTS (SELECT 1 FROM cf WHERE cf.rfc=r.rfc AND cf.total BETWEEN v.imp+99 AND v.imp+101 AND cf.fe BETWEEN v.fe-10 AND v.fe+3 AND cf.est='vigente') m_vig100,
   (kc.f IS NOT NULL) kcanc, dd.dclase
  FROM v LEFT JOIN rfc r USING (prov)
  LEFT JOIN kc ON kc.s=v.s AND kc.prov=v.prov AND kc.t=v.t AND kc.sb=v.sb AND kc.f=v.f
  LEFT JOIN dupdoc dd ON dd.s=v.s AND dd.prov=v.prov AND dd.t=v.t AND dd.sb=v.sb AND dd.f=v.f)
SELECT 'row', s, prov, replace(coalesce(nom,''),'|','/'), t, f, fe, pend, dv, ac,
  CASE WHEN fe < current_date - 365 THEN 'a_mas_1_anio'
       WHEN prov ~ '^(A|B\.B|TC)' THEN 'a2_financiera'
       WHEN t=45 THEN 'a3_anticipo_solicitado'
       WHEN pend < 1 THEN 'b_residuo'
       WHEN kcanc OR (m_can AND NOT m_vig) THEN 'd_cancelada'
       WHEN dclase IS NOT NULL THEN 'c_dup_'||dclase
       ELSE 'resto' END capa,
  rfc IS NOT NULL, m_vig, m_can, m_can100, m_vig100
FROM L;
ROLLBACK;
