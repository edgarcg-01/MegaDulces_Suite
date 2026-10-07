/**
 * Fase CC — Comprobantes de Cobranza (depósito + OCR).
 *
 * Digitaliza el adjunto del comprobante de depósito a un COBRO de Kepler. El cobro
 * ya existe en Kepler (documento `Collect1` / serie `UA0501` = U-A-5-1 "Cobro PUE",
 * asiento C 102 Bancos / A 115 Clientes) — NO lo creamos ni lo escribimos; solo le
 * colgamos la evidencia (ficha de depósito imagen/PDF + OCR) ligada por
 * `(sucursal, folio)`. 100% read-only sobre Kepler.
 *
 * Dos tablas:
 *   - `analytics.erp_collections`  = espejo read-only de los cobros de Kepler que
 *     puebla `import-collections.js` (CEDIS md_00 centraliza la cobranza). Sin RLS
 *     (analytics.*) → filtro tenant explícito. `(suc,folio)` es único en UA0501.
 *   - `finance.collection_deposits` = NUESTRO registro: adjunto + campos OCR +
 *     match de monto + flujo HITL `recibido → validado | rechazado`. RLS forzado.
 *     Calca `finance.expense_proofs`.
 *
 * Convención A.0mt: tenant_id + audit fields; finance.* con RLS forzado + grants
 * app_runtime; analytics.* con GRANT SELECT.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // 1) Espejo read-only de los cobros de Kepler (lista de la que el capturista elige).
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_collections'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_collections (
        tenant_id      uuid NOT NULL,
        sucursal       text NOT NULL,            -- kdm1.c1 (00 = CEDIS)
        folio          text NOT NULL,            -- kdm1.c6 (único en UA0501)
        doc_prefix     text NOT NULL DEFAULT 'UA0501',  -- Collect1 / U-A-5-1 "Cobro PUE"
        cobro_date     date,                     -- kdm1.c9
        cliente_code   text,                     -- kdm1.c10 (plaza/ruta/Cxxxx)
        cliente_nombre text,                     -- kdm1.c32 beneficiario
        concepto       text,                     -- kdm1.c24
        forma_pago     text,                     -- derivada del concepto: deposito|transferencia|tarjeta|efectivo|cheque|otro
        monto          numeric NOT NULL DEFAULT 0,  -- kdm1.c16
        tipo_cuenta    text,                     -- interno | ruta | cliente_final
        source_branch  text,                     -- md_00
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, folio)
      )`);
    await knex.raw(`CREATE INDEX ix_erpcoll_lookup ON analytics.erp_collections (tenant_id, tipo_cuenta, forma_pago, cobro_date DESC)`);
    await knex.raw(`CREATE INDEX ix_erpcoll_cliente ON analytics.erp_collections (tenant_id, cliente_code)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_collections TO app_runtime`);
  }

  // 2) Nuestro registro de evidencia (adjunto + OCR + validación), ligado al cobro.
  if (!(await knex.schema.withSchema('finance').hasTable('collection_deposits'))) {
    await knex.raw(`
      CREATE TABLE finance.collection_deposits (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        -- referencia al cobro Kepler (snapshot self-contained)
        sucursal        text NOT NULL,
        folio           text NOT NULL,
        cliente_code    text,
        cliente_nombre  text,
        cobro_date      date,
        cobro_monto     numeric DEFAULT 0,
        -- adjunto(s) en Cloudinary: [{ role, url, public_id, kind, name }]
        files           jsonb NOT NULL DEFAULT '[]',
        -- OCR de la ficha de depósito
        ocr_monto       numeric,
        ocr_fecha       date,
        ocr_banco       text,
        ocr_cuenta_dest text,                    -- últimos 4 / CLABE destino
        ocr_referencia  text,                    -- clave de rastreo SPEI / folio operación
        ocr_ordenante   text,
        ocr_metodo      text,                    -- efectivo|transferencia_spei|cheque|tarjeta|deposito_ventanilla
        ocr_raw         jsonb,                   -- salida cruda del LLM (auditoría)
        ocr_status      text NOT NULL DEFAULT 'pendiente'
                          CHECK (ocr_status IN ('pendiente','ok','ilegible','sin_key','manual')),
        monto_match     boolean,                 -- |ocr_monto - cobro_monto| <= tolerancia
        -- flujo HITL
        status          text NOT NULL DEFAULT 'recibido'
                          CHECK (status IN ('recibido','validado','rechazado')),
        comentarios     text,
        validated_by    text,
        validated_at    timestamptz,
        motivo_rechazo  text,
        created_by      text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_cd_status ON finance.collection_deposits (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_cd_cobro ON finance.collection_deposits (tenant_id, sucursal, folio)`);
    await knex.raw(`ALTER TABLE finance.collection_deposits ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.collection_deposits FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='collection_deposits' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.collection_deposits
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.collection_deposits TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('collection_deposits');
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_collections');
};
