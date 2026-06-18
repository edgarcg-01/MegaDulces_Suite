/* eslint-disable no-console */
/**
 * Thot T.1 — recomendación producto-first (afinidad + zona + rotación + margen).
 *
 * 1. GET /commercial/intelligence/thot/suggest/:customer → lista rankeada, pedible,
 *    con razón; no incluye basura (= GRATIS / no-comercial).
 * 2. Con ?cart=<producto> → cart-aware ("completá la canasta"): aparecen afines
 *    (aff_lift>0 / reason=affinity) y NO se sugiere lo que ya está en el carrito.
 *
 * Requiere: API :3334 con el código T.1 + feature store construido
 * (node database/scripts/thot-build-features.js).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 1 } });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0; const failures = [];

async function req(method, path, token) {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  let code = 1;
  try {
    const login = await fetch(`${BASE}/auth-mt/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }),
    }).then((r) => r.json());
    const token = login?.access_token;
    check('login superoot', !!token);
    if (!token) return;

    // customer con default (o cualquiera; suggest resuelve price list) + producto popular (CANELS 20005)
    const customer = (await knex('commercial.customers').where({ tenant_id: T }).whereNull('deleted_at').first('id')).id;
    const canels = (await knex('catalog.products').where({ tenant_id: T }).whereRaw("coalesce(sku,articulo)='20005'").first('id'))?.id;
    check('hay customer + producto CANELS', !!customer && !!canels);

    console.log('\n── 1. Sugerencias (carrito vacío) ──');
    const s = await req('GET', `/commercial/intelligence/thot/suggest/${customer}?limit=12`, token);
    check('responde array', Array.isArray(s.body), s.status);
    const list = s.body || [];
    check('hay sugerencias', list.length > 0, list.length);
    check('todas pedibles (price>0)', list.every((x) => Number(x.price) > 0));
    check('todas con razón', list.every((x) => !!x.reason_label));
    check('sin basura "= GRATIS"', !list.some((x) => /GRATIS/i.test(x.product_name)), list.map((x) => x.product_name).filter((n) => /GRATIS/i.test(n)));

    console.log('\n── 2. Cart-aware (completá la canasta) ──');
    const c = await req('GET', `/commercial/intelligence/thot/suggest/${customer}?cart=${canels}&limit=20`, token);
    const clist = c.body || [];
    check('responde con carrito', Array.isArray(clist) && clist.length > 0, clist.length);
    check('NO sugiere lo que ya está en el carrito', !clist.some((x) => x.product_id === canels));
    check('aparecen afines (algún aff_lift>0 / reason=affinity)',
      clist.some((x) => Number(x.aff_lift) > 0 || x.reason === 'affinity'),
      clist.slice(0, 3).map((x) => `${x.product_name}:${x.aff_lift}`));

    console.log('\n── 3. Promo como señal de empuje (CV.5: cohesión empuje↔promos) ──');
    // Elegir un producto SIN directriz (precedencia: estrategia > promo) para que
    // reason='promo' sea determinista. Lista amplia: el top suele estar dominado
    // por directrices ("Marca del mes" boostea toda la marca).
    const pick = await req('GET', `/commercial/intelligence/thot/suggest/${customer}?limit=50`, token);
    const nonDir = (pick.body || []).filter((x) => x.reason !== 'estrategia');
    const target = nonDir[0] || (pick.body || [])[0];
    check('hay producto base (sin directriz) para promocionar', !!target && target.reason !== 'estrategia', target?.reason);
    if (target) {
      const promoCode = 'THOT-CV5-TEST';
      await knex('commercial.promotions').where({ tenant_id: T, code: promoCode }).del();
      await knex('commercial.promotions').insert({
        tenant_id: T,
        code: promoCode,
        name: 'Test CV5 Empuje',
        promotion_type: 'percent_off_product',
        rules: JSON.stringify({ product_id: target.product_id, percent: 10 }),
        priority: 50,
        active: true,
      });
      const s2 = await req('GET', `/commercial/intelligence/thot/suggest/${customer}?limit=50`, token);
      const found = (s2.body || []).find((x) => x.product_id === target.product_id);
      check('producto en promo sigue sugerido', !!found, found?.product_id);
      check('marcado on_promo=true', !!found && found.on_promo === true, { on_promo: found?.on_promo });
      check('reason=promo + label "En promoción"', !!found && found.reason === 'promo', {
        reason: found?.reason,
        label: found?.reason_label,
      });
      await knex('commercial.promotions').where({ tenant_id: T, code: promoCode }).del();
    }

    console.log(`\n════════ Total: ${pass} pass / ${fail} fail ════════`);
    if (fail) console.log('Failures:\n  - ' + failures.join('\n  - '));
    code = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
    code = 1;
  } finally {
    await knex.destroy();
  }
  process.exit(code);
})();
