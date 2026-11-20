'use strict';
/**
 * `[PGP.122.6]` — **«Cancela sol gasto» desde la Suite, también para la solicitud que se capturó en Kepler.**
 * Pedido de Edgar (2026-11-19): «todos los procesos de gastos se deben poder hacer aquí», con el menú de Kepler
 * (Alta / Consulta / Cancela sol gasto · Autorización · Alta / Consulta / Cancela gasto CFDI). La F3 sólo cancelaba
 * la solicitud que escribió la Suite (por su marca). Nada de esto escribe en Kepler.
 *
 *  1. **La bitácora de cancelaciones en Kepler se EXTIENDE, no se copia** (regla 2; como hizo `[KR.7]`):
 *     `commercial.purchase_order_cancellations` admite `document_type = 'solicitud_gasto'` con su folio en
 *     `solicitud_folio` y, si la solicitud tiene vale en la Suite, el vale en `proof_id` (sin FK: el servicio sólo
 *     escribe el id que acaba de leer, y `expense_proofs` es de las tablas más usadas de Finanzas). Un índice único
 *     hace que una solicitud se cancele UNA vez desde la Suite. Ahí queda quién, el motivo y la foto de Kepler
 *     antes de cancelar (`kepler_original`), también para la solicitud que NO tiene vale.
 *  2. **El interruptor** `commercial.kepler_push_switch` admite `cancela_solicitud_gasto`, sembrado **apagado** en
 *     las nueve sucursales con tope de **1 por día** (canario). Aparte de `solicitud_gasto`: cancelar un documento
 *     que capturó una persona en Kepler es otro riesgo que escribir los de la Suite.
 *  Sin llave nueva: cancela quien COMPRUEBA (`FINANCE_EXPENSES_COMPROBAR`), igual que la F3.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-19) ──
 *  · `kepler_push_switch_tipo_ck` = cancela_oc, cancela_requisicion, cliente, compra, comprobacion_gasto,
 *    solicitud_gasto, telemarketing, traspaso.
 *  · `purchase_order_cancellations_doc_ck` = oc | requisicion; la tabla tiene 1 renglón (una OC de la 08).
 *  · Cómo cancela Kepler una X-A-15: las 156 canceladas desde el 1-oct (anexo §17, F3), todas capturadas en
 *    Kepler: `c43` C, IVA/total/saldo en 0, renglones conservados, `c67`–`c69` quién y cuándo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp122_cancelar_solicitud_kepler]';
const TABLA = 'purchase_order_cancellations';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'cancela_solicitud_gasto';
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

const DOC_CK_CON = `CHECK (document_type IN ('oc','requisicion','solicitud_gasto')
                           AND (document_type = 'oc') = (oc_folio IS NOT NULL)
                           AND (document_type <> 'requisicion' OR (requisicion_folio IS NOT NULL AND requisition_id IS NOT NULL))
                           AND (document_type = 'solicitud_gasto') = (solicitud_folio IS NOT NULL))`;
const DOC_CK_SIN = `CHECK (document_type IN ('oc','requisicion')
                           AND (document_type = 'oc') = (oc_folio IS NOT NULL)
                           AND (document_type = 'oc' OR (requisicion_folio IS NOT NULL AND requisition_id IS NOT NULL)))`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La bitácora de KR.7, extendida ─────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'document_type'))) {
    throw new Error(`${TAG} falta commercial.${TABLA}.document_type: aplica antes 20261114120335 (KR.7)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'solicitud_folio'))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN solicitud_folio text`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'proof_id'))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN proof_id uuid`);
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_doc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_doc_ck ${DOC_CK_CON}`);
  // Una solicitud se cancela UNA vez desde la Suite (los de OC y requisición no la cubren).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_solicitud_una_vez
                    ON commercial.${TABLA} (tenant_id, sucursal, solicitud_folio)
                    WHERE document_type = 'solicitud_gasto' AND estado = 'cancelada' AND deleted_at IS NULL`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────
  // La lista se DERIVA de lo vivo (lección de KR.7: una constante vieja choca con los tipos que otros agregaron).
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  const { rows: tiposHoy } = await knex.raw(`SELECT DISTINCT tipo FROM commercial.kepler_push_switch`);
  const TIPOS = [...new Set([...tiposHoy.map((r) => r.tipo), 'cancela_oc', 'cancela_requisicion', 'solicitud_gasto', TIPO])].sort();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(TIPOS)}))`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: 1,
      nota: '[PGP.122.6] Cancela sol gasto desde la Suite (también las capturadas en Kepler): apagada hasta su ensayo en esa sucursal; canario de 1 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  console.log(`  ${TAG} interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Las columnas se conservan si ya hay cancelaciones de solicitud (regla 5). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  const { rows: quedan } = await knex.raw(`SELECT DISTINCT tipo FROM commercial.kepler_push_switch`);
  const TIPOS = [...new Set([...quedan.map((r) => r.tipo), 'cancela_oc', 'cancela_requisicion', 'solicitud_gasto'])].filter((t) => t !== TIPO).sort();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(TIPOS)}))`);
  const { rows: [n] } = await knex.raw(`SELECT count(*) FILTER (WHERE document_type = 'solicitud_gasto')::int n FROM commercial.${TABLA}`);
  if (n.n > 0) { console.log(`  ${TAG} ${TABLA} tiene ${n.n} cancelación(es) de solicitud: se conservan sus columnas`); return; }
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_${TABLA}_solicitud_una_vez`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_doc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_doc_ck ${DOC_CK_SIN}`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS proof_id`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS solicitud_folio`);
};
