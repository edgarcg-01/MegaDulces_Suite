/* eslint-disable no-console */
/**
 * `[COT.1]` — **El motor de precio, por HTTP y con rol mínimo.**
 *
 * Qué prueba que ningún otro test cubre:
 *
 *   1. Que el precio sale de la fuente del ERP y no de una constante — cada aserción compara
 *      contra lo que `analytics.v_label_prices` dice EN ESE MOMENTO, no contra un número
 *      quemado acá. Si mañana cambia el precio, el test sigue siendo cierto.
 *   2. ⭐ **Que el descuento del CLIENTE no toca el precio unitario.** Son dos capas distintas
 *      (`ERP_KEPLER.md` §3.1: de 609 facturas sólo 172 cuadran entre una y otra). El renglón
 *      lleva la capa de precio; el 3% de C1086 tiene que aparecer en el TOTAL y **no** en el
 *      `unit_price`. Si algún día alguien "simplifica" componiéndolos, esto se pone rojo.
 *   3. ⭐ **Que un SKU sin precio devuelve NULL y no 0** (ADR-056). Un cero ahí se lee como "no
 *      cuesta nada" y se cotizaría regalado.
 *   4. ⭐ **Que el request NO puede imponer un precio.** Se manda `unit_price` y `discount_pct`
 *      en el body a propósito: el precio devuelto tiene que ser exactamente el mismo que sin
 *      ellos. Es el candado de la decisión de Dirección — el vendedor no inventa descuentos.
 *   5. Que el gate es de verdad: un rol sin `COMMERCIAL_QUOTES_*` recibe 403 en los tres
 *      endpoints nuevos. ⚠️ **No se prueba con admin**: pasaría por god-mode y saldría verde
 *      aunque el gate estuviera abierto (la forma de `[LC.6.2]`).
 *
 * Pre-requisitos: API levantada (por defecto :3334; `API_BASE` lo cambia) y la migración
 * `20260923140000_v_erp_discount_rules.js` aplicada.
 * Uso: node database/tests/http-quote-pricing-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');

const BASE = process.env.API_BASE_PRICING || 'http://localhost:3334/api';
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUF = String(Date.now()).slice(-8);
const PASS_PLANO = `Smoke!${SUF}`;
const BRANCH = '01';

let pass = 0;
let fail = 0;
let nomedido = 0;
const check = (name, cond, det) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${det ? ' — ' + det : ''}`); fail++; }
};
/** Tercer estado: lo que no se pudo medir se declara, no se pinta verde (ADR-056). */
const declarar = (name, motivo) => { console.log(`  ⚠️  NO MEDIDO: ${name} — ${motivo}`); nomedido++; };

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, body: json };
}

async function crearUsuario(rol) {
  const username = `cot_${rol}_${SUF}`.slice(0, 40);
  await knex('identity.users').insert({
    tenant_id: T,
    username,
    nombre: `SMOKE COT ${rol}`,
    password_hash: await bcrypt.hash(PASS_PLANO, 10),
    role_name: rol,
  });
  return username;
}

async function login(username) {
  const r = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'mega_dulces', username, password: PASS_PLANO,
  });
  return { token: r.body?.access_token ?? null, status: r.status };
}

