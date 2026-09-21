/**
 * `[E.12.0]` — **Cotizaciones de mayoreo: lo que el esquema tiene que impedir.**
 *
 * Una cotización es una oferta de precio con vigencia que todavía NO es venta. Lo fácil es
 * comprobar que se puede insertar una fila. Lo que se comprueba acá son las **seis maneras de
 * mentir** que los candados tienen que bloquear, cada una rompiéndola a propósito —un gate sin
 * prueba negativa es una intención, no un gate:
 *
 *  1. **Cotizar al aire.** Sin cliente registrado y sin siquiera un nombre de contacto, la
 *     cotización no le sirve a nadie y no se puede reclamar después.
 *  2. **Prometer para ayer.** Una vigencia que termina antes de empezar.
 *  3. **Colgar un pedido de una cotización que el cliente no aceptó.** El `order_id` es el
 *     linaje al dinero: si aparece sobre una rechazada, alguien convirtió por la puerta de atrás.
 *  4. **Dibujar un cero donde no hubo precio.** Un renglón sin precio vale NULL, no $0 (ADR-056).
 *     El único cero legítimo es el del REGALO, y tiene que declararse como tal.
 *  5. **Poner precio a algo que no es nuestro.** Un renglón que no casó con el catálogo informa
 *     demanda; no cobra.
 *  6. **Decir que las condiciones vienen de Kepler sin decir de qué sucursal.** Medido: el padrón
 *     `kepler_ods.kdud` es POR SUCURSAL y el mismo cliente tiene distinto límite de crédito en
 *     204 de 1,574 casos. Un descuento sin sucursal no es auditable.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-quotes.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ✅' : '  ❌'} ${m}`);
  if (!c) fail++;
};

// Corto a propósito: `quotes.code` es varchar(30) y un sufijo largo hace que el INSERT falle
// por LONGITUD antes de llegar al CHECK que se quiere probar — el test saldría "rojo" (o peor,
// verde si sólo afirmara "falló") por el motivo equivocado. Por eso cada aserción negativa
// compara contra el NOMBRE del constraint, no contra "hubo error".
const SUFIJO = String(Date.now()).slice(-8);

/** Intenta insertar; devuelve el nombre del constraint que lo frenó, o null si pasó. */
async function intentar(tabla, fila) {
  try {
    await knex(tabla).insert(fila);
    return null;
  } catch (e) {
    return e.constraint || e.message;
  }
}

