/* eslint-disable no-console */
/**
 * Smoke DB-directo — Auditor de recepción por caducidad (Fase WMS-REC, ADR-044).
 *
 * Valida schema + RLS + grants de las 2 tablas nuevas, y el MOTOR DE REGLAS
 * (mismo SQL de contexto que ReceivingAuditorService + mirror de computeVerdict):
 *
 *   1. Tablas existen con RLS forzado
 *   2. Política upsert por producto
 *   3. Contexto: existing_min_expiry (MIN de stock_lots) + days_of_life
 *   4. Veredictos: green (lejano) / red older_than_existing / red min_shelf_life /
 *      yellow near_min_shelf_life
 *   5. Captura: insert green (accepted) + red (pending_authorization) + CHECK rechaza verdict inválido
 *   6. Autorizar un rojo transiciona a authorized
 *
 * Usa un almacén dedicado (REC-TEST-WH) para no interferir con otros smokes.
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

// Mirror EXACTO de ReceivingAuditorService.computeVerdict (mantener sincronizado).
function computeVerdict({ confirmedExpiry, daysOfLife, existingMinExpiry, minShelfLifeDays, allowOlder }) {
  if (!confirmedExpiry) return { verdict: 'green', rule_broken: null };
  const belowMin = minShelfLifeDays != null && daysOfLife != null && daysOfLife < minShelfLifeDays;
  const olderThanExisting = !!existingMinExpiry && confirmedExpiry < existingMinExpiry;
  const nearMin = minShelfLifeDays != null && daysOfLife != null && !belowMin && daysOfLife < Math.ceil(minShelfLifeDays * 1.5);
  if (belowMin) return { verdict: 'red', rule_broken: 'min_shelf_life' };
  if (olderThanExisting && !allowOlder) return { verdict: 'red', rule_broken: 'older_than_existing' };
  if (olderThanExisting && allowOlder) return { verdict: 'yellow', rule_broken: 'older_than_existing_allowed' };
  if (nearMin) return { verdict: 'yellow', rule_broken: 'near_min_shelf_life' };
  return { verdict: 'green', rule_broken: null };
}

const toIso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

async function ctx(trx, whId, prodId, confirmedExpiry) {
  const r = await trx.raw(
    `SELECT
       ${confirmedExpiry ? `(?::date - CURRENT_DATE)::int` : `NULL::int`} AS days_of_life,
       (SELECT MIN(expiry_date) FROM commercial.stock_lots
          WHERE warehouse_id = ? AND product_id = ? AND quantity > 0 AND expiry_date IS NOT NULL) AS existing_min_expiry`,
    confirmedExpiry ? [confirmedExpiry, whId, prodId] : [whId, prodId],
  );
  const row = r.rows[0] || {};
  return {
    daysOfLife: row.days_of_life != null ? Number(row.days_of_life) : null,
    existingMinExpiry: row.existing_min_expiry ? toIso(row.existing_min_expiry) : null,
  };
}

(async () => {
  let whId, prodId;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    for (const t of ['expiry_receiving_policy', 'receiving_lot_captures']) {
      const reg = await knex.raw(`SELECT to_regclass('commercial.${t}') AS r`);
      check(reg.rows[0].r, `commercial.${t} existe`);
      const rls = await knex.raw(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`,
      );
      check(rls.rows[0]?.relforcerowsecurity === true, `commercial.${t} tiene RLS forzado`);
    }

    // ── Setup: almacén dedicado + un producto real del tenant ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ code: 'REC-TEST-WH' }).first();
      if (wh) whId = wh.id;
      else {
        const [row] = await trx('commercial.warehouses')
          .insert({ tenant_id: TENANT, code: 'REC-TEST-WH', name: 'Recepción Test WH' })
          .returning('id');
        whId = row.id;
      }
      const prod = await trx('catalog.products').where({ tenant_id: TENANT }).first('id');
      prodId = prod?.id;
    });
    check(!!whId && !!prodId, `setup: almacén + producto (${prodId ? 'ok' : 'SIN PRODUCTO'})`);
    if (!prodId) throw new Error('No hay productos en catalog.products para el tenant — no se puede probar');

    // fechas relativas a hoy, desde el server
    const d = (await knex.raw(
      `SELECT (CURRENT_DATE + 400)::text AS existing, (CURRENT_DATE + 800)::text AS far,
              (CURRENT_DATE + 30)::text AS soon, (CURRENT_DATE + 200)::text AS near,
              (CURRENT_DATE + 100)::text AS older`,
    )).rows[0];

    // ── Seed: lote existente que caduca en +400d (establece existing_min_expiry) ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.stock_lots')
        .where({ warehouse_id: whId, product_id: prodId, lot_code: 'REC-EXISTING' })
        .del();
      await trx('commercial.stock_lots').insert({
        tenant_id: TENANT, warehouse_id: whId, product_id: prodId,
        lot_code: 'REC-EXISTING', expiry_date: d.existing, quantity: 100,
      });
    });

    // ── 2. Política ──
    console.log('\n2) Política (upsert por producto)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.expiry_receiving_policy')
        .where({ product_id: prodId, category: null, supplier_code: null }).del();
      await trx('commercial.expiry_receiving_policy').insert({
        tenant_id: TENANT, product_id: prodId, min_shelf_life_days: 180,
        allow_older_than_existing: false, source: 'manual', updated_by: USER_A,
      });
    });
    const pol = await knex.transaction(async (trx) => {
      await setCtx(trx);
      return trx('commercial.expiry_receiving_policy').where({ product_id: prodId }).first();
    });
    check(pol && Number(pol.min_shelf_life_days) === 180, 'política min_shelf_life_days=180 persistida');

    // ── 3+4. Contexto + veredictos ──
    console.log('\n3) Contexto + 4) veredictos');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const policy = { minShelfLifeDays: 180, allowOlder: false };

      // GREEN: caduca en +800d, no más viejo que existente (+400d)
      let c = await ctx(trx, whId, prodId, d.far);
      check(c.existingMinExpiry === d.existing, `existing_min_expiry = ${d.existing} (MIN de stock_lots)`);
      let v = computeVerdict({ confirmedExpiry: d.far, ...c, ...policy });
      check(v.verdict === 'green', `+800d vs existente +400d → green (fue ${v.verdict})`);

      // RED older_than_existing: caduca en +100d (< existente +400d), cumple mínima? 100<180 → primero cae belowMin.
      // Para aislar older_than_existing usamos +200d (>=180, pero < +400d existente).
      c = await ctx(trx, whId, prodId, d.near);
      v = computeVerdict({ confirmedExpiry: d.near, ...c, ...policy });
      check(v.verdict === 'red' && v.rule_broken === 'older_than_existing', `+200d vs existente +400d → red older_than_existing (fue ${v.verdict}/${v.rule_broken})`);

      // RED min_shelf_life: caduca en +30d (< 180)
      c = await ctx(trx, whId, prodId, d.soon);
      v = computeVerdict({ confirmedExpiry: d.soon, ...c, ...policy });
      check(v.verdict === 'red' && v.rule_broken === 'min_shelf_life', `+30d < mín 180 → red min_shelf_life (fue ${v.verdict}/${v.rule_broken})`);

      // YELLOW near_min: SIN existente (null) + caduca en +200d (>=180 pero <270)
      v = computeVerdict({ confirmedExpiry: d.near, daysOfLife: 200, existingMinExpiry: null, ...policy });
      check(v.verdict === 'yellow' && v.rule_broken === 'near_min_shelf_life', `+200d, sin existente, mín 180 → yellow near_min_shelf_life (fue ${v.verdict}/${v.rule_broken})`);

      // GREEN sin política ni existente + caducidad lejana
      v = computeVerdict({ confirmedExpiry: d.far, daysOfLife: 800, existingMinExpiry: null, minShelfLifeDays: null, allowOlder: false });
      check(v.verdict === 'green', `sin política, caducidad lejana → green (fue ${v.verdict})`);
    });

    // ── 5. Captura: insert + CHECK ──
    console.log('\n5) Captura (insert + CHECK constraint)');
    let redId;
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.receiving_lot_captures').where({ warehouse_id: whId, product_id: prodId }).del();
      const [green] = await trx('commercial.receiving_lot_captures').insert({
        tenant_id: TENANT, warehouse_id: whId, product_id: prodId, supplier_code: 'REC-SUP',
        quantity: 10, confirmed_lot: 'L-GREEN', confirmed_expiry: d.far,
        verdict: 'green', status: 'accepted', created_by: USER_A,
      }).returning('id');
      check(!!green.id, 'insert captura green (accepted)');
      const [red] = await trx('commercial.receiving_lot_captures').insert({
        tenant_id: TENANT, warehouse_id: whId, product_id: prodId, supplier_code: 'REC-SUP',
        quantity: 5, confirmed_lot: 'L-RED', confirmed_expiry: d.soon,
        verdict: 'red', rule_broken: 'min_shelf_life', status: 'pending_authorization', created_by: USER_A,
      }).returning('id');
      redId = red.id;
      check(!!redId, 'insert captura red (pending_authorization)');
    });

    // CHECK rechaza verdict inválido
    let checkOk = false;
    try {
      await knex.transaction(async (trx) => {
        await setCtx(trx);
        await trx('commercial.receiving_lot_captures').insert({
          tenant_id: TENANT, warehouse_id: whId, product_id: prodId, quantity: 1,
          confirmed_lot: 'X', verdict: 'purple', status: 'accepted',
        });
      });
    } catch { checkOk = true; }
    check(checkOk, "CHECK constraint rechaza verdict inválido ('purple')");

    // ── 6. Autorizar rojo ──
    console.log('\n6) Autorizar rojo');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.receiving_lot_captures').where({ id: redId }).update({
        status: 'authorized', authorized_by: USER_A, authorized_at: trx.fn.now(),
      });
      const row = await trx('commercial.receiving_lot_captures').where({ id: redId }).first();
      check(row.status === 'authorized', 'rojo transiciona a authorized');
    });

    // scorecard: agregado por proveedor
    const score = await knex.transaction(async (trx) => {
      await setCtx(trx);
      return trx('commercial.receiving_lot_captures')
        .where({ supplier_code: 'REC-SUP' })
        .select('supplier_code')
        .count({ receptions: '*' })
        .select(trx.raw(`COUNT(*) FILTER (WHERE verdict <> 'green') AS nonconformities`))
        .groupBy('supplier_code')
        .first();
    });
    check(Number(score.receptions) === 2 && Number(score.nonconformities) === 1, `scorecard REC-SUP: 2 recepciones / 1 NC (fue ${score.receptions}/${score.nonconformities})`);

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.receiving_lot_captures').where({ warehouse_id: whId }).del();
      await trx('commercial.expiry_receiving_policy').where({ product_id: prodId }).del();
      await trx('commercial.stock_lots').where({ warehouse_id: whId, lot_code: 'REC-EXISTING' }).del();
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Auditor de recepción: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
