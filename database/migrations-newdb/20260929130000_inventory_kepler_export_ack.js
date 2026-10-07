'use strict';
/**
 * [IC.7] El ACUSE del archivo que va a Kepler — sin esto el ciclo no cierra.
 *
 * Decisión D1: el ajuste de nuestros conteos **no se escribe en Kepler** (ADR-040, no tocamos
 * el system of record). Se emite el archivo en su formato y alguien lo captura allá.
 *
 * ⛔ El problema de ese diseño es que **no deja rastro**. `keplerAdjustmentExport` genera el
 * archivo y ahí termina: nadie sabe si se capturó, quién, ni cuándo. Y mientras no se capture,
 * el ERP sigue con su saldo viejo y **el siguiente conteo vuelve a encontrar la misma
 * diferencia** — con lo cual alguien va otra vez al anaquel por algo ya resuelto.
 *
 * Esta tabla es la mitad que faltaba: el folio queda `exportado` cuando se genera el archivo y
 * `capturado` cuando una persona confirma que lo subió, **con su nombre y la hora**. Sin el
 * acuse, un conteo reconciliado de nuestro lado parece cerrado y no lo está.
 *
 * ⚠️ El acuse lo declara una PERSONA, no el sistema: no tenemos forma de comprobar contra
 * Kepler que el documento entró. Por eso `capturado_por` es obligatorio cuando hay captura —
 * un acuse anónimo no sirve para preguntarle a nadie.
 */

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('commercial').hasTable('inventory_kepler_exports');
  if (existe) return;

  await knex.schema.withSchema('commercial').createTable('inventory_kepler_exports', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('count_id').notNullable();
    t.text('estado').notNullable().defaultTo('exportado');
    t.integer('lineas').nullable();
    t.decimal('importe_neto', 18, 2).nullable();

    t.timestamp('exportado_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('exportado_por').nullable();

    // La mitad que cierra el ciclo.
    t.timestamp('capturado_at', { useTz: true }).nullable();
    t.uuid('capturado_por').nullable();
    t.text('kepler_folio').nullable();
    t.text('notas').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE commercial.inventory_kepler_exports
      ADD CONSTRAINT ck_ike_estado CHECK (estado IN ('exportado', 'capturado', 'descartado')),
      -- Un acuse ANÓNIMO no sirve: si nadie firma, no hay a quién preguntarle cuando el
      -- siguiente conteo vuelva a encontrar la misma diferencia.
      ADD CONSTRAINT ck_ike_captura_firmada CHECK (
        estado <> 'capturado' OR (capturado_at IS NOT NULL AND capturado_por IS NOT NULL))`);

  await knex.raw(`CREATE UNIQUE INDEX uq_ike_count
    ON commercial.inventory_kepler_exports (tenant_id, count_id)
    WHERE estado <> 'descartado'`);

  await knex.raw('ALTER TABLE commercial.inventory_kepler_exports ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.inventory_kepler_exports FORCE ROW LEVEL SECURITY');
  await knex.raw(`CREATE POLICY p_ike_tenant ON commercial.inventory_kepler_exports
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.inventory_kepler_exports TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.inventory_kepler_exports IS
    'IC.7 - Acuse del archivo de ajuste que va a Kepler. No escribimos al SoR (ADR-040): se emite el archivo y alguien lo captura alla, y sin este registro nadie sabe si se capturo. Mientras no se capture, el ERP sigue con su saldo viejo y el conteo siguiente vuelve a encontrar la MISMA diferencia -- o sea que alguien va otra vez al anaquel por algo ya resuelto. El acuse lo declara una PERSONA (no hay forma de comprobarlo contra Kepler) y por eso capturado_por es obligatorio: un acuse anonimo no deja a quien preguntarle.'`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_kepler_exports');
};
