/**
 * Fase CBW — Captura bancaria por WhatsApp (ficha/captura → libro de bancos).
 *
 * Un remitente autorizado (encargado de plaza) manda por WhatsApp la foto de una
 * ficha de depósito / captura de transferencia. El bot corre OCR, la atribuye
 * (persona + sucursal + cuenta + importe) y la deja en una BANDEJA DE CAPTURA
 * (staging) para que un humano la valide y la cuadre contra el estado de cuenta.
 *
 * REGLA DURA (ADR-042): la foto es un COMPROBANTE, NUNCA un asiento directo en
 * `finance.bank_movements`. El movimiento autoritativo lo produce el estado de
 * cuenta (importer CB); la captura se cuadra CONTRA ese movimiento.
 *
 * Dos tablas (finance.*, RLS forzado, patrón A.0mt tenant_id + audit):
 *   - `bank_capture_senders` = allowlist + identidad del remitente (teléfono E.164
 *      → nombre → sucursal → cuenta por defecto). Si no está (o inactive) → NO postea.
 *   - `bank_capture_inbox`   = la captura: adjunto Cloudinary + OCR + atribución +
 *      flujo HITL pendiente_confirmacion → confirmado → validado | rechazado | descartado.
 *
 * Permisos: reusa FINANCE_BANK_VER / FINANCE_BANK_GESTIONAR (mig 20260722180000).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // 1) Registro de remitentes (allowlist + identidad). Da nombre/sucursal/cuenta al teléfono.
  if (!(await knex.schema.withSchema('finance').hasTable('bank_capture_senders'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_capture_senders (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                uuid NOT NULL,
        phone                    text NOT NULL,          -- E.164 canónico (normalizeMxPhone)
        full_name                text NOT NULL,          -- nombre de la persona → atribución
        sucursal                 text,                   -- código S de su plaza (30/73/10…)
        default_bank_account_id  uuid REFERENCES finance.bank_accounts(id) ON DELETE SET NULL,
        active                   boolean NOT NULL DEFAULT true,
        created_by               text,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, phone)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_bcs_phone ON finance.bank_capture_senders (tenant_id, phone) WHERE active`);
    await knex.raw(`ALTER TABLE finance.bank_capture_senders ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.bank_capture_senders FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='bank_capture_senders' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.bank_capture_senders
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.bank_capture_senders TO app_runtime`);
  }

  // 2) La captura: comprobante en staging (adjunto + OCR + atribución + HITL).
  if (!(await knex.schema.withSchema('finance').hasTable('bank_capture_inbox'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_capture_inbox (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        source            text NOT NULL DEFAULT 'whatsapp',
        from_phone        text NOT NULL,                 -- E.164 del remitente
        sender_id         uuid REFERENCES finance.bank_capture_senders(id) ON DELETE SET NULL,
        wa_message_id     text,                          -- idempotencia del mensaje
        -- adjunto(s) en Cloudinary: [{ url, public_id, kind }]
        files             jsonb NOT NULL DEFAULT '[]',
        -- OCR de la ficha (extractDepositSlip)
        ocr_monto         numeric,
        ocr_fecha         date,
        ocr_banco         text,
        ocr_cuenta_dest   text,                          -- últimos 4 / CLABE destino
        ocr_referencia    text,                          -- clave de rastreo SPEI / folio
        ocr_ordenante     text,
        ocr_metodo        text,                          -- efectivo|transferencia_spei|cheque|tarjeta|deposito_ventanilla
        ocr_raw           jsonb,                         -- salida cruda del LLM (auditoría)
        ocr_status        text NOT NULL DEFAULT 'pendiente'
                            CHECK (ocr_status IN ('pendiente','ok','ilegible','sin_key','manual')),
        -- atribución (resuelta: OCR + remitente)
        bank_account_id   uuid REFERENCES finance.bank_accounts(id) ON DELETE SET NULL,
        sucursal          text,
        concept           text,
        amount_in         numeric NOT NULL DEFAULT 0,    -- depósito ("el cargo")
        amount_out        numeric NOT NULL DEFAULT 0,    -- retiro
        movement_date     date,
        -- flujo HITL
        status            text NOT NULL DEFAULT 'pendiente_confirmacion'
                            CHECK (status IN ('pendiente_confirmacion','confirmado','validado','rechazado','descartado')),
        bank_movement_id  uuid REFERENCES finance.bank_movements(id) ON DELETE SET NULL,  -- cuadre contra el estado de cuenta
        notified_at       timestamptz,                   -- CBW.4.1 aviso a Crédito y Cobranza (idempotencia)
        comentarios       text,
        validated_by      text,
        validated_at      timestamptz,
        motivo_rechazo    text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wa_message_id)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_bci_status ON finance.bank_capture_inbox (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_bci_phone ON finance.bank_capture_inbox (tenant_id, from_phone)`);
    await knex.raw(`CREATE INDEX ix_fin_bci_uncuadrado ON finance.bank_capture_inbox (tenant_id, status) WHERE bank_movement_id IS NULL`);
    await knex.raw(`ALTER TABLE finance.bank_capture_inbox ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.bank_capture_inbox FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='bank_capture_inbox' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.bank_capture_inbox
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.bank_capture_inbox TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('bank_capture_inbox');
  await knex.schema.withSchema('finance').dropTableIfExists('bank_capture_senders');
};
