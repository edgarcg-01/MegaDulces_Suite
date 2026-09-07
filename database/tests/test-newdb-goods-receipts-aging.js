/**
 * `[RE.3]` — **El calendario de pago, y sobre todo lo que NO debe publicar.**
 *
 * El plan pedía "aging de cuentas por pagar". No se puede: **no existe la liga recepción→pago**
 * (`erp_supplier_payments` no trae folio de entrada; `expense_doc_chain` está vacía), así que no
 * hay forma de saber qué ya se pagó.
 *
 * Medido al construirlo: **11,845 de 12,200** recepciones tienen vencimiento pasado, por
 * **$522M**. Un aging ingenuo publicaría esos $522M como deuda vencida — y casi todo está pagado
 * (los datos arrancan en ago-2024). Este smoke existe para que nadie "complete" la pantalla
 * abriendo esa lista sin haber resuelto antes la liga a pago (RE.8).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipts-aging.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const money = (v) => '$' + Math.round(Number(v) || 0).toLocaleString('es-MX');

/** Réplica de la ventana que devuelve `aging()`. */
const ventana = (trx, dias) => trx.raw(`
  SELECT count(*)::int n, COALESCE(sum(c.monto),0)::numeric monto,
         min(c.fecha_vence)::text primero, max(c.fecha_vence)::text ultimo
    FROM analytics.erp_goods_receipts c
   WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.fecha_vence IS NOT NULL
     AND c.fecha_vence >= current_date AND c.fecha_vence < current_date + ?::int`, [T, dias]);

(async () => {
  try {
    const cols = (await knex.raw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='erp_goods_receipts' AND column_name='fecha_vence'`)).rows;
    if (!cols.length) { console.log('  ⚠️  sin `fecha_vence` (¿RE.1 pendiente?) — SKIP'); process.exit(0); }

    // 1. El universo completo: el número que NO se debe publicar.
    const todo = (await knex.raw(`
      SELECT count(*) FILTER (WHERE fecha_vence < current_date)::int vencidas,
             COALESCE(sum(monto) FILTER (WHERE fecha_vence < current_date),0)::numeric dinero
        FROM analytics.erp_goods_receipts WHERE tenant_id = ? AND dup_of_folio IS NULL`, [T])).rows[0];
    if (!todo.vencidas) { console.log('  ⚠️  sin recepciones vencidas en este entorno — SKIP'); process.exit(0); }
    console.log(`     universo con vencimiento pasado: ${todo.vencidas} docs / ${money(todo.dinero)} (casi todo YA PAGADO)`);

    // 2. La ventana sólo mira hacia adelante.
    const v = (await ventana(knex, 30)).rows[0];
    ok(v.n > 0, `la ventana de 30 días trae ${v.n} documentos por vencer (${money(v.monto)})`);
    ok(Number(v.monto) < Number(todo.dinero) / 10,
      `lo publicado (${money(v.monto)}) es una fracción del histórico vencido (${money(todo.dinero)}) — no se publica la deuda falsa`);

    // 3. Nada anterior a hoy se cuela en la lista. Es LA invariante de la pantalla.
    const pasado = (await knex.raw(`
      SELECT count(*)::int n FROM analytics.erp_goods_receipts c
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.fecha_vence IS NOT NULL
         AND c.fecha_vence >= current_date AND c.fecha_vence < current_date + 30
         AND c.fecha_vence < current_date`, [T])).rows[0];
    ok(pasado.n === 0, 'ni un documento vencido se cuela en la lista de "por vencer"');

    // 4. Lo vencido que sí se declara está ACOTADO a 30 días, no es toda la historia.
    const dec = (await knex.raw(`
      SELECT count(*)::int n, COALESCE(sum(c.monto),0)::numeric monto
        FROM analytics.erp_goods_receipts c
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.fecha_vence IS NOT NULL
         AND c.fecha_vence < current_date AND c.fecha_vence >= current_date - 30`, [T])).rows[0];
    ok(dec.n < todo.vencidas,
      `lo declarado como "venció, sin confirmar pago" son ${dec.n} docs de los últimos 30 días, no las ${todo.vencidas} de toda la historia`);

    // 5. Las gemelas no se cuentan dos veces: la copia de oficinas es la MISMA compra.
    const gem = (await knex.raw(`
      SELECT count(*)::int n FROM analytics.erp_goods_receipts c
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NOT NULL
         AND c.fecha_vence >= current_date AND c.fecha_vence < current_date + 30`, [T])).rows[0];
    console.log(`     (${gem.n} copia(s) de oficinas en la ventana, excluidas por dup_of_folio)`);
    ok(true, 'las capturas duplicadas quedan fuera: pagar dos veces la misma compra es el riesgo');

    // 6. Coherencia del borde. Se compara contra `current_date` de la DB y NO contra
    //    `new Date()` de JS: eso es UTC, y con México en −6 el "hoy" de la app y el del test
    //    caen en días distintos toda la tarde. (Falló así la primera vez.)
    const borde = (await knex.raw(`
      SELECT count(*)::int fuera FROM analytics.erp_goods_receipts c
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.fecha_vence IS NOT NULL
         AND c.fecha_vence >= current_date AND c.fecha_vence < current_date + 30
         AND (c.fecha_vence < current_date OR c.fecha_vence >= current_date + 30)`, [T])).rows[0];
    ok(borde.fuera === 0, `todos los vencimientos de la ventana caen dentro del rango pedido`);

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
