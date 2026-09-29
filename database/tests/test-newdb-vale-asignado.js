/**
 * `[GX.41]` — **El vale de Kepler que cae en «Mis gastos» por la caja «Solicita».**
 *
 * Pedido textual: *«lo que vas a leer en ese campo es un username, el cual deberá coincidir
 * con alguno de nuestros usuarios en suite (…) cuando coincidan, va a aparecer ese vale en la
 * sección de "Mis Gastos" en el perfil del usuario que vinculaste»*.
 *
 * ## Lo que se prueba no es «la consulta devuelve filas»
 * Es que **el vale le llegue a UNA persona y a nadie más**, y que no se duplique. Cada
 * defecto se provoca a propósito:
 *
 *  1. **Que no llegue nunca.** La vista publica `c48` en MAYÚSCULAS; comparando literal
 *     contra un `username` en minúsculas la sección sale **vacía y parece correcta**.
 *  2. **Que llegue al que no es.** Un prefijo (`juan` ← `juana`) o un área con el mismo texto
 *     le mostraría a alguien el gasto de otro — el defecto que GX.34 ya cerró para la lista.
 *  3. **Que se vea dos veces.** Un vale ya capturado tiene expediente nuestro; si además
 *     apareciera como «asignado», la persona lo captura de nuevo.
 *  4. **Que el dedupe esconda de más.** 373 folios viven en más de una plaza: excluir por
 *     folio pelado le taparía a alguien el vale de SU tienda porque otra ya lo capturó.
 *  5. **Que aparezca lo cancelado.** Ruido en la lista de «te toca hacer algo» enseña a
 *     ignorarla.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-vale-asignado.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

const SUF = String(Date.now()).slice(-4);
const FOLIO = `88${SUF}`;
const USER = `smk_gx41_${SUF}`;
const PLAZA_A = '00';
const PLAZA_B = '02';

const doc = (sucursal, folio, solicita, extra = {}) => ({
  sucursal, c1: sucursal, c2: 'X', c3: 'A', c4: '15', c5: '1', c6: folio,
  c9: '2026-06-15', c16: '999.00', c24: `SMOKE GX41 ${SUF}`,
  c32: 'DESTINATARIO DEL VALE', c43: 'N', c48: solicita, c67: 'smoke',
  ...extra,
});

const NORM = String.fromCharCode(92) + 's+';

/** La MISMA regla del servicio: si allá se afloja, este archivo se pone rojo. */
const asignados = async (username) => knex('analytics.expense_requests as r')
  .where('r.tenant_id', T)
  .whereRaw(`upper(regexp_replace(btrim(r.solicitante),'${NORM}',' ','g')) = ?`,
    [String(username || '').trim().replace(/\s+/g, ' ').toUpperCase()])
  .whereRaw(`coalesce(btrim(r.estado),'') <> 'C'`)
  .whereNotExists(function () {
    this.select(knex.raw('1')).from('finance.expense_proofs as p')
      .whereRaw('p.tenant_id = r.tenant_id')
      .whereRaw('p.folio_solicitud = r.folio')
      .whereRaw('p.sucursal = r.sucursal');
  })
  .select('r.sucursal', 'r.folio', 'r.solicitante', 'r.beneficiario', 'r.aplicada');

async function limpiar() {
  await knex('kepler_ods.kdm1').where('c6', 'like', `88${SUF}%`).del();
  await knex('finance.expense_proofs').where('folio_solicitud', 'like', `88${SUF}%`).del();
}

