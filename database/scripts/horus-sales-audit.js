/* eslint-disable no-console */
/**
 * Read-only — audita la data de VENTA de campo para Horus H2.7 (venta↔ejecución).
 * ¿Hay con qué correlacionar ejecución (daily_captures) con venta real?
 *   - commercial.route_tickets  (cierre de ruta: venta/carga/combustible, vendor_user_id, total)
 *   - commercial.vendor_sale_lines (líneas de venta por tienda/producto/vendedor)
 *   - enlace vendor_user_id ↔ daily_captures.user_id
 * No escribe nada. Correr: node database/scripts/horus-sales-audit.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

(async () => {
  const out = [];
  const log = (...a) => out.push(a.join(' '));

  log('=== route_tickets por tipo (60d) ===');
  const rt = await knex.raw(
    `SELECT ticket_type,
            count(*)::int n,
            count(vendor_user_id)::int with_vendor,
            count(total)::int with_total,
            round(avg(total)::numeric,2) avg_total,
            round(sum(total)::numeric,2) sum_total,
            min(ticket_date) min_d, max(ticket_date) max_d
       FROM commercial.route_tickets
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND ticket_date >= current_date - 60
      GROUP BY ticket_type ORDER BY n DESC`,
    [T],
  );
  rt.rows.forEach((r) =>
    log(`  ${r.ticket_type.padEnd(12)} n=${r.n} vendor=${r.with_vendor} total=${r.with_total} avg=${r.avg_total} sum=${r.sum_total} [${r.min_d?.toISOString?.().slice(0,10)}..${r.max_d?.toISOString?.().slice(0,10)}]`),
  );

  log('\n=== route_tickets VENTA: 30d vs 60d, vendedores distintos ===');
  const v30 = await knex.raw(
    `SELECT count(*)::int n, count(DISTINCT vendor_user_id)::int vendors, round(sum(total)::numeric,2) sum_total
       FROM commercial.route_tickets
      WHERE tenant_id=? AND deleted_at IS NULL AND ticket_type='venta' AND ticket_date >= current_date - 30`,
    [T],
  );
  log(`  30d: tickets=${v30.rows[0].n} vendedores=${v30.rows[0].vendors} sum=${v30.rows[0].sum_total}`);

  log('\n=== vendor_sale_lines (60d) ===');
  const vsl = await knex.raw(
    `SELECT count(*)::int n,
            count(DISTINCT store_id)::int stores,
            count(DISTINCT vendor_user_id)::int vendors,
            count(DISTINCT product_id)::int products,
            round(sum(quantity)::numeric,2) sum_qty,
            min(sale_date) min_d, max(sale_date) max_d
       FROM commercial.vendor_sale_lines
      WHERE tenant_id=? AND deleted_at IS NULL AND sale_date >= current_date - 60`,
    [T],
  );
  const s = vsl.rows[0];
  log(`  n=${s.n} stores=${s.stores} vendors=${s.vendors} products=${s.products} sum_qty=${s.sum_qty} [${s.min_d?.toISOString?.().slice(0,10)}..${s.max_d?.toISOString?.().slice(0,10)}]`);

  log('\n=== ENLACE: vendedores con CAPTURAS y con VENTA (30d) ===');
  const link = await knex.raw(
    `WITH cap AS (
        SELECT DISTINCT user_id FROM daily_captures
         WHERE tenant_id=? AND hora_inicio >= now() - interval '30 days' AND user_id IS NOT NULL
     ), vt AS (
        SELECT DISTINCT vendor_user_id uid FROM commercial.route_tickets
         WHERE tenant_id=? AND deleted_at IS NULL AND ticket_type='venta' AND ticket_date >= current_date - 30 AND vendor_user_id IS NOT NULL
     ), vl AS (
        SELECT DISTINCT vendor_user_id uid FROM commercial.vendor_sale_lines
         WHERE tenant_id=? AND deleted_at IS NULL AND sale_date >= current_date - 30 AND vendor_user_id IS NOT NULL
     )
     SELECT (SELECT count(*) FROM cap)::int captores,
            (SELECT count(*) FROM vt)::int con_venta_ticket,
            (SELECT count(*) FROM cap c WHERE EXISTS (SELECT 1 FROM vt WHERE uid=c.user_id))::int captor_y_ticket,
            (SELECT count(*) FROM cap c WHERE EXISTS (SELECT 1 FROM vl WHERE uid=c.user_id))::int captor_y_lineas`,
    [T, T, T],
  );
  const l = link.rows[0];
  log(`  captores(30d)=${l.captores} | con venta-ticket=${l.con_venta_ticket} | captor∩ticket=${l.captor_y_ticket} | captor∩líneas=${l.captor_y_lineas}`);

  log('\n=== ENLACE tienda: stores con captura Y con vendor_sale_lines (30d) ===');
  const storeLink = await knex.raw(
    `WITH capst AS (
        SELECT DISTINCT store_id FROM daily_captures
         WHERE tenant_id=? AND hora_inicio >= now() - interval '30 days' AND store_id IS NOT NULL
     ), vlst AS (
        SELECT DISTINCT store_id FROM commercial.vendor_sale_lines
         WHERE tenant_id=? AND deleted_at IS NULL AND sale_date >= current_date - 30 AND store_id IS NOT NULL
     )
     SELECT (SELECT count(*) FROM capst)::int tiendas_capturadas,
            (SELECT count(*) FROM vlst)::int tiendas_con_venta,
            (SELECT count(*) FROM capst c WHERE EXISTS (SELECT 1 FROM vlst WHERE store_id=c.store_id))::int interseccion`,
    [T, T],
  );
  const sl = storeLink.rows[0];
  log(`  tiendas capturadas=${sl.tiendas_capturadas} | tiendas con venta=${sl.tiendas_con_venta} | intersección=${sl.interseccion}`);

  console.log(out.join('\n'));
  console.log('\n(read-only; no se escribió nada)');
  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
