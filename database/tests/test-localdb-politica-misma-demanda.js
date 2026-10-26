/**
 * `[AB.40]` LA POLÍTICA SE ESCRIBE CON LA DEMANDA DEL PEDIDO — los dos importers REALES contra una base real.
 *
 * Regla 13: lo que escribe se ejerce. Corre `import-computed-reorder.js` e `import-network-reorder.js` con
 * `--apply` contra la BASE LOCAL DE PRUEBAS (se niega a correr contra prod) sobre una red sembrada:
 *
 *   ZZ-HUB (vende 2/día) ──surte──▶ ZZ-SUC (vende 10/día)
 *                         └─surte──▶ RUTA-ZZ (vende 5/día, sin inventory_health: como las rutas reales)
 *
 * `inventory_health` lleva a propósito una venta EQUIVOCADA (3/día en ZZ-SUC, 1/día en ZZ-HUB) y
 * `demand_cv` = 0.5. Si el importer leyera la media de ahí (lo de antes), las cifras no cuadran: esa es la
 * negativa, sembrada en el dato. Cuentas a mano (lead 7, ciclo 14, clase C → Z 1.2816; red → Z 2.0537):
 *
 *   ZZ-SUC: μ 10, σ 5 → seguridad ⌈1.2816·5·√7⌉ = 17 · reorden 70+17 = 87 · máximo 87+140 = 227
 *   ZZ-HUB: μ 2+10+5 = 17, σ √(5²+0²+1²) = 5.099 → seguridad ⌈2.0537·5.099·√7⌉ = 28 ·
 *           reorden ⌈119⌉+28 = 147 · máximo 147+⌈238⌉ = 385   (la ruta SÍ cuenta: sin ella, μ = 12)
 *
 * Borra todo lo que siembra.
 *
 * Uso: node database/tests/test-localdb-politica-misma-demanda.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const PROD_SID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.REQ_TEST_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform';
const K = path.join(__dirname, '..', 'importers', 'kepler');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };

const db = require('knex')({ client: 'pg', connection: URL, pool: { min: 0, max: 1 } });
const id = { hub: randomUUID(), suc: randomUUID(), ruta: randomUUID(), prod: randomUUID(), marca: randomUUID() };
let vistaCreada = false;

(async () => {
  const sid = (await db.raw('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid === PROD_SID) throw new Error('esta prueba ESCRIBE: se niega a correr contra producción');

  // La base local va atrasada: si no tiene la vista de clase ABC, una vacía (todo cae a clase C, como
  // sin clase en prod). Se borra al final sólo si la creó esta prueba.
  if (!(await db.raw("SELECT to_regclass('analytics.v_abc_class') r")).rows[0].r) {
    await db.raw(`CREATE VIEW analytics.v_abc_class AS SELECT NULL::uuid tenant_id, NULL::uuid warehouse_id, NULL::uuid product_id,
                  NULL::text abc_class, NULL::text clase_motivo WHERE false`);
    vistaCreada = true;
  }
  await db('catalog.brands').insert({ id: id.marca, tenant_id: T, nombre: 'Marca prueba AB40' });
  await db('catalog.products').insert({ id: id.prod, tenant_id: T, sku: 'ZZAB40', nombre: 'Producto prueba AB40', brand_id: id.marca });
  await db('commercial.warehouses').insert({ id: id.hub, tenant_id: T, code: 'ZZ-HUB', name: 'Matriz prueba' });
  await db('commercial.warehouses').insert({ id: id.suc, tenant_id: T, code: 'ZZ-SUC', name: 'Sucursal prueba', source_warehouse_id: id.hub });
  await db('commercial.warehouses').insert({ id: id.ruta, tenant_id: T, code: 'RUTA-ZZ', name: 'Ruta prueba', source_warehouse_id: id.hub });
  await db('analytics.product_demand').insert([
    { tenant_id: T, warehouse_id: id.hub, product_id: id.prod, window_days: 30, daily_pieces: 2 },
    { tenant_id: T, warehouse_id: id.suc, product_id: id.prod, window_days: 30, daily_pieces: 10 },
    { tenant_id: T, warehouse_id: id.ruta, product_id: id.prod, window_days: 30, daily_pieces: 5 },
  ]);
  // La venta EQUIVOCADA de antes (la negativa): si la política la leyera, saldría con 3 y 1.
  await db('analytics.inventory_health').insert([
    { tenant_id: T, warehouse_id: id.suc, product_id: id.prod, avg_daily_units: 3, stddev_daily_units: 1.5, demand_cv: 0.5 },
    { tenant_id: T, warehouse_id: id.hub, product_id: id.prod, avg_daily_units: 1, stddev_daily_units: 0.5, demand_cv: 0.5 },
  ]);

  const env = { ...process.env, DATABASE_URL_NEW: URL };
  for (const imp of ['import-computed-reorder.js', 'import-network-reorder.js']) {
    const out = execFileSync('node', [path.join(K, imp), '--apply'], { env, encoding: 'utf8' });
    ok(/\[APPLY\] COMMIT/.test(out), `${imp} corrió y escribió`, out.split('\n').slice(-4).join(' | '));
  }

  const pol = async (w) => db('commercial.reorder_policy').where({ tenant_id: T, warehouse_id: w, product_id: id.prod }).first();
  const suc = await pol(id.suc);
  const hub = await pol(id.hub);
  ok(suc && Number(suc.min_stock) === 17 && Number(suc.reorder_point) === 87 && Number(suc.max_stock) === 227,
    'ZZ-SUC: mín 17 · reorden 87 · máx 227 (con la demanda del pedido, no la de inventory_health)',
    suc && [suc.min_stock, suc.reorder_point, suc.max_stock]);
  ok(hub && Number(hub.min_stock) === 28 && Number(hub.reorder_point) === 147 && Number(hub.max_stock) === 385,
    'ZZ-HUB: mín 28 · reorden 147 · máx 385 (la red completa, ruta incluida)',
    hub && [hub.min_stock, hub.reorder_point, hub.max_stock]);
  ok(!(await pol(id.ruta)), 'la ruta no recibe política propia (no tiene inventory_health), sólo suma a su matriz');
})().catch((e) => { fail++; console.log('  ✗ error:', e.message); })
  .finally(async () => {
    try {
      const ws = [id.hub, id.suc, id.ruta];
      if (await db.schema.withSchema('analytics').hasTable('master_data_history')) {
        await db('analytics.master_data_history').whereRaw('row_pk::text LIKE ?', [`%${id.prod}%`]).del().catch(() => undefined);
      }
      await db('commercial.reorder_policy').whereIn('warehouse_id', ws).del();
      await db('analytics.inventory_health').whereIn('warehouse_id', ws).del();
      await db('analytics.product_demand').whereIn('warehouse_id', ws).del();
      await db('commercial.warehouses').whereIn('id', [id.suc, id.ruta]).del();
      await db('commercial.warehouses').where({ id: id.hub }).del();
      await db('catalog.products').where({ id: id.prod }).del();
      await db('catalog.brands').where({ id: id.marca }).del();
      if (vistaCreada) await db.raw('DROP VIEW analytics.v_abc_class');
    } catch (e) { fail++; console.log('  ⚠️ limpieza incompleta:', e.message); }
    await db.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  });
