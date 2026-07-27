/* eslint-disable no-console */
/**
 * FIQ.7 (trust-score del contacto) — Smoke DB-direct del gate determinista.
 *
 * Verifica contra la DB real:
 *   1. Las 2 tablas existen con RLS FORZADO + seed de trust_thresholds (tenant MD).
 *   2. UPSERT idempotente del feature store por (tenant, phone) + CHECK del tier
 *      (rechaza un tier inválido) — dentro de una trx con ROLLBACK (cero efecto).
 *   3. La TABLA DE DECISIÓN (réplica exacta de decide()) produce los tiers
 *      esperados usando los UMBRALES SEMBRADOS, cubriendo: cold-start, comprador
 *      limpio, no-show duro (block), fallos parciales, cancelación alta, "solo
 *      juega" (0 pedidos + muchas charlas), y deuda.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Réplica EXACTA de ContactTrustEngineService.decide (motor determinista).
function decide(f, th) {
  const observations = f.orders_created + f.conversations_total;
  const failRate = f.deliveries_total > 0 ? f.deliveries_failed / f.deliveries_total : 0;
  const cancelRate = f.orders_created > 0 ? f.orders_cancelled / f.orders_created : 0;
  const playingRatio = f.conversations_total > 0 ? f.conversations_without_order / f.conversations_total : 0;
  const isPlaying = f.orders_created === 0 && f.conversations_without_order >= th.deposit_playing_convos;
  const hasDebt = f.balance >= th.deposit_min_balance;
  const riskScore = Math.round(clamp01(
    0.45 * failRate + 0.25 * cancelRate + 0.2 * playingRatio * (f.orders_created === 0 ? 1 : 0.3) +
    (hasDebt ? 0.15 : 0) + Math.min(f.reservations_expired, 3) * 0.05) * 10000) / 10000;
  if (observations < th.min_observations) return { tier: 'neutral', riskScore };
  if (failRate >= th.block_fail_rate && f.deliveries_failed >= th.block_fail_count) return { tier: 'block', riskScore };
  let deposit = false;
  if (f.deliveries_total >= 1 && failRate >= th.deposit_fail_rate) deposit = true;
  if (f.orders_created >= 2 && cancelRate >= th.deposit_cancel_rate) deposit = true;
  if (isPlaying) deposit = true;
  if (hasDebt) deposit = true;
  if (deposit) return { tier: 'require_deposit', riskScore };
  return { tier: 'allow', riskScore };
}

const feat = (o = {}) => ({
  orders_created: 0, orders_confirmed: 0, orders_fulfilled: 0, orders_cancelled: 0,
  deliveries_total: 0, deliveries_failed: 0, calls_total: 0, calls_unproductive: 0,
  conversations_total: 0, conversations_without_order: 0, reservations_expired: 0, balance: 0, ...o,
});

(async () => {
  try {
    // ── 1. Schema + RLS + seed ─────────────────────────────────────────────
    for (const t of ['contact_trust_features', 'trust_thresholds']) {
      const r = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`);
      ok(r.rows[0]?.relforcerowsecurity === true, `commercial.${t} existe con RLS FORZADO`);
    }
    const th = await knex('commercial.trust_thresholds').where({ tenant_id: T }).first();
    ok(!!th, 'trust_thresholds tiene seed para el tenant MD');
    const TH = {
      min_observations: Number(th.min_observations),
      block_fail_rate: Number(th.block_fail_rate),
      deposit_fail_rate: Number(th.deposit_fail_rate),
      block_fail_count: Number(th.block_fail_count),
      deposit_cancel_rate: Number(th.deposit_cancel_rate),
      deposit_playing_convos: Number(th.deposit_playing_convos),
      deposit_min_balance: Number(th.deposit_min_balance),
    };
    ok(TH.min_observations >= 1 && TH.deposit_playing_convos >= 1, `umbrales sembrados coherentes (min_obs=${TH.min_observations}, playing=${TH.deposit_playing_convos})`);

    // ── 2. UPSERT idempotente + CHECK del tier (rollback) ──────────────────
    await knex.transaction(async (trx) => {
      const phone = '525599990007';
      const base = {
        tenant_id: T, phone, orders_created: 1, conversations_total: 1, observations: 2,
        risk_score: 0.1, tier: 'allow', reasons: JSON.stringify(['x']),
      };
      await trx('commercial.contact_trust_features').insert(base)
        .onConflict(['tenant_id', 'phone']).merge({ tier: trx.raw("'require_deposit'"), updated_at: trx.fn.now() });
      await trx('commercial.contact_trust_features').insert({ ...base, tier: 'block' })
        .onConflict(['tenant_id', 'phone']).merge({ tier: trx.raw('EXCLUDED.tier'), updated_at: trx.fn.now() });
      const rows = await trx('commercial.contact_trust_features').where({ tenant_id: T, phone });
      ok(rows.length === 1, 'UPSERT por (tenant, phone) mantiene UNA fila (idempotente)');
      ok(rows[0].tier === 'block', 'el UPSERT actualizó el tier a la última evaluación');

      let checkRejected = false;
      try {
        await trx('commercial.contact_trust_features').insert({ ...base, phone: '525599990008', tier: 'invalid_tier' });
      } catch (e) { checkRejected = e.code === '23514'; }
      ok(checkRejected, 'el CHECK del tier rechaza un valor inválido');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    // ── 3. Tabla de decisión con umbrales sembrados ─────────────────────────
    const cases = [
      ['cold-start (nuevo, 1 charla)', feat({ conversations_total: 1, conversations_without_order: 1 }), 'neutral'],
      ['comprador limpio (5 pedidos, 3 entregas ok)', feat({ orders_created: 5, orders_confirmed: 5, orders_fulfilled: 3, conversations_total: 5, deliveries_total: 3 }), 'allow'],
      ['no-show duro (3/4 entregas fallidas)', feat({ orders_created: 4, conversations_total: 4, deliveries_total: 4, deliveries_failed: 3 }), 'block'],
      ['fallos parciales (1/3 entregas)', feat({ orders_created: 3, conversations_total: 3, deliveries_total: 3, deliveries_failed: 1 }), 'require_deposit'],
      ['cancela seguido (2/3 pedidos)', feat({ orders_created: 3, conversations_total: 3, orders_cancelled: 2, deliveries_total: 1 }), 'require_deposit'],
      ['solo juega (0 pedidos, 8 charlas)', feat({ orders_created: 0, conversations_total: 8, conversations_without_order: 8 }), 'require_deposit'],
      ['con deuda ($150)', feat({ orders_created: 4, conversations_total: 4, balance: 150 }), 'require_deposit'],
    ];
    for (const [label, f, expected] of cases) {
      const { tier } = decide(f, TH);
      ok(tier === expected, `${label} → ${tier} (esperado ${expected})`);
    }

    // Sanidad: el comprador limpio nunca dispara riesgo alto; el no-show sí.
    ok(decide(cases[1][1], TH).riskScore < 0.2, 'comprador limpio: risk_score bajo');
    ok(decide(cases[2][1], TH).riskScore >= 0.3, 'no-show duro: risk_score alto');

    console.log(`\nFIQ.7 contact-trust: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    await knex.destroy();
    process.exit(1);
  }
})();
