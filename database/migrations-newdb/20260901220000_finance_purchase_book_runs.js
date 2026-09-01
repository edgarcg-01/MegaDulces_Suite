/**
 * LC.6 (Fase LC, ADR-052) — El trámite mensual del libro de compras vive aquí.
 *
 * Hasta hoy el trámite era: la contadora arma el Excel, lo convierte a TXT y lo sube a
 * ContPAQi. No quedaba registro de qué se entregó, cuándo, ni con qué contenido — por eso
 * jul y ago 2026 se cayeron sin que nadie lo notara hasta que alguien miró la balanza.
 *
 * Esta tabla es la bitácora del trámite: una fila por mes, con el estado en el que va y el
 * contenido exacto de lo que se entregó (totales + hash del archivo). Así se puede
 * responder "¿ya se subió agosto?" y, después, "¿lo que está en ContPAQi es lo que
 * entregamos?" (LC.7).
 *
 * Estados:
 *   borrador   → se está armando; se puede regenerar cuantas veces haga falta
 *   generado   → hay un TXT firmado por su hash, listo para entregar
 *   entregado  → se le pasó a quien lo sube a ContPAQi
 *   aplicado   → confirmado contra la póliza real
 *   cancelado  → se abandonó (con motivo)
 *
 * Los renglones NO se guardan aquí: se derivan en el momento de `fiscal.cfdis` +
 * `finance.gl_supplier_accounts`. Guardar una copia sería materializar un valor que ya
 * tiene fuente, y quedaría desfasado en cuanto llegue una factura nueva.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_runs'))) {
    await knex.raw(`
      CREATE TABLE finance.purchase_book_runs (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        anio_mes          text NOT NULL,                 -- 'YYYY-MM'
        estado            text NOT NULL DEFAULT 'borrador',
        folio_poliza      int  NOT NULL DEFAULT 1,
        fecha_poliza      date,                          -- último día del mes
        concepto          text,

        -- Qué se entregó. Los totales se congelan al generar para poder comparar después.
        facturas          int,
        renglones         int,
        total_cargos      numeric(16,2),
        total_abonos      numeric(16,2),
        subtotal_exento   numeric(16,2),
        subtotal_gravado  numeric(16,2),
        total_iva         numeric(16,2),
        total_ieps        numeric(16,2),
        archivo_hash      text,                          -- sha256 del TXT entregado
        archivo_nombre    text,

        -- Cómo se armó (las decisiones de formato que cambian el archivo)
        impuestos_modo    text NOT NULL DEFAULT 'global',   -- global | por-cuenta
        incluye_uuid      boolean NOT NULL DEFAULT false,

        generado_at       timestamptz,
        generado_by       uuid,
        entregado_at      timestamptz,
        entregado_by      uuid,
        entregado_a       text,                          -- a quién se le pasó
        aplicado_at       timestamptz,
        aplicado_by       uuid,
        notas             text,

        created_at        timestamptz NOT NULL DEFAULT now(),
        created_by        uuid,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        uuid,
        deleted_at        timestamptz,
        deleted_by        uuid,
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, anio_mes, folio_poliza),
        CONSTRAINT purchase_book_runs_estado_valido
          CHECK (estado IN ('borrador','generado','entregado','aplicado','cancelado')),
        CONSTRAINT purchase_book_runs_mes_valido
          CHECK (anio_mes ~ '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT purchase_book_runs_impuestos_valido
          CHECK (impuestos_modo IN ('global','por-cuenta'))
      )`);
    await knex.raw(`CREATE INDEX ix_pbr_mes ON finance.purchase_book_runs (tenant_id, anio_mes DESC)`);

    await knex.raw(`ALTER TABLE finance.purchase_book_runs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.purchase_book_runs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY purchase_book_runs_tenant ON finance.purchase_book_runs
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.purchase_book_runs TO app_runtime`);
  }

  // Qué facturas entraron en cada corrida. Esto SÍ se guarda: es la decisión de qué se
  // incluyó, y mientras LC.2 siga abierto esa decisión la toma un humano, así que no se
  // puede volver a derivar sola.
  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_run_items'))) {
    await knex.raw(`
      CREATE TABLE finance.purchase_book_run_items (
        tenant_id     uuid NOT NULL,
        run_id        uuid NOT NULL,
        cfdi_uuid     varchar(36) NOT NULL,
        incluida      boolean NOT NULL DEFAULT true,
        motivo        text,                    -- por qué se excluyó, si aplica
        origen        text NOT NULL DEFAULT 'manual',  -- manual | regla | libro_previo
        created_at    timestamptz NOT NULL DEFAULT now(),
        created_by    uuid,
        PRIMARY KEY (tenant_id, run_id, cfdi_uuid)
      )`);
    await knex.raw(`CREATE INDEX ix_pbri_run ON finance.purchase_book_run_items (tenant_id, run_id) WHERE incluida`);
    await knex.raw(`ALTER TABLE finance.purchase_book_run_items ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.purchase_book_run_items FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY purchase_book_run_items_tenant ON finance.purchase_book_run_items
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.purchase_book_run_items TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('purchase_book_run_items');
  await knex.schema.withSchema('finance').dropTableIfExists('purchase_book_runs');
};
