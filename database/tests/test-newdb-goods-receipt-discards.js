/**
 * `[RE.20.3]` — Smoke del **descarte** de una orden de entrada.
 *
 * El proceso sólo tenía una salida —*Devuelta*— y devolver **rebota a la sucursal**: le pide
 * que suba otra vez algo que sí existe. Pero hay entradas que nunca van a tener factura de
 * proveedor (traspasos entre sucursales `TI*`, entradas en $0, canceladas en el ERP), y ésas se
 * quedaban *Sin factura* para siempre inflando el atraso de su sucursal.
 *
 * La aserción que justifica el archivo: **descartar tiene que sacar la entrada del
 * DENOMINADOR de cobertura, y a la vez seguir contándose aparte.** Si sólo restara, "descartar
 * todo" sería el camino más corto al 100% y el indicador dejaría de servir para exigirle a
 * nadie. Las dos mitades se verifican acá.
 *
 * Corre dentro de UNA TRANSACCIÓN CON ROLLBACK: no deja basura en la DB.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipt-discards.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** El denominador de `coverage()` para una sucursal: entradas del carril vivo, sin descartadas. */
const entradasDe = async (trx, suc, arranque) => Number((await trx.raw(`
  SELECT count(*)::int n
    FROM analytics.erp_goods_receipts c
   WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.sucursal = ?
     AND c.receipt_date >= ?
     AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_discards x
                      WHERE x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio)`,
  [T, suc, arranque])).rows[0].n);

