/**
 * FISCAL.4.2 — Almacén de CFDI 4.0 (cabecera indexada + JSONB).
 *
 * Cada renglón = un comprobante timbrado (identificado por su UUID del
 * TimbreFiscalDigital). El XML crudo NO vive aquí: se guarda en object storage
 * (R2) a nivel paquete y `stored_ref` apunta al nombre de entry dentro del ZIP.
 * Alimenta la conciliación CFDI↔póliza↔REP (FISCAL.5), DIOT e IVA (FISCAL.8).
 *
 * RLS forzado, tenant-scoped. Idempotente (UNIQUE tenant+uuid). Nota: cuando el
 * volumen lo pida, particionar por `fecha` (rango mensual) — hoy tabla plana.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('cfdis'))) {
    await knex.raw(`
      CREATE TABLE fiscal.cfdis (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        uuid               varchar(36) NOT NULL,          -- folio fiscal (TimbreFiscalDigital/UUID)
        version            text,                          -- '4.0'
        tipo_comprobante   varchar(1),                    -- I|E|T|N|P
        serie              text,
        folio              text,
        fecha              timestamptz,                   -- fecha de emisión
        fecha_timbrado     timestamptz,
        emisor_rfc         varchar(13),
        emisor_nombre      text,
        emisor_regimen     text,
        receptor_rfc       varchar(13),
        receptor_nombre    text,
        receptor_uso_cfdi  text,
        receptor_regimen   text,
        receptor_domicilio text,
        subtotal           numeric(18,6),
        descuento          numeric(18,6),
        total              numeric(18,6),
        moneda             text,
        tipo_cambio        numeric(18,6),
        metodo_pago        text,                          -- PUE|PPD
        forma_pago         text,                          -- 01|03|99...
        lugar_expedicion   text,
        no_certificado     text,
        no_certificado_sat text,
        pac_rfc            text,                          -- RfcProvCertif
        total_trasladados  numeric(18,6),
        total_retenidos    numeric(18,6),
        conceptos_count    int,
        impuestos          jsonb,                         -- detalle traslados/retenciones
        raw                jsonb,                         -- cabecera parseada (sin XML crudo)
        rol                text,                          -- emitidas|recibidas (perspectiva del solicitante)
        estatus_sat        text NOT NULL DEFAULT 'desconocido', -- vigente|cancelado|desconocido (FISCAL.6)
        estatus_checked_at timestamptz,
        source             text NOT NULL DEFAULT 'descarga_masiva', -- descarga_masiva|kepler|manual
        request_id         uuid,
        package_id         uuid,
        stored_ref         text,                          -- entry del XML dentro del ZIP del paquete
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, uuid)
      )`);
    await knex.raw(`ALTER TABLE fiscal.cfdis ADD CONSTRAINT fiscal_cfdis_rol_check CHECK (rol IS NULL OR rol IN ('emitidas','recibidas'))`);
    await knex.raw(`ALTER TABLE fiscal.cfdis ADD CONSTRAINT fiscal_cfdis_estatus_check CHECK (estatus_sat IN ('vigente','cancelado','desconocido'))`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_fecha ON fiscal.cfdis (tenant_id, fecha)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_emisor ON fiscal.cfdis (tenant_id, emisor_rfc)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_receptor ON fiscal.cfdis (tenant_id, receptor_rfc)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_tipo ON fiscal.cfdis (tenant_id, tipo_comprobante)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_metodo ON fiscal.cfdis (tenant_id, metodo_pago)`);
    await knex.raw(`CREATE INDEX ix_fiscal_cfdis_request ON fiscal.cfdis (tenant_id, request_id)`);
    await knex.raw(`ALTER TABLE fiscal.cfdis ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.cfdis FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.cfdis
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.cfdis TO app_runtime`);
  }

  // Permiso de lectura del almacén CFDI (anclado al de gastos existente).
  const ANCHOR = { FISCAL_CFDI_VER: 'FINANCE_EXPENSES_VER' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_cfdis] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_CFDI_VER' WHERE permissions -> 'FISCAL_CFDI_VER' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('cfdis');
};
