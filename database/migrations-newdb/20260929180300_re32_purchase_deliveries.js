'use strict';
/**
 * `[RE.32]` — **Entrega de compras a Finanzas: folio, quién entrega, quién recibe, y renglones.**
 *
 * ── Para qué (Francisco, 2026-09-29) ────────────────────────────────────────────────────
 * El auxiliar de compras revisa las compras recibidas (por fecha, con brinco por sucursal, proveedor
 * A-Z), marca con un check lo que tiene en físico y validado, y genera una **entrega con folio** para
 * Finanzas: quién entrega, quién recibe, y el PDF de respaldo. La persona de Finanzas la confirma en el
 * sistema y puede **rechazar renglón por renglón** (un renglón rechazado regresa a pendientes; la
 * entrega no se devuelve completa).
 *
 * ── Por qué son tablas y no una vista ───────────────────────────────────────────────────
 * Es DATO PROPIO (HITL): quién entregó qué, cuándo y a quién. Nada de esto existe en Kepler. Lo que
 * sí viene de Kepler (proveedor, importe, fechas) se lee de `analytics.erp_goods_receipts` y se
 * guarda como SNAPSHOT en el renglón a propósito: la entrega es un documento firmado, y si Kepler
 * corrige la entrada después, el papel que se firmó no debe cambiar solo. No es copia de tabla: es
 * el acta de lo que se entregó.
 *
 * ── Qué crea ────────────────────────────────────────────────────────────────────────────
 *   · `commercial.purchase_delivery_sequences` — contador por (tenant, año) para el folio
 *     `ENT-YYYY-NNNNN`; mismo UPSERT atómico que `commercial.quote_sequences` / `order_sequences`.
 *   · `commercial.purchase_deliveries` — la entrega: folio, estado, base de fecha y periodo usados,
 *     quién entrega (usuario + nombre en el momento), quién recibe (usuario de Finanzas asignado +
 *     nombre), cuándo se confirmó, totales.
 *   · `commercial.purchase_delivery_lines` — un renglón por orden de entrada (XA2001 / WCJ-*):
 *     llave de la entrada en Kepler, snapshot (proveedor, fechas, importe, vencimiento Kepler,
 *     estado de la evidencia) y su propio estado: entregado → aceptado | rechazado (con motivo), o
 *     cancelado si Compras cancela la entrega antes de que Finanzas la confirme.
 *
 * ── Invariantes en la BASE, no sólo en el servicio ──────────────────────────────────────
 *   · **Una entrada no puede estar en dos entregas vivas**: índice único parcial sobre
 *     (tenant, sucursal, doc_prefix, folio) WHERE status IN ('entregado','aceptado'). Rechazado o
 *     cancelado la libera, y vuelve a pendientes. Dos auxiliares marcando lo mismo a la vez: gana el
 *     primer commit, el segundo recibe 23505 (el servicio lo traduce).
 *   · Rechazar exige motivo; decidir (aceptar/rechazar) exige quién y cuándo.
 *   · El importe del renglón es > 0 y el periodo es coherente (desde ≤ hasta).
 *   · FK compuesta (tenant_id, delivery_id): un renglón no puede colgar de la entrega de otro tenant.
 *
 * Tablas nuevas → no bloquean nada existente (el FK a `identity.tenants` toma un lock breve sobre
 * esa tabla; `lock_timeout` por si acaso). RLS forzado + GRANT a `app_runtime` en las tres.
 * Idempotente (`hasTable` por tabla). `down` las quita en orden inverso (no hay datos de Kepler).
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON commercial.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  const S = knex.schema.withSchema('commercial');
  if ((await S.hasTable('purchase_delivery_sequences')) && (await S.hasTable('purchase_deliveries'))
      && (await S.hasTable('purchase_delivery_lines'))) {
    return;
  }
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  if (!(await S.hasTable('purchase_delivery_sequences'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_delivery_sequences (
        tenant_id     uuid NOT NULL REFERENCES identity.tenants (id) ON DELETE CASCADE,
        year          int  NOT NULL CHECK (year > 0),
        current_value int  NOT NULL DEFAULT 0 CHECK (current_value >= 0),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, year)
      )`);
    await knex.raw(`COMMENT ON TABLE commercial.purchase_delivery_sequences IS
      '[RE.32] Contador atómico por (tenant, año) del folio ENT-YYYY-NNNNN de las entregas de compras a Finanzas. Mismo patrón que quote_sequences.'`);
    await tenantRls(knex, 'purchase_delivery_sequences');
  }

  if (!(await S.hasTable('purchase_deliveries'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_deliveries (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        code                text NOT NULL,
        status              text NOT NULL DEFAULT 'entregada'
                            CHECK (status IN ('entregada','recibida','recibida_parcial','cancelada')),
        date_basis          text NOT NULL CHECK (date_basis IN ('recepcion','factura')),
        period_from         date,
        period_to           date,
        delivered_by        text NOT NULL,
        delivered_by_name   text,
        delivered_at        timestamptz NOT NULL DEFAULT now(),
        recipient_username  text NOT NULL,
        recipient_name      text,
        received_by         text,
        received_at         timestamptz,
        line_count          int NOT NULL DEFAULT 0 CHECK (line_count >= 0),
        total_amount        numeric(14,2) NOT NULL DEFAULT 0,
        notes               text,
        cancelled_by        text,
        cancelled_at        timestamptz,
        cancel_reason       text,
        created_by          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_by          text,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, code),
        CHECK (period_from IS NULL OR period_to IS NULL OR period_from <= period_to),
        CHECK (status NOT IN ('recibida','recibida_parcial') OR (received_by IS NOT NULL AND received_at IS NOT NULL)),
        CHECK (status <> 'cancelada' OR (cancelled_by IS NOT NULL AND nullif(btrim(cancel_reason), '') IS NOT NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_pdel_status ON commercial.purchase_deliveries (tenant_id, status, delivered_at DESC)`);
    await knex.raw(`CREATE INDEX ix_pdel_recipient ON commercial.purchase_deliveries (tenant_id, recipient_username, status)`);
    await knex.raw(`COMMENT ON TABLE commercial.purchase_deliveries IS
      '[RE.32] Entrega de compras recibidas de Compras a Finanzas: folio, quién entrega, quién recibe (usuario de Finanzas que confirma). Dato propio (HITL).'`);
    await tenantRls(knex, 'purchase_deliveries');
  }

  if (!(await S.hasTable('purchase_delivery_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_delivery_lines (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        delivery_id         uuid NOT NULL,
        receipt_sucursal    text NOT NULL,
        receipt_doc_prefix  text NOT NULL,
        receipt_folio       text NOT NULL,
        oc_folio            text,
        supplier_code       text,
        supplier_name       text,
        invoice_date        date,
        reception_date      date,
        reception_source    text,
        amount              numeric(14,2) NOT NULL CHECK (amount > 0),
        kepler_due_date     date,
        evidence_status     text,
        status              text NOT NULL DEFAULT 'entregado'
                            CHECK (status IN ('entregado','aceptado','rechazado','cancelado')),
        rejection_reason    text,
        decided_by          text,
        decided_at          timestamptz,
        created_by          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_by          text,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, delivery_id) REFERENCES commercial.purchase_deliveries (tenant_id, id) ON DELETE CASCADE,
        CHECK (status <> 'rechazado' OR nullif(btrim(rejection_reason), '') IS NOT NULL),
        CHECK (status NOT IN ('aceptado','rechazado') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
      )`);
    // Una entrada de Kepler no puede estar en dos entregas VIVAS a la vez.
    await knex.raw(`CREATE UNIQUE INDEX ux_pdel_lines_receipt_live ON commercial.purchase_delivery_lines
      (tenant_id, receipt_sucursal, receipt_doc_prefix, receipt_folio) WHERE status IN ('entregado','aceptado')`);
    await knex.raw(`CREATE INDEX ix_pdel_lines_delivery ON commercial.purchase_delivery_lines (tenant_id, delivery_id)`);
    await knex.raw(`COMMENT ON TABLE commercial.purchase_delivery_lines IS
      '[RE.32] Renglones de la entrega a Finanzas: la orden de entrada de Kepler + snapshot de lo que se firmó. Rechazado/cancelado libera la entrada (vuelve a pendientes).'`);
    await tenantRls(knex, 'purchase_delivery_lines');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const S = knex.schema.withSchema('commercial');
  await S.dropTableIfExists('purchase_delivery_lines');
  await S.dropTableIfExists('purchase_deliveries');
  await S.dropTableIfExists('purchase_delivery_sequences');
};
