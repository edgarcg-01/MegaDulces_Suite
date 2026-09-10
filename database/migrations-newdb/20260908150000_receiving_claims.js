/**
 * WMS-REC.8 — Reclamo diferenciado de faltantes de recepción (ADR-053).
 *
 * `commercial.receiving_claims` = el circuito que hoy se evapora: el Andén detecta
 * el faltante, lo muestra en pantalla, y al cerrar el vale no queda registro de que
 * se reclamó, ni a quién, ni si se resolvió.
 *
 * **Una fila POR RENGLÓN, no por vale** — se reclama por SKU. Idempotente por
 * `dedup_key = 'recv-line:'||receiving_line_id`: `close()` es reintentable (timeout,
 * doble clic) y no puede duplicar reclamos.
 *
 * **Ruteo por origen** (`receiving-origin.ts`, la misma función pura que pinta el chip):
 *   - `supplier` → se le reclama al proveedor y **le pega en su fill rate** (RA.14/RA-PRO.27).
 *   - `branch`   → traspaso interno: se le reclama a la sucursal que embarcó y la merma
 *                  es de la casa. `responsible_label` es **el nombre que trae el documento**;
 *                  la sucursal concreta NO se deduce de `TI###` (el ERP se contradice:
 *                  `TI005` sale como "ZAMORA CANINDO" y como "ABASTOS LP" mientras
 *                  `analytics.transfer_dest_map` dice que Canindo es `TI006`). El dueño
 *                  concreto sale del crosswalk capturado a mano `commercial.erp_transfer_origin`
 *                  (mig 20260908150100); mientras esté vacío, el reclamo se mide sin dueño.
 *
 * **Dinero:** `unit_cost` = `importe/cantidad` del renglón del ERP → el costo por unidad
 * DEL DOCUMENTO, en la unidad del documento (`qty_unit`: PZA/PAQ/CJA…). Cero factor de
 * caja inventado (sólo 3.1% de los SKU lo tienen). Sin renglón del ERP (vale manual) el
 * monto queda **NULL** con `amount_source='sin_dato'` — no se dibuja como $0.
 *
 * **No ajusta stock ni dinero** (decisión 2026-09-08): el faltante nunca entró al
 * inventario (`close()` da de alta sólo `received_qty`), así que ajustarlo lo contaría
 * dos veces; y la nota de crédito real vive en Kepler (`X-D-55`/`X-D-40`), que es
 * read-only. El `amount` es estimación para priorizar, etiquetada como tal.
 *
 * Patrón de bandeja reusado: `commercial.replenishment_findings` (RA.8) — schema
 * `commercial.*`, UPSERT idempotente, RLS forzado, se trabaja desde Compras. Tabla
 * propia porque el ciclo de vida es **negociado**, no auto-resolutivo: la condición
 * (faltó media tarima en un vale cerrado) es verdadera para siempre.
 *
 * Aditiva e idempotente. RLS forzado + grant app_runtime. FKs compuestas (tenant_id, id).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('receiving_claims')) return;

  await knex.raw(`
    CREATE TABLE commercial.receiving_claims (
      id                   uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,

      -- Liga al renglón del vale (el grano del reclamo) + snapshots para leer la
      -- bandeja sin 4 joins.
      session_id           uuid NOT NULL,
      receiving_line_id    uuid NOT NULL,
      warehouse_id         uuid NOT NULL,
      product_id           uuid,                    -- NULL: renglón cuyo SKU no está en el catálogo
      folio                varchar(24) NOT NULL,    -- VE-YYYY-NNNNN del vale
      source_ref           varchar(120),            -- sucursal/folio de la orden del ERP
      sku                  varchar(60),
      product_name         varchar(200),

      -- Qué pasó (copiado de receiving_lines al cerrar; el faltante NO se recalcula)
      kind                 varchar(24) NOT NULL,
      expected_qty         numeric(14,3) NOT NULL DEFAULT 0,
      received_qty         numeric(14,3) NOT NULL DEFAULT 0,
      qty_claimed          numeric(14,3),           -- NULL = falta capturarla (dañado / producto_incorrecto)
      qty_unit             varchar(12),             -- unidad DEL DOCUMENTO (o 'ambigua')

      -- A quién
      responsible_kind     varchar(12) NOT NULL,
      responsible_code     varchar(60),             -- CD015 / TI001 (supplier_code del vale)
      responsible_label    varchar(200),            -- nombre TAL CUAL del documento; nunca deducido
      supplier_id          uuid,                    -- sólo si responsible_code casa con catalog.suppliers.code
      responsible_warehouse_id uuid,                -- traspaso: sólo si el crosswalk manual lo resuelve

      -- Dinero (estimación para priorizar)
      unit_cost            numeric(14,4),
      amount               numeric(14,2),
      amount_source        varchar(12) NOT NULL DEFAULT 'sin_dato',

      -- Seguimiento
      status               varchar(16) NOT NULL DEFAULT 'open',
      opened_at            timestamptz NOT NULL DEFAULT now(),  -- = closed_at del vale
      claimed_at           timestamptz,
      claimed_by           uuid,
      claimed_by_username  varchar(80),
      claim_channel        varchar(24),
      resolved_at          timestamptz,
      resolved_by          uuid,
      resolved_by_username varchar(80),
      resolution_note      text,
      notes                text,                    -- snapshot de receiving_lines.notes

      dedup_key            text NOT NULL,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid,
      updated_at           timestamptz NOT NULL DEFAULT now(),
      updated_by           uuid,

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, dedup_key),

      CONSTRAINT commercial_recv_claims_kind_chk
        CHECK (kind IN ('faltante','dañado','producto_incorrecto')),
      CONSTRAINT commercial_recv_claims_resp_chk
        CHECK (responsible_kind IN ('supplier','branch')),
      CONSTRAINT commercial_recv_claims_status_chk
        CHECK (status IN ('open','claimed','accepted','discarded','written_off')),
      CONSTRAINT commercial_recv_claims_amount_src_chk
        CHECK (amount_source IN ('erp_line','sin_dato')),
      -- Cantidad reclamada: o no se sabe todavía (NULL) o es positiva. Un reclamo de 0
      -- no es un reclamo.
      CONSTRAINT commercial_recv_claims_qty_chk
        CHECK (qty_claimed IS NULL OR qty_claimed > 0),

      CONSTRAINT fk_commercial_recv_claims_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_commercial_recv_claims_session
        FOREIGN KEY (tenant_id, session_id) REFERENCES commercial.receiving_sessions (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_commercial_recv_claims_line
        FOREIGN KEY (tenant_id, receiving_line_id) REFERENCES commercial.receiving_lines (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_commercial_recv_claims_warehouse
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT fk_commercial_recv_claims_product
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE RESTRICT,
      -- `SET NULL (columna)` (Postgres 15+), NO `SET NULL` a secas: en una FK COMPUESTA el
      -- SET NULL pelado intenta anular las DOS columnas, y `tenant_id` es NOT NULL → borrar
      -- un proveedor con reclamos revienta con "null value in column tenant_id" en vez de
      -- soltar el vínculo. Vivido al limpiar el fixture del smoke.
      -- El reclamo sobrevive legible igual: `responsible_code` y `responsible_label` son
      -- snapshots del documento, no joins.
      CONSTRAINT fk_commercial_recv_claims_supplier
        FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers (tenant_id, id) ON DELETE SET NULL (supplier_id),
      CONSTRAINT fk_commercial_recv_claims_resp_wh
        FOREIGN KEY (tenant_id, responsible_warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE SET NULL (responsible_warehouse_id)
    )`);

  // Bandeja: abiertos primero, por antigüedad (lo que lleva más días sin cobrarse).
  await knex.raw(`CREATE INDEX ix_recv_claims_open ON commercial.receiving_claims (tenant_id, status, opened_at)`);
  // Scorecard del proveedor + link "reclamos de este proveedor".
  await knex.raw(`CREATE INDEX ix_recv_claims_supplier ON commercial.receiving_claims (tenant_id, supplier_id, status)`);
  // Fill rate por SKU×proveedor (el grano fino del motor de reabastecimiento).
  await knex.raw(`CREATE INDEX ix_recv_claims_product ON commercial.receiving_claims (tenant_id, product_id, status)`);
  await knex.raw(`CREATE INDEX ix_recv_claims_line ON commercial.receiving_claims (tenant_id, receiving_line_id)`);

  await knex.raw(`
    COMMENT ON TABLE commercial.receiving_claims IS
      'WMS-REC.8 (ADR-053) — reclamo POR RENGLÓN de un vale cerrado con faltante/dañado/producto_incorrecto. '
      'Ruteado por origen: supplier (le pega al fill rate) vs branch (traspaso, merma de la casa). '
      'No ajusta stock ni dinero: el faltante nunca entró y Kepler es read-only. UPSERT por (tenant, dedup_key).'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.receiving_claims.responsible_label IS
      'Nombre tal cual lo trae el documento del ERP. NUNCA una sucursal deducida de TI### (el ERP se contradice).'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.receiving_claims.unit_cost IS
      'importe/cantidad del renglón del ERP = costo por unidad DEL DOCUMENTO (qty_unit). Sin factor de caja.'`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.receiving_claims.status IS
      'open=levantado · claimed=pasado al responsable · accepted=reconocido · discarded=era error nuestro de conteo (NO penaliza el fill rate) · written_off=perdido (sí penaliza)'`);

  await knex.raw(`ALTER TABLE commercial.receiving_claims ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.receiving_claims FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.receiving_claims`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.receiving_claims
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.receiving_claims TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('receiving_claims');
};
