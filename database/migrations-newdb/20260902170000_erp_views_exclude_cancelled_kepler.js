/**
 * Excluir documentos CANCELADOS de Kepler (`kdm1.c43='C'`) de las cuatro vistas
 * derive-no-copy sobre `kepler_ods.kdm1`. Sin este filtro, un pago/entrada/cobro que se
 * canceló en el ERP seguía apareciendo en /finanzas/pagos-comprobantes, /compras/entradas,
 * /finanzas/cobranza y — lo que motivó el fix — en los CUADRES, inflando el lado Kepler.
 *
 * Evidencia (ODS, 2026-09-02): sólo la sucursal 00 traía 1,069 pagos y 468 entradas con
 * `c43='C'`. Ejemplo reportado por Edgar: pago XD-26 folio 0018321 (cancelado) casaba en el
 * cuadre como si fuera real.
 *
 * `c43='C'` = cancelado es la señal canónica de tesorería/documentos Kepler (ver
 * [[reference_kepler_treasury_bank_movements]]; ya la aplican import-kepler-bank-movements,
 * import-expense-requests e import-replenishment-plan). Como estas son VISTAS sobre el ODS
 * (no espejos UPSERT), excluir al leer es auto-sanable: cuando un doc se cancela en Kepler,
 * la siguiente sincronía del ODS lo saca de la vista sin dejar fantasmas — nada que borrar.
 *
 * `CREATE OR REPLACE` (nunca DROP): sólo se AGREGA un predicado al WHERE de la pierna Kepler;
 * la lista de columnas (nombre/tipo/orden) no cambia, que es lo único que Postgres reemplaza
 * en caliente. Respeta [[feedback_recreate_view_live_cached_plan]] (nada cuelga de estas vistas
 * con DROP). La pierna Wincaja de erp_goods_receipts NO se toca: movimiento_proveedores no trae
 * bandera de cancelación (verificado: 0 columnas cancel/estatus/anul).
 *
 * SQL reproducido VERBATIM de las migraciones dueñas actuales (idéntico a pg_get_viewdef):
 *   · erp_supplier_payments / erp_collections → 20260819220000_payments_collections_live_views
 *   · erp_goods_receipts                       → 20260831190000_re1_goods_receipts_vencimiento
 *   · erp_goods_receipt_lines                  → 20260819120000_erp_goods_receipts_live_view
 * Lo ÚNICO nuevo respecto de esas: la línea "AND btrim(coalesce(<ap>.c43::text,'')) <> 'C'".
 *
 * Además crea `analytics.kepler_cancelled_docs`: los documentos EXCLUIDOS (c43='C'), consolidados
 * y tipados (pago/entrada/cobro), con el MISMO alcance que las vistas de las que salieron (pagos y
 * cobros = CEDIS 00; entradas = todas las sucursales, anti-réplica c1=sucursal). Es la fuente del
 * "apartado pequeño" para auditar cancelados sin que ensucien los cuadres.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return; // entorno sin ODS: nada que derivar

  const isView = async (rel) => {
    const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass(?)`, [rel]);
    return r.rows[0]?.relkind === 'v';
  };

  // ── PAGOS A PROVEEDOR (XD2501/2601/6001, CEDIS md_00) ─────────────────────
  if (await isView('analytics.erp_supplier_payments')) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.erp_supplier_payments AS
      SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio)
        '${M}'::uuid AS tenant_id, q.sucursal, q.folio, q.doc_prefix, q.pago_date,
        q.proveedor_code, q.proveedor_nombre, q.proveedor_rfc, q.concepto, q.monto,
        'md_00'::text AS source_branch, now() AS computed_at, q.metodo_pago, q.descuento, w.id AS warehouse_id
      FROM (
        SELECT '00'::text AS sucursal, btrim(c6::text) AS folio,
          CASE btrim(c4::text) WHEN '26' THEN 'XD2601' WHEN '60' THEN 'XD6001' ELSE 'XD2501' END AS doc_prefix,
          CASE WHEN lower(btrim(c31::text)) LIKE 'tra%' THEN 'transferencia'
               WHEN lower(btrim(c31::text)) LIKE 'che%' THEN 'cheque'
               WHEN lower(btrim(c31::text)) LIKE 'ant%' THEN 'anticipo' END AS metodo_pago,
          c9::date AS pago_date, NULLIF(btrim(c10::text),'') AS proveedor_code,
          NULLIF(btrim(c32::text),'') AS proveedor_nombre, NULLIF(btrim(c22::text),'') AS proveedor_rfc,
          NULLIF(btrim(c24::text),'') AS concepto,
          round(coalesce(nullif(regexp_replace(c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
          round(coalesce(nullif(regexp_replace(c84::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS descuento
        FROM kepler_ods.kdm1
        WHERE c2='X' AND c3='D' AND btrim(c4::text) IN ('25','26','60') AND btrim(c10::text) ILIKE 'C%'
          AND sucursal::text='00' AND btrim(c1::text)='00'
          AND btrim(coalesce(c43::text,'')) <> 'C'   -- excluye documentos cancelados
      ) q
      LEFT JOIN commercial.warehouses w ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL
      ORDER BY q.sucursal, q.doc_prefix, q.folio`);
    await knex.raw('GRANT SELECT ON analytics.erp_supplier_payments TO app_runtime');
  }

  // ── COBROS (UA0501, CEDIS md_00) ──────────────────────────────────────────
  if (await isView('analytics.erp_collections')) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.erp_collections AS
      SELECT DISTINCT ON (q.sucursal, q.folio)
        '${M}'::uuid AS tenant_id, q.sucursal, q.folio, q.doc_prefix, q.cobro_date,
        q.cliente_code, q.cliente_nombre, q.concepto, q.forma_pago, q.monto, q.tipo_cuenta,
        'md_00'::text AS source_branch, now() AS computed_at, w.id AS warehouse_id
      FROM (
        SELECT '00'::text AS sucursal, btrim(c6::text) AS folio, 'UA0501'::text AS doc_prefix,
          c9::date AS cobro_date, NULLIF(btrim(c10::text),'') AS cliente_code, NULLIF(btrim(c32::text),'') AS cliente_nombre,
          NULLIF(btrim(c24::text),'') AS concepto,
          CASE WHEN upper(c24::text) ~ 'DEP[OÓ]SITO|\\mDEP\\M' THEN 'deposito'
               WHEN upper(c24::text) ~ 'TRANSFER|SPEI' THEN 'transferencia'
               WHEN upper(c24::text) ~ 'TARJETA|TARJ|TDC|TDD' THEN 'tarjeta'
               WHEN upper(c24::text) ~ 'EFECTIVO|EFVO|EFECTICO' THEN 'efectivo'
               WHEN upper(c24::text) ~ 'CHEQUE|\\mCHQ\\M' THEN 'cheque' ELSE 'otro' END AS forma_pago,
          round(coalesce(nullif(regexp_replace(c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
          CASE WHEN btrim(c10::text) ~* '^(RUTA|R\\.?[DV]\\.?|R[DV][\\s\\-0-9])' THEN 'ruta'
               WHEN btrim(c10::text) ~ '^\\d{2}-\\d{2}' THEN 'interno' ELSE 'cliente_final' END AS tipo_cuenta
        FROM kepler_ods.kdm1
        WHERE c2='U' AND c3='A' AND btrim(c4::text)='5' AND sucursal::text='00' AND btrim(c1::text)='00'
          AND btrim(coalesce(c43::text,'')) <> 'C'   -- excluye cobros cancelados
      ) q
      LEFT JOIN commercial.warehouses w ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL
      ORDER BY q.sucursal, q.folio`);
    await knex.raw('GRANT SELECT ON analytics.erp_collections TO app_runtime');
  }

  // ── ÓRDENES DE ENTRADA (XA2001, 00-06) + Wincaja (30/32/50) ───────────────
  //     Sólo la pierna Kepler filtra c43; Wincaja no trae bandera de cancelación.
  if (await isView('analytics.erp_goods_receipts')) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
      SELECT '${M}'::uuid AS tenant_id,
         ap.sucursal,
         btrim(ap.c6) AS folio,
         'XA2001'::text AS doc_prefix,
         ap.c9::date AS receipt_date,
         NULLIF(btrim(ap.c10), ''::text) AS proveedor_code,
         NULLIF(btrim(ap.c32), ''::text) AS proveedor_nombre,
         NULLIF(btrim(ap.c22), ''::text) AS proveedor_rfc,
         oe.vale_folio,
         oe.oc_folio,
         NULLIF(btrim(ap.c24), ''::text) AS concepto,
         round(COALESCE(NULLIF(regexp_replace(ap.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
         'md_'::text || ap.sucursal AS source_branch,
         now() AS computed_at,
         dd.dup_of_sucursal,
         dd.dup_of_folio,
         wk.id AS warehouse_id,
         ap.c18::date AS fecha_vence,
         NULLIF(btrim(ap.c30::text), ''::text) AS condicion_pago,
         (ap.c18::date - ap.c9::date) AS dias_credito
        FROM kepler_ods.kdm1 ap
          LEFT JOIN LATERAL ( SELECT NULLIF(btrim(oe_1.c39), ''::text) AS vale_folio,
                 ( SELECT NULLIF(btrim(v.c39), ''::text) AS "nullif"
                        FROM kepler_ods.kdm1 v
                       WHERE v.sucursal = oe_1.sucursal AND v.c2 = 'X'::text AND v.c3 = 'A'::text AND btrim(v.c4::text) = '37'::text AND btrim(v.c6) = btrim(oe_1.c39)
                       ORDER BY (btrim(v.c6))
                      LIMIT 1) AS oc_folio
                FROM kepler_ods.kdm1 oe_1
               WHERE oe_1.sucursal = ap.sucursal AND oe_1.c2 = 'X'::text AND oe_1.c3 = 'A'::text AND btrim(oe_1.c4::text) = '40'::text AND btrim(oe_1.c6) = btrim(ap.c39)
               ORDER BY (btrim(oe_1.c39))
              LIMIT 1) oe ON true
          LEFT JOIN warehouses wk ON wk.tenant_id = '${M}'::uuid AND wk.code::text = ap.sucursal AND wk.deleted_at IS NULL
          LEFT JOIN analytics.erp_goods_receipt_dedup dd ON dd.tenant_id = '${M}'::uuid AND ap.sucursal = '00'::text AND dd.cedis_folio = btrim(ap.c6) AND (dd.status = ANY (ARRAY['auto'::text, 'confirmado'::text]))
       WHERE ap.c2 = 'X'::text AND ap.c3 = 'A'::text AND btrim(ap.c4::text) = '20'::text AND btrim(ap.c1) = ap.sucursal
         AND btrim(coalesce(ap.c43::text,'')) <> 'C'   -- excluye entradas canceladas (Kepler)
      UNION ALL
       SELECT '${M}'::uuid AS tenant_id,
         mp.source_branch AS sucursal,
         btrim(mp.documento) AS folio,
         'WCJ-'::text || btrim(mp.tipo) AS doc_prefix,
         mp.fecha::date AS receipt_date,
         NULLIF(btrim(mp.tercero), ''::text) AS proveedor_code,
         pr.nombre AS proveedor_nombre,
         pr.rfc AS proveedor_rfc,
         NULL::text AS vale_folio,
         NULL::text AS oc_folio,
         NULL::text AS concepto,
         round(COALESCE(mp.valor, 0::numeric) + COALESCE(mp.iva, 0::numeric) + COALESCE(mp.ieps, 0::numeric), 2) AS monto,
         'wincaja_'::text || mp.source_branch AS source_branch,
         now() AS computed_at,
         NULL::text AS dup_of_sucursal,
         NULL::text AS dup_of_folio,
         ww.id AS warehouse_id,
         mp.fecha_vencimiento::date AS fecha_vence,
         NULL::text AS condicion_pago,
         (mp.fecha_vencimiento::date - mp.fecha::date) AS dias_credito
        FROM wincaja.movimiento_proveedores mp
          JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code ~~ 'MD-%'::text
          LEFT JOIN ( SELECT proveedores.source_branch,
                 proveedores.proveedor,
                 max(proveedores.nombre) AS nombre,
                 max(proveedores.rfc) AS rfc
                FROM wincaja.proveedores
               WHERE proveedores.tenant_id = '${M}'::uuid
               GROUP BY proveedores.source_branch, proveedores.proveedor) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
          LEFT JOIN warehouses ww ON ww.tenant_id = '${M}'::uuid AND ww.wincaja_source_branch = mp.source_branch AND ww.deleted_at IS NULL
       WHERE mp.tenant_id = '${M}'::uuid AND mp.source_dataset = 'actual'::text AND (mp.tipo = ANY (ARRAY['CR'::text, 'CC'::text]))
    `);
    await knex.raw('GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime');
  }

  // ── LÍNEAS DE ORDEN DE ENTRADA (XA2001, kdm2) ─────────────────────────────
  if (await isView('analytics.erp_goods_receipt_lines')) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.erp_goods_receipt_lines AS
      SELECT
        '${M}'::uuid                    AS tenant_id,
        ap.sucursal::text               AS sucursal,
        btrim(ap.c6::text)              AS folio,
        btrim(l.c7::text)               AS linea,
        NULLIF(btrim(l.c8::text),'')    AS sku,
        NULLIF(btrim(l.c10::text),'')   AS nombre,
        round(coalesce(nullif(regexp_replace(l.c9::text,'[^0-9.-]','','g'),'')::numeric,0),4)  AS cantidad,
        NULLIF(btrim(l.c11::text),'')   AS unidad,
        round(coalesce(nullif(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric,0),4) AS costo_unitario,
        round(coalesce(nullif(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
        now()                           AS computed_at
      FROM kepler_ods.kdm1 ap
      JOIN kepler_ods.kdm2 l
        ON l.sucursal=ap.sucursal AND l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
      WHERE ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20' AND btrim(ap.c1::text)=ap.sucursal::text
        AND btrim(coalesce(ap.c43::text,'')) <> 'C'   -- excluye líneas de entradas canceladas
    `);
    await knex.raw('GRANT SELECT ON analytics.erp_goods_receipt_lines TO app_runtime');
  }

  // ── APARTADO: DOCUMENTOS CANCELADOS (c43='C') consolidados ────────────────
  //     Lo que las vistas de arriba EXCLUYEN, aquí se puede ver — mismo alcance
  //     que cada una (pagos/cobros = CEDIS 00; entradas = todas, anti-réplica c1=sucursal).
  //     categoria tipa el doc para filtrar; monto/fecha/contraparte para auditar.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.kepler_cancelled_docs AS
    SELECT
      '${M}'::uuid AS tenant_id,
      btrim(c1::text) AS sucursal,
      btrim(c2::text)||'-'||btrim(c3::text)||'-'||btrim(c4::text) AS doc_tipo,
      CASE
        WHEN c2='X' AND c3='D' AND btrim(c4::text)='26' THEN 'XD2601'
        WHEN c2='X' AND c3='D' AND btrim(c4::text)='25' THEN 'XD2501'
        WHEN c2='X' AND c3='D' AND btrim(c4::text)='60' THEN 'XD6001'
        WHEN c2='X' AND c3='A' AND btrim(c4::text)='20' THEN 'XA2001'
        WHEN c2='U' AND c3='A' AND btrim(c4::text)='5'  THEN 'UA0501'
      END AS doc_prefix,
      CASE
        WHEN c2='X' AND c3='D' THEN 'pago'
        WHEN c2='X' AND c3='A' THEN 'entrada'
        WHEN c2='U' AND c3='A' THEN 'cobro'
      END AS categoria,
      btrim(c6::text) AS folio,
      c9::date AS fecha,
      round(coalesce(nullif(regexp_replace(c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
      NULLIF(btrim(c10::text),'') AS contraparte_code,
      NULLIF(btrim(c32::text),'') AS contraparte_nombre,
      NULLIF(btrim(c24::text),'') AS concepto,
      NULLIF(btrim(c31::text),'') AS metodo
    FROM kepler_ods.kdm1
    WHERE btrim(coalesce(c43::text,''))='C'
      AND (
        (c2='X' AND c3='D' AND btrim(c4::text) IN ('25','26','60') AND btrim(c10::text) ILIKE 'C%' AND sucursal::text='00' AND btrim(c1::text)='00')  -- pagos CEDIS
        OR (c2='U' AND c3='A' AND btrim(c4::text)='5'  AND sucursal::text='00' AND btrim(c1::text)='00')                                              -- cobros CEDIS
        OR (c2='X' AND c3='A' AND btrim(c4::text)='20' AND btrim(c1::text)=sucursal::text)                                                            -- entradas todas
      )
  `);
  await knex.raw('GRANT SELECT ON analytics.kepler_cancelled_docs TO app_runtime');
};

/**
 * No-op deliberado. El cambio es un predicado extra en el WHERE (excluir cancelados); revertir
 * exigiría re-emitir la definición previa desde su migración dueña. Si de verdad hay que
 * "des-excluir" cancelados, se re-corre la migración dueña de cada vista (ver cabecera).
 */
exports.down = async function () {
  /* aditivo (filtro): no se revierte */
};
