/**
 * LC.6 (Fase LC) — La marca de asociación contable del CFDI, y el índice para cruzarla.
 *
 * El sub-módulo "Movimientos no asociados" necesita responder una sola pregunta: de las
 * facturas que recibimos, **cuáles no están atadas a ninguna póliza**. Eso se contesta con
 * dos señales que hay que tener a mano, no derivar en caliente:
 *
 *   1. `fiscal.cfdis.aso_contabilidad` — el flag `Documento.IsAsoContabilidad` del ADD de
 *      ContPAQi. Es lo que el propio ContPAQi cree. El importer ya lo leía (solo para el
 *      log) y lo tiraba; ahora lo persiste.
 *
 *   2. El cruce contra `analytics.gl_poliza_lines.cfdi_uuid` — la **evidencia**, que viene
 *      de `AsocCFDIs` (ver [[reference_contpaqi_asoccfdis_join]]). El flag dice "sí/no";
 *      esta columna dice "en qué póliza". Sin índice de expresión el EXISTS sobre 478 mil
 *      patas no termina, así que el índice es parte del entregable, no una optimización.
 *
 * Las dos señales pueden discrepar y esa discrepancia es información: un CFDI contabilizado
 * por nuestro propio TXT queda SIN marca (nuestro layout no lleva UUID) y aun así su
 * importe ya está posteado. Por eso el criterio del sub-módulo mira las dos y no una.
 *
 * `aso_contabilidad` es NULL para lo que se cargó antes de esta migración: NULL significa
 * "no lo sabemos todavía", no "no asociado" — el carril del ADD lo va llenando.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('fiscal').hasColumn('cfdis', 'aso_contabilidad'))) {
    await knex.raw(`ALTER TABLE fiscal.cfdis ADD COLUMN aso_contabilidad boolean`);
    await knex.raw(`
      COMMENT ON COLUMN fiscal.cfdis.aso_contabilidad IS
        'Documento.IsAsoContabilidad del ADD de ContPAQi. NULL = aún no se sabe (cargado antes de LC.6). false = ContPAQi no lo tiene atado a ninguna póliza.'`);
  }

  // El barrido del sub-módulo: los no asociados de un mes, del más reciente al más viejo.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS cfdis_no_asociados_idx
      ON fiscal.cfdis (tenant_id, fecha DESC)
      WHERE rol = 'recibidas' AND tipo_comprobante = 'I' AND aso_contabilidad IS NOT TRUE`);

  // El cruce contra la evidencia. Expresión en upper() porque el UUID viene con casing
  // mezclado de ContPAQi y el join se normaliza en los dos lados.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS gl_poliza_lines_cfdi_uuid_idx
      ON analytics.gl_poliza_lines (tenant_id, upper(cfdi_uuid))
      WHERE cfdi_uuid IS NOT NULL`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.gl_poliza_lines_cfdi_uuid_idx`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.cfdis_no_asociados_idx`);
  if (await knex.schema.withSchema('fiscal').hasColumn('cfdis', 'aso_contabilidad')) {
    await knex.schema.withSchema('fiscal').alterTable('cfdis', (t) => t.dropColumn('aso_contabilidad'));
  }
};
