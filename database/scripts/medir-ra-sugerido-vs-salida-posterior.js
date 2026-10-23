#!/usr/bin/env node
/**
 * [RA-MED.1] ¿El comprador MEJORA, REPITE o EMPEORA el sugerido? — medición de sólo lectura contra prod.
 *
 * Árbitro: lo que SALIÓ de ese SKU × sucursal en los días siguientes al pedido, leído del ODS
 * (kepler_ods.kdm1/kdm2), no de nuestras tablas ni de la demanda que usó el motor:
 *   · sucursal  → venta U-D 8/10/12 no cancelada, sin la refactura vecinal (VERDAD_ABSOLUTA §4.4)
 *   · CEDIS 00  → embarques U-D-41 a sucursales (el CEDIS no vende: surte)
 * Unidad: todo en la unidad BASE de Kepler (kdm2.c9); las cajas de la requisición se llevan a base con
 * analytics.v_warehouse_box_factor (base_label = unidad de venta de Kepler en 20,461 de 20,492 pares).
 * Horizonte H = lead (plan) + cadencia (canal); cobertura = (existencia + pedido) / salida diaria posterior.
 * Veredicto por renglón: mejor · normal · peor · sin_medir (nunca cero ni verde).
 *
 * Lo que NO hace: no resta tránsito ni otras entradas (misma política que RA.TR); extrapola la salida
 * observada (hasta ayer) al horizonte H; no reconstruye por qué el motor sugirió lo que sugirió (la línea
 * no guarda su base: min/rop/max llegan en 0). Detalle y cifras del 2026-10-23 en
 * docs/IMPLEMENTACION/FASES/MEDICION_RA_SUGERIDO_Y_CUADRE_KEPLER_2026-10-23.md
 *
 * Uso: node database/scripts/medir-ra-sugerido-vs-salida-posterior.js [desde] [hasta]
 *      (fechas de creación de la requisición; default 2026-09-24 .. 2026-10-08)
 */

// ── corredor compartido (sólo lectura de hecho: temporales + ROLLBACK) ───────────────────────
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const SID_PROD = '7688376744939610156';
function urlProd() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  try {
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    return (env.match(/^DATABASE_URL_NEW=(.+)$/m) || [])[1];
  } catch { return undefined; }
}
function imprimir(x) {
  if (!x.rows || !x.rows.length) return;
  console.log('  ' + Object.keys(x.rows[0]).join(' | '));
  for (const row of x.rows) console.log('  ' + Object.values(row).map((v) => v === null ? '∅' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).join(' | '));
  console.log('');
}
async function correr(titulo, bloques) {
  const url = urlProd();
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: url, application_name: 'medicion-ra-ro' });
  await c.connect();
  try {
    const { rows: [id] } = await c.query('SELECT system_identifier::text AS sid, current_database() AS db FROM pg_control_system()');
    console.log(`\n=== ${titulo} ===\n  destino: ${id.db} · system_identifier ${id.sid}${id.sid === SID_PROD ? '' : '  ⚠️ NO es el prod conocido'}\n`);
    // Temporales y una función en pg_temp exigen READ WRITE dentro de la transacción. Nada se confirma: ROLLBACK siempre.
    await c.query('BEGIN'); await c.query('SET TRANSACTION READ WRITE'); await c.query("SET LOCAL statement_timeout='600s'");
    for (const [nombre, sql] of bloques) {
      const t0 = Date.now();
      const r = await c.query(sql);
      const rs = Array.isArray(r) ? r : [r];
      console.log(`── ${nombre} (${Date.now() - t0} ms)`);
      for (const x of rs) imprimir(x);
    }
  } catch (e) { console.error('ERROR', e.message); process.exitCode = 1; }
  finally { await c.query('ROLLBACK').catch(() => undefined); await c.end(); }
}

