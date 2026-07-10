/**
 * RA.15 — Cadena de compra real: Orden de Compra (OC) + Orden de Entrada (OE).
 * (ADR-030 + ADR-031). Deja de aplastar la cadena de Kepler en flags de estado.
 *
 * Kepler modela la compra como DOCUMENTOS distintos (verificado en md_03 vivo 2026-07-10):
 *   X-A-30 requisición (opcional) → X-A-35 OC → X-A-37 vale → X-A-40 orden de entrada
 *   [ENTRA al inventario, kardex kdij] → X-A-20 aplica/CxP.
 * Nosotros modelamos los 2 eslabones con valor operativo propio:
 *
 *   commercial.purchase_orders        (OC = X-A-35) — lo que se manda al proveedor.
 *   commercial.purchase_order_lines   — líneas pedidas (qty + costo pactado) + recibido acumulado.
 *   commercial.goods_receipts         (OE = X-A-40) — evento de recepción; MUEVE stock.
 *   commercial.goods_receipt_lines    — qty recibida real + costo real por línea.
 *   commercial.purchase_doc_sequences — folios OC-YYYY-NNNNN / OE-YYYY-NNNNN atómicos.
 *
 * La requisición (RQ) sigue siendo la NECESIDAD + aprobación HITL (nuestro valor; Kepler
 * ni la exige — 504/781 OCs nacen directas). Al aprobar se genera la OC (RQ→'ordered',
 * convertida). La recepción (OE) permite PARCIALES (varias OE contra una OC) y al confirmar
 * suma a commercial.stock vía un movimiento 'in' (overlay optimista; el snapshot nocturno
 * de Kepler re-sincroniza = verdad del inventario, sin doble-conteo permanente. Ver ADR-031).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; FKs compuestas
 * (tenant_id, id). Idempotente (hasTable). Perms reusan COMPRAS_VER / COMPRAS_GESTIONAR.
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
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

exports.up = async function (knex) {
  // ── commercial.purchase_doc_sequences (folios OC/OE atómicos) ──────────
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_doc_sequences'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_doc_sequences (
        tenant_id uuid NOT NULL,
        year      integer NOT NULL,
        doc_kind  varchar(4) NOT NULL CHECK (doc_kind IN ('OC','OE')),
        last_seq  integer NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, year, doc_kind)
      )`);
    await createTenantRls(knex, 'purchase_doc_sequences');
  }

  // ── commercial.purchase_orders (OC = X-A-35) ──────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_orders'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_orders (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        folio          varchar(20) NOT NULL,
        warehouse_id   uuid NOT NULL,                       -- destino
        supplier_id    uuid,                                -- proveedor (compra)
        source_type    varchar(8) NOT NULL DEFAULT 'supplier' CHECK (source_type IN ('supplier','branch')),
        source_warehouse_id uuid,                           -- origen si traspaso (branch)
        requisition_id uuid,                                -- RQ que la originó (NULL = OC directa)
        expected_date  date,                                -- fecha esperada de entrega
        estado         varchar(12) NOT NULL DEFAULT 'open'
                         CHECK (estado IN ('open','partial','received','cancelled')),
        target_basis   varchar(12) NOT NULL DEFAULT 'max' CHECK (target_basis IN ('min','reorder','max')),
        total_lines    integer NOT NULL DEFAULT 0,
        total_units    numeric(14,3) NOT NULL DEFAULT 0,    -- pedido
        received_units numeric(14,3) NOT NULL DEFAULT 0,    -- recibido acumulado (∑ OE)
        total_cost     numeric(14,4) NOT NULL DEFAULT 0,    -- pactado
        notes          text,
        created_by     uuid,
        created_at     timestamptz NOT NULL DEFAULT now(),
        closed_at      timestamptz,                         -- cuando pasó a received/cancelled
        cancelled_by   uuid,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, folio),
        CHECK (source_type <> 'branch' OR source_warehouse_id IS NOT NULL),
        FOREIGN KEY (tenant_id, warehouse_id)        REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, supplier_id)         REFERENCES catalog.suppliers     (tenant_id, id) ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, requisition_id)      REFERENCES commercial.purchase_requisitions (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_po_estado ON commercial.purchase_orders (tenant_id, estado, created_at)`);
    await knex.raw(`CREATE INDEX ix_po_supplier ON commercial.purchase_orders (tenant_id, supplier_id)`);
    await knex.raw(`CREATE INDEX ix_po_req ON commercial.purchase_orders (tenant_id, requisition_id)`);
    await knex.raw(`COMMENT ON TABLE commercial.purchase_orders IS 'RA.15/ADR-031 — Orden de Compra (espejo Kepler X-A-35). Documento que se manda al proveedor. estado open→partial→received por recepción (OE). No mueve stock (lo hace la OE).'`);
    await createTenantRls(knex, 'purchase_orders');
  }

  // ── commercial.purchase_order_lines ───────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_order_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_order_lines (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        purchase_order_id  uuid NOT NULL,
        product_id         uuid NOT NULL,
        requisition_line_id uuid,                           -- traza a la línea de RQ (si vino de una)
        ordered_qty        numeric(14,3) NOT NULL DEFAULT 0,
        received_qty       numeric(14,3) NOT NULL DEFAULT 0,-- acumulado real (∑ OE)
        unit_cost          numeric(14,4) NOT NULL DEFAULT 0,-- pactado
        line_cost          numeric(14,4) NOT NULL DEFAULT 0,
        created_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CHECK (ordered_qty >= 0 AND received_qty >= 0),
        FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES commercial.purchase_orders (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, product_id)        REFERENCES catalog.products          (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_po_lines_po ON commercial.purchase_order_lines (tenant_id, purchase_order_id)`);
    await createTenantRls(knex, 'purchase_order_lines');
  }

  // ── commercial.goods_receipts (OE = X-A-40; MUEVE stock) ──────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('goods_receipts'))) {
    await knex.raw(`
      CREATE TABLE commercial.goods_receipts (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        folio             varchar(20) NOT NULL,
        purchase_order_id uuid NOT NULL,
        warehouse_id      uuid NOT NULL,                    -- destino (= OC.warehouse_id)
        total_units       numeric(14,3) NOT NULL DEFAULT 0,
        total_cost        numeric(14,4) NOT NULL DEFAULT 0,
        stock_applied     boolean NOT NULL DEFAULT false,   -- si movió commercial.stock (overlay optimista)
        notes             text,
        received_by       uuid,
        received_at       timestamptz NOT NULL DEFAULT now(),
        created_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, folio),
        FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES commercial.purchase_orders (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, warehouse_id)      REFERENCES commercial.warehouses      (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_gr_po ON commercial.goods_receipts (tenant_id, purchase_order_id)`);
    await knex.raw(`COMMENT ON TABLE commercial.goods_receipts IS 'RA.15/ADR-031 — Orden de Entrada (espejo Kepler X-A-40). Recepción (permite parciales). Al confirmar suma a commercial.stock (movimiento in); el snapshot nocturno de Kepler re-sincroniza.'`);
    await createTenantRls(knex, 'goods_receipts');
  }

  // ── commercial.goods_receipt_lines ────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('goods_receipt_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.goods_receipt_lines (
        id                     uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        goods_receipt_id       uuid NOT NULL,
        purchase_order_line_id uuid NOT NULL,
        product_id             uuid NOT NULL,
        received_qty           numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost              numeric(14,4) NOT NULL DEFAULT 0,-- costo real recibido
        line_cost              numeric(14,4) NOT NULL DEFAULT 0,
        created_at             timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CHECK (received_qty >= 0),
        FOREIGN KEY (tenant_id, goods_receipt_id)       REFERENCES commercial.goods_receipts      (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, purchase_order_line_id) REFERENCES commercial.purchase_order_lines (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, product_id)             REFERENCES catalog.products               (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_gr_lines_gr ON commercial.goods_receipt_lines (tenant_id, goods_receipt_id)`);
    await createTenantRls(knex, 'goods_receipt_lines');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('goods_receipt_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('goods_receipts');
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_order_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_orders');
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_doc_sequences');
};
