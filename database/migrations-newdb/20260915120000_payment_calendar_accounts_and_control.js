/**
 * Fase TP.6-TP.8+TP.10 — Calendario de Pagos: separación de funciones, catálogo de cuentas de
 * pago a proveedor (con workflow de aprobación anti-fraude), folio de lote/pago, y motivo de
 * reprogramación (ADR-064, extensión pedida por el usuario 2026-09-15).
 *
 * TP.6 — separación preparar≠autorizar: no agrega columnas (el permiso nuevo
 *   `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` vive en `libs/contracts`); acá sólo se valida en el
 *   controller/servicio. `finance.payment_allocations.priority_rank` ya existía (nullable) — se
 *   vuelve el "orden de pago" real que el motor propone y Tesorería ajusta.
 *
 * TP.7 — `commercial.supplier_payment_accounts` (catálogo real: banco/cuenta/CLABE/alias/adjunto
 *   JPG-PDF/favorita) + `commercial.supplier_payment_account_change_requests` (mismo patrón que
 *   `finance.proposed_actions`: created_by ≠ decided_by, nunca se aplica sin aprobación humana).
 *   TODA alta o cambio de cuenta pasa por la solicitud — no hay alta directa (control anti-fraude:
 *   la primera cuenta de un proveedor es tan sensible como cambiarla).
 *
 * TP.8 — folio: `payment_calendar_lots.folio` (formato `YYMMDD-01`, el "01" es el consecutivo de
 *   LOTE del día — hoy SIEMPRE 1 porque `UNIQUE(tenant_id,lot_date)` impide más de un lote por
 *   día; se deja el hueco en el formato para cuando se soporten cortes múltiples, sin tabla de
 *   secuencia adicional porque hoy sería una tabla que sólo puede devolver 1) + generado SOLO al
 *   autorizar (`releaseLot`), nunca al crear el borrador. `payment_allocations.folio` (`<folio
 *   del lote>-NN`, NN = `priority_rank` de 2 dígitos — por eso TP.6 exige que todos los pagos
 *   pendientes tengan `priority_rank` antes de poder liberar el lote).
 *
 * TP.10 — `payment_allocations.reprogram_reason` (motivo cerrado + 'otro' con detalle libre).
 *
 * `payment_allocations.supplier_payment_account_id` — para clasificación `proveedor_mercancia`,
 * reemplaza el texto libre de `destination_account_text` por una referencia real al catálogo
 * (que a su vez ya trae el adjunto de la solicitud de pago para verificar contra la factura).
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente (hasTable/hasColumn).
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  // ── commercial.supplier_payment_accounts ─────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_payment_accounts'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_payment_accounts (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        supplier_id      uuid NOT NULL,
        bank_name        text NOT NULL,
        account_number   text,
        clabe            text,
        alias            text,
        notes            text,                 -- ej. "dónde encontrarla en la factura/recibo"
        attachment_url   text,                  -- JPG/PDF de la solicitud de pago
        attachment_kind  text CHECK (attachment_kind IN ('pdf','image')),
        es_favorita      boolean NOT NULL DEFAULT false,
        status           text NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','inactiva')),
        created_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_spa_supplier ON commercial.supplier_payment_accounts (tenant_id, supplier_id, status)`);
    await tenantRls(knex, 'commercial', 'supplier_payment_accounts');
  }

  // ── commercial.supplier_payment_account_change_requests ──────────────────────────────
  // Mismo patrón que finance.proposed_actions (ADR-013): created_by ≠ decided_by, nunca se
  // aplica sola. account_id NULL = alta de la primera cuenta del proveedor.
  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_payment_account_change_requests'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_payment_account_change_requests (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        supplier_id               uuid NOT NULL,
        account_id                uuid,          -- NULL = alta; no-NULL = modifica/desactiva esa cuenta
        proposed_bank_name        text,
        proposed_account_number   text,
        proposed_clabe            text,
        proposed_alias            text,
        proposed_attachment_url   text,
        proposed_attachment_kind  text CHECK (proposed_attachment_kind IN ('pdf','image')),
        proposed_es_favorita      boolean NOT NULL DEFAULT false,
        deactivate                boolean NOT NULL DEFAULT false, -- solicitud de BAJA de una cuenta existente
        reason                    text NOT NULL, -- justificación del cambio (obligatoria)
        status                    text NOT NULL DEFAULT 'pending_approval'
                                    CHECK (status IN ('pending_approval','approved','rejected','applied')),
        requested_by              text NOT NULL,
        requested_at              timestamptz NOT NULL DEFAULT now(),
        decided_by                text,
        decided_at                timestamptz,
        decision_notes            text,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, account_id)  REFERENCES commercial.supplier_payment_accounts (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_spacr_status ON commercial.supplier_payment_account_change_requests (tenant_id, status)`);
    await tenantRls(knex, 'commercial', 'supplier_payment_account_change_requests');
  }

  // ── finance.payment_calendar_lots.folio ──────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasColumn('payment_calendar_lots', 'folio'))) {
    await knex.raw(`ALTER TABLE finance.payment_calendar_lots ADD COLUMN folio text`);
    await knex.raw(`CREATE UNIQUE INDEX ux_pcl_folio ON finance.payment_calendar_lots (tenant_id, folio) WHERE folio IS NOT NULL`);
  }

  // ── finance.payment_allocations: folio + motivo de reprogramación + cuenta de proveedor ──
  const addCol = async (col, ddl) => {
    if (!(await knex.schema.withSchema('finance').hasColumn('payment_allocations', col))) {
      await knex.raw(`ALTER TABLE finance.payment_allocations ADD COLUMN ${ddl}`);
    }
  };
  await addCol('folio', 'folio text');
  await addCol('reprogram_reason', `reprogram_reason text CHECK (reprogram_reason IN ('cuenta_erronea','falla_sistema_banco','pago_devuelto','presupuesto_recortado','otro'))`);
  await addCol('reprogram_reason_detail', 'reprogram_reason_detail text');
  await addCol('supplier_payment_account_id', 'supplier_payment_account_id uuid');
  if (!(await knex.raw(`
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_pa_supplier_payment_account' AND table_schema='finance' AND table_name='payment_allocations'`
  )).rows.length) {
    await knex.raw(`
      ALTER TABLE finance.payment_allocations
      ADD CONSTRAINT fk_pa_supplier_payment_account
      FOREIGN KEY (tenant_id, supplier_payment_account_id)
      REFERENCES commercial.supplier_payment_accounts (tenant_id, id) ON DELETE SET NULL`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pa_folio ON finance.payment_allocations (tenant_id, folio) WHERE folio IS NOT NULL`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE finance.payment_allocations DROP CONSTRAINT IF EXISTS fk_pa_supplier_payment_account`);
  for (const col of ['supplier_payment_account_id', 'reprogram_reason_detail', 'reprogram_reason', 'folio']) {
    if (await knex.schema.withSchema('finance').hasColumn('payment_allocations', col)) {
      await knex.schema.withSchema('finance').alterTable('payment_allocations', (t) => t.dropColumn(col));
    }
  }
  if (await knex.schema.withSchema('finance').hasColumn('payment_calendar_lots', 'folio')) {
    await knex.schema.withSchema('finance').alterTable('payment_calendar_lots', (t) => t.dropColumn('folio'));
  }
  await knex.schema.withSchema('commercial').dropTableIfExists('supplier_payment_account_change_requests');
  await knex.schema.withSchema('commercial').dropTableIfExists('supplier_payment_accounts');
};
