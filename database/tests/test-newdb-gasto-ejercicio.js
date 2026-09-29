/**
 * `[GX.39]` — **«Por ejercer» y «Ejercido»: que el puente a Kepler diga la verdad.**
 *
 * Pedido textual del usuario: *«cuando el usuario de aprobación de gastos le dé luz verde se
 * va a pasar el vale a la sección de ejercer, esto quiere decir que está pendiente a que
 * aprueben el gasto en Kepler»*, y después *«le vas a decir al usuario que su gasto se aprobó
 * y se ejerció»*.
 *
 * ## Lo que se prueba, y por qué no alcanza con «la consulta devuelve filas»
 * Kepler **no marca** «ejercido» con una bandera: lo marca **creando otro documento** (el gasto
 * `X-A-10`, que apunta a su solicitud por `c39`). Así que esta prueba **siembra el gasto** y
 * verifica que el puente lo vea — el antes y el después, no sólo el después:
 *
 *  1. Sin gasto sembrado → `aplicada = false`. Es el estado «por ejercer».
 *  2. Con el gasto sembrado → `aplicada = true`. Es el estado «ejercido».
 *  3. Se retira el gasto → vuelve a `false`. La vista **deriva**, no recuerda.
 *
 * El punto 3 es el que importa: si alguien materializara `aplicada` en una tabla (lo que la
 * regla principal del proyecto prohíbe), el punto 3 se pondría rojo.
 *
 * ## ⛔ Los dos errores que este archivo vigila
 *  · **Que el folio cruce de plaza.** 373 folios viven en más de una sucursal. Se siembra el
 *    MISMO folio en dos plazas, se aplica una sola, y se verifica que la otra siga en `false`.
 *    Sin esto, un vale diría «ejercido» leyendo el gasto de otra tienda.
 *  · **Que «no medido» se lea como «no aplicado».** Un folio que no está en la vista tiene que
 *    dar *ausente*, no `false` — porque `false` afirma que Kepler no lo aplicó (ADR-056).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-gasto-ejercicio.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

/** Marca propia: se limpia sólo lo de esta corrida, nunca la tabla. */
const SUF = String(Date.now()).slice(-4);
const FOLIO = `99${SUF}`;
const PLAZA_A = '00';
const PLAZA_B = '01';

/** Una fila de `kdm1` mínima pero válida para la vista (anti-réplica: `c1 = sucursal`). */
const doc = (sucursal, tipo, folio, extra = {}) => ({
  sucursal, c1: sucursal, c2: 'X', c3: 'A', c4: tipo, c5: '1', c6: folio,
  c9: new Date().toISOString().slice(0, 10), c16: '1234.56', c24: `SMOKE GX39 ${SUF}`,
  c32: 'PROVEEDOR SMOKE', c43: 'N', c48: 'SMOKE AREA', c67: 'smoke',
  ...extra,
});

const aplicada = async (sucursal, folio) => {
  const r = await knex('analytics.expense_requests')
    .where({ tenant_id: T, folio, sucursal }).first('aplicada', 'estado');
  return r === undefined ? 'AUSENTE' : r.aplicada;
};

async function limpiar() {
  await knex('kepler_ods.kdm1').where('c6', FOLIO).whereIn('c4', ['15', '10']).del();
  await knex('kepler_ods.kdm1').where('c39', FOLIO).del();
}

(async () => {
  console.log(`\n[GX.39] el puente solicitud → gasto  (folio ${FOLIO})\n`);
  await limpiar();

  // ── 1) El folio que NO existe: ausente, jamás `false` ────────────────────────────────
  console.log('1) lo que no se puede medir se DECLARA, no se dibuja como «no aplicado»');
  ok(await aplicada(PLAZA_A, FOLIO) === 'AUSENTE',
    'un folio que no está en la vista da AUSENTE (el contrato lo traduce a «sin medir»)');

  // ── 2) La solicitud sola: por ejercer ───────────────────────────────────────────────
  console.log('\n2) la solicitud sin su gasto → «por ejercer»');
  await knex('kepler_ods.kdm1').insert(doc(PLAZA_A, '15', FOLIO));
  await knex('kepler_ods.kdm1').insert(doc(PLAZA_B, '15', FOLIO));
  ok(await aplicada(PLAZA_A, FOLIO) === false, 'la plaza A arranca en aplicada = false');
  ok(await aplicada(PLAZA_B, FOLIO) === false, 'la plaza B también');

  // ── 3) Aparece el gasto: ejercido ───────────────────────────────────────────────────
  console.log('\n3) Kepler crea el gasto X-A-10 apuntando a la solicitud (c39) → «ejercido»');
  await knex('kepler_ods.kdm1').insert(
    doc(PLAZA_A, '10', `G${FOLIO}`, { c37: '15', c38: '1', c39: FOLIO }));
  ok(await aplicada(PLAZA_A, FOLIO) === true, 'la plaza A pasa a aplicada = true');

  // ── 4) ⛔ El gasto de una plaza NO ejerce el de la otra ──────────────────────────────
  console.log('\n4) ⛔ el folio vive en dos plazas: el gasto de una NO ejerce el de la otra');
  ok(await aplicada(PLAZA_B, FOLIO) === false,
    'la plaza B sigue en false (si diera true, un vale diría «ejercido» con el gasto ajeno)');

  // ── 5) ⭐ Se retira el gasto y la vista se entera: DERIVA, no recuerda ────────────────
  console.log('\n5) ⭐ se retira el gasto → la vista vuelve a false (deriva, no materializa)');
  await knex('kepler_ods.kdm1').where('c39', FOLIO).del();
  ok(await aplicada(PLAZA_A, FOLIO) === false,
    'volvió a false sin que corriera ningún proceso — es una vista, no una copia');

  // ── 6) El otro testigo: c43 = F ─────────────────────────────────────────────────────
  console.log('\n6) el estado propio de la solicitud (c43) viaja aparte del puente');
  await knex('kepler_ods.kdm1').where({ c6: FOLIO, c4: '15', sucursal: PLAZA_A }).update({ c43: 'F' });
  const r = await knex('analytics.expense_requests').where({ tenant_id: T, folio: FOLIO, sucursal: PLAZA_A }).first('aplicada', 'estado');
  ok(r.estado === 'F', 'la vista publica estado = F («Aplicada — el dinero salió»)');
  ok(r.aplicada === false,
    'y aplicada sigue en false: son DOS testigos, no uno — el contrato los arbitra, la vista no');

  await limpiar();
  console.log(`\n${fail ? `❌ ${fail} fallo(s)` : '✅ todo verde'}\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.message); try { await limpiar(); } catch { /* noop */ } await knex.destroy(); process.exit(1); });
