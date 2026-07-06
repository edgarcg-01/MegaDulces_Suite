/**
 * GX v3 — Drill al documento fuente detrás de cada póliza de egreso.
 *
 * `analytics.expense_documents`      = cabecera del documento Kepler (kdm1) que
 *                                      respalda la póliza (proveedor, RFC, concepto,
 *                                      área, fecha, total, IVA, usuario, solicitud).
 * `analytics.expense_document_lines` = líneas de detalle (kdm2) — SOLO existen para
 *                                      compras (XA2001): producto/SKU, cantidad,
 *                                      presentación, costo unitario, importe.
 *
 * Llave de enlace con la póliza (analytics.expense_entries) y con Kepler:
 *   (tenant_id, sucursal, doc_tipo, doc_folio)
 *   = kdc2.(c14, c15||c16||lpad(c17,2)||lpad(c18,2), c19)
 *   = kdm1.(c1,  c2||c3||lpad(c4,2)||lpad(c5,2),     c6)
 *
 * Decode verificado kdm1: c6=folio, c9=fecha contable, c18=fecha doc, c14=IVA,
 * c16=total, c22=RFC, c24=concepto, c32=beneficiario, c48=área, c67=usuario,
 * c37/c39=doc origen (solicitud XA1501 para gastos). kdm2: c8=SKU, c9=cantidad,
 * c11=presentación, c12=costo unitario, c13=importe de línea.
 *
 * Lo puebla `import-expenses-polizas.js` (mismo nightly que expense_entries).
 * Aditiva, idempotente, schema analytics, sin RLS (filtro de tenant explícito).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('expense_documents'))) {
    await knex.raw(`
      CREATE TABLE analytics.expense_documents (
        tenant_id       uuid NOT NULL,
        sucursal        text NOT NULL,
        doc_tipo        text NOT NULL,
        doc_folio       text NOT NULL,
        fecha           date,
        fecha_doc       date,
        beneficiario    text,
        rfc             text,
        concepto        text,
        area            text,
        importe         numeric DEFAULT 0,   -- total con IVA (kdm1.c16)
        iva             numeric DEFAULT 0,   -- kdm1.c14
        usuario         text,                -- quién capturó (kdm1.c67)
        solicitud_tipo  text,                -- doc origen (ej XA1501) para gastos
        solicitud_folio text,
        clase           text,                -- Apl/Gas/Fac/Tra/Sol… (kdm1.c31)
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, doc_tipo, doc_folio)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expdoc_fecha ON analytics.expense_documents (tenant_id, fecha)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expdoc_benef ON analytics.expense_documents (tenant_id, beneficiario)`);
    await knex.raw(`GRANT SELECT ON analytics.expense_documents TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('expense_document_lines'))) {
    await knex.raw(`
      CREATE TABLE analytics.expense_document_lines (
        tenant_id      uuid NOT NULL,
        sucursal       text NOT NULL,
        doc_tipo       text NOT NULL,
        doc_folio      text NOT NULL,
        linea          int  NOT NULL,
        fecha          date,                -- = fecha de la póliza padre (idempotencia por ventana)
        sku            text,
        producto       text,                -- nombre del producto (kdm2.c10)
        cantidad       numeric,
        presentacion   text,
        costo_unitario numeric,
        importe        numeric DEFAULT 0,   -- importe de línea (kdm2.c13)
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, doc_tipo, doc_folio, linea)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expline_doc ON analytics.expense_document_lines (tenant_id, sucursal, doc_tipo, doc_folio)`);
    await knex.raw(`GRANT SELECT ON analytics.expense_document_lines TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_document_lines');
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_documents');
};
