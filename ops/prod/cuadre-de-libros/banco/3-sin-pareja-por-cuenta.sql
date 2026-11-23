, nm AS MATERIALIZED (SELECT DISTINCT ON (btrim(c2)) btrim(c2) acr, left(btrim(c3),35) nombre FROM kepler_ods.kdxd ORDER BY btrim(c2)),
o AS (
SELECT 1 ord, 'PU_cta|'||lbl||'|'||count(*)||'|'||round(sum(amt))||'|>50k:'||count(*) FILTER (WHERE amt>=50000)||'|'||coalesce(round(sum(amt) FILTER (WHERE amt>=50000)),0) t FROM pu GROUP BY lbl
UNION ALL
SELECT 2, 'PU|'||pu.suc||'|'||pu.acr||'|'||coalesce(nm.nombre,'?')||'|'||pu.tipo||'-'||pu.folio||'|'||pu.d||'|'||pu.lbl||'|'||pu.amt||'|'||coalesce(pu.capt,'')
  ||'|otra_cta:'||coalesce((SELECT string_agg(b.lbl||'@'||b.d||':'||b.ao||(CASE WHEN b.bid IN (SELECT bid FROM pm) THEN '(usada)' ELSE '' END),',') FROM b WHERE abs(b.ao-pu.amt)<=1 AND (b.d-pu.d) BETWEEN -3 AND 5),'-')
  FROM pu LEFT JOIN nm ON nm.acr=pu.acr WHERE pu.amt>=50000
UNION ALL
SELECT 3, 'BU|'||clase||'|'||lbl||'|'||d||'|'||ao||'|'||rt||'|'||rc||'|'||left(concept,60)||'|'||src FROM bu WHERE d BETWEEN '2026-10-06' AND '2026-11-14' AND ao>=50000 AND clase IN ('7 proveedor (libro con nombre)','9 transferencia a tercero sin nombre (descarga)','5 retiros/financiamiento/cheques','8 gasto (libro)','2 nomina','z otros')
)
SELECT t FROM o ORDER BY ord, t;
ROLLBACK;
