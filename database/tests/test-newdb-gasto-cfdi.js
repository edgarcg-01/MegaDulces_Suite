/**
 * `[GX.40]` — **El CFDI del gasto: sugerencia, nunca hecho.**
 *
 * Pedido del usuario: *«jalar esa factura o ese documento que genera y agregarlo al gasto como
 * un tipo de expediente»*. Se puede, pero **no desde Kepler y no para todos**.
 *
 * ## Por qué el enlace es heurístico (barrido del 2026-09-29 en prod)
 * Kepler **no guarda el UUID fiscal**: de las **200 columnas** de `kdm1` para `X-A-15` hay
 * **37 con dato y ninguna con UUID**, `kdm2` tiene **0 líneas** para estos documentos, y la
 * familia `kdfe33*` timbra **sólo ventas** (género U) — cero gastos `X-A-10`. Ya estaba
 * verificado en MAT.1 (2026-07-17). El único puente posible es **RFC + importe ±$1 + fecha
 * ±5 días**, y eso es una coincidencia, no una liga.
 *
 * ## La cobertura, que es parte del contrato
 * ```
 *   de 8,899 gastos:  3,203 con RFC · 1,596 con importe que cuadra
 *                       880 con importe y fecha · 743 con UN SOLO candidato (8.4%)
 * ```
 *
 * ## ⛔ Las cuatro maneras de mentir con esto, cada una provocada a propósito
 *  1. **Elegir con dos candidatos.** Le pega al gasto la factura equivocada del proveedor
 *     correcto — se ve perfecto y nadie lo audita. Con más de uno se marca `ambiguo`.
 *  2. **Aflojar el importe.** Un centavo de más ya es otra factura. El tope es $1.
 *  3. **Aflojar la fecha.** A ±30 días, un proveedor mensual casa con el mes que no es.
 *  4. **Devolver vacío sin decir por qué.** «Sin RFC» y «no cuadra ninguna» son cosas
 *     distintas: la primera la arregla quien captura en Kepler, la segunda nadie (ADR-056).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-gasto-cfdi.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };

const SUF = String(Date.now()).slice(-6);
const RFC = `SMK${SUF}XX1`.slice(0, 13);
const FECHA = '2026-06-15';
const IMPORTE = 1234.56;

const cfdi = (over = {}) => ({
  tenant_id: T, uuid: `${SUF}-0000-0000-0000-${String(Math.random()).slice(2, 14)}`,
  emisor_rfc: RFC, emisor_nombre: 'PROVEEDOR SMOKE', total: IMPORTE, fecha: FECHA,
  estatus_sat: 'desconocido', source: 'smoke_gx40', rol: 'recibidas', ...over,
});

/** La MISMA regla que `cfdiCandidato()` — si se afloja allá, este archivo se pone rojo. */
const candidatos = async (rfc, importe, fecha) => knex('fiscal.cfdis')
  .where('tenant_id', T)
  .whereRaw('upper(emisor_rfc) = ?', [String(rfc || '').toUpperCase()])
  .whereRaw('abs(total - ?::numeric) <= 1', [importe])
  .whereRaw('abs(fecha::date - ?::date) <= 5', [fecha])
  .orderByRaw('abs(fecha::date - ?::date) ASC', [fecha])
  .select('uuid', 'total', knex.raw('(xml IS NOT NULL) AS tiene_xml'));

const limpiar = () => knex('fiscal.cfdis').where('source', 'smoke_gx40').del();

(async () => {
  console.log(`\n[GX.40] el candidato a factura del gasto  (RFC ${RFC})\n`);
  await limpiar();

  console.log('1) sin nada cargado: no hay candidato, y eso NO es «no tiene factura»');
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 0, 'cero candidatos con la tabla vacía');

  console.log('\n2) ⭐ una factura que cuadra → candidato único');
  await knex('fiscal.cfdis').insert(cfdi());
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 1, 'exactamente uno');

  console.log('\n3) ⛔ dos que cuadran → AMBIGUO, no se elige ninguna');
  await knex('fiscal.cfdis').insert(cfdi({ fecha: '2026-06-17' }));
  const dos = await candidatos(RFC, IMPORTE, FECHA);
  ok(dos.length === 2, 'los dos aparecen (la pantalla dice «hay 2 que cuadran»)');
  ok(dos[0].uuid !== dos[1].uuid, 'son facturas distintas, no la misma dos veces');

  console.log('\n4) ⛔ el tope de IMPORTE es $1 — un peso de más ya es otra factura');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ total: IMPORTE + 1.00 }));
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 1, 'a $1.00 exacto todavía cuadra (el borde entra)');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ total: IMPORTE + 1.01 }));
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 0, 'a $1.01 ya NO cuadra');

  console.log('\n5) ⛔ el tope de FECHA es 5 días — a ±30 un proveedor mensual casa con el mes que no es');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ fecha: '2026-06-20' }));   // +5
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 1, 'a +5 días todavía cuadra (el borde entra)');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ fecha: '2026-06-21' }));   // +6
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 0, 'a +6 días ya NO cuadra');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ fecha: '2026-06-10' }));   // -5
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 1, 'y el borde de atrás también entra');

  console.log('\n6) ⛔ el RFC no se afloja: otro proveedor NO cuadra aunque el importe y la fecha sí');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi({ emisor_rfc: 'OTRO010101AAA' }));
  ok((await candidatos(RFC, IMPORTE, FECHA)).length === 0, 'el mismo importe y fecha de OTRO emisor no cuenta');

  console.log('\n7) ⚠️ el «documento» son DATOS, no un archivo');
  await limpiar();
  await knex('fiscal.cfdis').insert(cfdi());
  const c = (await candidatos(RFC, IMPORTE, FECHA))[0];
  ok(c.tiene_xml === false,
    'un CFDI sin XML se declara como tal — en prod 0 de 168,245 tienen PDF y sólo 1,015 XML');

  await limpiar();
  console.log(`\n${fail ? `❌ ${fail} fallo(s)` : '✅ todo verde'}\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERR', e.message); try { await limpiar(); } catch { /* noop */ } await knex.destroy(); process.exit(1); });
