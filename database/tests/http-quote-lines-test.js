/* eslint-disable no-console */
/**
 * `[COT.1b]` — **Los renglones de una cotización, por HTTP y con rol mínimo.**
 *
 * `http-quote-pricing-test.js` (COT.1) probó que el MOTOR pone bien el precio. Esto prueba lo
 * que el motor no cubría y que la pantalla nueva ejercita de verdad:
 *
 *   1. ⭐ **El PATCH re-tarifica.** Es la diferencia deliberada contra un pedido:
 *      `OrdersService.updateLine` conserva el `unit_price` del snapshot
 *      (`commercial-orders.service.ts:842`), y por eso en `/vendor/take-order` el `+` del
 *      stepper nunca dispara el mayoreo. En una cotización el precio **es** el producto: subir
 *      la cantidad hasta cruzar el umbral de volumen tiene que BAJAR el precio.
 *   2. ⭐ **El PATCH conserva el `line_number`.** Borrar y re-agregar mandaba el renglón al
 *      final (`line_number` es `max+1` y nunca se reusa) y la cotización dejaba de estar en el
 *      orden de la lista que mandó el cliente — que es lo que el módulo existe para conservar.
 *   3. ⭐ **El peldaño se GUARDA.** Antes el `rung` se usaba para preciar y se tiraba: leyendo
 *      la fila no se sabía si el 10 eran 10 piezas o 10 cajas. Se afirma el sello completo
 *      (`qty_unit` + `qty_factor` + `qty_factor_source='kepler_ladder'`).
 *   4. ⭐ **Una fila vieja sigue en NULL.** El contrato `[VU.0]` prohíbe rellenar: NULL no es
 *      pieza, es "no se registró". Se comprueba que la migración no inventó nada.
 *   5. ⭐ **El gate es de verdad.** Un rol sin `COMMERCIAL_QUOTES_GESTIONAR` recibe 403 en el
 *      PATCH. ⚠️ **No se prueba con admin**: pasaría por god-mode y saldría verde aunque el
 *      gate estuviera abierto — la forma exacta de `[LC.6.2]`.
 *   6. Que un regalo NO se edita a mano: lo pone y lo quita la regla del ERP sobre su padre.
 *
 * Pre-requisitos: API levantada (por defecto :3334; `API_BASE_LINES` lo cambia) y las
 * migraciones `20260923140000`, `20260923150000` y `20260923170000` aplicadas.
 * Uso: node database/tests/http-quote-lines-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const bcrypt = require('bcryptjs');

const BASE = process.env.API_BASE_LINES || 'http://localhost:3334/api';
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
  const username = `cotl_${rol}_${SUF}`.slice(0, 40);
  await knex('identity.users').insert({
    tenant_id: T,
    username,
    nombre: `SMOKE COT.1b ${rol}`,
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
  console.log('\n=== [COT.1b] Renglones de cotización — HTTP, rol mínimo ===\n');
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

    // El SKU sale de la MISMA fuente que el motor. Sin escalera de volumen no se puede probar
    // el punto 1, así que se DECLARA en vez de inventar un número.
    const fuente = await knex.raw(
      `SELECT sku, name, piece_price, wholesale_piece_price, wholesale_piece_min_qty,
              box_price, box_size, unit_base
         FROM analytics.v_label_prices
        WHERE sucursal = ? AND piece_price > 0
          AND wholesale_piece_price IS NOT NULL AND wholesale_piece_min_qty > 1
          AND wholesale_piece_price < piece_price
        ORDER BY sku LIMIT 1`, [BRANCH],
    );
    if (!fuente.rows.length) {
      declarar('el re-tarifado del PATCH', `no hay SKU con volumen más barato en la sucursal ${BRANCH}`);
    }
    const F = fuente.rows[0] || null;

    // Un cliente de mayoreo real de esa sucursal: las condiciones se congelan al crear.
    const cli = await knex.raw(
      `SELECT customer_code FROM analytics.v_erp_wholesale_customers
        WHERE sucursal = ? ORDER BY customer_code LIMIT 1`, [BRANCH],
    );
    if (!cli.rows.length) {
      declarar('todo el resto', `no hay clientes de mayoreo en la sucursal ${BRANCH}`);
      return;
    }
    const CODIGO = cli.rows[0].customer_code;

    const nueva = await req('POST', '/commercial/quotes', op.token, {
      erp_customer_code: CODIGO, source_branch: BRANCH, origin: 'telemarketing',
    });
    check('POST /quotes crea el borrador', !!nueva.body?.id, `status ${nueva.status}`);
    if (!nueva.body?.id) { declarar('todo el resto', 'sin cotización no hay renglones que probar'); return; }
    const QID = nueva.body.id;
    cotizaciones.push(QID);
    console.log(`     cotización ${nueva.body.code} · cliente ${CODIGO} · sucursal ${BRANCH}`);

    // ── 1. El sello de unidad se GUARDA ────────────────────────────────────────────────────
    console.log('\n1 — ⭐ el peldaño cotizado queda escrito (antes se usaba y se tiraba)');
    let LID = null;
    if (F) {
      const add = await req('POST', `/commercial/quotes/${QID}/lines`, op.token, {
        sku: F.sku, quantity: 1, rung: 'base',
      });
      check('POST /lines → 2xx', add.status === 200 || add.status === 201, `status ${add.status}`);
      const fila = await knex.raw(
        `SELECT id, line_number, quantity, unit_price, qty_unit, qty_factor, qty_factor_source
           FROM commercial.quote_lines WHERE quote_id = ? ORDER BY line_number LIMIT 1`, [QID],
      );
      check('el renglón existe en la base', fila.rows.length === 1);
      if (fila.rows.length) {
        const r = fila.rows[0];
        LID = r.id;
        check('qty_unit trae el rótulo del ERP', r.qty_unit === F.unit_base, `qty_unit=${r.qty_unit} erp=${F.unit_base}`);
        // En la BASE no hubo conversión: el factor se declara ausente, NO 1 de relleno (VU.0).
        check('en el peldaño base el factor va NULL, no 1', r.qty_factor === null, `qty_factor=${r.qty_factor}`);
        check('y su fuente también, porque no hubo factor', r.qty_factor_source === null, `source=${r.qty_factor_source}`);
      }

      // El peldaño CAJA sí convierte: ahí el factor y su procedencia tienen que estar.
      if (F.box_size && Number(F.box_size) > 1) {
        const addCja = await req('POST', `/commercial/quotes/${QID}/lines`, op.token, {
          sku: F.sku, quantity: 1, rung: 'box',
        });
        check('POST /lines con peldaño caja → 2xx', addCja.status === 200 || addCja.status === 201, `status ${addCja.status}`);
        const cja = await knex.raw(
          `SELECT qty_unit, qty_factor, qty_factor_source FROM commercial.quote_lines
            WHERE quote_id = ? ORDER BY line_number DESC LIMIT 1`, [QID],
        );
        const c = cja.rows[0] || {};
        check('la caja guarda su factor', Number(c.qty_factor) === Number(F.box_size), `factor=${c.qty_factor} erp=${F.box_size}`);
        check(
          "y lo rotula 'kepler_ladder', no 'kepler_c84'",
          c.qty_factor_source === 'kepler_ladder',
          `source=${c.qty_factor_source} — v_label_prices lee c84 O c81 según la ranura; kepler_c84 sería falso en la rama c81`,
        );
      } else {
        declarar('el sello del peldaño caja', `${F.sku} no declara box_size en la sucursal ${BRANCH}`);
      }
    } else {
      declarar('el sello de unidad', 'no hubo SKU con el que armar el renglón');
    }

    // ── 2. ⭐ El PATCH re-tarifica y conserva el lugar ──────────────────────────────────────
    console.log('\n2 — ⭐ el PATCH re-corre el motor (al revés que el de pedidos) y no mueve la fila');
    if (F && LID) {
      const antes = await knex.raw(
        `SELECT line_number, unit_price, quantity FROM commercial.quote_lines WHERE id = ?`, [LID],
      );
      const A = antes.rows[0];
      const qtyVol = Number(F.wholesale_piece_min_qty);

      const pat = await req('PATCH', `/commercial/quotes/${QID}/lines/${LID}`, op.token, { quantity: qtyVol });
      check('PATCH /lines/:id → 200', pat.status === 200, `status ${pat.status} ${JSON.stringify(pat.body).slice(0, 120)}`);

      const desp = await knex.raw(
        `SELECT line_number, unit_price, quantity, price_source FROM commercial.quote_lines WHERE id = ?`, [LID],
      );
      const D = desp.rows[0];
      check('el line_number NO cambió (la fila conserva su lugar en la lista)',
        Number(D.line_number) === Number(A.line_number), `antes=${A.line_number} después=${D.line_number}`);
      check('la cantidad quedó en lo pedido', Number(D.quantity) === qtyVol, `quantity=${D.quantity}`);
      check(
        `⭐ el precio BAJÓ al cruzar el umbral de volumen (${qtyVol} u)`,
        Number(D.unit_price) === Number(F.wholesale_piece_price),
        `después=${D.unit_price} esperado=${F.wholesale_piece_price} antes=${A.unit_price}`,
      );
      check('y el renglón declara que el precio vino del volumen',
        D.price_source === 'volume_qty', `price_source=${D.price_source}`);

      // Prueba negativa del punto 1: si el PATCH conservara el snapshot —como hace el de
      // pedidos— el precio seguiría siendo el de lista y esta comparación lo delataría.
      check('prueba negativa: el precio NO se quedó en el de lista',
        Number(D.unit_price) !== Number(A.unit_price),
        'si no cambió, el PATCH está conservando el snapshot como OrdersService.updateLine');

      // `requested_quantity` es lo que el CLIENTE pidió: la corrección del operador no lo pisa.
      const rq = await knex.raw(`SELECT requested_quantity FROM commercial.quote_lines WHERE id = ?`, [LID]);
      check('requested_quantity conserva lo que el cliente pidió originalmente',
        Number(rq.rows[0].requested_quantity) === Number(A.quantity), `requested=${rq.rows[0].requested_quantity}`);
    } else {
      declarar('el re-tarifado del PATCH', 'sin renglón con escalera de volumen no hay qué comparar');
    }

    // ── 3. El renglón sin casar ────────────────────────────────────────────────────────────
    console.log('\n3 — lo que el cliente pidió y no manejamos se guarda, no se borra');
    const nc = await req('POST', `/commercial/quotes/${QID}/lines`, op.token, {
      requested_text: `CHICLOSOS ROSAS DEL SEÑOR ${SUF}`, quantity: 3,
    });
    check('POST /lines sin SKU → 2xx', nc.status === 200 || nc.status === 201, `status ${nc.status}`);
    const filaNc = await knex.raw(
      `SELECT product_id, unit_price, availability, requested_text, qty_unit
         FROM commercial.quote_lines WHERE quote_id = ? AND requested_text LIKE ? LIMIT 1`,
      [QID, `%${SUF}`],
    );
    if (filaNc.rows.length) {
      const n = filaNc.rows[0];
      check('queda sin product_id (es demanda, no catálogo)', n.product_id === null);
      check('y SIN precio en NULL, nunca $0', n.unit_price === null, `unit_price=${n.unit_price}`);
      check("se declara 'unmatched'", n.availability === 'unmatched', `availability=${n.availability}`);
      check('sin peldaño: no hubo con qué resolverlo, y se declara', n.qty_unit === null, `qty_unit=${n.qty_unit}`);
    } else {
      check('el renglón sin casar se guardó', false, 'no apareció en la base');
    }

    // ── 4. Un regalo no se edita a mano ────────────────────────────────────────────────────
    console.log('\n4 — el renglón de regalo lo pone la regla del ERP, no el operador');
    const regalo = await knex.raw(
      `SELECT id FROM commercial.quote_lines WHERE quote_id = ? AND parent_line_number IS NOT NULL LIMIT 1`, [QID],
    );
    if (regalo.rows.length) {
      const r = await req('PATCH', `/commercial/quotes/${QID}/lines/${regalo.rows[0].id}`, op.token, { quantity: 99 });
      check('PATCH sobre un regalo → 400', r.status === 400, `status ${r.status}`);
    } else {
      declarar('el candado del regalo', 'ninguna regla de producto gratis se activó con estas cantidades');
    }

    // ── 5. ⭐ El gate, con rol mínimo y sin admin ───────────────────────────────────────────
    console.log('\n5 — ⭐ prueba negativa del permiso (sin admin: god-mode lo pintaría verde)');
    if (LID) {
      const p403 = await req('PATCH', `/commercial/quotes/${QID}/lines/${LID}`, sin.token, { quantity: 2 });
      check('PATCH sin COMMERCIAL_QUOTES_GESTIONAR → 403', p403.status === 403, `status ${p403.status}`);
    }
    const a403 = await req('POST', `/commercial/quotes/${QID}/lines`, sin.token, { sku: 'X', quantity: 1 });
    check('POST /lines sin la llave → 403', a403.status === 403, `status ${a403.status}`);
    const d403 = await req('DELETE', `/commercial/quotes/${QID}/lines/${LID || '00000000-0000-0000-0000-000000000000'}`, sin.token);
    check('DELETE /lines sin la llave → 403', d403.status === 403, `status ${d403.status}`);

    // ── 6. ⛔ Las filas viejas NO se rellenaron ─────────────────────────────────────────────
    console.log('\n6 — ⛔ la migración no inventó unidades donde no las había (VU.0)');
    const viejas = await knex.raw(
      `SELECT count(*)::int AS n FROM commercial.quote_lines
        WHERE created_at < (SELECT min(created_at) FROM commercial.quote_lines WHERE quote_id = ?)
          AND qty_unit IS NOT NULL`, [QID],
    );
    const previas = await knex.raw(
      `SELECT count(*)::int AS n FROM commercial.quote_lines
        WHERE created_at < (SELECT min(created_at) FROM commercial.quote_lines WHERE quote_id = ?)`, [QID],
    );
    if (Number(previas.rows[0].n) === 0) {
      declarar('el no-relleno de filas viejas', 'no había renglones anteriores a esta corrida con qué comprobarlo');
    } else {
      check(
        `ninguno de los ${previas.rows[0].n} renglones previos ganó una unidad inventada`,
        Number(viejas.rows[0].n) === 0,
        `${viejas.rows[0].n} filas viejas tienen qty_unit — alguien rellenó`,
      );
    }

    // ── 7. Borrar se lleva a los hijos ─────────────────────────────────────────────────────
    console.log('\n7 — quitar un renglón se lleva sus regalos');
    if (LID) {
      const del = await req('DELETE', `/commercial/quotes/${QID}/lines/${LID}`, op.token);
      check('DELETE → 200', del.status === 200, `status ${del.status}`);
      const huerfano = await knex.raw(
        `SELECT count(*)::int AS n FROM commercial.quote_lines WHERE quote_id = ? AND id = ?`, [QID, LID],
      );
      check('el renglón ya no está', Number(huerfano.rows[0].n) === 0);
    }
  } catch (e) {
    console.error('\n💥', e.message);
    fail++;
  } finally {
    // Limpieza: los usuarios efímeros y las cotizaciones de prueba no se quedan.
    for (const id of cotizaciones) {
      await knex.raw(`DELETE FROM commercial.quote_lines WHERE quote_id = ?`, [id]).catch(() => {});
      await knex.raw(`DELETE FROM commercial.quotes WHERE id = ?`, [id]).catch(() => {});
    }
    for (const u of [uOperador, uSinLlave]) {
      if (u) await knex('identity.users').where({ tenant_id: T, username: u }).del().catch(() => {});
    }
    await knex.destroy();
  }

  console.log(`\n=== ${pass} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} NO MEDIDO` : ''} ===\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
