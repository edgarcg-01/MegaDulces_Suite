'use strict';
/**
 * `[COT.7.3]` — La cotización aceptada se arma como «Pedido Telemarketing» en Kepler (ADR-113).
 *
 * Dos piezas, las dos aditivas (la API desplegada no las lee ni las escribe: expand/contract):
 *
 *  1. **`commercial.quotes`**: dónde quedó el pedido y si salió mal, cinco columnas *nullable*.
 *     · `kepler_sucursal` + `kepler_folio`: la coordenada del `U-D-40` (las dos juntas, RQ.15).
 *       Es la IDEMPOTENCIA: con folio, no se vuelve a escribir.
 *     · `kepler_sent_at` / `kepler_sent_by`: cuándo y quién.
 *     · `kepler_error`: «no salió» y «salió mal» son ausencias distintas (ADR-056).
 *     · `kepler_sending_at`: el RECLAMO. Un envío marca la cotización antes de hablarle al ERP y
 *       otro que llegue en ese momento rebota: dos clics no escriben dos pedidos.
 *
 *  2. **`commercial.kepler_push_switch`**: el tipo `telemarketing` en el CHECK y un renglón por
 *     sucursal **APAGADO**, con tope 1 (el canario de KR.12: encender sin decidir el tope deja
 *     pasar uno por día). Habilitar = encenderlo en `/compras/kepler-escritura`, una vez que el
 *     secreto tenga la plantilla (`KEPLER_TLMK_TEMPLATE_FOLIO_NN`).
 *
 * ── Lo medido antes (sólo lectura, prod, sid 7688376744939610156, 2026-11-03) ──────────────
 *  · 0 cotizaciones aceptadas; 59 vivas, 45 con cliente del ERP.
 *  · `kepler_push_switch`: 18 renglones (compra encendida 00–08, traspaso apagado); CHECK
 *    `tipo IN ('compra','traspaso')`.
 *  · Ensayo contra Kepler real (01 y 06, ROLLBACK): el adaptador reproduce los importes de un
 *    pedido TELEMARK real al centavo.
 *
 * ⚠️ Sólo DDL aditivo + INSERT de 9 renglones apagados. Aplicar con `apply-one-migration-prod.js`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const COLUMNAS = [
  ['kepler_sucursal', (t) => t.string('kepler_sucursal', 2)],
  ['kepler_folio', (t) => t.string('kepler_folio', 10)],
  ['kepler_sent_at', (t) => t.timestamp('kepler_sent_at', { useTz: true })],
  ['kepler_sent_by', (t) => t.uuid('kepler_sent_by')],
  ['kepler_error', (t) => t.text('kepler_error')],
  ['kepler_sending_at', (t) => t.timestamp('kepler_sending_at', { useTz: true })],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [col, add] of COLUMNAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('quotes', col))) {
      await knex.schema.withSchema('commercial').alterTable('quotes', (t) => add(t));
    }
  }

  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN ('compra','traspaso','telemarketing'))`);

  // Con FORCE RLS, el insert necesita el tenant en la sesión. ON CONFLICT DO NOTHING: re-correr
  // no pisa lo que alguien ya encendió desde la pantalla.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: 'telemarketing', encendida: false, tope_dia: 1,
      nota: 'COT.7: pedido TELEMARK desde la cotización; nace apagado, tope 1 (canario)',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE encendida)::int AS encendidas
       FROM commercial.kepler_push_switch WHERE tipo = 'telemarketing'`);
  console.log(`[cot7_quotes_pedido_tlmk_kepler] interruptor telemarketing: ${rows[0].n} renglones, ${rows[0].encendidas} encendidos`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: 'telemarketing' }).del();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN ('compra','traspaso'))`);
  for (const [col] of COLUMNAS) {
    if (await knex.schema.withSchema('commercial').hasColumn('quotes', col)) {
      await knex.schema.withSchema('commercial').alterTable('quotes', (t) => t.dropColumn(col));
    }
  }
};
