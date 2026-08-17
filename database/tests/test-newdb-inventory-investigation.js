/* eslint-disable no-console */
/**
 * Smoke DB-directo — Expediente de investigación de diferencias (Fase PREV.1, Apéndice B).
 *
 *   1. Tablas existen con RLS forzado
 *   2. Folio INV-DIF-YYYY-NNNNN secuencial
 *   3. Abrir expediente: difference = físico − esperado, value = diff × costo
 *   4. CHECK root_cause (taxonomía EC/ER/EA/DC/DP/TR/UB/MR/PNI) + status
 *   5. Idempotencia: índice único parcial 1 expediente por item de conteo
 *   6. Transiciones: classify → investigating (con causa) · resolve → resolved
 *   7. Línea de tiempo del SKU (commercial.stock_movements, signed = after − before)
 *
 * Almacén dedicado (PREV-TEST-WH). Cada insert que viola constraint va en su propia tx (25P02).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW_RUNTIME });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USER_A = '00000000-0000-0000-0000-0000000000aa';
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
async function expectFail(fn) { try { await fn(); return false; } catch { return true; } }

(async () => {
  let whId, prod, invId, fakeItemId;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    for (const t of ['inventory_investigations', 'inventory_investigation_sequences']) {
      const reg = await knex.raw(`SELECT to_regclass('commercial.${t}') AS r`);
      check(reg.rows[0].r, `commercial.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`);
      check(rls.rows[0]?.relforcerowsecurity === true, `commercial.${t} tiene RLS forzado`);
    }

    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ code: 'PREV-TEST-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'PREV-TEST-WH', name: 'Prevención Test WH' }).returning('id'))[0].id;
      prod = (await trx('catalog.products').where({ tenant_id: TENANT }).first('id')).id;
      await trx('commercial.inventory_investigations').where({ warehouse_id: whId }).del();
      await trx('commercial.stock_movements').where({ warehouse_id: whId, product_id: prod, reference_type: 'prev_test' }).del();
    });
    check(!!whId && !!prod, 'setup: almacén + producto');

    // ── 2. Folio secuencial ──
    console.log('\n2) Folio secuencial');
    const folios = await knex.transaction(async (trx) => {
      await setCtx(trx);
      const year = new Date().getFullYear();
      const g = async () => (await trx.raw(
        `INSERT INTO commercial.inventory_investigation_sequences (tenant_id, year, last_seq) VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_seq = commercial.inventory_investigation_sequences.last_seq + 1 RETURNING last_seq`, [year])).rows[0].last_seq;
      return { a: Number(await g()), b: Number(await g()), year };
    });
    check(folios.b === folios.a + 1, `secuencia incrementa (${folios.a}→${folios.b})`);
    check(/^INV-DIF-\d{4}-\d{5}$/.test(`INV-DIF-${folios.year}-${String(folios.b).padStart(5, '0')}`), 'formato INV-DIF-YYYY-NNNNN');

    // ── 3. Abrir expediente (difference + value) ──
    console.log('\n3) Abrir expediente');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const expected = 120, physical = 114, cost = 8.5;
      const diff = physical - expected; // -6
      const [row] = await trx('commercial.inventory_investigations').insert({
        tenant_id: TENANT, folio: `INV-DIF-${folios.year}-${String(folios.b).padStart(5, '0')}`,
        warehouse_id: whId, product_id: prod, expected_qty: expected, physical_qty: physical,
        difference: diff, unit_cost: cost, value_at_cost: diff * cost, status: 'open', opened_by: USER_A,
      }).returning('*');
      invId = row.id;
      check(Number(row.difference) === -6, `difference = 114−120 = −6 (fue ${row.difference})`);
      check(Number(row.value_at_cost) === -51, `value_at_cost = −6 × 8.5 = −51 (fue ${row.value_at_cost})`);
      check(row.status === 'open', 'status inicial open');
    });

    // ── 4. CHECK constraints ──
    console.log('\n4) CHECK root_cause + status');
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_investigations').where({ id: invId }).update({ root_cause: 'ZZ' });
    })), "root_cause inválido ('ZZ') rechazado");
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_investigations').where({ id: invId }).update({ status: 'bogus' });
    })), "status inválido ('bogus') rechazado");

    // ── 5. Idempotencia por item de conteo (índice único parcial) ──
    console.log('\n5) 1 expediente por item de conteo');
    fakeItemId = '11111111-1111-1111-1111-111111111111';
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const year = folios.year;
      const seq = (await trx.raw(`INSERT INTO commercial.inventory_investigation_sequences (tenant_id, year, last_seq) VALUES (public.current_tenant_id(), ?, 1)
        ON CONFLICT (tenant_id, year) DO UPDATE SET last_seq = commercial.inventory_investigation_sequences.last_seq + 1 RETURNING last_seq`, [year])).rows[0].last_seq;
      await trx('commercial.inventory_investigations').insert({
        tenant_id: TENANT, folio: `INV-DIF-${year}-${String(seq).padStart(5, '0')}`,
        warehouse_id: whId, product_id: prod, source_item_id: fakeItemId,
        expected_qty: 10, physical_qty: 8, difference: -2, unit_cost: 1, value_at_cost: -2, status: 'open',
      });
    });
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_investigations').insert({
        tenant_id: TENANT, folio: `INV-DIF-${folios.year}-99999`,
        warehouse_id: whId, product_id: prod, source_item_id: fakeItemId,
        expected_qty: 10, physical_qty: 8, difference: -2, unit_cost: 1, value_at_cost: -2, status: 'open',
      });
    })), '2º expediente para el mismo source_item_id rechazado (único parcial)');

    // ── 6. Transiciones ──
    console.log('\n6) classify → resolve');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_investigations').where({ id: invId }).update({ root_cause: 'MR', status: 'investigating', updated_at: trx.fn.now() });
      let r = await trx('commercial.inventory_investigations').where({ id: invId }).first();
      check(r.status === 'investigating' && r.root_cause === 'MR', 'classify → investigating + causa MR');
      await trx('commercial.inventory_investigations').where({ id: invId }).update({ status: 'resolved', resolved_by: USER_A, resolved_at: trx.fn.now(), resolution_notes: 'Merma documentada' });
      r = await trx('commercial.inventory_investigations').where({ id: invId }).first();
      check(r.status === 'resolved' && !!r.resolved_at, 'resolve → resolved + resolved_at');
    });

    // ── 7. Línea de tiempo del SKU ──
    console.log('\n7) Línea de tiempo del SKU');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.stock_movements').insert([
        { tenant_id: TENANT, warehouse_id: whId, product_id: prod, movement_type: 'in', quantity: 120, quantity_before: 0, quantity_after: 120, reference_type: 'prev_test', created_by: USER_A },
        { tenant_id: TENANT, warehouse_id: whId, product_id: prod, movement_type: 'adjust', quantity: 6, quantity_before: 120, quantity_after: 114, reference_type: 'prev_test', created_by: USER_A },
      ]);
      const rows = await trx('commercial.stock_movements').where({ warehouse_id: whId, product_id: prod }).orderBy('created_at', 'desc');
      check(rows.length >= 2, `timeline: ≥2 movimientos (fue ${rows.length})`);
      const adj = rows.find((m) => m.reference_type === 'prev_test' && m.movement_type === 'adjust');
      const signed = Number(adj.quantity_after) - Number(adj.quantity_before);
      check(signed === -6, `ajuste signed = 114−120 = −6 (fue ${signed})`);
    });

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_investigations').where({ warehouse_id: whId }).del();
      await trx('commercial.stock_movements').where({ warehouse_id: whId, product_id: prod, reference_type: 'prev_test' }).del();
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Expediente de investigación: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
