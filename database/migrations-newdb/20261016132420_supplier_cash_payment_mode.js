'use strict';
/**
 * `[CGA-C.2]` — **Quién cobra en efectivo**: tres estados por proveedor sobre `catalog.suppliers`.
 *
 * Pedido de Edgar (2026-10-16): *"un sistema de configuración en interfaz que seleccionemos qué
 * proveedores se les paga con efectivo"*.
 *
 * ── Lo medido antes, contra prod (sólo lectura) ─────────────────────────────────────────────
 *
 * ⛔ **NINGÚN campo de Kepler declara esto, así que la pantalla CREA el dato, no lo refleja.**
 *  · `kdud` es el maestro de CLIENTES y **no tiene `c31`**. El de proveedores es `kepler_ods.kdxd`,
 *    y su `c31` es un campo de **email**: una sola fila no vacía en 6,507.
 *  · `kdxd.c35` (0/1/S) **no discrimina**: cruzado contra el pago real, el % en efectivo es
 *    prácticamente igual en sus cuatro estados.
 *  · `kdm1.c31` es 1:1 con el doctype (`Tra`/`Che`/`Ant`) y rotula `Tra` lo mismo a caja que a banco.
 *  · Lo único que declara el efectivo es la **cuenta de tesorería** `kdm1.c45` ⋈ `kdb1`, que es el
 *    HECHO. Se publica ya derivado en `analytics.erp_supplier_payments.medio_pago`.
 *
 * ⭐⭐ **POR QUÉ TRES ESTADOS Y NO UN BOOLEANO.** Medido sobre los pagos de 2026:
 *
 *       nunca   (0 % caja)   187 proveedores   $281,906,926.64
 *       siempre (100 % caja) 111 proveedores   $ 33,443,523.46
 *       mixto                 22 proveedores   $128,468,923.05  ← $23,908,142.47 en caja
 *
 *   Los **22 mixtos se llevan el 41.7 % de todo el efectivo** ($23.9 M de $57.35 M). Un
 *   `pays_cash boolean` obliga a mentir sobre ese 41.7 %: `true` promete efectivo donde el 86 %
 *   fue banco (`CG021`, 13.3 % en caja) y `false` esconde $17 M (`CB005`, 53.6 %).
 *
 * ⚠️ **El modo NO se deriva en esta migración, y es a propósito.** Es una DECLARACIÓN de la
 *    persona —a quién vamos a pagarle en efectivo— que arranca sembrada con el hecho pero puede
 *    diferir de él. Sembrar desde SQL aquí la volvería un dato derivado disfrazado de decisión.
 *    La siembra va en `[CGA-C.4]`, por la pantalla, con su autor y su fecha.
 *
 * ⚠️ **Y una trampa de la siembra, para C.4:** con tolerancia cero, `CB013` BOTANAS PAU
 *    ($2,587,209.71, **$9.09** fuera de caja) y `CA022` ABARROTES (**$2.00** fuera) caen en
 *    `mixto` aunque redondeen a 100.0 %. La tolerancia es una decisión declarada, no un detalle.
 *
 * Sigue el precedente exacto de `[RE.30]` en esta misma tabla (`credit_term_base` +
 * `credit_terms_updated_by/at`): columna de valor + motivo + quién y cuándo. No se crea tabla
 * nueva — `catalog.suppliers` (1,331 filas, 29 columnas) ya es el tablero de configuración por
 * proveedor y se extiende SIEMPRE de forma aditiva.
 *
 * Idempotente (`hasColumn` antes de cada `ADD COLUMN`).
 *
 * @param { import("knex").Knex } knex
 */

const COLS = [
  ['cash_payment_mode', 'text',
    'CGA-C.2 — a este proveedor se le paga en efectivo: siempre | mixto | nunca. DECLARADO por una persona (se siembra con el hecho de analytics.erp_supplier_payments.medio_pago, pero puede diferir). NULL = nadie lo ha declarado todavía, que no es lo mismo que "nunca".'],
  ['cash_payment_reason', 'text',
    'CGA-C.2 — por qué se declaró así. Obligatorio en la pantalla cuando el modo difiere del hecho medido.'],
  ['cash_payment_updated_by', 'text',
    'CGA-C.2 — username de quien lo declaró (mismo tipo que credit_terms_updated_by).'],
  ['cash_payment_updated_at', 'timestamptz',
    'CGA-C.2 — cuándo se declaró.'],
];

const CHK = 'suppliers_cash_payment_mode_chk';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [col, ddl, comment] of COLS) {
    if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', col))) {
      await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN ${col} ${ddl}`);
    }
    // ⛔ GOTCHAS §51: `COMMENT ON` toma un LITERAL, no un bind param — con `?` revienta con
    // `syntax error at or near "$1"` a mitad de la migración, con el ADD COLUMN ya corrido.
    await knex.raw(`COMMENT ON COLUMN catalog.suppliers.${col} IS '${comment.replace(/'/g, "''")}'`);
  }

  /**
   * El CHECK deja pasar `NULL` a propósito: **«nadie lo declaró» no es «nunca»** (ADR-056). Las
   * 1,331 filas existentes quedan en NULL y la pantalla las distingue de las declaradas.
   *
   * ⚠️ `NOT VALID` + `VALIDATE` en dos pasos: sobre una tabla con tráfico, un CHECK normal toma
   * `ACCESS EXCLUSIVE` mientras escanea. Acá son 1,331 filas y daría igual, pero el patrón es el
   * que hay que copiar cuando la tabla sea grande — y con `lock_timeout` arriba, si algo la
   * tiene tomada esto falla en 5 s en vez de encolar a todo el mundo detrás (GOTCHAS §38).
   */
  const existe = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'catalog.suppliers'::regclass`, [CHK]);
  if (!existe.rows.length) {
    await knex.raw(`ALTER TABLE catalog.suppliers ADD CONSTRAINT ${CHK}
      CHECK (cash_payment_mode IS NULL OR cash_payment_mode IN ('siempre','mixto','nunca')) NOT VALID`);
    await knex.raw(`ALTER TABLE catalog.suppliers VALIDATE CONSTRAINT ${CHK}`);
  }

  /**
   * Índice parcial: la pantalla pregunta «quiénes están declarados» sobre 1,331 filas de las que
   * hoy **cero** lo están. Un índice completo sería casi todo NULL.
   */
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_suppliers_cash_payment_mode
    ON catalog.suppliers (tenant_id, cash_payment_mode)
    WHERE cash_payment_mode IS NOT NULL AND deleted_at IS NULL`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS catalog.ix_suppliers_cash_payment_mode`);
  await knex.raw(`ALTER TABLE catalog.suppliers DROP CONSTRAINT IF EXISTS ${CHK}`);
  for (const [col] of COLS) {
    if (await knex.schema.withSchema('catalog').hasColumn('suppliers', col)) {
      await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN ${col}`);
    }
  }
};
