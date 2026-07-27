/* eslint-disable no-console */
/**
 * FIQ.1 (cerebro avanzado) — Smoke DB-direct del audit/throttle/tiering.
 *
 * Verifica contra la DB real:
 *   1. whatsapp.bot_chat_log existe con RLS FORZADO + CHECK del feedback (±1).
 *   2. THROTTLE: la MISMA query del guard (turnos por teléfono en ventana móvil)
 *      cuenta los turnos dentro de 24h y NO cuenta los más viejos — dentro de una
 *      trx con ROLLBACK (cero efecto real).
 *   3. TIERING: la heurística pickModel (réplica exacta) enruta a Haiku los turnos
 *      simples y a Sonnet los difíciles (largo/ambigüedad/mayoreo/comparación).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Réplica EXACTA de ConversationOrchestratorService.pickModel.
function pickModel(userText, historyLen) {
  const t = (userText || '').toLowerCase();
  const complex =
    t.length > 160 ||
    historyLen >= 6 ||
    /(por qu|porqu|cu[aá]l|diferencia|recomien|no s[eé]|conviene|mejor opci|comparar|cu[aá]nto.*(sale|cuesta|queda).*(si|con)|mayoreo|al por mayor|factura|descuento|precio especial|crédito|credito)/i.test(t);
  return complex ? SONNET : HAIKU;
}

(async () => {
  try {
    // ── 1. Schema + RLS + CHECK ──────────────────────────────────────────────
    const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'whatsapp.bot_chat_log'::regclass`);
    ok(rls.rows[0]?.relforcerowsecurity === true, 'whatsapp.bot_chat_log existe con RLS FORZADO');

    await knex.transaction(async (trx) => {
      const phone = '525599990011';
      // 2. Throttle: 3 turnos dentro de 24h + 1 hace 48h (no debe contar).
      const mk = (agoHours) => ({
        tenant_id: T, thread_id: null, phone, user_text: 'hola', reply_text: 'hola!',
        model: HAIKU, escalated: false, tools_used: JSON.stringify([]), iterations: 1,
        created_at: trx.raw(`now() - (? || ' hours')::interval`, [agoHours]),
      });
      await trx('whatsapp.bot_chat_log').insert([mk(0), mk(1), mk(5), mk(48)]);

      const h = 24;
      const r = await trx('whatsapp.bot_chat_log')
        .where({ phone })
        .where('created_at', '>', trx.raw(`now() - (? || ' hours')::interval`, [h]))
        .count({ count: '*' })
        .first();
      ok(Number(r.count) === 3, `throttle cuenta 3 turnos en 24h (ignora el de 48h) — dio ${r.count}`);

      // +1 / -1 sí se aceptan (ANTES del insert inválido: el 23514 aborta la trx).
      await trx('whatsapp.bot_chat_log').insert([{ ...mk(0), feedback: 1 }, { ...mk(0), feedback: -1 }]);
      ok(true, 'feedback 👍(+1)/👎(-1) se aceptan');

      // CHECK del feedback: 2 es inválido (solo ±1). Va al final (aborta la trx).
      let rejected = false;
      try {
        await trx('whatsapp.bot_chat_log').insert({ ...mk(0), feedback: 2 });
      } catch (e) { rejected = e.code === '23514'; }
      ok(rejected, 'el CHECK del feedback rechaza un valor distinto de ±1');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    // ── 3. Tiering ─────────────────────────────────────────────────────────
    const cases = [
      ['hola', 0, HAIKU],
      ['quiero un pulparindo', 0, HAIKU],
      ['me mandas 3 mazapanes porfa', 0, HAIKU],
      ['¿cuál es la diferencia entre estos dos y cuál me recomiendas?', 0, SONNET],
      ['me das precio de mayoreo?', 0, SONNET],
      ['necesito factura', 0, SONNET],
      ['x'.repeat(170), 0, SONNET],           // mensaje largo
      ['sí', 6, SONNET],                       // hilo ya extenso
    ];
    for (const [text, hist, expected] of cases) {
      const m = pickModel(text, hist);
      const label = text.length > 30 ? text.slice(0, 30) + '…' : text;
      ok(m === expected, `tiering "${label}" (hist ${hist}) → ${m === HAIKU ? 'Haiku' : 'Sonnet'} (esperado ${expected === HAIKU ? 'Haiku' : 'Sonnet'})`);
    }

    console.log(`\nFIQ.1 brain: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    await knex.destroy();
    process.exit(1);
  }
})();
