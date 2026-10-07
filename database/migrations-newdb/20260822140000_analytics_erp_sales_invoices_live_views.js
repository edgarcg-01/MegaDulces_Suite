/**
 * Fase AX.0 — Facturas de venta a nivel documento, DERIVE-NO-COPY.
 *
 * Dos vistas EN VIVO sobre `kepler_ods.*` (sin tabla, sin importer): heredan la frescura
 * del CDC WAL (~segundos). Cualquier tabla copiada aquí reintroduciría lag de batch, que es
 * justo lo que la Fase CDC quitó. Mismo patrón que `analytics.erp_collections` /
 * `erp_supplier_payments` (mig 20260819220000).
 *
 * DOCTYPES incluidos — decidido con datos (30d), no por catálogo:
 *   U/D/8  Factura Telemarketing  5,958 líneas · 0 servicio · 100% producto  ✅
 *   U/D/12 Venta a crédito        3,306 líneas · 11 servicio · 99.7% producto ✅
 *   U/D/13 (EXCLUIDO)             1,097 líneas · 1,097 SERVICIO · 0 producto  ❌
 *          = factura del traspaso CEDIS (el detalle real vive en U/D/41). Meterla llenaría
 *          el anexo de renglones sin producto. `import-customer-receivables` agrupa 12+13
 *          como "venta crédito": correcto para saldos, incorrecto para detalle de producto.
 *   U/D/10 (fuera de alcance)     factura de mostrador/contado, 160k docs/90d.
 *
 * DEDUPE: `kdm1`/`kdm2` arrastran la réplica de cada rama en las demás → `btrim(c1)=btrim(sucursal)`
 * deja solo la copia propia (mismo filtro que usaba el importer per-branch).
 *
 * DECODE verificado en vivo (factura 06 UD0801-0000087, agosto 2026):
 *   kdm1: c5=serie c6=folio c9=fecha c10=cliente c11=referencia c12=VENDEDOR c13=descuento
 *         c15=IEPS c16=total c19=%desc c22=RFC c27=canal c31=tipo c32..c35=nombre/domicilio
 *         c37/c38/c39=documento padre (pedido)
 *   kdm2: c7=nº línea c8=sku c9=cantidad c10=descripción c11=unidad c12=precio unitario
 *         c13=importe de línea (c13 = c9×c12)
 *   kdud: c15=límite de crédito · c16=DÍAS de crédito · c17=% descuento del cliente
 *         (c14 NO es el límite: es la zona)
 *   kduv: c2=código de vendedor → c3=nombre
 *   Tipos en kepler_ods son los del origen: c4/c5/c37/c38 numeric → castear, no btrim.
 *
 * VENCIMIENTO: `fecha + dias_credito`; si el cliente no tiene días asignados (0/NULL) vence
 * al día siguiente (regla de negocio, Edgar 2026-08-22). NO se usa `kdm1.c18`: se verificó
 * que trae fechas ANTERIORES a la propia factura en varios documentos.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// Money defensivo: kepler_ods conserva el tipo del origen y hay columnas sucias.
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
// Filtro común de documento (cabecera y líneas deben coincidir o el JOIN miente).
const DOCFILTER = `h.c2='U' AND h.c3='D' AND (h.c4)::int IN (8,12) AND btrim(h.c1)=btrim(h.sucursal)`;

exports.up = async function up(knex) {
  // ── CABECERAS ───────────────────────────────────────────────────────────
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_sales_invoices`);

  await knex.raw(`
    CREATE VIEW analytics.erp_sales_invoices AS
    SELECT
      '${M}'::uuid AS tenant_id,
      q.sucursal, w.id AS warehouse_id,
      q.doc_prefix, q.doc_tipo, q.doc_label, q.folio,
      q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
      q.fecha,
      -- días del cliente; sin días asignados ⇒ vence al día siguiente
      (q.fecha + (COALESCE(NULLIF(q.dias_credito,0),1) || ' days')::interval)::date AS vencimiento,
      q.dias_credito, q.limite_credito,
      q.cliente_code, q.cliente_nombre, q.cliente_rfc,
      q.cliente_domicilio, q.cliente_colonia, q.cliente_estado, q.cliente_cp,
      q.vendedor_code, q.vendedor_nombre,
      q.canal, q.referencia, q.doc_origen,
      q.total, q.ieps, q.descuento, q.descuento_pct,
      -- desglose fiscal: el CFDI presenta subtotal SIN IEPS y el descuento sobre esa base
      round(q.total - q.ieps + q.descuento, 2) AS subtotal,
      'md_' || q.sucursal AS source_branch, now() AS computed_at
    FROM (
      SELECT DISTINCT ON (btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text))
        btrim(h.sucursal) AS sucursal,
        'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
        CASE (h.c4)::int WHEN 8 THEN 'telemarketing' ELSE 'credito' END AS doc_tipo,
        CASE (h.c4)::int WHEN 8 THEN 'Factura Telemarketing' ELSE 'Venta a crédito' END AS doc_label,
        btrim(h.c6::text) AS folio,
        h.c9::date AS fecha,
        NULLIF(btrim(h.c10::text),'') AS cliente_code,
        NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
        NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
        NULLIF(btrim(h.c33::text),'') AS cliente_domicilio,
        NULLIF(btrim(h.c34::text),'') AS cliente_colonia,
        NULLIF(btrim(h.c35::text),'') AS cliente_estado,
        NULLIF(btrim(u.c27::text),'') AS cliente_cp,
        NULLIF(btrim(h.c12::text),'') AS vendedor_code,
        NULLIF(btrim(v.c3::text),'')  AS vendedor_nombre,
        NULLIF(btrim(h.c27::text),'') AS canal,
        NULLIF(btrim(h.c11::text),'') AS referencia,
        CASE WHEN NULLIF(btrim(h.c39::text),'') IS NULL THEN NULL
             ELSE 'UD' || lpad((h.c37)::int::text,2,'0') || lpad((h.c38)::int::text,2,'0')
                  || '-' || btrim(h.c39::text) END AS doc_origen,
        ${money('h.c16')} AS total,
        ${money('h.c15')} AS ieps,
        ${money('h.c13')} AS descuento,
        coalesce(nullif(regexp_replace(h.c19::text,'[^0-9.]','','g'),'')::numeric,0) AS descuento_pct,
        coalesce(nullif(regexp_replace(u.c16::text,'[^0-9]','','g'),'')::int,0) AS dias_credito,
        ${money('u.c15')} AS limite_credito
      FROM kepler_ods.kdm1 h
      LEFT JOIN kepler_ods.kdud u
        ON btrim(u.sucursal)=btrim(h.sucursal) AND btrim(u.c2::text)=btrim(h.c10::text)
      LEFT JOIN kepler_ods.kduv v
        ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
      WHERE ${DOCFILTER}
      ORDER BY btrim(h.sucursal), (h.c4)::int, (h.c5)::int, btrim(h.c6::text)
    ) q
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoices TO app_runtime');

  // ── LÍNEAS ──────────────────────────────────────────────────────────────
  // `factor_caja` (kdii.c84) va aquí porque el anexo lo necesita para la equivalencia
  // paquete↔caja; sin él no se puede mostrar "120 paquetes = 5 cajas".
  await knex.raw(`
    CREATE VIEW analytics.erp_sales_invoice_lines AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(l.sucursal) AS sucursal,
      'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0') AS doc_prefix,
      btrim(l.c6::text) AS folio,
      btrim(l.sucursal) || 'UD' || lpad((l.c4)::int::text,2,'0') || lpad((l.c5)::int::text,2,'0')
        || '-' || btrim(l.c6::text) AS folio_digital,
      (l.c7)::int AS linea,
      btrim(l.c8::text) AS sku,
      NULLIF(btrim(l.c10::text),'') AS descripcion,
      NULLIF(btrim(l.c11::text),'') AS unidad,
      abs(coalesce((l.c9)::numeric,0)) AS cantidad,
      ${money('l.c12')} AS precio_unitario,
      ${money('l.c13')} AS importe,
      -- factor de empaque: >1 sólo cuando el catálogo lo tiene capturado
      NULLIF(coalesce(nullif(regexp_replace(k.c84::text,'[^0-9.]','','g'),'')::numeric,0),0) AS factor_caja,
      p.id AS product_id,
      now() AS computed_at
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 h
      ON btrim(h.sucursal)=btrim(l.sucursal) AND btrim(h.c1)=btrim(l.c1)
     AND h.c2=l.c2 AND h.c3=l.c3 AND (h.c4)::int=(l.c4)::int AND h.c6=l.c6
    LEFT JOIN kepler_ods.kdii k
      ON btrim(k.sucursal)=btrim(l.sucursal) AND btrim(k.c1::text)=btrim(l.c8::text)
    LEFT JOIN catalog.products p
      ON p.tenant_id='${M}'::uuid AND btrim(p.sku)=btrim(l.c8::text) AND p.deleted_at IS NULL
    WHERE ${DOCFILTER}
      AND coalesce(btrim(l.c11::text),'') <> 'SER'
      AND abs(coalesce((l.c9)::numeric,0)) > 0`);
  await knex.raw('GRANT SELECT ON analytics.erp_sales_invoice_lines TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoice_lines');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_sales_invoices');
};
