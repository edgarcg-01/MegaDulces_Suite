/**
 * MAT.1 — Asignación CFDI ↔ operación (documento Kepler), confirmada por humano.
 *
 * Kepler NO guarda el UUID fiscal (verificado), así que el enlace entre un CFDI
 * (fiscal.cfdis) y la operación que lo respalda (analytics.expense_documents,
 * ancla = factura de compra XA2001) es HEURÍSTICO (RFC + importe ± $1 + fecha ± 5d)
 * y debe CONFIRMARLO una persona. Esta tabla persiste esa decisión: es la evidencia
 * dura de materialidad (MAT.3 arma el veredicto con las asignaciones confirmadas).
 *
 * Motor sugiere / humano confirma (ADR-016): el LLM no interviene. `status`:
 *   confirmed = enlace validado (evidencia)   ·   rejected = sugerencia descartada
 *   (para que no vuelva a proponerse).
 *
 * RLS forzado, tenant-scoped (igual que fiscal.cfdis). Idempotente.
 * `analytics.*` no tiene RLS → el lado operación se guarda desnormalizado
 * (sucursal, doc_tipo, doc_folio) + snapshots de importe/fecha para audit.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('cfdi_assignments'))) {
    await knex.raw(`
      CREATE TABLE fiscal.cfdi_assignments (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        cfdi_id            uuid NOT NULL,          -- fiscal.cfdis.id
        cfdi_uuid          varchar(36),           -- denormalizado (audit / deep-link)
        rfc                varchar(13),           -- emisor del CFDI = proveedor (query por expediente)
        sucursal           text NOT NULL,         -- lado operación: documento Kepler…
        doc_tipo           text NOT NULL DEFAULT 'XA2001',
        doc_folio          text NOT NULL,
        importe_cfdi       numeric(18,6),         -- snapshots de calidad del match…
        importe_operacion  numeric(18,6),
        diff_importe       numeric(18,6),
        diff_days          int,
        status             text NOT NULL DEFAULT 'confirmed',      -- confirmed|rejected
        match_source       text NOT NULL DEFAULT 'importe_fecha',  -- importe_fecha|manual
        note               text,
        created_by         uuid,
        created_by_username text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await knex.raw(`ALTER TABLE fiscal.cfdi_assignments ADD CONSTRAINT fiscal_cfdi_assign_status_check CHECK (status IN ('confirmed','rejected'))`);
    // Un CFDI se confirma a lo sumo a UNA operación (rechazos no cuentan → parcial).
    await knex.raw(`CREATE UNIQUE INDEX ux_fiscal_cfdi_assign_confirmed ON fiscal.cfdi_assignments (tenant_id, cfdi_id) WHERE status = 'confirmed'`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdi_assign_rfc ON fiscal.cfdi_assignments (tenant_id, rfc)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdi_assign_op ON fiscal.cfdi_assignments (tenant_id, sucursal, doc_tipo, doc_folio)`);
    await knex.raw(`ALTER TABLE fiscal.cfdi_assignments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.cfdi_assignments FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.cfdi_assignments
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.cfdi_assignments TO app_runtime`);
  }

  // Permiso de gestión de materialidad (confirmar/descartar asignaciones). Se ancla
  // a quien ya ve el expediente; customer_b2b nunca. Backfill idempotente.
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('FISCAL_MATERIALIDAD_GESTIONAR',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'FISCAL_MATERIALIDAD_VER')::boolean, false) END)
      WHERE permissions -> 'FISCAL_MATERIALIDAD_GESTIONAR' IS NULL`,
  );
  console.log(`[fiscal_cfdi_assignments] up FISCAL_MATERIALIDAD_GESTIONAR: filas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_MATERIALIDAD_GESTIONAR' WHERE permissions -> 'FISCAL_MATERIALIDAD_GESTIONAR' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('cfdi_assignments');
};
