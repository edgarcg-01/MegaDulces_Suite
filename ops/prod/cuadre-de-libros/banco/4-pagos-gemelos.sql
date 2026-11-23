, nm AS MATERIALIZED (SELECT DISTINCT ON (btrim(c2)) btrim(c2) acr, left(btrim(c3),30) nombre FROM kepler_ods.kdxd ORDER BY btrim(c2)),
tw AS MATERIALIZED (
  SELECT a.pid pa, b.pid pb, a.acr, a.amt, a.d da, b.d db, a.suc sa, b.suc sb, a.tipo||'-'||a.folio fa, b.tipo||'-'||b.folio fb, a.lbl la, b.lbl lb, a.capt ca, b.capt cb
  FROM p0 a JOIN p0 b ON a.acr=b.acr AND a.amt=b.amt AND a.pid<b.pid AND abs(a.d-b.d)<=5 WHERE a.amt>=1000),
twc AS MATERIALIZED (
  SELECT tw.*, (SELECT count(*) FROM b x WHERE abs(x.ao-tw.amt)<=1 AND x.d BETWEEN least(tw.da,tw.db)-3 AND greatest(tw.da,tw.db)+5) n_salidas FROM tw),
ctl AS MATERIALIZED (
  SELECT count(*) n FROM p0 a JOIN p0 b ON a.acr=b.acr AND a.amt=b.amt AND a.pid<b.pid AND abs(a.d-b.d) BETWEEN 20 AND 25 WHERE a.amt>=1000),
o AS (
SELECT 1 ord, 'TW_sum|pares:'||count(*)||'|monto_un_lado:'||round(sum(amt))||'|con_0_salidas:'||count(*) FILTER (WHERE n_salidas=0)||'|con_1_salida:'||count(*) FILTER (WHERE n_salidas=1)||'|'||coalesce(round(sum(amt) FILTER (WHERE n_salidas=1)),0)||'|con_2+:'||count(*) FILTER (WHERE n_salidas>=2)||'|misma_suc:'||count(*) FILTER (WHERE sa=sb)||'|ctrl_20a25dias:'||(SELECT n FROM ctl) t FROM twc
UNION ALL
SELECT 2, 'TW|'||acr||'|'||coalesce(nm.nombre,'?')||'|'||amt||'|'||sa||':'||fa||'@'||da||'/'||la||'/'||coalesce(ca,'')||'|'||sb||':'||fb||'@'||db||'/'||lb||'/'||coalesce(cb,'')||'|salidas:'||n_salidas FROM twc LEFT JOIN nm USING (acr) WHERE n_salidas<=1
)
SELECT t FROM o ORDER BY ord, t;
ROLLBACK;
