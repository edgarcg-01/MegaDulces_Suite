/**
 * FISCAL.4 — Descarga masiva de CFDI (WS SAT). Persistencia del pipeline
 * solicitud→verificación→paquete descrito en el doc SAT.
 *
 *   fiscal.download_requests  = una solicitud de descarga (rango + tipo + rol),
 *                               con su IdSolicitud del SAT y el estado (1-6 del doc).
 *   fiscal.download_packages  = los IdsPaquetes que devuelve la verificación cuando
 *                               la solicitud queda Terminada; su descarga/parseo.
 *
 * El pipeline se orquesta sobre fiscal.jobs (FISCAL.3). RLS forzado. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('download_requests'))) {
    await knex.raw(`
      CREATE TABLE fiscal.download_requests (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        rfc_solicitante    varchar(13) NOT NULL,
        tipo_solicitud     text NOT NULL DEFAULT 'CFDI',   -- CFDI | Metadata
        rol                text NOT NULL,                  -- emitidas | recibidas
        fecha_ini          date NOT NULL,
        fecha_fin          date NOT NULL,
        id_solicitud       text,                           -- IdSolicitud del SAT
        estado             text NOT NULL DEFAULT 'nueva',  -- nueva|solicitada|en_proceso|terminada|descargada|error|rechazada|vencida
        estado_solicitud   int,                            -- EstadoSolicitud SAT (1-6)
        codigo_estado      text,                           -- CodigoEstadoSolicitud (5000/5002/5003/5004/5005)
        numero_cfdis       int,
        mensaje_sat        text,
        packages_total     int NOT NULL DEFAULT 0,
        packages_done      int NOT NULL DEFAULT 0,
        requested_by       uuid,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await knex.raw(`ALTER TABLE fiscal.download_requests ADD CONSTRAINT fiscal_dlreq_tipo_check CHECK (tipo_solicitud IN ('CFDI','Metadata'))`);
    await knex.raw(`ALTER TABLE fiscal.download_requests ADD CONSTRAINT fiscal_dlreq_rol_check CHECK (rol IN ('emitidas','recibidas'))`);
    await knex.raw(`CREATE INDEX ix_fiscal_dlreq_estado ON fiscal.download_requests (tenant_id, estado)`);
    await knex.raw(`CREATE INDEX ix_fiscal_dlreq_idsol ON fiscal.download_requests (tenant_id, id_solicitud)`);
    await knex.raw(`ALTER TABLE fiscal.download_requests ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.download_requests FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.download_requests
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.download_requests TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('fiscal').hasTable('download_packages'))) {
    await knex.raw(`
      CREATE TABLE fiscal.download_packages (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        request_id    uuid NOT NULL,
        id_paquete    text NOT NULL,                 -- IdsPaquetes del SAT
        estado        text NOT NULL DEFAULT 'pendiente',  -- pendiente|descargado|parseado|error
        stored_ref    text,                          -- puntero al ZIP (R2/objeto), no el blob
        num_cfdis     int,
        last_error    text,
        downloaded_at timestamptz,
        parsed_at     timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, request_id, id_paquete),
        FOREIGN KEY (tenant_id, request_id) REFERENCES fiscal.download_requests (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`ALTER TABLE fiscal.download_packages ADD CONSTRAINT fiscal_dlpkg_estado_check CHECK (estado IN ('pendiente','descargado','parseado','error'))`);
    await knex.raw(`ALTER TABLE fiscal.download_packages ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.download_packages FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.download_packages
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.download_packages TO app_runtime`);
  }

  // Permisos descarga.
  const ANCHOR = { FISCAL_DESCARGA_VER: 'FINANCE_EXPENSES_VER', FISCAL_DESCARGA_GESTIONAR: 'FINANCE_FINDINGS_GESTIONAR' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_downloads] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of ['FISCAL_DESCARGA_VER', 'FISCAL_DESCARGA_GESTIONAR']) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`);
  }
  await knex.schema.withSchema('fiscal').dropTableIfExists('download_packages');
  await knex.schema.withSchema('fiscal').dropTableIfExists('download_requests');
};
