/* eslint-disable no-console */
// P2.2d — verifica que el trigger decrementa NO-VENCIDO primero, vencido al final.
// Read-only: todo corre en una trx que se ROLLBACK → cero pollution.
//   node database/scripts/verify-fefo-expired-last.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const MEGA = '00000000-0000-0000-0000-00000000d01c';

(async () => {
  let ok = true;
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
      const s = await trx('commercial.stock').select('warehouse_id', 'product_id').first();
      if (!s) throw new Error('sin stock de muestra');
      const { warehouse_id: wh, product_id: pr } = s;

      // Re-lotear: bueno(+30d, 10) + vencido(-5d, 10), NA a 0; stock=20.
      await trx('commercial.stock_lots').where({ warehouse_id: wh, product_id: pr }).del();
      await trx('commercial.stock_lots').insert([
        { tenant_id: MEGA, warehouse_id: wh, product_id: pr, lot_code: 'GOOD', expiry_date: trx.raw(`CURRENT_DATE + 30`), quantity: 10, reserved_quantity: 0 },
        { tenant_id: MEGA, warehouse_id: wh, product_id: pr, lot_code: 'EXPIRED', expiry_date: trx.raw(`CURRENT_DATE - 5`), quantity: 10, reserved_quantity: 0 },
      ]);
      await trx('commercial.stock').where({ warehouse_id: wh, product_id: pr }).update({ quantity: 20 });

      // Venta de 5 → debe bajar GOOD (no vencido), dejar EXPIRED intacto.
      await trx('commercial.stock').where({ warehouse_id: wh, product_id: pr }).update({ quantity: 15 });

      const lots = await trx('commercial.stock_lots')
        .where({ warehouse_id: wh, product_id: pr })
        .whereIn('lot_code', ['GOOD', 'EXPIRED'])
        .select('lot_code', 'quantity');
      const good = Number(lots.find((l) => l.lot_code === 'GOOD')?.quantity);
      const expired = Number(lots.find((l) => l.lot_code === 'EXPIRED')?.quantity);
      console.log(`  GOOD=${good} (esperado 5)  EXPIRED=${expired} (esperado 10)`);
      const sum = good + expired;
      if (good !== 5) { console.log('  FAIL: el lote bueno no bajó primero'); ok = false; }
      if (expired !== 10) { console.log('  FAIL: el lote vencido fue tocado (no debía)'); ok = false; }
      if (sum !== 15) { console.log(`  FAIL: invariante roto, sum=${sum} != 15`); ok = false; }
      if (ok) console.log('  OK: FEFO no-vencido primero + invariante intacto');

      throw new Error('__ROLLBACK__'); // deshacer todo
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('FATAL:', e.message); ok = false; }
  }
  await knex.destroy();
  console.log(ok ? '\n✅ PASS' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
})();
