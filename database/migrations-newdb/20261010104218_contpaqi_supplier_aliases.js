'use strict';
/**
 * `[CP.8.36]` — **Dónde se guarda que «Hersheys Mexico» del banco es tal cuenta de ContPAQi.**
 *
 * ── Por qué hace falta una tabla y no alcanza con el padrón ──────────────────────────────────
 * `[CP.8.35]` resuelve **144 de 216** movimientos de `compra_mercancia` pareando el concepto del
 * banco contra el padrón de cuentas `2120*`. Los **72 que quedan son $6.8M** y no se resuelven
 * solos: el banco escribe `"Effem Mexico Inc y Compañia"` y ContPAQi tiene otra razón social.
 *
 * ⛔ **No se arregla con pareo difuso.** El resolvedor se niega a parear por subcadena a
 * propósito: un `HERSHEYS` que casara con `HERSHEYS DISTRIBUIDORA` cargaría a la cuenta
 * equivocada **y la póliza cuadraría igual**, así que nadie lo notaría hasta la balanza. Lo que
 * falta no es un algoritmo más listo: es **que una persona lo diga una vez**.
 *
 * ── El molde ────────────────────────────────────────────────────────────────────────────────
 * Se calca `finance.bank_classify_rules` (Fase CB), que ya resuelve exactamente esta forma —
 * texto de un estado de cuenta → un código, editable por humanos, con `active` y `note`.
 * ⚠️ **No** se calcan `commercial.product_aliases` ni `trade.catalog_aliases`: ésas mapean
 * **id → id** (una entidad absorbida por otra), que es otro problema.
 *
 * ── Lo que la tabla NO permite ──────────────────────────────────────────────────────────────
 *  · **Dos cuentas para el mismo alias.** `UNIQUE (tenant_id, alias_normalizado)` donde está
 *    activo: si el mismo texto pudiera ir a dos cuentas, el resolvedor tendría que elegir, y
 *    elegir es justo lo que no hace.
 *  · **Un alias sin autor.** `confirmado_por` es NOT NULL: esto no lo deriva un script, lo
 *    afirma una persona, y dentro de un año alguien va a querer saber quién.
 *  · **Una cuenta inventada.** CHECK de forma (10 dígitos) + el servicio valida contra
 *    `analytics.contpaqi_accounts` antes de aceptar.
 *
 * ⚠️ `alias_normalizado` lo escribe **el mismo `normalizarNombre()`** que usa el resolvedor. Dos
 * normalizaciones distintas sobre el mismo texto producen dos padrones distintos, y el alias
 * dejaría de encontrarse sin que nada falle.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const hay = await knex.schema.withSchema('contpaqi').hasTable('supplier_aliases');
  if (!hay) {
    await knex.schema.withSchema('contpaqi').createTable('supplier_aliases', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      /** El texto tal cual lo escribió el banco. Se guarda para poder auditar el alias. */
      t.text('concepto_banco').notNullable();
      /** El mismo texto pasado por `normalizarNombre()`. Es la llave de búsqueda. */
      t.text('alias_normalizado').notNullable();
      /** La cuenta de ContPAQi a la que carga. */
      t.text('cuenta').notNullable();
      t.text('cuenta_nombre');
      /** ⛔ NOT NULL: un alias sin autor no es una afirmación, es un dato huérfano. */
      t.text('confirmado_por').notNullable();
      t.text('nota');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS supplier_aliases_uno_por_texto
      ON contpaqi.supplier_aliases (tenant_id, alias_normalizado)
      WHERE active`);

  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE contpaqi.supplier_aliases
        ADD CONSTRAINT supplier_aliases_cuenta_forma_chk CHECK (cuenta ~ '^[0-9]{10}$');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE contpaqi.supplier_aliases
        ADD CONSTRAINT supplier_aliases_alias_no_vacio_chk
        CHECK (length(btrim(alias_normalizado)) >= 5);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  await knex.raw(`
    COMMENT ON TABLE contpaqi.supplier_aliases IS
    '[CP.8.36] Texto del estado de cuenta -> cuenta de proveedor de ContPAQi, confirmado por una PERSONA. '
    'Lo consulta el resolvedor ANTES del padron: un alias explicito le gana a la derivacion. '
    'Molde: finance.bank_classify_rules. El alias_normalizado lo escribe normalizarNombre() del resolvedor.'`);

  /**
   * ⛔ Freno de identidad: una migración que no encuentra su esquema termina en verde y deja al
   * código leyendo una tabla que no existe. Ya pasó en esta fase.
   */
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'contpaqi' AND table_name = 'supplier_aliases'`);
  if (!rows[0] || rows[0].n !== 1) {
    throw new Error('[CP.8.36] `contpaqi.supplier_aliases` no quedó creada.');
  }
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('contpaqi').dropTableIfExists('supplier_aliases');
};
