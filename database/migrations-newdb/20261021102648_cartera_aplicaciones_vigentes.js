'use strict';
/**
 * `[CSU.11]` — **La cartera deja de restar cobros CANCELADOS.** Los tres objetos que suman
 * aplicaciones de Kepler leen `analytics.kepler_kdm5_vigente` en vez de `kepler_ods.kdm5`.
 *
 * ── Qué cambia, medido en prod el 2026-10-21 (sólo lectura) ────────────────────────────────
 *
 * Un cobro cancelado (cabecera `kdm1.c43 = 'C'`, importe 0) conserva su aplicación en `kdm5`, y
 * estos objetos la restaban del saldo de la factura:
 *
 *   · `analytics.erp_receivable_documents` (y `customer_receivables`, que se apoya en ella) →
 *     /finanzas/cartera, hallazgos de CXC, flujo de caja, ciclo de caja.
 *   · `analytics.erp_receivable_doc(...)` → saldo, cobrado y estatus de `erp_sales_invoices`
 *     (/comercial/documentos, Televenta, Guía de Cobranza).
 *   · `analytics.v_route_credit_sales` → crédito de ruta. Su `LATERAL` YA excluía el cancelado,
 *     pero sólo para la FECHA del cobro: el `sum(m.c13)` lo seguía contando.
 *
 *   Aplicaciones de documentos cancelados a cargos de cliente: U-A-5 → D-13 242 / $5,050,203.12,
 *   U-A-5 → D-12 52 / $1,154,048.39, U-A-25 → D-13 30 / $467,321.86, U-A-7 → D-8 12 / $127,505.44.
 *
 * ── Cómo, y por qué así ──────────────────────────────────────────────────────────────────────
 *
 * La definición se toma VIVA de la base (`pg_get_viewdef` / `pg_get_functiondef`), no de una
 * migración vieja: varias ya las recrearon, y copiar el texto de un archivo publicaría una versión
 * que ya no es la de prod. Lo ÚNICO que cambia es el nombre de la tabla, y se exige que aparezca
 * exactamente una vez por objeto (medido en prod): si no, la definición cambió desde que esto se
 * escribió y se aborta en vez de adivinar.
 *
 * ⚠️ `erp_receivable_documents` nombra la tabla SIN alias (`FROM kepler_ods.kdm5 WHERE kdm5.c2`):
 *    el reemplazo agrega el alias `kdm5` para que esas referencias sigan valiendo.
 * ⚠️ `CREATE OR REPLACE VIEW` sin `WITH (...)` BORRA las opciones de la vista: se leen y se repiten.
 *
 * Requiere `20261021102646_kepler_kdm5_vigente` (la vista que se lee). Idempotente: un objeto que
 * ya lee la vista se salta. Las vistas se verifican: mismo número de filas antes y después (sólo
 * cambian montos, nunca qué documentos hay).
 *
 * @param { import("knex").Knex } knex
 */

const ORIGEN = 'kepler_ods.kdm5';
const DESTINO = 'analytics.kepler_kdm5_vigente';
/** Palabras que pueden seguir a una tabla SIN alias. Si sigue otra cosa, es el alias. */
const NO_ALIAS = new Set(['where', 'join', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'on', 'group',
  'order', 'limit', 'offset', 'union', 'except', 'intersect', 'having', 'window', 'fetch', 'for', 'using']);

const OBJETOS = [
  { tipo: 'vista', nombre: 'analytics.erp_receivable_documents', contar: true },
  { tipo: 'funcion', nombre: 'analytics.erp_receivable_doc(text,text,text,text)' },
  { tipo: 'vista', nombre: 'analytics.v_route_credit_sales', contar: true },
];

/** Cambia la tabla por la vista conservando el alias. Devuelve el texto y cuántas cambió. */
function cambiarFuente(def, de, a, aliasSiFalta) {
  let n = 0;
  const re = new RegExp(`${de.replace('.', '\\.')}\\b(\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`, 'g');
  const texto = def.replace(re, (todo, cola, palabra) => {
    n++;
    if (palabra && !NO_ALIAS.has(palabra.toLowerCase())) return a + cola;   // ya tiene alias
    return `${a} ${aliasSiFalta}${cola || ''}`;                            // sin alias: se le pone
  });
  return { texto, n };
}