(async () => {
  try {
    // ── 1. El esquema ────────────────────────────────────────────────────────
    const t = (await knex.raw(`
      SELECT to_regclass('finance.goods_receipt_discards') IS NOT NULL AS existe`)).rows[0];
    if (!t.existe) { console.log('  ⚠️  falta la migración 20260829180000 — SKIP'); process.exit(0); }
    ok(true, 'finance.goods_receipt_discards existe');

    const rls = (await knex.raw(`
      SELECT relrowsecurity AS on, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'finance.goods_receipt_discards'::regclass`)).rows[0];
    ok(rls.on && rls.forced, 'RLS habilitado Y forzado');

    const grants = (await knex.raw(`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema='finance' AND table_name='goods_receipt_discards' AND grantee='app_runtime'`))
      .rows.map((r) => r.privilege_type).sort();
    ok(grants.includes('INSERT') && grants.includes('DELETE') && grants.includes('SELECT'),
      `app_runtime puede descartar y reactivar (${grants.join(',')})`);
    // Cambiar el motivo de un descarte viejo sin dejar rastro es reescribir la historia: se
    // reactiva y se vuelve a descartar, y las dos cosas quedan en el historial append-only.
    ok(!grants.includes('UPDATE'), 'app_runtime NO puede editar un descarte (se reactiva y se rehace)');

    // El descarte es una decisión sobre la ENTRADA, no sobre una evidencia — y justo se descarta
    // lo que nunca va a tener una. Sin esto el historial no puede registrarlo.
    const h = (await knex.raw(`
      SELECT is_nullable = 'YES' AS nullable FROM information_schema.columns
       WHERE table_schema='finance' AND table_name='goods_receipt_proof_history' AND column_name='proof_id'`)).rows[0];
    ok(h && h.nullable, 'el historial acepta decisiones sin evidencia (proof_id nullable)');

    // ── 2. El comportamiento ─────────────────────────────────────────────────
    const cfg = (await knex.raw(`SELECT reception_start FROM finance.receipt_settings WHERE tenant_id = ?`, [T])).rows[0];
    const arranque = cfg ? cfg.reception_start : '2026-08-01';
    // Una entrada del carril vivo SIN evidencia: es lo único que se puede descartar.
    const e = (await knex.raw(`
      SELECT c.sucursal, c.folio FROM analytics.erp_goods_receipts c
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.receipt_date >= ?
         AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_proofs p
                          WHERE p.sucursal = c.sucursal AND p.folio = c.folio)
         AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_discards x
                          WHERE x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio)
       LIMIT 1`, [T, arranque])).rows[0];
    if (!e) { console.log('  ⚠️  sin entradas descartables en el carril vivo — SKIP del comportamiento'); }
    else {
      console.log(`\n  (entrada de prueba: ${e.sucursal}/${e.folio})`);
      await knex.transaction(async (trx) => {
        const antes = await entradasDe(trx, e.sucursal, arranque);

        await trx('finance.goods_receipt_discards').insert({
          tenant_id: T, sucursal: e.sucursal, folio: e.folio,
          motivo_codigo: 'traspaso', descartado_por: 'smoke_test',
        });

        // LA aserción de la fase: el descarte SALE del denominador.
        const despues = await entradasDe(trx, e.sucursal, arranque);
        ok(despues === antes - 1,
          `la descartada sale del denominador de cobertura (${antes} → ${despues})`);

        // …y a la vez SIGUE contándose. Sin esto, descartar sería el camino corto al 100%.
        const cont = Number((await trx.raw(`
          SELECT count(*)::int n FROM finance.goods_receipt_discards
           WHERE tenant_id = ? AND sucursal = ?`, [T, e.sucursal])).rows[0].n);
        ok(cont >= 1, `y se sigue contando aparte: ${cont} descartada(s) en ${e.sucursal}`);

        // Se ve pidiéndola por su nombre — si desapareciera del todo, no sería auditable.
        const visible = Number((await trx.raw(`
          SELECT count(*)::int n FROM analytics.erp_goods_receipts c
            JOIN finance.goods_receipt_discards x
              ON x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio
           WHERE c.tenant_id = ? AND c.sucursal = ? AND c.folio = ?`, [T, e.sucursal, e.folio])).rows[0].n);
        ok(visible === 1, `estado=descartada la muestra, con su motivo`);

        // Dos personas descartando la misma entrada: gana una, la otra se entera.
        let choco = false;
        try {
          await trx.raw(`SAVEPOINT sp_dup`);
          await trx('finance.goods_receipt_discards').insert({
            tenant_id: T, sucursal: e.sucursal, folio: e.folio, motivo_codigo: 'otro', motivo: 'x',
          });
          await trx.raw(`RELEASE SAVEPOINT sp_dup`);
        } catch { choco = true; await trx.raw(`ROLLBACK TO SAVEPOINT sp_dup`); }
        ok(choco, 'no se puede descartar dos veces la misma entrada (índice único)');

        // El historial registra la decisión SIN evidencia detrás.
        await trx('finance.goods_receipt_proof_history').insert({
          tenant_id: T, proof_id: null, sucursal: e.sucursal, folio: e.folio,
          status_from: null, status_to: 'descartada', motivo_codigo: 'traspaso', changed_by: 'smoke_test',
        });
        const hist = Number((await trx.raw(`
          SELECT count(*)::int n FROM finance.goods_receipt_proof_history
           WHERE tenant_id = ? AND sucursal = ? AND folio = ? AND status_to = 'descartada'`,
          [T, e.sucursal, e.folio])).rows[0].n);
        ok(hist === 1, 'la decisión queda en el historial aunque no haya evidencia');

        // Reactivar: apareció la factura de algo que se había dado por perdido.
        await trx('finance.goods_receipt_discards').where({ sucursal: e.sucursal, folio: e.folio }).del();
        const vuelta = await entradasDe(trx, e.sucursal, arranque);
        ok(vuelta === antes, `reactivar la devuelve al denominador (${despues} → ${vuelta})`);

        throw new Error('__rollback__'); // nada se persiste
      }).catch((err) => { if (err.message !== '__rollback__') throw err; });

      const quedo = Number((await knex.raw(
        `SELECT count(*)::int n FROM finance.goods_receipt_discards WHERE descartado_por = 'smoke_test'`)).rows[0].n);
      ok(quedo === 0, 'rollback limpio: la DB quedó igual que antes');
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