(async () => {
  console.log('\n=== [E.12.0] commercial.quotes — cimiento del submódulo ===\n');

  // ── Contexto mínimo real: un almacén, un usuario y (opcional) un cliente del tenant ──────
  const wh = await knex('commercial.warehouses').where({ tenant_id: T }).first('id');
  const user = await knex('identity.users').where({ tenant_id: T }).first('id');
  if (!wh || !user) {
    console.error('NO MEDIDO: el tenant no tiene almacén o usuario con qué probar.');
    process.exit(1);
  }
  const cust = await knex('commercial.customers').where({ tenant_id: T }).first('id');

  const base = {
    tenant_id: T,
    user_id: user.id,
    warehouse_id: wh.id,
    valid_until: knex.raw("CURRENT_DATE + 15"),
  };

  let quoteId = null;
  try {
    // ── BLOQUE 1: la cotización nace y se identifica ───────────────────────────────────────
    console.log('BLOQUE 1 — la cotización existe y se puede identificar');

    const [q] = await knex('commercial.quotes')
      .insert({ ...base, code: `COT-${SUFIJO}`, contact_name: 'PROSPECTO DE PRUEBA' })
      .returning(['id', 'status', 'terms_source']);
    quoteId = q.id;
    ok(!!quoteId, 'se crea con contacto suelto (sin cliente registrado todavía)');
    ok(q.status === 'draft', `nace en borrador (status=${q.status})`);
    ok(
      q.terms_source === 'unknown',
      `las condiciones nacen DECLARADAS como desconocidas, no como cero (terms_source=${q.terms_source})`,
    );

    const c1 = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}-A`,
    });
    ok(
      c1 === 'commercial_quotes_has_recipient',
      `(1) sin cliente NI contacto: rechazada [${c1}]`,
    );

    // ── BLOQUE 2: la vigencia ──────────────────────────────────────────────────────────────
    console.log('\nBLOQUE 2 — la vigencia no puede terminar antes de empezar');
    const c2 = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}-P`,
      contact_name: 'X',
      valid_until: knex.raw('CURRENT_DATE - 1'),
    });
    ok(
      c2 === 'commercial_quotes_valid_until_after_date',
      `(2) vigencia vencida al nacer: rechazada [${c2}]`,
    );

    // ── BLOQUE 3: el linaje al dinero ──────────────────────────────────────────────────────
    console.log('\nBLOQUE 3 — el pedido sólo cuelga de una cotización aceptada');
    const anyOrder = await knex('commercial.orders').where({ tenant_id: T }).first('id');
    if (!anyOrder) {
      console.log('  ⚠️  NO MEDIDO: el tenant no tiene ningún pedido con qué probar el linaje.');
    } else {
      const c3 = await intentar('commercial.quotes', {
        ...base,
        code: `COT-${SUFIJO}-T`,
        contact_name: 'X',
        status: 'rejected',
        order_id: anyOrder.id,
      });
      ok(
        c3 === 'commercial_quotes_order_only_when_accepted',
        `(3) pedido colgado de una cotización RECHAZADA: rechazada [${c3}]`,
      );
      // Y el camino feliz sí pasa: el candado no es un "no" a todo.
      const c3b = await intentar('commercial.quotes', {
        ...base,
        code: `COT-${SUFIJO}-OK`,
        contact_name: 'X',
        status: 'accepted',
        order_id: anyOrder.id,
      });
      ok(c3b === null, 'el mismo pedido sobre una ACEPTADA sí pasa (el candado discrimina)');
    }

    // ── BLOQUE 4: el cero ──────────────────────────────────────────────────────────────────
    console.log('\nBLOQUE 4 — el cero sólo es precio cuando es regalo');
    const prod = await knex('catalog.products').where({ tenant_id: T }).first('id');
    if (!prod) {
      console.log('  ⚠️  NO MEDIDO: el tenant no tiene productos con qué probar los renglones.');
    } else {
      const lineBase = { tenant_id: T, quote_id: quoteId, product_id: prod.id, quantity: 10 };

      const c4 = await intentar('commercial.quote_lines', {
        ...lineBase,
        line_number: 90,
        unit_price: 0,
        price_source: 'list',
      });
      ok(
        c4 === 'commercial_quote_lines_zero_price_only_free_goods',
        `(4) precio $0 declarado como precio de lista: rechazado [${c4}]`,
      );

      const c4b = await intentar('commercial.quote_lines', {
        ...lineBase,
        line_number: 91,
        unit_price: 0,
        price_source: 'free_goods',
        parent_line_number: 1,
      });
      ok(c4b === null, 'el MISMO $0 declarado como regalo sí pasa (es el cero real de Kepler)');

      const c4c = await intentar('commercial.quote_lines', {
        ...lineBase,
        line_number: 92,
        unit_price: null,
        price_source: 'unknown',
      });
      ok(c4c === null, 'sin precio se guarda NULL con motivo, no $0');

      // Un regalo cuelga de quien lo ganó; un renglón normal no cuelga de nadie.
      const c4d = await intentar('commercial.quote_lines', {
        ...lineBase,
        line_number: 93,
        unit_price: 12.5,
        price_source: 'list',
        parent_line_number: 1,
      });
      ok(
        c4d === 'commercial_quote_lines_parent_only_free_goods',
        `renglón normal colgado de un padre: rechazado [${c4d}]`,
      );

      // ── BLOQUE 5: el renglón que no casó con el catálogo ─────────────────────────────────
      console.log('\nBLOQUE 5 — lo que el cliente pidió y no tenemos: informa, no cobra');
      const c5 = await intentar('commercial.quote_lines', {
        tenant_id: T,
        quote_id: quoteId,
        line_number: 94,
        product_id: null,
        requested_text: 'GOMITAS DE MANGO MARCA X',
        quantity: 5,
        unit_price: 33.0,
        price_source: 'manual',
      });
      ok(
        c5 === 'commercial_quote_lines_unmatched_has_no_price',
        `(5) precio sobre un renglón sin producto del catálogo: rechazado [${c5}]`,
      );

      const c5b = await intentar('commercial.quote_lines', {
        tenant_id: T,
        quote_id: quoteId,
        line_number: 95,
        product_id: null,
        requested_text: 'GOMITAS DE MANGO MARCA X',
        quantity: 5,
        availability: 'not_carried',
      });
      ok(c5b === null, 'el mismo renglón SIN precio sí se guarda: es demanda que estamos perdiendo');

      const c5c = await intentar('commercial.quote_lines', {
        tenant_id: T,
        quote_id: quoteId,
        line_number: 96,
        product_id: null,
        requested_text: '   ',
        quantity: 1,
      });
      ok(
        c5c === 'commercial_quote_lines_identified',
        `un renglón sin producto Y sin texto no es un renglón: rechazado [${c5c}]`,
      );
    }

    // ── BLOQUE 6: las condiciones dicen de dónde salieron ──────────────────────────────────
    console.log('\nBLOQUE 6 — condiciones de Kepler sin sucursal no son auditables');
    const c6 = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}-S`,
      contact_name: 'X',
      terms_source: 'kepler_kdud',
      terms_discount_pct: 3,
      source_branch: null,
    });
    ok(
      c6 === 'commercial_quotes_kepler_terms_need_branch',
      `(6) descuento "de Kepler" sin decir de qué sucursal: rechazado [${c6}]`,
    );

    const c6b = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}-C`,
      contact_name: 'X',
      terms_source: 'kepler_kdud',
      terms_discount_pct: 3,
      terms_credit_limit: 60000,
      terms_payment_days: 15,
      source_branch: '01',
    });
    ok(c6b === null, 'con la sucursal declarada sí pasa');

    const c6c = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}-G`,
      contact_name: 'X',
      origin: 'whatsapp',
    });
    ok(c6c === 'commercial_quotes_origin_valid', `origen inventado: rechazado [${c6c}]`);

    // ── BLOQUE 7: el folio no se repite ────────────────────────────────────────────────────
    console.log('\nBLOQUE 7 — el folio es único por tenant');
    const c7 = await intentar('commercial.quotes', {
      ...base,
      code: `COT-${SUFIJO}`,
      contact_name: 'X',
    });
    ok(
      c7 === 'commercial_quotes_tenant_code_unique',
      `folio repetido: rechazado [${c7}]`,
    );

    // ── BLOQUE 8: RLS forzado y grants ─────────────────────────────────────────────────────
    console.log('\nBLOQUE 8 — aislamiento por tenant declarado en la tabla');
    const rls = await knex.raw(`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'commercial'
        AND c.relname IN ('quotes','quote_lines','quote_sequences')
      ORDER BY 1
    `);
    ok(rls.rows.length === 3, `las 3 tablas existen (${rls.rows.length}/3)`);
    ok(
      rls.rows.every((r) => r.rls && r.forced),
      'las 3 tienen RLS habilitado Y forzado (FORCE: ni el dueño la evade)',
    );
    const grants = await knex.raw(`
      SELECT table_name, count(*)::int n
      FROM information_schema.role_table_grants
      WHERE grantee = 'app_runtime' AND table_schema = 'commercial' AND table_name LIKE 'quote%'
      GROUP BY 1
    `);
    ok(
      grants.rows.length === 3 && grants.rows.every((r) => r.n >= 4),
      'app_runtime tiene SELECT/INSERT/UPDATE/DELETE en las 3',
    );
  } finally {
    // Limpieza: sólo lo que este smoke creó.
    await knex('commercial.quote_lines').where({ tenant_id: T, quote_id: quoteId }).del();
    await knex('commercial.quotes').where({ tenant_id: T }).andWhere('code', 'like', `COT-${SUFIJO}%`).del();
    await knex.destroy();
  }

  console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} FALLAS`}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
