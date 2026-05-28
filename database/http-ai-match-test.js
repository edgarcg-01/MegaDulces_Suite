/* eslint-disable no-console */
/**
 * HTTP smoke test — Fase K.1 (AI product match).
 *
 * Pre-requisitos:
 *   - API en http://localhost:3334
 *   - DB Docker pgvector-md con backfill de embeddings hecho (1278/1278)
 *   - .env con VOYAGE_API_KEY y ANTHROPIC_API_KEY válidas
 *
 * Probamos:
 *   1. Login legacy con `superoot/superoot` (role superadmin).
 *   2. POST /api/ai/products/match-ai con 4 listas distintas:
 *      a) Lista con SKUs reales del catálogo (esperamos autoConfirm en 1+).
 *      b) Texto con typos / abreviaciones.
 *      c) Texto vacío → 400.
 *      d) Rate limit: 11+ requests seguidas dispara 429 en la última.
 *   3. Validar shape: items[*].suggested, alternatives, score 0..1, autoConfirm bool.
 */
const BASE = 'http://localhost:3334/api';

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
}

let pass = 0;
let fail = 0;
function check(name, cond, det) {
  if (cond) {
    console.log(`  OK  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`);
    fail++;
  }
}

(async () => {
  console.log('── 0. Login legacy ──');
  const login = await req('POST', '/auth/login', null, {
    username: 'superoot',
    password: 'superoot',
  });
  const token = login.body?.access_token || login.body?.token;
  check('login OK (status 200/201)', login.status === 200 || login.status === 201);
  check('login devuelve access_token', !!token, `body=${JSON.stringify(login.body).slice(0, 200)}`);
  if (!token) {
    console.log('\n— Abort: sin token, no se puede continuar —');
    process.exit(1);
  }

  console.log('\n── 1. Match con productos reales del catálogo ──');
  const m1 = await req('POST', '/ai/products/match-ai', token, {
    rawText: 'mazapan rosa, pulparindo 20pz, paleta payaso',
  });
  check('status 200', m1.status === 200, `status=${m1.status} body=${JSON.stringify(m1.body).slice(0, 300)}`);
  check('items es array', Array.isArray(m1.body?.items));
  check('items.length >= 3', (m1.body?.items?.length || 0) >= 3, `got=${m1.body?.items?.length}`);
  check('meta presente', !!m1.body?.meta);
  check('meta.items_count = items.length', m1.body?.meta?.items_count === m1.body?.items?.length);
  check('meta.elapsed_ms numérico', typeof m1.body?.meta?.elapsed_ms === 'number');
  if (m1.body?.items) {
    for (const [i, it] of m1.body.items.entries()) {
      const sug = it.suggested;
      console.log(
        `    [${i}] raw="${it.raw}" → ${sug ? sug.brand_name + ' — ' + sug.product_name : '(no match)'} ` +
          `score=${sug?.score} autoConfirm=${sug?.autoConfirm}`,
      );
      check(`item ${i} tiene raw + normalized strings`, typeof it.raw === 'string' && typeof it.normalized === 'string');
      check(`item ${i} alternatives es array`, Array.isArray(it.alternatives));
      if (sug) {
        check(`item ${i} suggested.score en [0,1]`, sug.score >= 0 && sug.score <= 1);
        check(`item ${i} suggested.autoConfirm boolean`, typeof sug.autoConfirm === 'boolean');
        check(`item ${i} suggested.product_id string`, typeof sug.product_id === 'string');
      }
    }
    const anyAuto = m1.body.items.some((it) => it.suggested?.autoConfirm === true);
    check('al menos 1 autoConfirm=true en lista real', anyAuto);
  }

  console.log('\n── 2. Match con typos + abreviaciones ──');
  const m2 = await req('POST', '/ai/products/match-ai', token, {
    rawText: 'carlota fresita, dulce de tamarindo (pulparindo) y un mazapan',
  });
  check('status 200', m2.status === 200);
  check('items >= 1', (m2.body?.items?.length || 0) >= 1);

  console.log('\n── 3. Empty rawText → 400 ──');
  const m3 = await req('POST', '/ai/products/match-ai', token, { rawText: '   ' });
  check('status 400', m3.status === 400, `status=${m3.status}`);

  console.log('\n── 4. Sin token → 401 ──');
  const m4 = await req('POST', '/ai/products/match-ai', null, {
    rawText: 'hello',
  });
  check('status 401', m4.status === 401, `status=${m4.status}`);

  console.log('\n── 5. Rate limit: 12 requests rápidos ──');
  // El throttle del endpoint es 10/min. La request 11+ debería ser 429.
  let limited = false;
  for (let i = 1; i <= 12; i++) {
    const r = await req('POST', '/ai/products/match-ai', token, {
      rawText: `test ${i}`,
    });
    if (r.status === 429) {
      limited = true;
      console.log(`    request #${i} → 429 (throttled) ✓`);
      break;
    }
  }
  check('throttle 429 disparado dentro de 12 requests', limited);

  console.log(`\n── ${pass} OK · ${fail} FAIL ──`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
