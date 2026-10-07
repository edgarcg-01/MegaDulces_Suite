/* eslint-disable no-console */
/**
 * Fase TC (ADR-026) — Thot Chat. Evals "golden-questions": verifica que el agente
 * RUTEE cada pregunta a la(s) tool(s) correcta(s) y devuelva respuesta no vacía.
 * Es el gate de calidad (estilo LinkedIn SQL Bot / guía Anthropic): no medimos la
 * prosa, medimos que el modelo elija bien la herramienta y que los números salgan
 * de una tool (nunca de la nada).
 *
 * Requiere: API arriba (localhost:3334) + ANTHROPIC_API_KEY configurada + las
 * migraciones analytics.* + commercial.thot_chat_log aplicadas + feeds Kepler
 * cargados. Sin API key, el test se salta (no se puede evaluar el LLM).
 *
 * Standalone. Agregar a run-all-tests.js SOLO tras verlo verde.
 */
const BASE = 'http://localhost:3334/api';

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}
const ok2xx = (s) => s >= 200 && s < 300;

// Cada caso: pregunta + al menos una tool esperada (substring del nombre).
const GOLDEN = [
  { q: '¿Cuánto se vendió en los últimos 30 días?', tools: ['thot_sales_timeseries', 'thot_flexible_aggregate', 'thot_get_sales_overview'] },
  { q: 'Dame el top 10 de productos más vendidos', tools: ['thot_top_products', 'thot_product_ranking', 'thot_flexible_aggregate'] },
  { q: '¿Qué productos están agotados siendo best-sellers?', tools: ['thot_out_of_stock_bestsellers'] },
  { q: 'Margen por categoría', tools: ['thot_margin_by_category'] },
  { q: '¿Qué promociones hay vigentes?', tools: ['thot_active_promotions'] },
  { q: '¿Qué clientes llevan más de 30 días sin comprar?', tools: ['thot_inactive_customers'] },
  { q: '¿Qué almacenes existen?', tools: ['thot_list_warehouses'] },
  { q: 'Muéstrame el stock muerto', tools: ['thot_dead_stock'] },
  { q: 'Ventas por marca este mes', tools: ['thot_flexible_aggregate', 'thot_sales_by_brand'] },
  { q: 'Salud del inventario: qué está crítico', tools: ['thot_inventory_health'] },
];

(async () => {
  console.log('── 1. Login admin ──');
  const admin = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  check('admin login OK', !!admin.body?.access_token);
  const token = admin.body?.access_token;
  if (!token) { console.log('Sin token, abortando.'); process.exit(1); }

  console.log('\n── 2. Sanity: una pregunta ──');
  const first = await req('POST', '/commercial/intelligence/thot/chat', { message: GOLDEN[0].q }, token);
  check('endpoint responde 2xx', ok2xx(first.status), `status ${first.status}`);
  if (first.body?.source === 'no_api_key') {
    console.log('\n⚠️  ANTHROPIC_API_KEY no configurada — evals del LLM omitidos (sin error).');
    console.log(`\nRESUMEN: ${pass} OK / ${fail} FAIL (evals omitidos)`);
    process.exit(fail > 0 ? 1 : 0);
  }

  console.log('\n── 3. Golden-questions (ruteo de tools) ──');
  for (const g of GOLDEN) {
    const res = await req('POST', '/commercial/intelligence/thot/chat', { message: g.q }, token);
    const body = res.body || {};
    const used = (body.tools_used || []).map((t) => t.name);
    const routedOk = used.some((n) => g.tools.includes(n));
    const hasAnswer = typeof body.answer === 'string' && body.answer.trim().length > 0;
    check(`"${g.q.slice(0, 42)}…" → tool correcta`, routedOk, `usó [${used.join(', ') || 'ninguna'}], esperaba una de [${g.tools.join('/')}]`);
    check(`"${g.q.slice(0, 42)}…" → respuesta no vacía`, hasAnswer);
  }

  console.log('\n── 4. Entidad difusa (resolve_entity) ──');
  const ent = await req('POST', '/commercial/intelligence/thot/chat', { message: '¿Cómo se vende la marca Kinder?' }, token);
  const entTools = (ent.body?.tools_used || []).map((t) => t.name);
  check('marca difusa usa resolve_entity o agregación', entTools.includes('thot_resolve_entity') || entTools.includes('thot_flexible_aggregate') || entTools.includes('thot_top_products'), `usó [${entTools.join(', ')}]`);

  console.log('\n── 5. Multi-turno (contexto) ──');
  const turn1 = await req('POST', '/commercial/intelligence/thot/chat', { message: 'Top 5 productos más vendidos' }, token);
  const histLen = (turn1.body?.answer || '').length > 0;
  const turn2 = await req('POST', '/commercial/intelligence/thot/chat', {
    history: [
      { role: 'user', content: 'Top 5 productos más vendidos' },
      { role: 'assistant', content: turn1.body?.answer || '...' },
    ],
    message: '¿Y de esos cuál deja más margen?',
  }, token);
  check('turno 1 responde', histLen);
  check('turno 2 (follow-up) responde 2xx', ok2xx(turn2.status));

  console.log(`\nRESUMEN: ${pass} OK / ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