async function definicion(knex, o) {
  if (o.tipo === 'vista') {
    const r = await knex.raw(`SELECT pg_get_viewdef(to_regclass(?), true) AS def,
                                     (SELECT reloptions FROM pg_class WHERE oid = to_regclass(?)) AS opciones`, [o.nombre, o.nombre]);
    return { def: r.rows[0].def, opciones: r.rows[0].opciones };
  }
  const r = await knex.raw(`SELECT pg_get_functiondef(to_regprocedure(?)) AS def`, [o.nombre]);
  return { def: r.rows[0].def, opciones: null };
}

async function existe(knex, o) {
  const fn = o.tipo === 'vista' ? 'to_regclass' : 'to_regprocedure';
  return !!(await knex.raw(`SELECT ${fn}(?) AS x`, [o.nombre])).rows[0].x;
}

async function recrear(knex, o, def, opciones) {
  if (o.tipo === 'funcion') { await knex.raw(def); return; }
  const cuerpo = def.trim().replace(/;\s*$/, '');
  const conOpciones = opciones && opciones.length ? ` WITH (${opciones.join(', ')})` : '';
  await knex.raw(`CREATE OR REPLACE VIEW ${o.nombre}${conOpciones} AS ${cuerpo}`);
}

async function aplicar(knex, de, a, aliasSiFalta, etiqueta) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '300s'`);
  for (const o of OBJETOS) {
    if (!(await existe(knex, o))) { console.log(`  [CSU.11] ${o.nombre}: no existe en esta base — se salta`); continue; }
    const { def, opciones } = await definicion(knex, o);
    if (def.includes(a) && !def.includes(de)) { console.log(`  [CSU.11] ${o.nombre}: ya ${etiqueta} — se salta`); continue; }
    const { texto, n } = cambiarFuente(def, de, a, aliasSiFalta);
    if (n !== 1) throw new Error(`[CSU.11] ${o.nombre}: se esperaba 1 aparición de ${de} y hay ${n}. La definición cambió: revisar antes de tocarla.`);
    const antes = o.contar ? Number((await knex.raw(`SELECT count(*) AS n FROM ${o.nombre}`)).rows[0].n) : null;
    await recrear(knex, o, texto, opciones);
    if (o.contar) {
      const despues = Number((await knex.raw(`SELECT count(*) AS n FROM ${o.nombre}`)).rows[0].n);
      if (despues !== antes) throw new Error(`[CSU.11] ${o.nombre}: ${antes} filas antes y ${despues} después. Sólo debían cambiar montos.`);
      console.log(`  [CSU.11] ${o.nombre}: ${etiqueta} (${despues} filas, las mismas)`);
    } else console.log(`  [CSU.11] ${o.nombre}: ${etiqueta}`);
  }
}

exports.up = async function up(knex) {
  const v = await knex.raw(`SELECT to_regclass(?) AS x`, [DESTINO]);
  if (!v.rows[0].x) {
    const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm5') AS x`);
    if (!ods.rows[0].x) return; // dev sin ODS: no hay nada que cambiar
    throw new Error(`[CSU.11] falta ${DESTINO}: aplicar antes 20261021102646_kepler_kdm5_vigente`);
  }
  await aplicar(knex, ORIGEN, DESTINO, 'kdm5', 'lee las aplicaciones vigentes');
};

/** Deshace EXACTAMENTE el cambio de tabla: vuelve a leer kepler_ods.kdm5 crudo. */
exports.down = async function down(knex) {
  // pg_get_viewdef imprime el alias agregado ("analytics.kepler_kdm5_vigente kdm5"): se quita con él.
  const deshacer = async (o) => {
    if (!(await existe(knex, o))) return;
    const { def, opciones } = await definicion(knex, o);
    if (!def.includes(DESTINO)) return;
    const texto = def.split(`${DESTINO} kdm5`).join(ORIGEN).split(DESTINO).join(ORIGEN);
    await recrear(knex, o, texto, opciones);
  };
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const o of OBJETOS) await deshacer(o);
};

// Para la prueba unitaria del reemplazo (database/scripts/csu-cortes-paridad-local.js no la cubre).
exports._cambiarFuente = cambiarFuente;
