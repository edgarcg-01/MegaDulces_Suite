WITH acc AS MATERIALIZED (SELECT id, account_label lbl, kind FROM finance.bank_accounts WHERE tenant_id='00000000-0000-0000-0000-00000000d01c'),
lib AS MATERIALIZED (
  SELECT 'L'||m.id::text bid, a.lbl, m.movement_date d, m.amount_out ao, m.amount_in ai, coalesce(m.concept,'') concept, coalesce(m.raw_type,'') rt, coalesce(m.raw_code,'') rc, m.sync_source src
  FROM finance.bank_movements m JOIN acc a ON a.id=m.bank_account_id
  WHERE m.tenant_id='00000000-0000-0000-0000-00000000d01c' AND m.deleted_at IS NULL AND m.movement_date BETWEEN '2026-09-20' AND '2026-11-23' AND a.kind<>'cash'),
dsl AS MATERIALIZED (
  SELECT DISTINCT ON (l.bank_account_id, l.movement_date, l.amount_out, l.amount_in, coalesce(l.reference,''), coalesce(l.concept,''), l.running_balance)
   'D'||l.id::text bid, a.lbl, l.movement_date d, l.amount_out ao, l.amount_in ai, coalesce(l.concept,'')||' '||coalesce(l.reference,'')||' '||coalesce(l.counterparty_name,'') concept, ''::text rt, ''::text rc, 'descarga'::text src
  FROM finance.bank_statement_lines l JOIN acc a ON a.id=l.bank_account_id
  WHERE l.tenant_id='00000000-0000-0000-0000-00000000d01c' AND l.movement_date BETWEEN '2026-09-20' AND '2026-11-23'),
dadd AS MATERIALIZED (
  SELECT s.* FROM dsl s WHERE NOT EXISTS (SELECT 1 FROM lib x WHERE x.lbl=s.lbl AND x.ao=s.ao AND x.ai=s.ai AND abs(x.d-s.d)<=1)),
mv AS MATERIALIZED (SELECT * FROM lib UNION ALL SELECT * FROM dadd),
ob AS MATERIALIZED (SELECT o.*, row_number() OVER (PARTITION BY o.lbl, o.ao, o.d ORDER BY (o.rt<>'S'), (o.concept NOT ILIKE '%SPEI ENVIADO%'), o.bid) orn FROM mv o WHERE o.ao>0),
rtn AS MATERIALIZED (SELECT i.lbl, i.ai, i.d, row_number() OVER (PARTITION BY i.lbl, i.ai, i.d ORDER BY i.bid) rrn FROM mv i WHERE i.ai>0 AND (i.rt='DS' OR i.concept ILIKE '%DEVOL%')),
b0 AS MATERIALIZED (
  SELECT ob.*,
   EXISTS (SELECT 1 FROM rtn WHERE rtn.lbl=ob.lbl AND rtn.ai=ob.ao AND rtn.d=ob.d AND rtn.rrn=ob.orn) devuelta,
   EXISTS (SELECT 1 FROM mv i WHERE i.lbl<>ob.lbl AND i.ai=ob.ao AND abs(i.d-ob.d)<=1) entra_en_propia
  FROM ob),
b AS MATERIALIZED (SELECT * FROM b0 WHERE NOT devuelta),
p0 AS MATERIALIZED (
 SELECT x.sucursal||'|'||btrim(x.c2)||'|'||x.c4||'-'||x.c5||'-'||btrim(x.c6) pid, x.sucursal suc, btrim(x.c2) acr, x.c4::int tipo, btrim(x.c6) folio, x.c7::date d, x.c11 amt, btrim(x.c22) cta,
  CASE btrim(x.c22) WHEN '6506' THEN '506' WHEN '5854' THEN '854' ELSE btrim(x.c22) END lbl,
  (SELECT max(m.c67) FROM kepler_ods.kdm1 m WHERE m.c3='D' AND btrim(m.c1)=m.sucursal AND m.sucursal=x.sucursal AND m.c1=x.c1 AND m.c10=x.c2 AND m.c4=x.c4 AND m.c5=x.c5 AND m.c6=x.c6) capt
 FROM kepler_ods.kdxe x
 WHERE btrim(x.c1)=x.sucursal AND x.c3='D' AND x.c4 IN (25,26,45,60) AND x.c7>='2026-10-01' AND x.c7<'2026-11-18' AND btrim(x.c2) NOT LIKE 'TI%' AND x.c11>0
  AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 m WHERE m.c3='D' AND m.c43='C' AND btrim(m.c1)=m.sucursal AND m.sucursal=x.sucursal AND m.c1=x.c1 AND m.c10=x.c2 AND m.c4=x.c4 AND m.c5=x.c5 AND m.c6=x.c6)),
p AS MATERIALIZED (SELECT * FROM p0 WHERE lbl IN (SELECT lbl FROM acc WHERE kind='bank')),
c1 AS MATERIALIZED (
 SELECT p.pid, b.bid, abs(b.d-(p.d+__SHIFT_DAYS__))*100 + abs(b.ao-(p.amt+__SHIFT_AMT__)) sc FROM p JOIN b ON b.lbl=p.lbl AND abs(b.ao-(p.amt+__SHIFT_AMT__))<=1 AND (b.d-(p.d+__SHIFT_DAYS__)) BETWEEN -3 AND (CASE WHEN p.tipo=25 THEN 60 ELSE 5 END)),
