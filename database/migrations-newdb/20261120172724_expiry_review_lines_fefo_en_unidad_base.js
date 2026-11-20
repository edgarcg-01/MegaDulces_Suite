'use strict';
/**
 * `[P2.9 paso 4]` — Caducidades: FEFO se alimenta en la UNIDAD BASE del producto (D4 del PM, 2026-10-19:
 * «FEFO sólo cuando la unidad sea convertible»). Agrega tres columnas al renglón para que el número
 * declare con qué se calculó (ADR-056):
 *
 *  · `fefo_base_qty` — unidades BASE que se movieron del lote `NA` al lote fechado. Es lo que
 *    `unfeedLine` devuelve. `NULL` = renglón anterior al paso 4 (se movió `fefo_qty` tal cual).
 *  · `fefo_factor`   — unidades base por unidad capturada que se usó (la base vale 1; una caja de 24
 *    paquetes vale 24). Sale de `analytics.v_label_presentations` en la plaza del almacén.
 *  · `fefo_motivo`   — por qué el renglón NO fechó, o no fechó todo. `NULL` = fechó todo, o es anterior.
 *
 * `fefo_qty` NO cambia de significado: sigue en la unidad CAPTURADA (lo que leen la hoja, el expediente
 * y `estadoFefo`), ahora como `fefo_base_qty / fefo_factor`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ─────────────────────────────────────────
 *  · 156 renglones. **47 en una unidad con factor ≠ 1** (45 caja · 2 paquete): FEFO fechó **1,248**
 *    unidades tal cual; en la base del producto eran **24,365**.
 *  · 66 renglones «pieza» sobre productos que en Kepler no tienen pieza (base PAQ): se fecharon como
 *    si fueran paquetes. 1 «pieza» que sólo existe en la escalera (sin factor).
 *  · La existencia cuenta en la base: el costo unitario de Kepler (`kdik.c16`) es el de la base en 45
 *    de 46 productos (0.54–0.90 del precio de la base).
 *
 * No toca ninguna fila: los renglones viejos quedan como se fecharon (y se revierten con lo que movieron).
 * Columnas NULLABLE: ningún camino de inserción existente se rompe.
 *
 * Idempotente (`hasColumn` + CHECK por nombre con IF EXISTS).
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.expiry_review_lines';
const CHK = 'commercial_expiry_review_lines_fefo_motivo_chk';
// Espejo de FEFO_MOTIVOS en libs/contracts (caducidad-unidad). Agregar uno allá sin ampliar éste = 500 al guardar.
const MOTIVOS = [
  'sin_producto', 'sin_caducidad', 'sin_cantidad', 'sin_unidad',
  'sin_presentaciones', 'sin_lectura', 'unidad_fuera_del_producto', 'unidad_sin_factor',
  'sin_existencia_sin_fecha', 'existencia_sin_fecha_insuficiente',
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const has = (c) => knex.schema.withSchema('commercial').hasColumn('expiry_review_lines', c);
  if (!(await has('fefo_base_qty'))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN fefo_base_qty numeric(14,3)`);
  if (!(await has('fefo_factor'))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN fefo_factor numeric(14,4)`);
  if (!(await has('fefo_motivo'))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN fefo_motivo varchar(40)`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${CHK}`);
  await knex.raw(
    `ALTER TABLE ${T} ADD CONSTRAINT ${CHK} CHECK (fefo_motivo IS NULL OR fefo_motivo IN (${MOTIVOS.map((m) => `'${m}'`).join(', ')}))`,
  );
  await knex.raw(`COMMENT ON COLUMN ${T}.fefo_base_qty IS '[P2.9 paso 4] Unidades BASE del producto que se movieron del lote NA al lote fechado (lo que se devuelve al revertir). NULL = renglón anterior al paso 4: se movió fefo_qty tal cual.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.fefo_factor IS '[P2.9 paso 4] Unidades base por unidad capturada que se usó al fechar (la base = 1), de analytics.v_label_presentations en la plaza del almacén. NULL = no se convirtió.'`);
  await knex.raw(`COMMENT ON COLUMN ${T}.fefo_motivo IS '[P2.9 paso 4] Por qué el renglón no fechó, o no fechó todo (FEFO_MOTIVOS en libs/contracts). NULL = fechó todo, o es anterior al paso 4.'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: quita el CHECK y las tres columnas (sólo existen por esta migración).
 * ⚠️ Va JUNTO con revertir el código: el servicio viejo revierte `fefo_qty` tal cual, y en un renglón
 *    fechado con factor eso devolvería al lote `NA` menos de lo que se movió.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${CHK}`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS fefo_motivo`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS fefo_factor`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS fefo_base_qty`);
};
