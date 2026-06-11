/* eslint-disable no-console */
/**
 * Thot T.2 — Empuje dirigido. El negocio crea una directriz de marca foco y Thot
 * la amplifica en el suggest (la marca surge con reason='estrategia' + su razón).
 *
 * 1. brands picker · 2. crear directriz (boost 2) · 3. aparece en el listado ·
 * 4. suggest muestra productos de esa marca con reason=estrategia · 5. cleanup.
 *
 * Requiere API :3334 con T.2 + feature store.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 1 } });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';
const PL = null;
let pass = 0, fail = 0; const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
function check(n, c, d) { if (c) { console.log(`  OK   ${n}`); pass++; } else { console.log(`  FAIL ${n}${d !== undefined ? ' — ' + JSON.stringify(d) : ''}`); failures.push(n); fail++; } }

(async () => {
  let code = 1; let createdId = null;
  try {
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('login', !!token); if (!token) return;

    // marca con productos pedibles (determinista, vía DB) para que surja en suggest
    const def = (await knex('commercial.price_lists').where({ tenant_id: T, is_default: true }).first('id')).id;
    const brand = (await knex.raw(
      `select b.id, b.nombre from catalog.brands b
        where b.tenant_id=? and (b.is_commercial=true or b.is_commercial is null)
          and exists (select 1 from catalog.products p join commercial.product_prices pp on pp.product_id=p.id and pp.price_list_id=? and pp.deleted_at is null and pp.price>0 where p.brand_id=b.id)
        order by b.nombre limit 1`, [T, def])).rows[0];
    const customer = (await knex('commercial.customers').where({ tenant_id: T }).whereNull('deleted_at').first('id')).id;
    check('marca con pedibles + customer', !!brand && !!customer, brand?.nombre);

    console.log('\n── 1. brands picker ──');
    const brs = await req('GET', '/commercial/intelligence/directives/brands?search=', null, token);
    check('brands devuelve array', Array.isArray(brs.body) && brs.body.length > 0, brs.status);

    console.log('\n── 2. crear directriz (boost 2) ──');
    const c = await req('POST', '/commercial/intelligence/directives', {
      directive_type: 'focus_brand', target_id: brand.id, reason: 'TEST FOCO SMOKE', boost: 2, sponsor: 'Smoke',
    }, token);
    check('crear → 2xx + id', c.status < 300 && !!c.body?.id, c.body);
    createdId = c.body?.id;

    console.log('\n── 3. aparece en el listado con target_name ──');
    const list = await req('GET', '/commercial/intelligence/directives', null, token);
    const mine = (list.body || []).find((d) => d.id === createdId);
    check('directriz listada', !!mine);
    check('trae target_name', !!mine?.target_name, mine?.target_name);

    console.log('\n── 4. suggest amplifica la marca foco ──');
    const s = await req('GET', `/commercial/intelligence/thot/suggest/${customer}?limit=40`, null, token);
    const boosted = (s.body || []).filter((x) => x.reason === 'estrategia');
    check('hay items con reason=estrategia', boosted.length > 0, (s.body || []).slice(0, 3).map((x) => x.reason));
    check('su razón es la de la directriz', boosted.some((x) => x.reason_label === 'TEST FOCO SMOKE'), boosted[0]?.reason_label);

    console.log('\n── 5. cleanup ──');
    const del = await req('DELETE', `/commercial/intelligence/directives/${createdId}`, null, token);
    check('eliminar → 2xx', del.status < 300);
    createdId = null;

    console.log(`\n════════ Total: ${pass} pass / ${fail} fail ════════`);
    if (fail) console.log('Failures:\n  - ' + failures.join('\n  - '));
    code = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message); code = 1;
  } finally {
    if (createdId) { try { await knex('intelligence.push_directives').where({ id: createdId }).del(); } catch (_) {} }
    await knex.destroy();
  }
  process.exit(code);
})();