(async () => {
  console.log(`\n[GX.41] el vale que Kepler asigna por «Solicita»  (user ${USER} · folio ${FOLIO})\n`);
  await limpiar();

  // ── 1) ⭐ El caso que sostiene la fase: la vista lo devuelve en MAYÚSCULAS ───────────
  console.log('1) ⭐ Kepler recibe minúsculas y la vista publica MAYÚSCULAS — tiene que casar igual');
  await knex('kepler_ods.kdm1').insert(doc(PLAZA_A, FOLIO, USER));
  const pub = await knex('analytics.expense_requests').where({ tenant_id: T, folio: FOLIO, sucursal: PLAZA_A }).first('solicitante');
  ok(pub.solicitante === USER.toUpperCase(), `la vista lo publica como «${pub.solicitante}» (en mayúsculas)`);
  const r1 = await asignados(USER);
  ok(r1.length === 1, 'y aun así le llega al usuario, que está en minúsculas');
  ok(!!r1[0] && r1[0].beneficiario === 'DESTINATARIO DEL VALE',
    'el destinatario viene del MISMO vale de Kepler');

  // ── 2) ⛔ No le llega a nadie más ───────────────────────────────────────────────────
  console.log('\n2) ⛔ no le llega a nadie más');
  ok((await asignados('otro_usuario')).length === 0, 'otro usuario no lo ve');
  ok((await asignados(USER.slice(0, -1))).length === 0, 'un prefijo del username NO casa');
  ok((await asignados(`${USER}x`)).length === 0, 'un username más largo tampoco');
  ok((await asignados('')).length === 0, 'el vacío no se lleva nada');

  // ── 3) ⛔ El que ya capturó no lo ve dos veces ──────────────────────────────────────
  console.log('\n3) ⛔ el vale YA capturado desaparece de «asignados» (si no, se captura dos veces)');
  await knex('finance.expense_proofs').insert({
    tenant_id: T, solicitante: USER, departamento: 'SMOKE', sucursal: PLAZA_A,
    folio_solicitud: FOLIO, proveedor: 'SMOKE', importe: 999, files: '[]',
    status: 'recibida', created_by: USER,
  });
  ok((await asignados(USER)).length === 0, 'con expediente nuestro ya no aparece como asignado');

  // ── 4) ⛔ Pero el dedupe NO puede esconder el de la otra plaza ──────────────────────
  console.log('\n4) ⛔ el MISMO folio en otra plaza sigue apareciendo (373 folios viven en varias)');
  await knex('kepler_ods.kdm1').insert(doc(PLAZA_B, FOLIO, USER));
  const r4 = await asignados(USER);
  ok(r4.length === 1 && r4[0].sucursal === PLAZA_B,
    'aparece el de la plaza B, que nadie capturó — el dedupe cruza por folio Y sucursal');

  // ── 5) ⛔ Lo cancelado no entra ─────────────────────────────────────────────────────
  console.log('\n5) ⛔ un vale cancelado en Kepler no ensucia la lista de «te toca hacer algo»');
  await knex('kepler_ods.kdm1').where({ c6: FOLIO, sucursal: PLAZA_B }).update({ c43: 'C' });
  ok((await asignados(USER)).length === 0, 'el cancelado se fue');

  // ── 6) Lo aplicado SÍ se muestra: puede seguir necesitando su comprobante ───────────
  console.log('\n6) lo APLICADO sí se muestra — sigue pudiendo necesitar su comprobante');
  await knex('kepler_ods.kdm1').where({ c6: FOLIO, sucursal: PLAZA_B }).update({ c43: 'F' });
  await knex('kepler_ods.kdm1').insert(
    { ...doc(PLAZA_B, `G${FOLIO}`, USER), c4: '10', c37: '15', c38: '1', c39: FOLIO });
  const r6 = await asignados(USER);
  ok(r6.length === 1 && r6[0].aplicada === true, 'aparece, y viene marcado como ya aplicado');

  // ── 7) ⛔ Un área con el texto de un usuario NO se lleva sus vales ──────────────────
  console.log('\n7) ⛔ hoy la caja trae ÁREAS: ninguna puede llevarse el vale de un usuario');
  await knex('kepler_ods.kdm1').insert(doc(PLAZA_A, `${FOLIO}9`, '10 PADRE HIDALGO RD'));
  ok((await asignados(USER)).length === 1, 'el vale de un área no se suma a los del usuario');
  ok((await asignados('10 PADRE HIDALGO')).length === 0, 'y un texto parcial del área tampoco casa');

  await limpiar();
  console.log(`\n${fail ? `❌ ${fail} fallo(s)` : '✅ todo verde'}\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.message); try { await limpiar(); } catch { /* noop */ } await knex.destroy(); process.exit(1); });
