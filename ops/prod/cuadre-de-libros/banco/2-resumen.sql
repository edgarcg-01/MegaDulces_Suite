, nm AS MATERIALIZED (SELECT DISTINCT ON (btrim(c2)) btrim(c2) acr, left(btrim(c3),30) nombre FROM kepler_ods.kdxd ORDER BY btrim(c2)),
o AS (
SELECT 0 ord, 'R|P_banco|'||(SELECT count(*) FROM p)||'|'||(SELECT round(sum(amt)) FROM p)||'|emparejados|'||(SELECT count(*) FROM pm)||'|'||(SELECT round(sum(p.amt)) FROM pm JOIN p USING (pid))||'|sin_salida|'||(SELECT count(*) FROM pu)||'|'||(SELECT round(sum(amt)) FROM pu)||'|sin_salida>=50k|'||(SELECT count(*) FROM pu WHERE amt>=50000)||'|'||(SELECT round(sum(amt)) FROM pu WHERE amt>=50000) t
UNION ALL SELECT 0, 'R|pass|'||pass||'|'||count(*)||'|'||round(sum(p.amt)) FROM pm JOIN p USING (pid) GROUP BY pass
UNION ALL SELECT 0, 'R|B_rep|'||count(*)||'|'||round(sum(ao))||'|match|'||count(*) FILTER (WHERE bid IN (SELECT bid FROM pm))||'|'||round(sum(ao) FILTER (WHERE bid IN (SELECT bid FROM pm))) FROM b WHERE d BETWEEN '2026-10-06' AND '2026-11-14'
UNION ALL SELECT 0, 'R|devueltas_rep|'||count(*)||'|'||round(sum(ao)) FROM b0 WHERE devuelta AND d BETWEEN '2026-10-06' AND '2026-11-14'
UNION ALL SELECT 1, 'BU|'||clase||'|'||count(*)||'|'||round(sum(ao))||'|>=50k:'||count(*) FILTER (WHERE ao>=50000)||'|'||coalesce(round(sum(ao) FILTER (WHERE ao>=50000)),0) FROM bu WHERE d BETWEEN '2026-10-06' AND '2026-11-14' GROUP BY clase
UNION ALL SELECT 2, 'PU|'||pu.suc||'|'||pu.acr||'|'||coalesce(nm.nombre,'?')||'|'||pu.tipo||'-'||pu.folio||'|'||pu.d||'|'||pu.lbl||'|'||pu.amt||'|'||coalesce(pu.capt,'') FROM pu LEFT JOIN nm USING (acr) WHERE pu.amt>=50000
UNION ALL SELECT 3, 'P4|'||p.suc||'|'||p.acr||'|'||p.tipo||'-'||p.folio||'|'||p.d||'|'||p.lbl||'|'||p.amt||'|banco:'||b.lbl||'@'||b.d||':'||b.ao||'|'||left(b.concept,40) FROM pm JOIN p USING (pid) JOIN b USING (bid) WHERE pm.pass=4
UNION ALL SELECT 4, 'BU|'||clase||'|'||lbl||'|'||d||'|'||ao||'|'||rt||'|'||left(concept,50)||'|'||src FROM bu WHERE d BETWEEN '2026-10-06' AND '2026-11-14' AND ao>=50000 AND clase NOT IN ('1 traspaso propio')
)
SELECT t FROM o ORDER BY ord, t;
ROLLBACK;
