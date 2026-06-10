/* eslint-disable no-console */
/**
 * Seed de demostración del Motor de Inteligencia (Fase M).
 *
 * Crea un customer 'NBA-DEMO-001' con 6 pedidos fulfilled ESPACIADOS ~7 días
 * (último hace 10) → cadencia ~7, recency ~10 → due_for_reorder. Sirve para
 * ejercitar el happy-path del NBA/agente que la testdata amontonada no cubre.
 *
 * Idempotente: limpia los pedidos demo previos y re-inserta. Inserta como
 * `postgres` (bypassa RLS) con tenant_id explícito. Tras sembrar, llama al API
 * (localhost:3334) para mostrar compute → NBA → mensaje.
 *
 * Uso: node database/scripts/seed-nba-demo.js
 */
const ROOT = 'c:/Users/Sistemas/CascadeProjects/Trade_marketing';
const cfg = require(ROOT + '/database/knexfile-newdb.js').development;
const k = require(ROOT + '/node_modules/knex')(cfg);
const BASE = 'http://localhost:3334/api';
const DEMO_CODE = 'NBA-DEMO-001';

(async () => {
  const tenant = await k('public.tenants').where({ slug: 'mega_dulces' }).first('id');
  if (!tenant) throw new Error('tenant mega_dulces no encontrado');
  const tenantId = tenant.id;

  const user = await k('public.users').where({ tenant_id: tenantId }).whereNull('deleted_at').first('id');
  const wh = await k('commercial.warehouses').where({ tenant_id: tenantId }).whereNull('deleted_at').orderBy('is_default', 'desc').first('id');
  const pl = await k('commercial.price_lists').where({ tenant_id: tenantId }).whereNull('deleted_at').orderBy('is_default', 'desc').first('id');
  if (!user || !wh || !pl) throw new Error(`Faltan refs: user=${!!user} warehouse=${!!wh} price_list=${!!pl}`);

  const products = await k('commercial.product_prices as pp')
    .where('pp.tenant_id', tenantId)
    .where('pp.price_list_id', pl.id)
    .whereNull('pp.deleted_at')
    .join('public.products as p', function () {
      this.on('p.id', '=', 'pp.product_id').andOn('p.tenant_id', '=', 'pp.tenant_id');
    })
    .whereNull('p.deleted_at')
    .select('pp.product_id', 'pp.price', 'p.nombre')
    .limit(3);
  if (products.length === 0) throw new Error('Sin productos con precio en la lista default');

  // Customer demo (find-or-clone para cubrir NOT NULL sin adivinar columnas).
  let cust = await k('commercial.customers').where({ tenant_id: tenantId, code: DEMO_CODE }).first();
  if (!cust) {
    const tmpl = await k('commercial.customers').where({ tenant_id: tenantId }).whereNull('deleted_at').first();
    if (!tmpl) throw new Error('No hay customer plantilla para clonar');
    const row = { ...tmpl };
    delete row.id;
    row.code = DEMO_CODE;
    row.name = 'Demo Reorden (cadencia)';
    row.rfc = null;
    row.email = null;
    row.deleted_at = null;
    row.deleted_by = null;
    row.created_at = new Date();
    row.updated_at = new Date();
    if ('default_price_list_id' in row) row.default_price_list_id = pl.id;
    const [ins] = await k('commercial.customers').insert(row).returning('*');
    cust = ins;
    console.log(`Customer creado: ${cust.code} (${cust.id})`);
  } else {
    console.log(`Customer ya existe: ${cust.code} (${cust.id}) — limpio pedidos demo`);
  }

  // Limpiar pedidos previos del demo (cascade borra order_lines).
  const del = await k('commercial.orders').where({ tenant_id: tenantId, customer_id: cust.id }).del();
  if (del) console.log(`  ${del} pedidos demo previos borrados`);

  const N = 6, gapDays = 7, lastDaysAgo = 10;
  for (let i = 0; i < N; i++) {
    const daysAgo = lastDaysAgo + (N - 1 - i) * gapDays; // i=0 más viejo
    const ts = new Date(Date.now() - daysAgo * 86400000);
    const lines = products.map((p, idx) => {
      const qty = 5 + idx;
      const price = Number(p.price);
      const sub = +(qty * price).toFixed(2);
      const tax = +(sub * 0.16).toFixed(2);
      return {
        product_id: p.product_id,
        line_number: idx + 1,
        quantity: qty,
        unit_price: price,
        tax_rate: 0.16,
        discount_percent: 0,
        line_subtotal: sub,
        line_tax: tax,
        line_total: +(sub + tax).toFixed(2),
      };
    });
    const subtotal = +lines.reduce((a, l) => a + l.line_subtotal, 0).toFixed(2);
    const taxTotal = +lines.reduce((a, l) => a + l.line_tax, 0).toFixed(2);
    const total = +(subtotal + taxTotal).toFixed(2);
    const [order] = await k('commercial.orders').insert({
      tenant_id: tenantId,
      code: `NBA-DEMO-${String(i + 1).padStart(4, '0')}`,
      customer_id: cust.id,
      user_id: user.id,
      warehouse_id: wh.id,
      price_list_id: pl.id,
      status: 'fulfilled',
      payment_method: 'cash',
      subtotal,
      tax_total: taxTotal,
      total,
      paid_amount: total,
      balance_due: 0,
      currency: 'MXN',
      confirmed_at: ts,
      fulfilled_at: ts,
      created_at: ts,
      updated_at: ts,
    }).returning('id');
    await k('commercial.order_lines').insert(lines.map((l) => ({ ...l, tenant_id: tenantId, order_id: order.id, created_at: ts })));
  }
  console.log(`Sembrados ${N} pedidos fulfilled espaciados ${gapDays}d (último hace ${lastDaysAgo}d).`);

  // ── Demostración vía API ──
  console.log('\n── Demo happy-path vía API ──');
  const loginRes = await fetch(`${BASE}/auth-mt/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }),
  });
  const login = await loginRes.json();
  const tok = login.access_token;
  const api = async (m, p) => {
    const r = await fetch(`${BASE}${p}`, { method: m, headers: { Authorization: `Bearer ${tok}` } });
    try { return await r.json(); } catch { return null; }
  };
  const c360 = await api('POST', `/commercial/intelligence/customer-360/${cust.id}/compute`);
  console.log('  Customer360:', JSON.stringify({ orders: c360?.orders_count, stage: c360?.lifecycle_stage, cadence: c360?.cadence_days, next: c360?.next_order_estimate, recency: c360?.recency_days }));
  const nba = await api('GET', `/commercial/intelligence/nba/${cust.id}`);
  console.log('  NBA:', JSON.stringify({ action: nba?.action, urgency: nba?.urgency, days_overdue: nba?.days_overdue, reason: nba?.reason }));
  const msg = await api('GET', `/commercial/intelligence/nba/${cust.id}/message`);
  console.log('  Mensaje:', JSON.stringify({ action: msg?.action, by: msg?.generated_by, message: msg?.message, basket: (msg?.basket || []).map((b) => b.product_name) }));
  const list = await api('GET', '/commercial/intelligence/nba?limit=50');
  console.log('  NBA list (tenant):', Array.isArray(list) ? `${list.length} due` : list);

  await k.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
