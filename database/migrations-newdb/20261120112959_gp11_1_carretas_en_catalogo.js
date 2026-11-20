'use strict';
/**
 * `[GP.11.1]` — Carretas y carritos entran al catálogo de ubicaciones (`commercial.warehouse_bins`), que
 * ya tiene la familia `carreta` desde UB.1 (FASE_UB D8: misma tabla, otra familia, código `C01`–`C99`).
 * Lo que faltaba es distinguir **carreta** (madera, para cajas) de **carrito** (tipo súper, para piezas
 * y paquetes) — D6 de FASE_GP — y que la base exija la forma de su código.
 *
 * No se crea otra tabla (regla 2): se extiende el CHECK de `tipo` con `carreta` y `carrito`, y se agregan
 * dos reglas:
 *  · `ck_wh_bins_carreta`: una fila de familia `carreta` tiene código `C01`–`C99`, tipo `carreta` o
 *    `carrito`, y ninguna de las partes de ubicación (zona, pasillo, rack, nivel).
 *  · `ck_wh_bins_tipo_familia`: el tipo `carreta`/`carrito` es exclusivo de esa familia (una ubicación
 *    `BA053` no puede quedar como «carrito»).
 * ⚠️ Escritas con `coalesce(…, false)`: un `tipo` NULL haría NULL la condición y un CHECK en NULL PASA.
 *
 * Carretas y carritos comparten numeración (`C01`–`C99`) porque Kepler guarda la carreta en UNA columna
 * (`kdm2.c59`): la carreta 12 y el carrito 12 serían el mismo valor.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ────────────────────────────────────────
 *  · `warehouse_bins`: 383 de familia `ubicacion` y 1 `legado`; **0 carretas**.
 *  · Ninguna fila tiene un tipo fuera del CHECK actual, así que las reglas nuevas validan sin tocar datos.
 *  · Kepler `kdm2.c59` (la carreta): vacío o relleno con el número de la etapa; ninguna numeración real
 *    que haya que respetar (ERP_KEPLER §3.y).
 *
 * Compatible con la API desplegada: hoy sólo inserta familia `ubicacion` con un tipo del CHECK viejo.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.warehouse_bins';
const CART_RE = '^C(0[1-9]|[1-9][0-9])$';

const TIPO_VIEJO = `tipo IS NULL OR tipo IN ('surtido','reserva','tienda_piso','tienda_cabecera','recepcion','cuarentena','merma')`;
const TIPO_NUEVO = `tipo IS NULL OR tipo IN ('surtido','reserva','tienda_piso','tienda_cabecera','recepcion','cuarentena','merma','carreta','carrito')`;

const NUEVOS = {
  ck_wh_bins_carreta: `familia <> 'carreta' OR coalesce(
      code ~ '${CART_RE}' AND tipo IN ('carreta','carrito')
      AND zona IS NULL AND pasillo IS NULL AND rack IS NULL AND nivel IS NULL, false)`,
  ck_wh_bins_tipo_familia: `(familia = 'carreta') = coalesce(tipo IN ('carreta','carrito'), false)`,
};

async function definicion(knex, nombre) {
  const r = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?`,
    [T, nombre],
  );
  return r.rows[0]?.def ?? null;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // El CHECK de tipo se reemplaza sólo si todavía no acepta carreta/carrito.
  const tipo = await definicion(knex, 'ck_wh_bins_tipo');
  if (!tipo || !tipo.includes("'carrito'")) {
    await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ck_wh_bins_tipo`);
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ck_wh_bins_tipo CHECK (${TIPO_NUEVO})`);
  }
  for (const [nombre, expr] of Object.entries(NUEVOS)) {
    if (!(await definicion(knex, nombre))) await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
  }
  await knex.raw(`COMMENT ON CONSTRAINT ck_wh_bins_carreta ON ${T} IS
    '[GP.11.1] Carreta o carrito: código C01-C99, tipo carreta|carrito, sin zona/pasillo/rack/nivel. Comparten numeración: Kepler guarda la carreta en una sola columna (kdm2.c59).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Falla (a propósito) si ya hay carretas dadas de alta. */
exports.down = async function down(knex) {
  for (const nombre of Object.keys(NUEVOS)) await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ${nombre}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS ck_wh_bins_tipo`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT ck_wh_bins_tipo CHECK (${TIPO_VIEJO})`);
};
