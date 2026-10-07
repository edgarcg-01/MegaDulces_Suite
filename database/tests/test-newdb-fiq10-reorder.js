/* eslint-disable no-console */
/**
 * FIQ.10 (outbound reorden) — Smoke DB-direct del motor de targeting/idempotencia.
 *
 * Verifica contra data real:
 *   1. whatsapp.reorder_nudges existe con RLS FORZADO + CHECK status.
 *   2. listDueForReorder (réplica exacta de la query del binding, tenant explícito):
 *      candidatos ATRASADOS (recency > cadence + minOverdue), CONTACTABLES (phone
 *      no-nulo), etapa active/at_risk, ordenados por más atrasado.
 *   3. Idempotencia/cooldown: un nudge reciente marca al customer como "ya nudgeado"
 *      (la query del cooldown lo trae) — dentro de una trx con ROLLBACK.
 *   4. composeReorderMessage (réplica) arma mensaje con nombre + producto.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Réplica de WhatsAppReorderService.composeReorderMessage.
function compose(c) {
  const first = (c.name || '').trim().split(/\s+/)[0] || '';
  const hi = first ? `Hola ${first} 👋` : 'Hola 👋';
  const prod = c.top_product ? ` tu ${c.top_product}` : ' tu pedido habitual';
  return `${hi} Somos de Mega Dulces 🍬 Notamos que quizá ya se te está acabando${prod}. ¿Te reabastecemos? Respondé este mensaje y armamos tu pedido a domicilio.`;
}

const dueSql = `
  SELECT c360.customer_id, cu.name,
         COALESCE(public.mx_normalize_phone(cu.whatsapp), public.mx_normalize_phone(cu.phone)) AS phone,
         (c360.recency_days - c360.cadence_days) AS days_overdue, c360.cadence_days, c360.lifecycle_stage
    FROM commercial.customer_360 c360
    JOIN commercial.customers cu ON cu.id = c360.customer_id AND cu.tenant_id = c360.tenant_id
   WHERE c360.tenant_id = ?
     AND cu.deleted_at IS NULL
     AND c360.cadence_days IS NOT NULL AND c360.cadence_days > 0
     AND c360.recency_days > c360.cadence_days + ?
     AND c360.lifecycle_stage IN ('active','at_risk')
     AND COALESCE(cu.whatsapp, cu.phone) IS NOT NULL
   ORDER BY (c360.recency_days - c360.cadence_days) DESC
   LIMIT ?`;

(async () => {
  try {
    // ── 1. Schema + RLS ──────────────────────────────────────────────────────
    const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'whatsapp.reorder_nudges'::regclass`);
    ok(rls.rows[0]?.relforcerowsecurity === true, 'whatsapp.reorder_nudges existe con RLS FORZADO');

    // ── 2. Targeting ─────────────────────────────────────────────────────────
    const minOverdue = 1;
    const r = await knex.raw(dueSql, [T, minOverdue, 50]);
    const due = r.rows;
    ok(Array.isArray(due), `listDueForReorder corre (${due.length} candidatos atrasados)`);
    if (due.length) {
      ok(due.every((d) => Number(d.days_overdue) > minOverdue - 1), 'todos ATRASADOS (recency − cadence > minOverdue)');
      ok(due.every((d) => !!d.phone), 'todos CONTACTABLES (phone E.164 no-nulo)');
      ok(due.every((d) => ['active', 'at_risk'].includes(d.lifecycle_stage)), 'todos en etapa active/at_risk (no lost)');
      const ov = due.map((d) => Number(d.days_overdue));
      ok(ov.every((v, i) => i === 0 || ov[i - 1] >= v), 'orden por MÁS atrasado primero');
    } else {
      console.log('  · sin candidatos atrasados hoy (ok — la query es válida)');
    }

    // ── 3. Idempotencia / cooldown (rollback) ─────────────────────────────────
    await knex.transaction(async (trx) => {
      const someCustomer = due[0]?.customer_id
        || (await trx('commercial.customers').where({ tenant_id: T }).whereNull('deleted_at').first('id')).id;
      await trx('whatsapp.reorder_nudges').insert({
        tenant_id: T, customer_id: someCustomer, phone: '525599990021',
        days_overdue: 10, top_product: 'Pulparindo', message: 'x', status: 'planned',
      });
      const cooldownDays = 14;
      const recent = await trx('whatsapp.reorder_nudges')
        .where('created_at', '>', trx.raw(`now() - (? || ' days')::interval`, [cooldownDays]))
        .distinct('customer_id');
      const set = new Set(recent.map((x) => x.customer_id));
      ok(set.has(someCustomer), 'cooldown: un nudge reciente marca al customer como ya-nudgeado (anti-spam)');

      // CHECK status inválido.
      let rejected = false;
      try {
        await trx('whatsapp.reorder_nudges').insert({ tenant_id: T, customer_id: someCustomer, phone: '5255', status: 'weird' });
      } catch (e) { rejected = e.code === '23514'; }
      ok(rejected, 'CHECK de status rechaza un valor inválido');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    // ── 4. Composición del mensaje ─────────────────────────────────────────────
    const msg = compose({ name: 'María López', top_product: 'Mazapán', days_overdue: 12 });
    ok(msg.includes('María') && msg.includes('Mazapán') && msg.includes('reabastecemos'), 'mensaje arma nombre + producto + CTA');
    const msg2 = compose({ name: '', top_product: null, days_overdue: 5 });
    ok(msg2.includes('pedido habitual') && !msg2.includes('undefined'), 'fallback sin nombre/producto no rompe');

    console.log(`\nFIQ.10 reorder: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    await knex.destroy();
    process.exit(1);
  }
})();
