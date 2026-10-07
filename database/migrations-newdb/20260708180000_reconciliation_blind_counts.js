/**
 * SM.8 / P1 — Arqueo CIEGO (Supervisor de Movimientos).
 *
 * El hallazgo de SM.7: el 73% de los cortes cuadra exacto al centavo porque el
 * cajero ve el esperado y lo teclea (arqueo no ciego). Kepler no fuerza el conteo
 * a ciegas → lo forzamos en NUESTRA capa: el cajero/supervisor captura el conteo
 * físico por denominación ANTES de ver el esperado. Sellado con timestamp.
 * El motor compara el total ciego vs el efectivo esperado de Kepler → el descuadre
 * REAL, independiente del c25 contaminado.
 *
 * RLS forzado + grants app_runtime (convención A.0mt). Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS reconciliation`);
  if (await knex.schema.withSchema('reconciliation').hasTable('blind_counts')) return;
  await knex.raw(`
    CREATE TABLE reconciliation.blind_counts (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_code text NOT NULL,          -- sucursal
      caja           text NOT NULL,
      business_date  date NOT NULL,
      turno          text,
      cajero_code    text,                   -- cajero que cierra (para matchear al corte)
      denominations  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"1000":2,"500":3,"0.5":10,…}
      total_contado  numeric NOT NULL DEFAULT 0,          -- server-computed = Σ(denom×conteo)
      nota           text,
      photo_url      text,                   -- opcional (evidencia)
      captured_by    text,                   -- username que capturó (sella responsabilidad)
      captured_at    timestamptz NOT NULL DEFAULT now(),  -- timestamp ciego (antes de ver el esperado)
      created_at     timestamptz NOT NULL DEFAULT now()
    )`);
  // Un arqueo ciego por caja/día/cajero (idempotente). Re-captura = UPDATE.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_blind_count ON reconciliation.blind_counts (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_blind_count_date ON reconciliation.blind_counts (tenant_id, business_date DESC)`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE reconciliation.blind_counts FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='reconciliation' AND tablename='blind_counts' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON reconciliation.blind_counts
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation.blind_counts TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('reconciliation').dropTableIfExists('blind_counts');
};
