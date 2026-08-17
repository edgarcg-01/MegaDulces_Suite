/* eslint-disable no-console */
/**
 * Smoke DB-directo — Modo recepción por escaneo / Vale vivo (Fase WMS-REC Pieza 1, ADR-044).
 *
 *   1. Tablas existen con RLS forzado
 *   2. Folio VE-YYYY-NNNNN por secuencia atómica (UPSERT incrementa)
 *   3. Abrir sesión manual + agregar 2 líneas esperadas
 *   4. Discrepancia: recibido==esperado → ok · recibido<esperado → faltante ·
 *      escaneo no esperado → sobrante
 *   5. Cerrar: pending con esperado>0 → faltante
 *   6. Progreso del detalle (expected/received units, discrepancies)
 *
 * Almacén dedicado (RECV-SESS-WH). Mirror de discrepancyFor sincronizado con el servicio.
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

// Mirror EXACTO de ReceivingSessionService.discrepancyFor (mantener sincronizado).
function disc(expected, received, manual) {
  if (manual === 'producto_incorrecto' || manual === 'dañado') return manual;
  if (received === 0 && expected > 0) return 'pending';
  if (received < expected) return 'faltante';
  if (received > expected) return 'sobrante';
  return 'ok';
}

(async () => {
  let whId, prods, sessionId, folio;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    for (const t of ['receiving_sessions', 'receiving_lines', 'receiving_session_sequences']) {
      const reg = await knex.raw(`SELECT to_regclass('commercial.${t}') AS r`);
      check(reg.rows[0].r, `commercial.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`);
      check(rls.rows[0]?.relforcerowsecurity === true, `commercial.${t} tiene RLS forzado`);
    }

    // Setup: almacén dedicado + 3 productos reales
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ code: 'RECV-SESS-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'RECV-SESS-WH', name: 'Recepción Sesión WH' }).returning('id'))[0].id;
      prods = await trx('catalog.products').where({ tenant_id: TENANT }).limit(3).select('id');
    });
    check(!!whId && prods.length >= 3, `setup: almacén + 3 productos (${prods.length})`);
    if (prods.length < 3) throw new Error('Se requieren ≥3 productos en catalog.products');

    // ── 2. Folio secuencial ──
    console.log('\n2) Folio secuencial (UPSERT atómico)');
    const folios = await knex.transaction(async (trx) => {
      await setCtx(trx);
      const year = new Date().getFullYear();
      const one = (await trx.raw(
        `INSERT INTO commercial.receiving_session_sequences (tenant_id, year, last_seq) VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_seq = commercial.receiving_session_sequences.last_seq + 1 RETURNING last_seq`, [year])).rows[0].last_seq;
      const two = (await trx.raw(
        `INSERT INTO commercial.receiving_session_sequences (tenant_id, year, last_seq) VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_seq = commercial.receiving_session_sequences.last_seq + 1 RETURNING last_seq`, [year])).rows[0].last_seq;
      return { one: Number(one), two: Number(two), year };
    });
    check(folios.two === folios.one + 1, `secuencia incrementa (${folios.one} → ${folios.two})`);
    check(/^VE-\d{4}-\d{5}$/.test(`VE-${folios.year}-${String(folios.two).padStart(5, '0')}`), 'formato folio VE-YYYY-NNNNN');

    // ── 3. Abrir sesión + líneas esperadas ──
    console.log('\n3) Abrir sesión + líneas esperadas');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      folio = `VE-${folios.year}-${String(folios.two).padStart(5, '0')}`;
      const [s] = await trx('commercial.receiving_sessions').insert({
        tenant_id: TENANT, folio, warehouse_id: whId, supplier_code: 'RECV-SUP',
        source_kind: 'manual', status: 'open', created_by: USER_A,
      }).returning('id');
      sessionId = s.id;
      // línea A esperada 10, línea B esperada 5
      await trx('commercial.receiving_lines').insert([
        { tenant_id: TENANT, session_id: sessionId, product_id: prods[0].id, expected_qty: 10, received_qty: 0, discrepancy_kind: 'pending' },
        { tenant_id: TENANT, session_id: sessionId, product_id: prods[1].id, expected_qty: 5, received_qty: 0, discrepancy_kind: 'pending' },
      ]);
      const n = await trx('commercial.receiving_lines').where({ session_id: sessionId }).count('* as c').first();
      check(Number(n.c) === 2, '2 líneas esperadas creadas');
    });

    // ── 4. Escaneo → discrepancias ──
    console.log('\n4) Escaneo → discrepancias');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      // A: recibir 10 == esperado → ok
      let lineA = await trx('commercial.receiving_lines').where({ session_id: sessionId, product_id: prods[0].id }).first();
      let recA = Number(lineA.received_qty) + 10;
      await trx('commercial.receiving_lines').where({ id: lineA.id }).update({ received_qty: recA, discrepancy_kind: disc(Number(lineA.expected_qty), recA) });
      lineA = await trx('commercial.receiving_lines').where({ id: lineA.id }).first();
      check(lineA.discrepancy_kind === 'ok', `A recibido 10/10 → ok (fue ${lineA.discrepancy_kind})`);

      // B: recibir 3 < 5 → faltante
      let lineB = await trx('commercial.receiving_lines').where({ session_id: sessionId, product_id: prods[1].id }).first();
      let recB = Number(lineB.received_qty) + 3;
      await trx('commercial.receiving_lines').where({ id: lineB.id }).update({ received_qty: recB, discrepancy_kind: disc(Number(lineB.expected_qty), recB) });
      lineB = await trx('commercial.receiving_lines').where({ id: lineB.id }).first();
      check(lineB.discrepancy_kind === 'faltante', `B recibido 3/5 → faltante (fue ${lineB.discrepancy_kind})`);

      // C: escaneo no esperado → sobrante (línea nueva)
      await trx('commercial.receiving_lines').insert({
        tenant_id: TENANT, session_id: sessionId, product_id: prods[2].id,
        expected_qty: 0, received_qty: 2, discrepancy_kind: 'sobrante',
      });
      const lineC = await trx('commercial.receiving_lines').where({ session_id: sessionId, product_id: prods[2].id }).first();
      check(lineC.discrepancy_kind === 'sobrante', `C no esperado, recibido 2 → sobrante (fue ${lineC.discrepancy_kind})`);
    });

    // ── 5. Cerrar → pending+esperado → faltante ──
    console.log('\n5) Cerrar sesión');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      // agregar una línea D pending con esperado 4, no recibida → debe volverse faltante al cerrar
      await trx('commercial.receiving_lines').insert({
        tenant_id: TENANT, session_id: sessionId, product_id: null, expected_sku: 'D-EXP', expected_name: 'Esperado no llegó',
        expected_qty: 4, received_qty: 0, discrepancy_kind: 'pending',
      });
      await trx('commercial.receiving_lines').where({ session_id: sessionId, discrepancy_kind: 'pending' }).where('expected_qty', '>', 0)
        .update({ discrepancy_kind: 'faltante' });
      await trx('commercial.receiving_lines').where({ session_id: sessionId, discrepancy_kind: 'pending' }).update({ discrepancy_kind: 'ok' });
      await trx('commercial.receiving_sessions').where({ id: sessionId }).update({ status: 'closed', closed_at: trx.fn.now(), closed_by: USER_A });

      const s = await trx('commercial.receiving_sessions').where({ id: sessionId }).first();
      check(s.status === 'closed', 'sesión cerrada');
      const d = await trx('commercial.receiving_lines').where({ session_id: sessionId, expected_sku: 'D-EXP' }).first();
      check(d.discrepancy_kind === 'faltante', `D pending+esperado 4 → faltante al cerrar (fue ${d.discrepancy_kind})`);
    });

    // ── 6. Progreso ──
    console.log('\n6) Progreso del detalle');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const lines = await trx('commercial.receiving_lines').where({ session_id: sessionId });
      const progress = {
        lines: lines.length,
        discrepancies: lines.filter((l) => ['faltante', 'sobrante', 'producto_incorrecto', 'dañado'].includes(l.discrepancy_kind)).length,
        expected_units: lines.reduce((a, l) => a + Number(l.expected_qty), 0),
        received_units: lines.reduce((a, l) => a + Number(l.received_qty), 0),
      };
      // A ok, B faltante, C sobrante, D faltante → 3 discrepancias
      check(progress.discrepancies === 3, `3 discrepancias (fue ${progress.discrepancies})`);
      check(progress.expected_units === 19 && progress.received_units === 15, `unidades esperado 19 / recibido 15 (fue ${progress.expected_units}/${progress.received_units})`);
    });

    // Mirror discrepancyFor
    check(disc(5, 5) === 'ok' && disc(5, 3) === 'faltante' && disc(0, 2) === 'sobrante' && disc(5, 0) === 'pending' && disc(5, 5, 'dañado') === 'dañado', 'discrepancyFor mirror correcto');

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.receiving_lines').where({ session_id: sessionId }).del();
      await trx('commercial.receiving_sessions').where({ id: sessionId }).del();
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Recepción por escaneo: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
