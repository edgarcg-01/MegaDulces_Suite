'use strict';
/**
 * `[RA-DYN.U7]` — **El umbral de muestra del fill rate del ERP, medido en vez de elegido.**
 *
 * `[RA-DYN.U5/U6]` dejó `analytics.mv_supplier_fill_rate` en prod: 86,833 renglones de la cadena
 * `X-A-35` → `X-A-37`, 329 proveedores. Era la herramienta de negociación. Esta migración abre la
 * puerta para que además **entre al motor de pedido**, y lo único que agrega es el umbral.
 *
 * ── Por qué un umbral propio, y por qué 25 ───────────────────────────────────────────────────
 * `replenishment_settings` ya traía `fill_min_lines = 3`, pensado para la evidencia app-nativa
 * (nuestras OCs y el reclamo del andén). Aplicarlo tal cual al ERP habría cableado ruido. Medido
 * contra prod el 2026-10-02, partiendo la historia de cada proveedor en dos mitades cronológicas
 * y preguntando si la primera mitad predice la segunda:
 *
 *     renglones    proveedores   correlación   error medio
 *     6 a 14            40         -0.026         0.026
 *     15 a 24           30         -0.052         0.041
 *     25 a 99           90          0.607         0.053
 *     100 o más        100          0.341         0.038
 *
 * ⭐ **Debajo de 25 renglones el fill rate no predice NADA** — la correlación es cero, y las dos
 * veces que se aparta lo hace hacia el lado negativo. Arriba de 25 aparece la señal. El corte no
 * se eligió por redondo: es donde la medición cambia de régimen.
 *
 * ⚠️ **Y el dinero NO es el argumento.** Entre umbral 3 y umbral 50 el sugerido se mueve de
 * $367,126 a $361,726 — 1.5%. O sea: bajar el umbral casi no agrega pedido, sólo agrega ruido.
 * Si se hubiera decidido por el monto, cualquier corte parecía igual de bueno.
 *
 * ── El CHECK sólo deja moverlo hacia ARRIBA ──────────────────────────────────────────────────
 * `>= 25` a propósito. Un comprador puede querer ser más exigente (pedir 50 renglones antes de
 * creerle a un proveedor); nadie debería poder bajarlo a la zona donde ya se midió que no hay
 * señal. El knob existe para ser más conservador, no menos.
 *
 * ⛔ **No cambia ningún número por sí sola**: agrega una columna con default. El número lo mueve
 * el servicio cuando consume este umbral (ver el antes/después en `03_LOG_REVISIONES.md`).
 *
 * @param { import("knex").Knex } knex
 */

const TBL = 'commercial.replenishment_settings';
const COL = 'fill_min_lines_erp';

exports.up = async function up(knex) {
  const existeTabla = await knex.schema.withSchema('commercial').hasTable('replenishment_settings');
  if (!existeTabla) {
    // RA-PRO.27 todavía no corrió en este destino. Nada que extender; el servicio degrada a sus
    // defaults (incluido el 25) y no rompe.
    return;
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('replenishment_settings', COL))) {
    await knex.raw(`ALTER TABLE ${TBL} ADD COLUMN ${COL} integer NOT NULL DEFAULT 25`);
  }

  // El CHECK va aparte del ADD COLUMN para que la migración sea idempotente sobre un destino que
  // ya tenga la columna sin la restricción.
  const { rows: [chk] } = await knex.raw(`
    SELECT count(*)::int c FROM pg_constraint
     WHERE conrelid = '${TBL}'::regclass AND conname = 'chk_fill_min_lines_erp'`);
  if (!chk.c) {
    await knex.raw(
      `ALTER TABLE ${TBL} ADD CONSTRAINT chk_fill_min_lines_erp CHECK (${COL} >= 25)`);
  }

  await knex.raw(`
    COMMENT ON COLUMN ${TBL}.${COL} IS
      '[RA-DYN.U7] Renglones minimos de la cadena Kepler para que el fill rate de un proveedor '
      'entre al motor. Default 25: medido contra prod el 2026-10-02, debajo de 25 la correlacion '
      'entre la primera y la segunda mitad de la historia es CERO (-0.026 y -0.052); arriba salta '
      'a 0.607 / 0.341. El CHECK solo deja subirlo.'`);

  // ── Verificación dentro de la migración ──────────────────────────────────────────────────
  const { rows: [v] } = await knex.raw(
    `SELECT min(${COL})::int AS minimo, count(*)::int AS filas FROM ${TBL}`);
  if (v.filas && v.minimo < 25) {
    throw new Error(`[RA-DYN.U7] quedó una fila con ${COL}=${v.minimo}, por debajo del piso medido`);
  }

  // PRUEBA NEGATIVA: el CHECK tiene que RECHAZAR un valor de la zona sin señal. Un gate que nunca
  // se probó roto es una intención.
  //
  // ⚠️ El intento va dentro de un BEGIN/EXCEPTION de plpgsql, que abre una SUBtransacción: así el
  // UPDATE que viola se revierte solo y la transacción de la migración sigue viva. Lanzar el error
  // desde JS (o un RAISE suelto) dejaría la transacción abortada y las sentencias siguientes
  // morirían con 25P02 — la trampa que este repo ya documentó.
  if (!v.filas) {
    // Sin filas el UPDATE no toca nada y nunca violaría: no se puede probar la compuerta acá.
    console.warn('[RA-DYN.U7] NO MEDIDO — la tabla de settings está vacía, el CHECK no se pudo romper a propósito');
  } else {
    await knex.raw(`
      DO $$
      DECLARE frena boolean := false;
      BEGIN
        BEGIN
          UPDATE ${TBL} SET ${COL} = 3;
        EXCEPTION WHEN check_violation THEN
          frena := true;
        END;
        IF NOT frena THEN
          RAISE EXCEPTION '[RA-DYN.U7] el CHECK dejo pasar un umbral de 3: la compuerta no frena';
        END IF;
      END $$;`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('replenishment_settings'))) return;
  await knex.raw(`ALTER TABLE ${TBL} DROP CONSTRAINT IF EXISTS chk_fill_min_lines_erp`);
  if (await knex.schema.withSchema('commercial').hasColumn('replenishment_settings', COL)) {
    await knex.raw(`ALTER TABLE ${TBL} DROP COLUMN ${COL}`);
  }
};
