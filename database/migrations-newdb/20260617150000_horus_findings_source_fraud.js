/**
 * Horus — H2.4: habilita source='fraud' en commercial.supervisor_findings.
 *
 * El detector de fraude (FraudEngineService) emite hallazgos deterministas de
 * INTEGRIDAD (GPS fuera de tienda, velocidad imposible, visita demasiado corta,
 * capturas solapadas, foto reciclada) con source='fraud'. El CHECK original solo
 * permitía engine|vision|embedding. Idempotente: DROP IF EXISTS + ADD.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_findings DROP CONSTRAINT IF EXISTS chk_supervisor_findings_source`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_source
      CHECK (source IN ('engine', 'vision', 'embedding', 'fraud'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_findings DROP CONSTRAINT IF EXISTS chk_supervisor_findings_source`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_source
      CHECK (source IN ('engine', 'vision', 'embedding'))
  `);
};
