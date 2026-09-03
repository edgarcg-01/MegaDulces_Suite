/**
 * LC.15 (Fase LC, ADR-052) — `concepto` del MOVIMIENTO en `analytics.gl_poliza_lines`.
 *
 * El layout del TXT de ContPAQi **no tiene campo de UUID**. Es la causa raíz de las 5,521
 * patas de compras sin CFDI asociado: ContPAQi contabiliza la factura y nadie la liga.
 *
 * La vuelta que ya damos es meter el UUID en el `Concepto` del movimiento — 100 caracteres
 * que están vacíos en el 100% de las patas históricas, y `incluye_uuid` viene en `true` por
 * default. Pero **no lo podíamos leer de vuelta**: el importer traía `p.Concepto` (el de la
 * póliza) y nunca `m.Concepto` (el del movimiento), así que no había forma de verificar que
 * el UUID llegó, ni de usarlo como prueba.
 *
 * Con esta columna nace la cuarta puerta del anti-duplicado (`contpaqi_concepto`): exacta,
 * **desde ContPAQi mismo, sin depender de que nadie use el Asociador de CFDI**. Cubre todo
 * lo que entreguemos de aquí en adelante, que es justo donde el histórico del workbook ya
 * no llega.
 *
 * No es §32 (materializar una segunda forma de un dato que ya tiene tabla): es una columna
 * del ORIGEN que se estaba descartando. Precedente literal: `fiscal.cfdis.aso_contabilidad`
 * — el importer ya la leía para el log y la tiraba.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('gl_poliza_lines'))) return;
  if (!(await knex.schema.withSchema('analytics').hasColumn('gl_poliza_lines', 'concepto'))) {
    await knex.raw(`ALTER TABLE analytics.gl_poliza_lines ADD COLUMN concepto text`);
    await knex.raw(`
      COMMENT ON COLUMN analytics.gl_poliza_lines.concepto IS
        'MovimientosPoliza.Concepto (100 chars). Vacío en el 100% de las patas históricas; nosotros metemos ahí el UUID del CFDI porque el layout del TXT no tiene campo propio. Leerlo de vuelta es la cuarta puerta del anti-duplicado (LC.15).'`);
  }

  // Índice de expresión para buscar por UUID dentro del concepto sin escanear las 949 mil
  // patas. Parcial: sólo las que traen algo que parece UUID.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS gl_poliza_lines_concepto_uuid_idx
      ON analytics.gl_poliza_lines (tenant_id, upper(concepto))
      WHERE concepto IS NOT NULL AND length(concepto) = 36`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.gl_poliza_lines_concepto_uuid_idx`);
  if (await knex.schema.withSchema('analytics').hasColumn('gl_poliza_lines', 'concepto')) {
    await knex.raw(`ALTER TABLE analytics.gl_poliza_lines DROP COLUMN concepto`);
  }
};