m1 AS MATERIALIZED (SELECT pid,bid FROM (SELECT c1.*, row_number() OVER (PARTITION BY pid ORDER BY sc,bid) rp, row_number() OVER (PARTITION BY bid ORDER BY sc,pid) rb FROM c1) z WHERE rp=1 AND rb=1),
c2 AS MATERIALIZED (SELECT c1.* FROM c1 WHERE pid NOT IN (SELECT pid FROM m1) AND bid NOT IN (SELECT bid FROM m1)),
m2 AS MATERIALIZED (SELECT pid,bid FROM (SELECT c2.*, row_number() OVER (PARTITION BY pid ORDER BY sc,bid) rp, row_number() OVER (PARTITION BY bid ORDER BY sc,pid) rb FROM c2) z WHERE rp=1 AND rb=1),
c3 AS MATERIALIZED (SELECT c2.* FROM c2 WHERE pid NOT IN (SELECT pid FROM m2) AND bid NOT IN (SELECT bid FROM m2)),
m3 AS MATERIALIZED (SELECT pid,bid FROM (SELECT c3.*, row_number() OVER (PARTITION BY pid ORDER BY sc,bid) rp, row_number() OVER (PARTITION BY bid ORDER BY sc,pid) rb FROM c3) z WHERE rp=1 AND rb=1),
mx AS MATERIALIZED (SELECT pid,bid,1 pass FROM m1 UNION ALL SELECT pid,bid,2 FROM m2 UNION ALL SELECT pid,bid,3 FROM m3),
g AS MATERIALIZED (SELECT lbl, acr, d, sum(amt) amt, count(*) n, array_agg(pid) pids FROM p WHERE pid NOT IN (SELECT pid FROM mx) GROUP BY 1,2,3 HAVING count(*)>1),
cg AS MATERIALIZED (SELECT g.lbl||'|'||g.acr||'|'||g.d gid, g.pids, b.bid, abs(b.d-(g.d+__SHIFT_DAYS__))*100+abs(b.ao-(g.amt+__SHIFT_AMT__)) sc FROM g JOIN b ON b.lbl=g.lbl AND abs(b.ao-(g.amt+__SHIFT_AMT__))<=1 AND (b.d-(g.d+__SHIFT_DAYS__)) BETWEEN -3 AND 5 WHERE b.bid NOT IN (SELECT bid FROM mx)),
mg AS MATERIALIZED (SELECT gid,pids,bid FROM (SELECT cg.*, row_number() OVER (PARTITION BY gid ORDER BY sc,bid) rp, row_number() OVER (PARTITION BY bid ORDER BY sc,gid) rb FROM cg) z WHERE rp=1 AND rb=1),
pm AS MATERIALIZED (SELECT pid, bid, pass FROM mx UNION ALL SELECT unnest(pids), bid, 4 FROM mg),
pu AS MATERIALIZED (SELECT p.* FROM p WHERE pid NOT IN (SELECT pid FROM pm)),
bu AS MATERIALIZED (SELECT b.*,
  CASE WHEN b.rt IN ('TE','TL') OR b.concept ~* 'TRASPASO|TREASPASO|ENTRE C' OR b.entra_en_propia THEN '1 traspaso propio'
       WHEN b.rc IN ('610','6120','160') OR b.concept ~* 'NOMINA|NOM\.? ?[0-9]|N4[0-9] |FINIQUITO|CAJA DE AHORRO|PRESTAMO CAJA' THEN '2 nomina'
       WHEN b.concept ~* '(^| )SAT( |$)|IMSS|INFONAVIT|IMPUESTO|(^| )SUA( |$)|TESOFE|ISR|CONTRIBUC|REFERENCIADO|SHCP' THEN '3 impuestos'
       WHEN b.rc IN ('612','147') OR b.concept ~* 'COMISI|I\.? ?V\.? ?A\.? |IVA |RENTA TERMINAL|CUOTA|MEMBRESIA|TASA DE DES|ADMINISTRACION RENTA|COM SERV|COM VTAS|CARGO POR PAGO CONCENTRAC' THEN '4 comisiones e IVA'
       WHEN b.rt IN ('PL','LC','PF') OR b.concept ~* 'RETIRO|CREDITO LIQUIDO|FINANCIERA|PAGO LEM|CHEQUE|EFECTIVO' THEN '5 retiros/financiamiento/cheques'
       WHEN b.concept ~* 'DISPOSICION POR POS|COMPRA ' THEN '6 compras con tarjeta'
       WHEN b.rt='C' OR b.rc IN ('510','102') THEN '7 proveedor (libro con nombre)'
       WHEN b.rt='G' THEN '8 gasto (libro)'
       WHEN b.src IN ('banco','descarga') THEN '9 transferencia a tercero sin nombre (descarga)'
       ELSE 'z otros' END clase
  FROM b WHERE bid NOT IN (SELECT bid FROM pm))
