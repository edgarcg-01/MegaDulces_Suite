'use strict';
/**
 * `[CGP-VEC.2]` — **`cobro_vecinal` entra al vocabulario de `origen_tipo`.**
 *
 * El cierre de ruta vecinal **no es un `cobro`**, y eso no es una sutileza de nombres: `create()`
 * trata a `cobro` como **anclado a un documento de Kepler** (`ORIGEN_ANCLADO`) y rechaza con frase
 * cualquier `origen_ref` que la bandeja no resuelva — *«No se registra efectivo contra un documento
 * que el ERP no tiene»*. Esa regla está bien y se conserva: protege de capturar efectivo contra un
 * documento inexistente.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-15/16) ─────────────────────────────────────
 *  · El cobro de ruta vecinal **no tiene documento de caja en Kepler**: de 270 ruta-día desde el
 *    1-sep, sólo **8 (3.0 %)** tienen un depósito cuyo importe calce — y el **placebo dio 3.1 %**,
 *    así que ese cruce no identifica nada. Para Morelia Abastos (2V005) no hay **ningún** cobro.
 *  · Lo que sí existe es la venta (`kepler_ods.kdm1`, doctype `U-D-10`) **ya arbitrada contra el
 *    arqueo** en `analytics.v_vecinal_conciliacion`: para el 7-oct de la 2V005, vecinal $6,244.48 =
 *    arqueo = contado, diferencia **$0.00**.
 *  · Desde el 12-oct hay **19 cierres vecinales sin un solo movimiento en el libro**.
 *
 * ⇒ Es un origen con **árbitro propio**, distinto del documento de Kepler. Por eso lleva su propio
 * valor en vez de disfrazarse de `manual` (que diría que alguien lo inventó, y es falso) o de
 * `cobro` (que promete un documento que no existe).
 *
 * ⚠️ **Aditiva y sin reescribir filas**: sólo amplía el CHECK. Ninguna fila existente cambia de
 * valor, así que no hay nada que migrar hacia atrás salvo el propio CHECK.
 *
 * ⛔ **Aplicar en prod ANTES de soltar el código que usa el valor nuevo** (`apply-one-migration-prod.js`,
 * nunca `migrate:latest`): si el código sale primero, cada captura de cierre vecinal muere con
 * `23514`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CONSTRAINT = 'cash_ledger_origen_chk';
// ⛔ `[CGP-VEC.2.1]` Esta lista es la UNION de lo que el CHECK vivo ya aceptaba MAS el valor
//    nuevo -- no una lista escrita de memoria. Faltaban `caos`, `gasto` y `orden_entrada`, asi
//    que esta migracion, que se describe como "aditiva: solo amplia el CHECK", en realidad lo
//    ESTRECHABA. Al aplicarla a prod el 2026-10-16 fallo con 23514 ("is violated by some row"):
//    `caos` tiene 34 filas vivas. La transaccion revirtio y el CHECK viejo quedo intacto.
// ⚠️ Y su propia autocomprobacion no lo habria visto: verifica que `cobro_vecinal` ESTE, no que
//    no falte nada. Ampliar un CHECK por enumeracion exige leer el que hay, no recordarlo.
const VALORES = ['cfdi', 'recepcion', 'pago_proveedor', 'cobro', 'banco', 'manual', 'caos', 'gasto', 'orden_entrada', 'cobro_vecinal'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const lista = VALORES.map((v) => `'${v}'`).join(',');
  // Soltar y recrear es la única forma de ampliar un CHECK. La tabla es chica (decenas de filas) y
  // la validación es inmediata; aun así va con `lock_timeout` para no sostener el candado si algo
  // más está escribiendo.
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT ${CONSTRAINT}
      CHECK (origen_tipo IS NULL OR origen_tipo IN (${lista}))`);

  // Comprueba su propio efecto: una migración de esquema que no verifica lo que hizo es un ALTER
  // con esperanza (GOTCHAS §80.3).
  const ok = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ?`, [CONSTRAINT]);
  const def = ok.rows?.[0]?.def ?? '';
  if (!def.includes('cobro_vecinal')) {
    throw new Error(`[CGP-VEC.2] el CHECK ${CONSTRAINT} quedó sin 'cobro_vecinal': ${def || '(no existe)'}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  /**
   * ⚠️ Volver al CHECK viejo **falla** si ya existe alguna fila con `cobro_vecinal`: es lo
   * correcto. Un `down` que borrara esas filas para poder encogerse destruiría movimientos de
   * dinero; que reviente es el aviso de que primero hay que decidir qué pasa con ellos.
   */
  const previos = ['cfdi', 'recepcion', 'pago_proveedor', 'cobro', 'banco', 'manual'].map((v) => `'${v}'`).join(',');
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT ${CONSTRAINT}
      CHECK (origen_tipo IS NULL OR origen_tipo IN (${previos}))`);
};