const DESDE = process.argv[2] || '2026-09-24';
const HASTA = process.argv[3] || '2026-10-08';
if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE) || !/^\d{4}-\d{2}-\d{2}$/.test(HASTA)) { console.error('fechas YYYY-MM-DD'); process.exit(1); }
const BASE = "create or replace function pg_temp.abs_dist(cov numeric, h numeric) returns numeric language sql immutable as $$\n  select case when cov < h then h - cov when cov > 45 then cov - 45 else 0 end $$;\n-- Demanda posterior: sucursales = venta U-D 8/10/12 (sin refactura vecinal); CEDIS (00) = embarques U-D-41 a sucursales\ncreate temp table _ventas as\nselect btrim(h.sucursal) suc, btrim(d.c8) sku, h.c9::date f, sum(d.c9::numeric) u\nfrom kepler_ods.kdm1 h join kepler_ods.kdm2 d on d.sucursal=h.sucursal and d.c1=h.c1 and d.c2=h.c2 and d.c3=h.c3 and d.c4=h.c4 and d.c5=h.c5 and d.c6=h.c6\nwhere h.c2='U' and h.c3='D' and btrim(h.c1)=btrim(h.sucursal) and coalesce(nullif(btrim(h.c43),''),'')<>'C'\n  and h.c9::date between '2026-09-25' and current_date-1\n  and ( (h.sucursal<>'00' and h.c4::int in (8,10,12) and not (h.c4::int=12 and btrim(coalesce(h.c12,'')) ~ '^[0-9]V[0-9]'))\n     or (h.sucursal='00' and h.c4::int=41) )\ngroup by 1,2,3;\ncreate temp table _lineas as\nselect r.id rq_id, r.folio, r.estado, (r.created_at at time zone 'America/Mexico_City')::date d, w.kepler_code suc, w.name sucursal, p.sku, p.nombre,\n       s.code prov, s.name proveedor, r.created_by comprador,\n       bf.box_factor bf, bf.base_label,\n       l.suggested_qty sug_cajas, l.final_qty fin_cajas, l.on_hand oh_cajas, l.unit_cost costo_caja,\n       l.suggested_qty*bf.box_factor S, l.final_qty*bf.box_factor F, l.on_hand*bf.box_factor OH,\n       rpl.lead_days lead_pl, ch.cadence_days cad_ch, rpl.daily_pieces dp_motor,\n       coalesce(rpl.lead_days, 7) + coalesce(ch.cadence_days, 14) H\nfrom commercial.purchase_requisition_lines l\njoin commercial.purchase_requisitions r on r.id=l.requisition_id\njoin commercial.warehouses w on w.id=r.warehouse_id\njoin catalog.products p on p.id=l.product_id\nleft join catalog.suppliers s on s.id=r.supplier_id\nleft join analytics.v_warehouse_box_factor bf on bf.warehouse_id=r.warehouse_id and bf.product_id=l.product_id\nleft join commercial.replenishment_channel ch on ch.warehouse_id=r.warehouse_id and ch.supplier_id=r.supplier_id and ch.via='purchase'\nleft join analytics.replenishment_plan rpl on rpl.warehouse_id=r.warehouse_id and rpl.product_id=l.product_id\nwhere r.source_type='supplier' and r.estado in ('approved','ordered','received')\n  and r.created_at::date between '2026-09-24' and '2026-10-08' and w.kepler_code is not null;\ncreate temp table _m1 as\nselect x.*, least(x.d + x.H::int, current_date-1) - x.d as hobs,\n  coalesce((select sum(u) from _ventas v where v.suc=x.suc and v.sku=x.sku and v.f between x.d+1 and least(x.d + x.H::int, current_date-1)),0) V\nfrom _lineas x;\ncreate temp table _ver as\nselect m.*, case when hobs>0 then V/hobs end rate,\n  case when hobs < 7 then 'sin_medir:ventana_corta'\n       when V = 0 and OH <= 0 then 'sin_medir:agotado_sin_salida'\n       when S = F then 'normal:sin_cambio'\n       when V = 0 and OH > 0 then case when F > S then 'peor:sin_salida_pidio_mas' else 'mejor:sin_salida_pidio_menos' end\n       when dist_f < dist_s then 'mejor' when dist_f > dist_s then 'peor' else 'normal' end veredicto,\n  case when V>0 then round((OH+S)/(V/hobs),1) end cov_s, case when V>0 then round((OH+F)/(V/hobs),1) end cov_f\nfrom (select m.*, case when V>0 then pg_temp.abs_dist((OH+S)/(V/hobs), H) end dist_s, case when V>0 then pg_temp.abs_dist((OH+F)/(V/hobs), H) end dist_f from _m1 m) m;\n".replace("'2026-09-24' and '2026-10-08'", "'" + DESDE + "' and '" + HASTA + "'");
const CORTES = "select veredicto, count(*) n, count(distinct rq_id) reqs, round(sum(case when F>S then (F-S)/bf*costo_caja else 0 end)) mxn_extra, round(sum(case when F<S then (S-F)/bf*costo_caja else 0 end)) mxn_recortado from _ver group by 1 order by 2 desc;\nselect case when F>S then 'subio' when F<S then 'bajo' else 'igual' end dir, split_part(veredicto,':',1) v, count(*) n, round(avg(hobs),1) hobs, round(avg(H),1) h_obj, round(avg(cov_s),1) cov_s, round(avg(cov_f),1) cov_f from _ver group by 1,2 order by 1,2;\nselect sucursal, count(*) n, count(*) filter (where veredicto like 'mejor%') mejor, count(*) filter (where veredicto like 'peor%') peor, count(*) filter (where veredicto like 'normal%') normal, count(*) filter (where veredicto like 'sin_medir%') sin_medir, round(sum(case when veredicto like 'peor%' and F>S then (F-S)/bf*costo_caja else 0 end)) mxn_peor_extra from _ver group by 1 order by 2 desc;\nselect comprador, count(*) n, count(*) filter (where veredicto like 'mejor%') mejor, count(*) filter (where veredicto like 'peor%') peor, count(*) filter (where veredicto like 'normal%') normal, count(*) filter (where veredicto like 'sin_medir%') sin_medir, round(sum(case when veredicto like 'peor%' and F>S then (F-S)/bf*costo_caja else 0 end)) mxn_peor_extra from _ver group by 1 order by 2 desc;\nselect proveedor, count(*) n, count(*) filter (where veredicto like 'mejor%') mejor, count(*) filter (where veredicto like 'peor%') peor, count(*) filter (where veredicto like 'normal%') normal, count(*) filter (where veredicto like 'sin_medir%') sin_medir, round(sum(case when veredicto like 'peor%' and F>S then (F-S)/bf*costo_caja else 0 end)) mxn_peor_extra from _ver group by 1 order by 2 desc limit 12;\n-- ¿el sugerido en sí estaba bien? cobertura que daba S vs intervalo [H,45]\nselect case when cov_s is null then 'sin_medir' when cov_s < H then 'S corto (agotaría)' when cov_s > 45 then 'S largo (>45 d)' else 'S en rango' end sug_juicio,\n       case when cov_f is null then 'sin_medir' when cov_f < H then 'F corto' when cov_f > 45 then 'F largo' else 'F en rango' end fin_juicio, count(*) n from _ver group by 1,2 order by 1,2;\nselect count(*) n, count(lead_pl) con_lead_plan, count(cad_ch) con_cadencia, count(*) filter (where sug_cajas=0) sug_cero, round(100.0*count(*) filter (where sug_cajas=0)/count(*),1) pct_sug_cero from _ver;\nselect count(*) filter (where suc='00') cedis, count(*) filter (where suc='00' and V>0) cedis_con_salida, count(*) filter (where suc<>'00') suc, count(*) filter (where suc<>'00' and V>0) suc_con_venta from _ver;\nselect folio, sucursal, sku, left(nombre,24) nom, bf, base_label, oh_cajas, sug_cajas, fin_cajas, costo_caja, round(H) H, hobs, round(V,1) V, cov_s, cov_f, veredicto from _ver where veredicto in ('mejor','peor') and suc='00' order by random() limit 10;\n";
const SALIDAS = "select sug_cajas=0 sug_cero, split_part(veredicto,':',1) v, count(*) n, round(sum(F/bf*costo_caja)) mxn_pedido from _ver group by 1,2 order by 1,2;\nselect estado, split_part(veredicto,':',1) v, count(*) n from _ver group by 1,2 order by 1,2;\nselect split_part(veredicto,':',1) v, count(*) n, round(100.0*count(*)/sum(count(*)) over(),1) pct, round(sum(F/bf*costo_caja)) mxn_pedido_total, round(sum(case when F>S then (F-S)/bf*costo_caja else 0 end)) mxn_sumado_al_sugerido from _ver group by 1 order by 2 desc;\n-- medible: cuánto se agotaría con S y con F (días de cobertura mediana)\nselect percentile_cont(0.5) within group (order by cov_s) cov_s_med, percentile_cont(0.5) within group (order by cov_f) cov_f_med, percentile_cont(0.5) within group (order by H) h_med from _ver where cov_s is not null;\n";
correr('[RA-MED.1] sugerido vs salida posterior · requisiciones de compra creadas ' + DESDE + ' .. ' + HASTA, [
  ['universo y veredictos', BASE],
  ['cortes: veredicto, dirección, sucursal, comprador, proveedor, juicio del sugerido', CORTES],
  ['cortes: sugerido en 0, estado, totales, cobertura mediana', SALIDAS],
]);
