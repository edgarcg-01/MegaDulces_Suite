#!/usr/bin/env node
'use strict';
/**
 * `[NP.3]` Demo LOCAL de Productos nuevos: siembra el escenario y lo deja, para ver la pantalla.
 *
 * Usa el MISMO escenario que el candado (`database/tests/_lib/new-products-scenario.js`), así que
 * lo que se ve en pantalla es lo que la prueba ya verificó cifra por cifra.
 *
 * ⚠️ Además le da UNA venta vieja (hace 200 días) a cada producto real de la base local cuya
 * primera venta en tienda cae en los últimos 180 días. Sin eso, la base local —que trae venta de
 * tienda sólo desde el 21-sep— haría pasar por "nuevos" a productos que no lo son en cuanto el
 * escenario le da historia a la tienda. Esas ventas llevan la misma marca (serie 99, folio NPD*) y
 * `--undo` las borra junto con todo lo demás.
 *
 * ⛔ SÓLO base local: escribe en `kepler_ods.*` y `catalog.*` (`assertSafeTarget`).
 *
 *   node database/scripts/seed-local-new-products-demo.js          # siembra + refresca
 *   node database/scripts/seed-local-new-products-demo.js --undo   # borra todo lo sembrado
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('../tests/_lib/assert-safe-target').assertSafeTarget('seed-local-new-products-demo');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const esc = require('../tests/_lib/new-products-scenario');

const UNDO = process.argv.includes('--undo');

(async () => {
  try {
    if (UNDO) {
      await knex.transaction(async (trx) => {
        await esc.limpiar(trx);
        await esc.refrescar(trx);
      });
      console.log('Demo de Productos nuevos borrada y matvistas refrescadas.');
      return;
    }

    await knex.transaction(async (trx) => {
      await esc.limpiar(trx);
      // Sin esto, al volver a correr el demo la venta materializada todavía trae la historia de
      // fondo de la corrida anterior y la consulta de abajo no encuentra a quién dársela.
      await trx.raw('REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily');
      const { hoy, productos } = await esc.sembrar(trx);
      // Lo de HOY: no entra a la historia, lo trae la parte en vivo de la pantalla.
      await esc.sembrarVivo(trx, hoy);

      // Historia de fondo para los productos reales de la base local (ver cabecera).
      const sinHistoria = (await trx.raw(`
        SELECT k.sku, min(k.business_date) AS primera, (array_agg(k.source_branch ORDER BY k.business_date))[1] AS plaza
          FROM analytics.mv_kepler_sales_daily k
         WHERE k.sku NOT LIKE ?
         GROUP BY k.sku
        HAVING min(k.business_date) >= (?::date - 180)`, [`${esc.PREFIJO_SKU}%`, hoy])).rows;
      let folio = 0;
      for (const r of sinHistoria) {
        // La venta vieja va en 03/04/05: las únicas plazas que ya eran Kepler hace 200 días.
        const plaza = ['03', '04', '05'].includes(r.plaza) ? r.plaza : '03';
        folio += 1;
        const f = `NPDH${String(folio).padStart(6, '0')}`;
        await trx.raw(
          `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c12, c13, c16, c43)
           VALUES (?, ?, 'U', 'D', 10, ?, ?, ?::timestamp, '991', 0, 1, 'N')`,
          [plaza, plaza, esc.SERIE, f, esc.fecha(hoy, -200)]);
        await trx.raw(
          `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12, c13)
           VALUES (?, ?, 'U', 'D', 10, ?, ?, 1, ?, 1, 'PZA', 1, 1)`,
          [plaza, plaza, esc.SERIE, f, r.sku]);
      }

      // Un producto ya clasificado por Compras, para que la pantalla muestre los dos estados.
      const p01 = productos.find((p) => p.clave === '01');
      await trx.raw(
        `INSERT INTO catalog.new_product_reviews (tenant_id, product_id, kind, note, created_by_username, updated_by_username)
         VALUES (?, ?, 'nuevo', 'Lanzamiento de temporada con el proveedor; meta: recuperar la inversión en 60 días.', 'demo', 'demo')`,
        [esc.TENANT, p01.product_id]);

      await esc.refrescar(trx);
      console.log(`Demo sembrada (hoy = ${hoy}): ${productos.length} productos NPDEMO-*, ` +
        `${sinHistoria.length} productos locales con historia de fondo. Matvistas refrescadas.`);
    });
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
