/* eslint-disable no-console */
/**
 * Sync ERP → catalog.products: costo + rotación para el take-order del vendedor.
 *
 * Lee `Mega_Dulces.public.productos_activos` (conexión DIRECTA al ERP, no via el
 * foreign table erp.* que solo expone `articulo`) y puebla en catalog.products
 * (match por SKU = articulo, tenant mega_dulces):
 *   - cost_with_tax   ← costo_civa        (costo c/IVA unitario → margen)
 *   - cost_per_case   ← costo_x_caja      (costo por caja)
 *   - sales_units_30d ← Σ almXX_actual_30_r (almacenes 10/30/32/50 = los de venta)
 *   - rotation_tier   ← derivado por percentil: alta (>= p75) | media | baja (0 ventas)
 *
 * Idempotente (UPDATE por SKU; re-correr refresca). Solo afecta productos con
 * match en el ERP; el resto queda intacto (NULL → sin chip/margen en la UI).
 *
 * Conexiones:
 *   - ERP (read):  DATABASE_URL_REMOTE_SNAPSHOT con dbname → Mega_Dulces.
 *   - App (write): DATABASE_URL_NEW.
 * Corre donde el ERP (.245) sea alcanzable. El resultado vive en catalog.products
 * (tabla real) → viaja con el deploy; NO se consulta el ERP en runtime.
 *
 * Uso:
 *   node database/scripts/sync-erp-product-costs.js            # aplica
 *   node database/scripts/sync-erp-product-costs.js --dry-run  # solo reporta
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const Knex = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c'; // tenant mega_dulces
const DRY = process.argv.includes('--dry-run');

// Solo alm10/30/32/50 tienen *_actual_30_r (warehouses de venta retail);
// 40/42/44/54 son CEDIS/tránsito (solo existencia/anterior).
const U30 =
  'coalesce(alm10_actual_30_r,0)+coalesce(alm30_actual_30_r,0)+coalesce(alm32_actual_30_r,0)+coalesce(alm50_actual_30_r,0)';

function erpConnString() {
  const base = process.env.DATABASE_URL_REMOTE_SNAPSHOT;
  if (!base) throw new Error('DATABASE_URL_REMOTE_SNAPSHOT no seteado (necesario para alcanzar el ERP)');
  const u = new URL(base);
  u.pathname = '/Mega_Dulces';
  return u.toString();
}

(async () => {
  const erp = Knex({ client: 'pg', connection: erpConnString(), pool: { min: 0, max: 1 } });
  const app = Knex({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
  try {
    // 1) Leer del ERP (chico: ~6.5k filas, pocas columnas).
    const rows = (
      await erp.raw(
        `select articulo,
                costo_civa::numeric         as cost_with_tax,
                costo_x_caja::numeric       as cost_per_case,
                (${U30})::int               as units_30d
           from public.productos_activos
          where articulo is not null`,
      )
    ).rows;
    console.log(`ERP productos_activos leídos: ${rows.length}`);

    if (DRY) {
      const top = [...rows].sort((a, b) => (b.units_30d || 0) - (a.units_30d || 0)).slice(0, 8);
      console.log('\n[DRY-RUN] top rotación (ERP):');
      console.table(top);
      console.log('\nNada escrito. Quitá --dry-run para aplicar.');
      return;
    }

    // 2) Cargar a temp table en la app + UPDATE...FROM (match por SKU) en una trx.
    await app.transaction(async (trx) => {
      await trx.raw(
        `create temp table _erp_pa (articulo text primary key, cost_with_tax numeric, cost_per_case numeric, units_30d int) on commit drop`,
      );
      await trx.batchInsert('_erp_pa', rows, 1000);

      const upd = await trx.raw(
        `update catalog.products p set
           cost_with_tax   = e.cost_with_tax,
           cost_per_case   = e.cost_per_case,
           sales_units_30d = e.units_30d,
           updated_at      = now()
         from _erp_pa e
         where coalesce(p.sku, p.articulo) = e.articulo
           and p.tenant_id = ?
           and p.deleted_at is null`,
        [T],
      );
      console.log(`Costo + unidades 30d actualizados: ${upd.rowCount} filas`);

      const pct = await trx.raw(
        `select percentile_cont(0.75) within group (order by sales_units_30d)::numeric as p75
           from catalog.products where tenant_id = ? and sales_units_30d > 0`,
        [T],
      );
      const p75 = Math.max(1, Math.round(Number(pct.rows[0].p75) || 1));

      const tier = await trx.raw(
        `update catalog.products set rotation_tier = case
             when sales_units_30d >= ? then 'alta'
             when sales_units_30d = 0  then 'baja'
             else 'media' end
          where tenant_id = ? and sales_units_30d is not null`,
        [p75, T],
      );

      const dist = await trx.raw(
        `select rotation_tier, count(*)::int n
           from catalog.products where tenant_id = ? and rotation_tier is not null
          group by rotation_tier order by n desc`,
        [T],
      );
      console.log(`Umbral alta rotación (p75 unidades 30d): ${p75}`);
      console.log(`rotation_tier seteado: ${tier.rowCount} filas`);
      console.table(dist.rows);
    });
    console.log('\nSync OK.');
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await erp.destroy();
    await app.destroy();
  }
})();
