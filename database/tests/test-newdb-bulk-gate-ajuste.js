/**
 * `[RE.21.2]` — **La puerta nueva del lote: "cuadra con ajuste".**
 *
 * `validateBulk` exigía `monto_match === true` a secas, y con eso una recepción con una
 * devolución **legítima** no se podía aprobar en lote **nunca**: se iba a revisión manual para
 * siempre, aunque Kepler ya tuviera el X-D-40 que la explica.
 *
 * La puerta nueva es a propósito la más angosta de las tres de `forEntrada`: no basta que un
 * ajuste del proveedor tenga el tamaño del hueco (eso es circunstancial y lo decide una persona)
 * — se pide que **`entrada_folio` apunte a ESTA recepción Y que la magnitud case**. Es el ~4% de
 * los ajustes, el único caso con liga estructural.
 *
 * Este smoke ejercita la SQL del gate (`ajusteLigadoQueExplica`) con datos SEMBRADOS en una
 * transacción con ROLLBACK, porque `analytics.erp_purchase_adjustments` está vacía en local (el
 * importer no corre acá). Lo que se afirma es lo que tiene que NO pasar: que la puerta se abra
 * de más.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-bulk-gate-ajuste.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const TOL = 1.0;
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/**
 * Réplica fiel de `ajusteLigadoQueExplica`: el corte por `!delta` **y** la cláusula SQL. El
 * corte va acá y no sólo en el service para que la aserción de "sin hueco no abre" sea real y
 * no un `|| true` que nunca falla.
 */
const gate = async (trx, sucursal, folio, delta) => {
  const d = Math.abs(Number(delta) || 0);
  if (!d) return null; // sin hueco no hay nada que explicar
  return (await trx('analytics.erp_purchase_adjustments')
    .where({ tenant_id: T, sucursal, entrada_folio: folio })
    .whereRaw('ABS(ABS(monto::numeric) - ?) <= ?', [d, TOL])
    .orderByRaw('ABS(ABS(monto::numeric) - ?) ASC', [d])
    .first('doctype', 'folio', trx.raw('monto::numeric AS monto'), 'categoria')) || null;
};

(async () => {
  try {
    const e = (await knex.raw(
      `SELECT sucursal, folio, proveedor_code FROM analytics.erp_goods_receipts
        WHERE tenant_id = ? AND dup_of_folio IS NULL AND receipt_date >= '2026-08-01' LIMIT 1`, [T])).rows[0];
    if (!e) { console.log('  ⚠️  sin entradas del carril vivo — SKIP'); process.exit(0); }
    console.log(`\n  entrada de prueba: ${e.sucursal}/${e.folio}\n`);

    await knex.transaction(async (trx) => {
      const base = {
        tenant_id: T, sucursal: e.sucursal, adjustment_date: '2026-08-15',
        proveedor_code: e.proveedor_code, proveedor_nombre: 'SMOKE', monto: 0,
        categoria: 'faltante', source_branch: 'smoke', computed_at: trx.fn.now(),
      };
      const DELTA = 1234.56;

      // 1. El caso que la puerta DEBE abrir: ligado a esta entrada y del tamaño del hueco.
      await trx('analytics.erp_purchase_adjustments').insert({
        ...base, doctype: 'XD40', folio: 'SMK-OK', entrada_folio: e.folio, monto: DELTA,
      });
      const hit = await gate(trx, e.sucursal, e.folio, DELTA);
      ok(hit?.folio === 'SMK-OK', `abre con ajuste ligado del tamaño del hueco (${hit?.folio ?? 'nada'})`);

      // 2. Que el signo NO importe: la dirección contable no es estable (el ajuste va del 0% al
      //    100% de la entrada). Se compara magnitud, así que un ajuste NEGATIVO también explica.
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' }).update({ monto: -DELTA });
      const neg = await gate(trx, e.sucursal, e.folio, DELTA);
      ok(neg?.folio === 'SMK-OK', 'abre igual con el ajuste en negativo (compara magnitud, no signo)');

      // 3. Lo que NO debe abrir: mismo monto pero ligado a OTRA entrada. Es el error que haría
      //    que el ajuste de una recepción apruebe la de al lado.
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' })
        .update({ entrada_folio: e.folio + '-OTRA' });
      ok((await gate(trx, e.sucursal, e.folio, DELTA)) === null,
        'NO abre si el ajuste está ligado a otra entrada');

      // 4. Lo que NO debe abrir: ligado bien, pero de otro tamaño. Sin esto, cualquier ajuste
      //    del proveedor aprobaría cualquier descuadre.
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' })
        .update({ entrada_folio: e.folio, monto: DELTA + 500 });
      ok((await gate(trx, e.sucursal, e.folio, DELTA)) === null,
        'NO abre si el ajuste no tiene el tamaño del hueco');

      // 5. Tolerancia: los centavos sí pasan (el OCR y Kepler difieren por redondeo).
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' })
        .update({ monto: DELTA + 0.4 });
      ok((await gate(trx, e.sucursal, e.folio, DELTA))?.folio === 'SMK-OK',
        `dentro de la tolerancia ($${TOL}) sí abre — el redondeo no bloquea`);

      // 6. Sin hueco no hay nada que explicar. Y ojo con el borde: un ajuste de $0 (los X-D-40
      //    de faltante se capturan en 0) NO puede convertirse en "explica el descuadre 0".
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' }).update({ monto: 0 });
      ok((await gate(trx, e.sucursal, e.folio, 0)) === null,
        'con hueco 0 NO abre, ni con un ajuste de $0 ligado');

      // 7. Cuando hay varios, gana el MÁS cercano al hueco — es el que se escribe en el historial.
      await trx('analytics.erp_purchase_adjustments').where({ folio: 'SMK-OK' }).update({ monto: DELTA + 0.9 });
      await trx('analytics.erp_purchase_adjustments').insert({
        ...base, doctype: 'XD55', folio: 'SMK-MEJOR', entrada_folio: e.folio, monto: DELTA + 0.05,
      });
      ok((await gate(trx, e.sucursal, e.folio, DELTA))?.folio === 'SMK-MEJOR',
        'con varios candidatos gana el más cercano al hueco');

      throw new Error('__rollback__');
    }).catch((err) => { if (err.message !== '__rollback__') throw err; });

    const quedo = Number((await knex.raw(
      `SELECT count(*)::int n FROM analytics.erp_purchase_adjustments WHERE source_branch = 'smoke'`)).rows[0].n);
    ok(quedo === 0, 'rollback limpio: la DB quedó igual que antes');

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
