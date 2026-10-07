/**
 * Fase CXC.13 (ADR-048/016) — Compromisos de pago (promesas de cobro).
 *
 * Flujo de cobranza que Kepler NO tiene: el operador registra que el cliente se
 * compromete a pagar $X el DD/MM. El sistema rastrea cumplidas vs incumplidas
 * (el scanner marca incumplidas y las eleva a hallazgo). Tabla propia — NUNCA
 * escribe a Kepler. RLS forzado (patrón finance.collection_deposits).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  if (!(await knex.schema.withSchema('finance').hasTable('collection_promises'))) {
    await knex.raw(`
      CREATE TABLE finance.collection_promises (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        sucursal          text NOT NULL,
        cliente_code      text NOT NULL,
        cliente_nombre    text,                  -- snapshot al registrar
        monto_prometido   numeric NOT NULL DEFAULT 0,
        fecha_promesa     date NOT NULL,
        saldo_al_registrar numeric,              -- saldo del cliente cuando se pactó
        estado            text NOT NULL DEFAULT 'abierta'
                            CHECK (estado IN ('abierta','cumplida','incumplida','cancelada')),
        nota              text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        resolved_by       text,
        resolved_at       timestamptz,
        updated_at        timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_cp_cliente ON finance.collection_promises (tenant_id, sucursal, cliente_code)`);
    await knex.raw(`CREATE INDEX ix_fin_cp_estado ON finance.collection_promises (tenant_id, estado, fecha_promesa)`);
    await knex.raw(`ALTER TABLE finance.collection_promises ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.collection_promises FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='collection_promises' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.collection_promises
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.collection_promises TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('collection_promises');
};
