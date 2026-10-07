/**
 * FD.0 — Diagnóstico de facturación: captura de errores de emisión.
 *
 * Hoy los fallos del PAC (timbrado/nota de crédito/REP/cancelación) se lanzan como
 * excepción HTTP y NO se persisten (salvo commercial.orders.cfdi_error en el auto-
 * timbrado). Esta tabla es el almacén canónico de esos fallos: UPSERT idempotente
 * por (tenant, dedup_key), se resuelve solo cuando un intento posterior tiene éxito.
 * La lee el tablero de Diagnóstico (FD.2/FD.4), que la cruza con la base de
 * conocimiento SAT/PAC para proponer la solución.
 *
 * Además corrige el bug FE.10: el CHECK de fiscal.cfdis.estatus_sat NO permitía
 * 'en_proceso_cancelacion' (que emision.service.ts YA escribe) → la cancelación con
 * aceptación del receptor reventaba con violación de CHECK. Se amplía el dominio.
 *
 * @param { import("knex").Knex } knex
 */
async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE fiscal.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE fiscal.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='fiscal' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON fiscal.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  // ── 1) Fix bug FE.10: ampliar el CHECK de estatus_sat ──────────────────────
  if (await knex.schema.withSchema('fiscal').hasTable('cfdis')) {
    await knex.raw(`ALTER TABLE fiscal.cfdis DROP CONSTRAINT IF EXISTS fiscal_cfdis_estatus_check`);
    await knex.raw(`ALTER TABLE fiscal.cfdis ADD CONSTRAINT fiscal_cfdis_estatus_check
      CHECK (estatus_sat IN ('vigente','cancelado','desconocido','en_proceso_cancelacion','rechazado'))`);
  }

  // ── 2) Almacén de errores de emisión (self-resolving) ──────────────────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('emission_errors'))) {
    await knex.raw(`
      CREATE TABLE fiscal.emission_errors (
        id              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        kind            varchar(16) NOT NULL CHECK (kind IN ('timbrado','nota_credito','rep','cancelacion')),
        dedup_key       text NOT NULL,
        status          varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
        order_id        uuid,
        cfdi_uuid       varchar(36),
        receptor_rfc    varchar(13),
        receptor_nombre text,
        serie           text,
        folio           text,
        total           numeric(18,6),
        num_parcialidad int,
        http_status     int,
        pac_provider    text,
        pac_code        text,            -- código SAT/PAC extraído (CFDI40102, 301, 302…)
        error_message   text,            -- mensaje del PAC (resumen)
        error_detail    text,            -- messageDetail si el PAC lo devuelve
        pac_raw         jsonb,           -- sobre completo del PAC (para el técnico)
        attempts        int NOT NULL DEFAULT 1,
        first_seen_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now(),
        resolved_at     timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, dedup_key)
      )`);
    await knex.raw(`CREATE INDEX ix_fiscal_emission_errors_open ON fiscal.emission_errors (tenant_id, status, last_seen_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fiscal_emission_errors_kind ON fiscal.emission_errors (tenant_id, kind, status)`);
    await knex.raw(`COMMENT ON TABLE fiscal.emission_errors IS 'FD.0 — errores de emisión CFDI (timbrado/NC/REP/cancelación). UPSERT por (tenant, dedup_key); se resuelve solo al tener éxito un intento posterior.'`);
    await createTenantRls(knex, 'emission_errors');
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.withSchema('fiscal').dropTableIfExists('emission_errors');
  // El CHECK ampliado de estatus_sat NO se revierte: revertirlo rompería filas ya
  // marcadas 'en_proceso_cancelacion'/'rechazado'. El dominio ampliado es correcto.
};
