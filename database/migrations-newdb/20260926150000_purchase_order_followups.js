/**
 * `[RA-PRO.62]` Seguimiento de órdenes de compra de Kepler — `/compras/oc-abiertas`.
 *
 * Compras necesita llevar el registro de POR QUÉ una orden sigue abierta: vigente, detenida por
 * pago, detenida por logística, backorder vigente, o no surtida / cancelada. Ese dato no existe en
 * ningún lado: el ERP sólo dice si hay vale de entrada o no.
 *
 * **Es dato propio (HITL), por eso es TABLA y no vista:** la regla principal del proyecto (derivar
 * del ODS, cero importers) aplica a los datos del ERP; esto lo captura una persona.
 *
 * **No toca Kepler.** Kepler es read-only: marcar una orden "no surtida / cancelada" acá NO la
 * cancela allá. La llave es la del documento del ERP (`sucursal`, `oc_folio` = kdm1.c1/c6 de un
 * XA3501); no hay FK porque la orden vive en `kepler_ods`, no en una tabla nuestra.
 *
 * Dos tablas:
 *   - `purchase_order_followups`: UN renglón por orden, el estatus vigente. Una orden sin renglón es
 *     "Sin revisar" (no "Vigente": vigente = alguien la revisó y sigue en pie).
 *   - `purchase_order_followup_history`: cada cambio, quién y cuándo. Sin UPDATE ni DELETE para
 *     app_runtime: la historia no se reescribe.
 *
 * La lista de estatus y la regla "nota obligatoria salvo Vigente" están en
 * `libs/contracts/src/http/oc-seguimiento.contract.ts`; los CHECK de acá son la misma regla en la
 * base, por si alguien escribe sin pasar por el servicio. Si se agrega un estatus, van los dos.
 *
 * Aditiva e idempotente. RLS forzado + grant app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
const ESTATUS = `('vigente','detenida_pago','detenida_logistica','backorder','no_surtida_cancelada')`;

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_order_followups'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_order_followups (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        sucursal             varchar(10) NOT NULL,          -- kdm1.c1 del XA3501
        oc_folio             varchar(30) NOT NULL,          -- kdm1.c6 del XA3501
        estatus              varchar(30) NOT NULL,
        nota                 text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        created_by           uuid,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        updated_by_username  varchar(80),                   -- snapshot: se lee sin join a usuarios

        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, sucursal, oc_folio),

        CONSTRAINT commercial_po_followup_estatus_chk CHECK (estatus IN ${ESTATUS}),
        -- Detenida / backorder / cancelada piden motivo (mismo mínimo que el contrato: 3).
        CONSTRAINT commercial_po_followup_nota_chk
          CHECK (estatus = 'vigente' OR (nota IS NOT NULL AND length(btrim(nota)) >= 3)),
        CONSTRAINT commercial_po_followup_nota_len_chk CHECK (nota IS NULL OR length(nota) <= 500),

        CONSTRAINT fk_commercial_po_followup_tenant
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT
      )`);
    await knex.raw(`
      COMMENT ON TABLE commercial.purchase_order_followups IS
        'RA-PRO.62 — estatus de seguimiento de una OC de Kepler (XA3501), capturado por Compras. '
        'Un renglón por orden; sin renglón = Sin revisar. NO cancela nada en Kepler (read-only).'`);
  }
  // Fuera del `if`: RLS, política y grants se aplican SIEMPRE (son idempotentes). Si la tabla
  // existiera por otro camino (creada a mano), igual queda protegida.
  await blindar(knex, 'commercial.purchase_order_followups', 'SELECT, INSERT, UPDATE');

  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_order_followup_history'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_order_followup_history (
        id                   uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        sucursal             varchar(10) NOT NULL,
        oc_folio             varchar(30) NOT NULL,
        estatus_anterior     varchar(30),                   -- NULL = venía de "Sin revisar"
        estatus              varchar(30) NOT NULL,
        nota                 text,
        changed_at           timestamptz NOT NULL DEFAULT now(),
        changed_by           uuid,
        changed_by_username  varchar(80),
        created_at           timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        CONSTRAINT commercial_po_followup_hist_estatus_chk CHECK (estatus IN ${ESTATUS}),
        CONSTRAINT commercial_po_followup_hist_prev_chk CHECK (estatus_anterior IS NULL OR estatus_anterior IN ${ESTATUS}),
        CONSTRAINT fk_commercial_po_followup_hist_tenant
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT
      )`);
    // El historial de UNA orden, del más reciente al más viejo (lo que pinta el detalle y el PDF).
    await knex.raw(`CREATE INDEX ix_po_followup_hist_oc ON commercial.purchase_order_followup_history (tenant_id, sucursal, oc_folio, changed_at DESC)`);
    await knex.raw(`
      COMMENT ON TABLE commercial.purchase_order_followup_history IS
        'RA-PRO.62 — cada cambio de estatus de seguimiento de una OC: quién, cuándo, de qué a qué y por qué. '
        'Sólo INSERT para app_runtime: la historia no se reescribe.'`);
  }
  // La historia es sólo INSERT: no se reescribe.
  await blindar(knex, 'commercial.purchase_order_followup_history', 'SELECT, INSERT');
};

/** RLS forzado por tenant + grants a app_runtime. Idempotente: se puede correr N veces. */
async function blindar(knex, tabla, grants) {
  await knex.raw(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${grants} ON ${tabla} TO app_runtime`);
}

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_order_followup_history');
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_order_followups');
};
