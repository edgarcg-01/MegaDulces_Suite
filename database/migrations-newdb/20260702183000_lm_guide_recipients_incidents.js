/**
 * Fase LM.0 (M4) — incidencias tipificadas + firma en `logistics.guide_recipients`.
 *
 * `status` ya distingue pendiente/entregado/no_entregado/rechazado (estado plano).
 * LM agrega el DETALLE de la incidencia (§10 del SOP) y la firma del cliente (§9):
 *
 *   - incident_type: not_located | wrong_address | customer_rejected |
 *                    missing_product | other  (patrón 6-outcomes de call_logs).
 *   - incident_notes: motivo/observación (obligatorio en rechazo, a nivel servicio).
 *   - attempted_at: hora del intento (protocolo "llamé + esperé 10 min").
 *   - delivered_signature_url: firma del cliente (canvas → Cloudinary), evidencia POD.
 *
 * Idempotente (hasColumn + DROP CONSTRAINT IF EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('logistics').hasColumn('guide_recipients', col))) {
      await knex.raw(`ALTER TABLE logistics.guide_recipients ADD COLUMN ${ddl}`);
    }
  };

  await add('incident_type', 'incident_type VARCHAR(30)');
  await add('incident_notes', 'incident_notes TEXT');
  await add('attempted_at', 'attempted_at TIMESTAMP');
  await add('delivered_signature_url', 'delivered_signature_url TEXT');

  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP CONSTRAINT IF EXISTS logistics_guide_recipients_incident_type_check`);
  await knex.raw(`
    ALTER TABLE logistics.guide_recipients
      ADD CONSTRAINT logistics_guide_recipients_incident_type_check
      CHECK (incident_type IS NULL OR incident_type IN
        ('not_located', 'wrong_address', 'customer_rejected', 'missing_product', 'other'))
  `);

  await knex.raw(`
    COMMENT ON COLUMN logistics.guide_recipients.delivered_signature_url IS
      'Fase LM: firma del cliente (POD). Obligatoria salvo excepción justificada en incident_notes.'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP CONSTRAINT IF EXISTS logistics_guide_recipients_incident_type_check`);
  for (const col of ['delivered_signature_url', 'attempted_at', 'incident_notes', 'incident_type']) {
    await knex.raw(`ALTER TABLE logistics.guide_recipients DROP COLUMN IF EXISTS ${col}`);
  }
};