(async () => {
  console.log('\n=== [COT.1] El motor de precio de cotizaciones — HTTP, rol mínimo ===\n');
  let uOperador = null, uSinLlave = null;
  const cotizaciones = [];

  try {
    // ── 0. Andamiaje ───────────────────────────────────────────────────────────────────────
    console.log('0 — usuarios efímeros y fuente de verdad');
    uOperador = await crearUsuario('telemarketing');
    uSinLlave = await crearUsuario('almacenista');
    const op = await login(uOperador);
    const sin = await login(uSinLlave);
    check('login del operador', !!op.token, `status ${op.status}`);
    check('login del rol sin llave', !!sin.token, `status ${sin.status}`);
    if (!op.token || !sin.token) { declarar('todo el resto', 'sin token no se prueba ningún gate'); return; }
    const payload = JSON.parse(Buffer.from(op.token.split('.')[1], 'base64').toString());
    check(`el token es rol telemarketing, no admin (role=${payload.role_name})`, payload.role_name === 'telemarketing');

    // El SKU de prueba sale de la MISMA fuente que el motor: si no hay dato, se declara.
    const fuente = await knex.raw(
      `SELECT sku, name, piece_price, wholesale_pack_price, wholesale_pack_min_qty, box_price, box_size, unit_base
         FROM analytics.v_label_prices
        WHERE sucursal = ? AND piece_price > 0
          AND wholesale_pack_price IS NOT NULL AND wholesale_pack_min_qty IS NOT NULL
        ORDER BY sku LIMIT 1`, [BRANCH],
    );
    if (!fuente.rows.length) {
      declarar('el motor completo', `no hay ningún SKU con escalera de volumen en la sucursal ${BRANCH}`);
      return;
    }
    const F = fuente.rows[0];
    console.log(`     SKU de prueba: ${F.sku} (${F.name}) · base ${F.unit_base} $${F.piece_price} · volumen ≥${F.wholesale_pack_min_qty} $${F.wholesale_pack_price}`);

    // ── 1. El precio sale del ERP ──────────────────────────────────────────────────────────
    console.log('\n1 — precio de lista, derivado de v_label_prices');
    const uno = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: F.sku, quantity: 1 });
    check('POST /price-preview → 2xx (Nest responde 201 en POST)', uno.status === 200 || uno.status === 201, `status ${uno.status} ${JSON.stringify(uno.body).slice(0, 120)}`);
    check('list_price == el precio del ERP', Number(uno.body?.list_price) === Number(F.piece_price), `api=${uno.body?.list_price} erp=${F.piece_price}`);
    check('unit_price == list_price cuando no hay ningún descuento aplicable', Number(uno.body?.unit_price) === Number(F.piece_price), `unit=${uno.body?.unit_price}`);
    check('declara la unidad del peldaño', uno.body?.unit_label === F.unit_base, `unit_label=${uno.body?.unit_label}`);
    check('el desglose trae el paso "lista" con su fuente', uno.body?.applied?.some((s) => s.step === 'lista' && /v_label_prices/.test(s.source)));
    check('line_total = precio × cantidad', Number(uno.body?.line_total) === Number(F.piece_price), `line_total=${uno.body?.line_total}`);

    // ── 2. El volumen del propio ERP ───────────────────────────────────────────────────────
    console.log('\n2 — descuento por volumen (kdpv_prod_util)');
    const qty = Number(F.wholesale_pack_min_qty);
    const vol = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: F.sku, quantity: qty });
    const esperadoVol = Number(F.wholesale_pack_price) < Number(F.piece_price) ? Number(F.wholesale_pack_price) : Number(F.piece_price);
    check(`con ${qty} unidades baja al precio por volumen`, Number(vol.body?.unit_price) === esperadoVol, `unit=${vol.body?.unit_price} esperado=${esperadoVol}`);
    if (Number(F.wholesale_pack_price) < Number(F.piece_price)) {
      check('el desglose declara el paso "volumen" con su antes y después',
        vol.body?.applied?.some((s) => s.step === 'volumen' && Number(s.before) === Number(F.piece_price) && Number(s.after) === Number(F.wholesale_pack_price)));
    } else {
      check('el "mayoreo" más caro que la lista NO se aplica, y se avisa',
        vol.body?.warnings?.some((w) => /MAYOR que el de lista/.test(w)));
    }

    // ── 3. ⭐ El request NO puede imponer precio ────────────────────────────────────────────
    console.log('\n3 — ⭐ prueba negativa: el body intenta poner su propio precio');
    const intruso = await req('POST', '/commercial/quotes/price-preview', op.token, {
      branch: BRANCH, sku: F.sku, quantity: 1,
      unit_price: 1, list_price: 1, discount_pct: 99, price: 1,
    });
    // ⚠️ La primera versión de esta aserción comparaba los dos precios a secas — y con el 500 de
    // fondo salió VERDE comparando undefined contra undefined. Un test que se pone verde cuando
    // no midió nada es peor que no tenerlo: ahora exige además que el precio EXISTA.
    check('el precio devuelto IGNORA lo que mandó el cliente',
      typeof intruso.body?.unit_price === 'number' && Number(intruso.body.unit_price) === Number(uno.body?.unit_price),
      `con intruso=${intruso.body?.unit_price} sin=${uno.body?.unit_price}`);
    check('y sigue declarando su fuente', intruso.body?.price_source === uno.body?.price_source);

    // ── 4. ⭐ Sin precio = NULL, nunca 0 ────────────────────────────────────────────────────
    console.log('\n4 — ⭐ prueba negativa: SKU que el ERP no cotiza');
    const fantasma = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: `NOEXISTE${SUF}`, quantity: 5 });
    check('responde 2xx (no es un error: es información)', fantasma.status === 200 || fantasma.status === 201, `status ${fantasma.status}`);
    check('unit_price es NULL, NO 0', fantasma.body?.unit_price === null, `unit_price=${JSON.stringify(fantasma.body?.unit_price)}`);
    check('y dice por qué', typeof fantasma.body?.unpriced_reason === 'string' && fantasma.body.unpriced_reason.length > 10, fantasma.body?.unpriced_reason);
    check('lo marca como no manejado', ['not_carried', 'unavailable'].includes(fantasma.body?.availability), `availability=${fantasma.body?.availability}`);

    // ── 5. Peldaño inexistente ─────────────────────────────────────────────────────────────
    console.log('\n5 — el peldaño que el producto no tiene');
    // Sin CJA **y** sin BTO/CUB: un producto a granel sin caja SÍ tiene unidad mayor (el bulto),
    // así que ya no sirve de ejemplo de "peldaño ausente" (ver 5b). El fixture se elige con la
    // MISMA fuente que usa el motor (`v_label_presentations`); lo que no puede salir de ahí es
    // la afirmación, que se arbitra aparte.
    const sinCaja = await knex.raw(
      `SELECT v.sku FROM analytics.v_label_prices v
        WHERE v.sucursal = ? AND v.piece_price > 0 AND v.box_price IS NULL AND v.box_size IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM analytics.v_label_presentations p
             WHERE p.sucursal = v.sucursal AND p.sku = v.sku
               AND ( (upper(btrim(p.unidad)) = 'CJA' AND (p.precio_lista IS NOT NULL OR p.factor IS NOT NULL))
                  OR (upper(btrim(p.unidad)) IN ('BTO','CUB') AND p.factor > 1 AND p.precio_lista IS NOT NULL) ))
        LIMIT 1`, [BRANCH],
    );
    if (!sinCaja.rows.length) {
      declarar('el peldaño ausente', 'todos los SKUs de la sucursal declaran unidad mayor');
    } else {
      const caja = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: sinCaja.rows[0].sku, quantity: 1, rung: 'box' });
      check('pedir una presentación que el ERP no declara → NULL con motivo', caja.body?.unit_price === null && /no tiene el peldaño/.test(caja.body?.unpriced_reason || ''), JSON.stringify(caja.body?.unpriced_reason));
    }

    // ── 5b. La unidad mayor que NO se llama CJA (bulto / cubeta) ──────────────────────────────
    // Bug 2026-09-30: 17083 (KG → BTO de 20 kg, $1,169.91) respondía "no tiene el peldaño box"
    // porque el motor sólo leía 'CJA'.
    // ⚠️ El árbitro NO es la ranura de `kdii`: eso es la misma expresión que corre en producción,
    // y una prueba que se arbitra contra sí misma se pone verde con la derivación equivocada. El
    // testigo independiente es el DINERO — `analytics.mv_kepler_unit_ladder`, que sale de lo que
    // Kepler facturó: para el 17083 da BTO, factor 20.0000, `ambiguo = false`, 223 renglones en
    // 8 sucursales, $410,403.40 (ADR-059: el dinero arbitra la cantidad).
    console.log('\n5b — la unidad mayor que no se llama CJA');
    const bto = await knex.raw(
      `SELECT p.sku, upper(btrim(p.unidad)) AS unidad, p.factor::int AS factor, p.precio_lista AS precio,
              l.factor::numeric AS factor_vendido, l.ambiguo, l.renglones, l.importe
         FROM analytics.v_label_presentations p
         JOIN analytics.v_label_prices v ON v.sucursal = p.sucursal AND v.sku = p.sku
         LEFT JOIN analytics.mv_kepler_unit_ladder l
                ON l.sku = p.sku AND upper(btrim(l.unidad_vendida)) = upper(btrim(p.unidad))
        WHERE p.sucursal = ? AND v.box_price IS NULL AND v.box_size IS NULL
          AND upper(btrim(p.unidad)) IN ('BTO','CUB') AND p.factor > 1 AND p.precio_lista IS NOT NULL
        ORDER BY (p.sku = '17083') DESC, (l.renglones IS NULL), l.renglones DESC NULLS LAST, p.sku
        LIMIT 1`, [BRANCH],
    );
    if (!bto.rows.length) {
      declarar('la unidad mayor BTO/CUB', `ningún SKU de la sucursal ${BRANCH} tiene bulto o cubeta sin caja`);
    } else {
      const m = bto.rows[0];
      const r = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: m.sku, quantity: 1, rung: 'box' });
      check(`${m.sku} por ${m.unidad} tiene precio (no "sin peldaño")`, r.body?.list_price !== null && r.body?.list_price !== undefined, JSON.stringify(r.body?.unpriced_reason));
      check(`el precio de lista es el de la presentación del ERP ($${m.precio})`, Math.abs(Number(r.body?.list_price) - Number(m.precio)) < 0.005, `list_price=${r.body?.list_price}`);
      check(`el rótulo dice ${m.unidad}, no CJA`, r.body?.unit_label === m.unidad, `unit_label=${r.body?.unit_label}`);
      check(`el factor es ${m.factor} unidades base`, Number(r.body?.unit_factor) === m.factor, `unit_factor=${r.body?.unit_factor}`);
      // El árbitro independiente: lo que Kepler COBRÓ con esa unidad.
      if (m.factor_vendido === null || m.factor_vendido === undefined) {
        declarar('el factor contra el dinero', `${m.sku} no tiene ventas por ${m.unidad} en mv_kepler_unit_ladder`);
      } else if (m.ambiguo) {
        declarar('el factor contra el dinero', `${m.sku} tiene factor ambiguo en las ventas por ${m.unidad}`);
      } else {
        check(
          `el factor coincide con lo que Kepler facturó (${m.renglones} renglones, $${m.importe})`,
          Math.abs(Number(m.factor_vendido) - Number(m.factor)) < 0.0005,
          `vendido=${m.factor_vendido} ficha=${m.factor}`,
        );
      }
    }

    // ── 5c. El botón y la escalera no pueden decir cosas distintas ─────────────────────────────
    // El buscador del catálogo rotula el botón con una lectura RÁPIDA de `kdii`; el precio sale de
    // `v_label_presentations`, que es 70× más lenta y no se puede usar en el buscador. Son dos
    // caminos: hay que medir que no se separen. La dirección que importa es "botón sin peldaño"
    // (ofrecer algo que después no tiene precio); la inversa —botón mudo donde sí hay peldaño— se
    // DECLARA, hoy 182 filas, y son las que `v_label_prices` no trae y la vista sí rellena.
    console.log('\n5c — el botón del buscador vs la escalera del precio');
    const acuerdo = await knex.raw(
      `WITH lp AS (SELECT sucursal, sku, box_size, box_price FROM analytics.v_label_prices),
       kd AS (
         SELECT btrim(k.sucursal) sucursal, btrim(k.c1) sku,
                (array_agg(s.unidad ORDER BY s.prioridad))[1] unidad
           FROM kepler_ods.kdii k
           CROSS JOIN LATERAL (VALUES
             (upper(btrim(k.c83)), floor(k.c84)::int, NULLIF(k.c92,0), 1),
             (upper(btrim(k.c80)), floor(k.c81)::int, NULLIF(k.c91,0), 2)
           ) AS s(unidad, factor, price, prioridad)
          WHERE s.unidad IN ('BTO','CUB') AND s.factor > 1 AND s.price IS NOT NULL
          GROUP BY 1,2),
       vista AS (
         SELECT sucursal, sku,
                (array_agg(upper(btrim(unidad)) ORDER BY CASE WHEN upper(btrim(unidad))='CJA' THEN 0 ELSE 1 END, factor DESC NULLS LAST))[1] unidad
           FROM analytics.v_label_presentations
          WHERE ( (upper(btrim(unidad))='CJA' AND (precio_lista IS NOT NULL OR factor IS NOT NULL))
               OR (upper(btrim(unidad)) IN ('BTO','CUB') AND factor > 1 AND precio_lista IS NOT NULL) )
          GROUP BY 1,2)
       SELECT count(*)::int filas,
              count(*) FILTER (WHERE boton IS NOT NULL AND escalera IS NULL)::int boton_sin_peldano,
              count(*) FILTER (WHERE boton IS NULL AND escalera IS NOT NULL)::int boton_mudo
         FROM (
           SELECT CASE WHEN lp.box_size IS NOT NULL OR lp.box_price IS NOT NULL THEN 'CJA' ELSE kd.unidad END AS boton,
                  COALESCE(vista.unidad, CASE WHEN lp.box_size IS NOT NULL OR lp.box_price IS NOT NULL THEN 'CJA' END) AS escalera
             FROM lp LEFT JOIN kd USING (sucursal, sku) LEFT JOIN vista USING (sucursal, sku)) x`,
    );
    const ac = acuerdo.rows[0];
    check(
      `ningún botón ofrece una unidad que la escalera no sabe cotizar (sobre ${ac.filas} filas)`,
      Number(ac.boton_sin_peldano) === 0,
      `boton_sin_peldano=${ac.boton_sin_peldano}`,
    );
    declarar('botón mudo con peldaño', `${ac.boton_mudo} filas — el buscador no ofrece la unidad mayor aunque el precio existe`);

    // ── 6. ⭐ Las dos capas: el descuento del cliente NO toca el renglón ────────────────────
    console.log('\n6 — ⭐ el descuento del cliente es capa DOCUMENTO, no capa precio');
    const cli = await knex.raw(
      `SELECT customer_code, discount_1_pct FROM analytics.v_erp_wholesale_customers
        WHERE sucursal = ? AND discount_1_pct > 0 ORDER BY customer_code LIMIT 1`, [BRANCH],
    );
    if (!cli.rows.length) {
      declarar('la capa documento', `ningún cliente de la sucursal ${BRANCH} tiene descuento configurado`);
    } else {
      const C = cli.rows[0];
      const pct = Number(C.discount_1_pct);
      const creada = await req('POST', '/commercial/quotes', op.token, {
        erp_customer_code: C.customer_code, source_branch: BRANCH, origin: 'telemarketing',
        notes: `SMOKE COT.1 ${SUF}`,
      });
      check(`crea la cotización para ${C.customer_code} (${pct}%)`, creada.status === 201 || creada.status === 200, `status ${creada.status} ${JSON.stringify(creada.body).slice(0, 140)}`);
      const qid = creada.body?.id;
      if (qid) cotizaciones.push(qid);

      if (!qid) {
        declarar('el renglón y los totales', 'la cotización no se creó');
      } else {
        const add = await req('POST', `/commercial/quotes/${qid}/lines`, op.token, { sku: F.sku, quantity: 1 });
        check('agrega el renglón → 200/201', add.status === 200 || add.status === 201, `status ${add.status} ${JSON.stringify(add.body).slice(0, 140)}`);

        const det = await req('GET', `/commercial/quotes/${qid}`, op.token);
        const linea = det.body?.lines?.[0];
        const bruto = Number(F.piece_price);
        check('⭐ el unit_price del renglón NO trae el descuento del cliente', Number(linea?.unit_price) === bruto, `unit=${linea?.unit_price} lista=${bruto}`);
        const esperadoTotal = Math.round(bruto * (1 - pct / 100) * 100) / 100;
        check(`⭐ el TOTAL sí lo trae (${pct}% sobre ${bruto} = ${esperadoTotal})`, Math.abs(Number(det.body?.total) - esperadoTotal) < 0.02, `total=${det.body?.total} esperado=${esperadoTotal}`);
        check('el renglón declara de dónde salió su precio', typeof linea?.price_source === 'string' && linea.price_source.length > 0, `price_source=${linea?.price_source}`);

        // Renglón sin SKU: lo que el cliente pidió y no casó.
        const crudo = await req('POST', `/commercial/quotes/${qid}/lines`, op.token, { requested_text: 'DULCE QUE NO MANEJAMOS 20PZ', quantity: 4 });
        check('acepta un renglón sin SKU (demanda que rechazamos)', crudo.status === 200 || crudo.status === 201, `status ${crudo.status}`);
        const det2 = await req('GET', `/commercial/quotes/${qid}`, op.token);
        const sinCasar = det2.body?.lines?.find((l) => !l.product_id);
        check('guarda lo que el cliente escribió, tal cual', sinCasar?.requested_text === 'DULCE QUE NO MANEJAMOS 20PZ', JSON.stringify(sinCasar?.requested_text));
        check('y lo declara sin casar, sin precio', sinCasar?.availability === 'unmatched' && sinCasar?.unit_price === null, `av=${sinCasar?.availability} price=${sinCasar?.unit_price}`);
        check('el renglón sin precio NO mueve el total', Math.abs(Number(det2.body?.total) - esperadoTotal) < 0.02, `total=${det2.body?.total}`);

        // Quitar el renglón
        const quitar = await req('DELETE', `/commercial/quotes/${qid}/lines/${linea.id}`, op.token);
        check('DELETE del renglón → 200', quitar.status === 200, `status ${quitar.status}`);
        const det3 = await req('GET', `/commercial/quotes/${qid}`, op.token);
        check('el total se recalcula al quitarlo', Number(det3.body?.total) === 0, `total=${det3.body?.total}`);
      }
    }

    // ── 7. Validaciones ────────────────────────────────────────────────────────────────────
    console.log('\n7 — lo que el motor rechaza');
    const sinBranch = await req('POST', '/commercial/quotes/price-preview', op.token, { sku: F.sku, quantity: 1 });
    check('sin sucursal → 400 (el precio no es el mismo en todas)', sinBranch.status === 400, `status ${sinBranch.status}`);
    const qtyCero = await req('POST', '/commercial/quotes/price-preview', op.token, { branch: BRANCH, sku: F.sku, quantity: 0 });
    check('cantidad 0 → 400', qtyCero.status === 400, `status ${qtyCero.status}`);
    if (cotizaciones.length) {
      const vacio = await req('POST', `/commercial/quotes/${cotizaciones[0]}/lines`, op.token, { quantity: 3 });
      check('renglón sin SKU ni texto → 400', vacio.status === 400, `status ${vacio.status}`);
    }

    // ── 8. El gate ─────────────────────────────────────────────────────────────────────────
    console.log('\n8 — el rol SIN la llave (prueba negativa del gate)');
    const p1 = await req('POST', '/commercial/quotes/price-preview', sin.token, { branch: BRANCH, sku: F.sku, quantity: 1 });
    check('price-preview con rol sin llave → 403', p1.status === 403, `status ${p1.status}`);
    if (cotizaciones.length) {
      const p2 = await req('POST', `/commercial/quotes/${cotizaciones[0]}/lines`, sin.token, { sku: F.sku, quantity: 1 });
      check('agregar renglón con rol sin llave → 403', p2.status === 403, `status ${p2.status}`);
      const p3 = await req('DELETE', `/commercial/quotes/${cotizaciones[0]}/lines/00000000-0000-0000-0000-000000000000`, sin.token);
      check('borrar renglón con rol sin llave → 403', p3.status === 403, `status ${p3.status}`);
    }

    // ── 9. La vista que alimenta el motor ──────────────────────────────────────────────────
    console.log('\n9 — analytics.v_erp_discount_rules');
    const reglas = await knex.raw(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE aplica_a IS NULL)::int sin_unidad,
              count(*) FILTER (WHERE NOT umbral_verificado)::int sin_verificar,
              count(DISTINCT tienda)::int tiendas
         FROM analytics.v_erp_discount_rules`,
    );
    const R = reglas.rows[0];
    check('la vista existe y responde', Number.isInteger(R.total), JSON.stringify(R));
    check('cubre MÁS de una tienda (la vista vieja estaba clavada en la 03)', R.tiendas > 1, `tiendas=${R.tiendas}`);
    console.log(`     ${R.total} reglas vigentes · ${R.tiendas} tiendas · ${R.sin_unidad} apuntan a una unidad que el producto no tiene · ${R.sin_verificar} con umbral sin verificar`);
    const dupes = await knex.raw(
      `SELECT count(*)::int n FROM (
         SELECT tienda, sku, unidad, mecanismo, count(*) c
           FROM analytics.v_erp_discount_rules GROUP BY 1,2,3,4 HAVING count(*) > 1) x`,
    );
    check('⭐ no emite duplicados por (tienda, sku, unidad, mecanismo) — un JOIN sin dedupe triplicaba el renglón', Number(dupes.rows[0].n) === 0, `grupos duplicados=${dupes.rows[0].n}`);

  } catch (e) {
    console.error('\n💥 Excepción:', e.message);
    fail++;
  } finally {
    // ── Limpieza ───────────────────────────────────────────────────────────────────────────
    for (const id of cotizaciones) {
      await knex.raw('DELETE FROM commercial.quote_lines WHERE quote_id = ?', [id]).catch(() => {});
      await knex.raw('DELETE FROM commercial.quotes WHERE id = ?', [id]).catch(() => {});
    }
    for (const u of [uOperador, uSinLlave]) {
      if (u) await knex('identity.users').where({ tenant_id: T, username: u }).del().catch(() => {});
    }
    console.log(`\n=== ${pass} ✓ · ${fail} ✗ · ${nomedido} no medido ===\n`);
    await knex.destroy();
    process.exit(fail > 0 ? 1 : 0);
  }
})();
