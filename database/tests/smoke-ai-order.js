/**
 * Smoke test para POST /api/commercial/ai-order/suggest.
 *
 * Uso (contra local):
 *   API_URL=http://localhost:3333 TENANT=mega_dulces USER=cliente_demo PASS=cliente_demo \
 *     node database/smoke-ai-order.js
 *
 * Uso (contra prod):
 *   API_URL=https://<tu-railway-host> TENANT=mega_dulces USER=cliente_demo PASS=cliente_demo \
 *     node database/smoke-ai-order.js
 *
 * Si ANTHROPIC_API_KEY no está en el backend, el endpoint cae a fallback heurístico
 * — vas a recibir un response válido pero sin LLM real. Para distinguir:
 *   - LLM real: assistant_message conversacional y reason útil
 *   - Heurístico: reason siempre = "Coincide con tu búsqueda"
 */
const API_URL = process.env.API_URL || 'http://localhost:3333';
const TENANT = process.env.TENANT || 'mega_dulces';
const USER = process.env.USER || 'cliente_demo';
const PASS = process.env.PASS || 'cliente_demo';

async function main() {
  console.log(`▶ Login a ${API_URL} con tenant=${TENANT} user=${USER}`);
  const loginRes = await fetch(`${API_URL}/api/auth-mt/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant_slug: TENANT, username: USER, password: PASS }),
  });
  if (!loginRes.ok) {
    console.error(`✗ Login HTTP ${loginRes.status}:`, await loginRes.text());
    process.exit(1);
  }
  const login = await loginRes.json();
  const token = login.access_token;
  console.log(`  ✓ Token obtenido. role=${login.user?.role_name} customer_id=${login.user?.customer_id || '(none)'}`);

  const cases = [
    { label: 'Mensaje directo con cantidad', msg: 'Necesito 5 cajas de chocolate' },
    { label: 'Sin cantidad específica', msg: 'Recomendame algo para reponer paletas' },
    { label: 'Ambiguo (pregunta esperada)', msg: 'Quiero algo nuevo' },
  ];

  for (const c of cases) {
    console.log(`\n▶ ${c.label}: "${c.msg}"`);
    const t0 = Date.now();
    const res = await fetch(`${API_URL}/api/commercial/ai-order/suggest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message: c.msg, history: [] }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.error(`  ✗ HTTP ${res.status} (${ms}ms):`, await res.text());
      continue;
    }
    const body = await res.json();
    console.log(`  ✓ ${ms}ms`);
    console.log(`  assistant_message: ${(body.assistant_message || '').slice(0, 160)}${body.assistant_message?.length > 160 ? '…' : ''}`);
    console.log(`  suggestions: ${body.suggestions?.length || 0}`);
    if (body.suggestions?.length) {
      const heuristic = body.suggestions.every((s) => s.reason === 'Coincide con tu búsqueda');
      console.log(`  mode: ${heuristic ? '⚠ HEURÍSTICO (falta ANTHROPIC_API_KEY)' : '✓ Claude Haiku'}`);
      for (const s of body.suggestions.slice(0, 3)) {
        console.log(`    • ${s.qty}× [${s.brand_name || '—'}] ${s.product_name} @ $${s.unit_price}`);
        if (s.reason) console.log(`        reason: ${s.reason}`);
      }
    }
  }

  // Multi-turn test
  console.log('\n▶ Multi-turn (history)');
  const turn1 = await fetch(`${API_URL}/api/commercial/ai-order/suggest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: 'Quiero chocolates', history: [] }),
  }).then((r) => r.json());
  console.log(`  Turn 1: ${turn1.suggestions?.length || 0} sugerencias`);

  const turn2 = await fetch(`${API_URL}/api/commercial/ai-order/suggest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      message: 'Cambiá las cantidades a 3 unidades cada uno',
      history: [
        { role: 'user', content: 'Quiero chocolates' },
        { role: 'assistant', content: turn1.assistant_message || '' },
      ],
    }),
  }).then((r) => r.json());
  console.log(`  Turn 2: ${turn2.suggestions?.length || 0} sugerencias`);
  if (turn2.suggestions?.length) {
    console.log(`  Sample qty: ${turn2.suggestions[0]?.qty} (esperado: 3 si Claude entendió)`);
  }

  console.log('\n✓ Smoke completo.');
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
