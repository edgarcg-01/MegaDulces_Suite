/**
 * ER.7 — Orden de compra (X-A-35) y Vale de entrada (X-A-37) como documentos abribles.
 *
 * Hasta ahora `erp_goods_receipts.oc_folio` y `.vale_folio` eran TEXTO: la recepción
 * decía de qué OC venía, pero no había forma de abrirla — no existía la tabla. El panel
 * de ficha lo declaraba como hueco. Esto lo cierra.
 *
 * Cadena completa de compra en Kepler (kdm1, género X-A):
 *   Requisición 30 → **OC 35** → **Vale 37** → Orden de entrada 40 → Aplica 20 (XA2001)
 *
 * UNA sola tabla para los dos doctypes, no dos: verificado en vivo (CEDIS) que X-A-35 y
 * X-A-37 tienen EXACTAMENTE el mismo shape en kdm1/kdm2 — el vale es la OC "aterrizada"
 * con `c37`='35' + `c39`=folio de su OC. Partirlas en dos tablas duplicaría importer,
 * índices y código del resolvedor para ganar nada. `doctype` va en la PK, así que sumar
 * la requisición (X-A-30) mañana es una fila más, no una migración.
 *
 * Read-only sobre Kepler (lo puebla `import-purchase-docs.js` desde la LAN — Railway no
 * alcanza las DBs de sucursal). Convención analytics.*: sin RLS, filtro `tenant_id`
 * explícito en el service + GRANT SELECT a app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('erp_purchase_docs'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_purchase_docs (
        tenant_id        uuid NOT NULL,
        doctype          text NOT NULL,            -- XA3501 = orden de compra · XA3701 = vale de entrada
        sucursal         text NOT NULL,            -- kdm1.c1 (la propia; las réplicas se filtran en el importer)
        folio            text NOT NULL,            -- kdm1.c6 (con ceros a la izquierda, se guarda como texto)
        doc_date         date,                     -- kdm1.c9
        due_date         date,                     -- kdm1.c18 (vence = c9 + días de la condición)
        proveedor_code   text,                     -- kdm1.c10
        proveedor_nombre text,                     -- kdm1.c32
        proveedor_rfc    text,                     -- kdm1.c22
        concepto         text,                     -- kdm1.c24
        condicion_pago   text,                     -- kdm1.c30 ("Pago de contado", "30 días fecha factura"…)
        referencia       text,                     -- kdm1.c11 (referencia del proveedor / remisión)
        monto            numeric NOT NULL DEFAULT 0,  -- kdm1.c16
        -- A qué documento ANTERIOR de la cadena apunta. En el vale: ref_doctype='35' y
        -- ref_folio = folio de su OC. En la OC viene vacío (arriba está la requisición).
        ref_doctype      text,                     -- kdm1.c37
        ref_folio        text,                     -- kdm1.c39
        source_branch    text,                     -- md_00 … md_06
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, doctype, sucursal, folio)
      )`);
    await knex.raw(`CREATE INDEX ix_erppd_fecha ON analytics.erp_purchase_docs (tenant_id, doctype, doc_date DESC)`);
    await knex.raw(`CREATE INDEX ix_erppd_prov ON analytics.erp_purchase_docs (tenant_id, proveedor_code)`);
    // El salto que más se usa: del vale a su OC, y de la OC a los vales que la aterrizaron.
    await knex.raw(`CREATE INDEX ix_erppd_ref ON analytics.erp_purchase_docs (tenant_id, sucursal, ref_folio) WHERE ref_folio IS NOT NULL`);
    await knex.raw(`GRANT SELECT ON analytics.erp_purchase_docs TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('erp_purchase_doc_lines'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_purchase_doc_lines (
        tenant_id        uuid NOT NULL,
        doctype          text NOT NULL,
        sucursal         text NOT NULL,
        folio            text NOT NULL,
        linea            text NOT NULL,            -- kdm2.c7
        sku              text,                     -- kdm2.c8
        nombre           text,                     -- kdm2.c10
        cantidad         numeric NOT NULL DEFAULT 0,  -- kdm2.c9
        unidad           text,                     -- kdm2.c11
        costo_unitario   numeric NOT NULL DEFAULT 0,  -- kdm2.c12
        importe          numeric NOT NULL DEFAULT 0,  -- kdm2.c13
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, doctype, sucursal, folio, linea)
      )`);
    // Para "¿qué OCs pidieron este SKU?" desde la ficha del producto.
    await knex.raw(`CREATE INDEX ix_erppdl_sku ON analytics.erp_purchase_doc_lines (tenant_id, sku) WHERE sku IS NOT NULL`);
    await knex.raw(`GRANT SELECT ON analytics.erp_purchase_doc_lines TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.erp_purchase_doc_lines`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.erp_purchase_docs`);
};
