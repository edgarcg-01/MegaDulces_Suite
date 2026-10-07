/**
 * RA-PRO.45.1 — La orden de compra de Kepler se lee de UNA vista normalizada, no re-decodificando
 * `kdm1` en cada consumidor.
 *
 * Contexto: `analytics.erp_purchase_docs` / `_lines` ya son vistas derive-no-copy sobre
 * `kepler_ods` (mig 20260820200000) y cubren X-A-35 (OC) y X-A-37 (vale) con el anti-réplica
 * `c1 = sucursal` ya puesto. Aun así, el motor del pedido y el detalle de "En camino" traían el
 * decode escrito a mano (`c2='X' AND c3='A' AND c4='35'` + la cadena `NOT EXISTS` hasta X-A-40)
 * en CINCO lugares. Es la misma duplicación que ya nos costó el tránsito fantasma: cinco sitios,
 * uno se mueve.
 *
 * Esta migración:
 *
 *  1. Agrega a `erp_purchase_docs` la columna `estatus` (`kdm1.c43`: N pendiente · F finalizada ·
 *     C cancelada · R recibida). Es la segunda fuente independiente de la cadena de documentos.
 *  2. Agrega a `erp_purchase_doc_lines` el EMPAQUE DECLARADO por el proveedor en la línea
 *     (`c55` unidad de caja, `c58` unidades de la línea por caja, `c57` costo de esa caja;
 *     verificado `c12 × c58 = c57`). Es lo que hace convertible una línea sin adivinar la unidad.
 *  3. Crea `analytics.erp_purchase_orders`: SOLO las OC, con la cadena ya resuelta hacia adelante
 *     (`cerrada` = existe vale X-A-37 que apunta a ella y una orden de entrada X-A-40 que apunta
 *     a ese vale) y `dias_abierta`. Un solo lugar donde vive el decode de "OC abierta".
 *
 * Ambos `CREATE OR REPLACE` sólo AGREGAN columnas al final: el conjunto de filas no cambia, así
 * que los consumidores existentes (`entity-ref`, `/compras/entradas`) no se enteran.
 *
 * Por qué la cadena se sigue HACIA ADELANTE y no por `erp_goods_receipts.oc_folio`: esa vista
 * resuelve la OC de origen sólo en el 66.7% de las entradas (medido 2026-08-29). Usarla al revés
 * marcaría como "abiertas" un tercio de las OC ya recibidas.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
/** Numérico de Kepler (texto con formato) → numeric, 0 si viene vacío. */
const NUM = (col, dec) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),${dec})`;
/** Igual pero preserva NULL: "no declarado" ≠ "cero". */
const NUMN = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t, to_regclass('kepler_ods.kdm2') AS l`);
  if (!ods.rows[0]?.t || !ods.rows[0]?.l) {
    console.log('  [RA-PRO.45.1] kepler_ods ausente — no-op (dev local sin réplica).');
    return;
  }
  const cur = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_docs')`);
  if (!cur.rows[0] || cur.rows[0].relkind !== 'v') {
    console.log('  [RA-PRO.45.1] erp_purchase_docs no es vista todavía — no-op (corre después de 20260820200000).');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_purchase_docs AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      CASE btrim(h.c4::text) WHEN '35' THEN 'XA3501' ELSE 'XA3701' END AS doctype,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      h.c9::date                                     AS doc_date,
      h.c18::date                                    AS due_date,
      NULLIF(btrim(h.c10::text),'')                  AS proveedor_code,
      NULLIF(btrim(h.c32::text),'')                  AS proveedor_nombre,
      NULLIF(btrim(h.c22::text),'')                  AS proveedor_rfc,
      NULLIF(btrim(h.c24::text),'')                  AS concepto,
      NULLIF(btrim(h.c30::text),'')                  AS condicion_pago,
      NULLIF(btrim(h.c11::text),'')                  AS referencia,
      ${NUM('h.c16', 2)}                             AS monto,
      NULLIF(btrim(h.c37::text),'')                  AS ref_doctype,
      NULLIF(btrim(h.c39::text),'')                  AS ref_folio,
      ('md_'||h.sucursal)::text                      AS source_branch,
      now()                                          AS computed_at,
      -- RA-PRO.45: estatus del documento en el propio ERP.
      COALESCE(NULLIF(btrim(h.c43::text),''), 'N')   AS estatus
    FROM kepler_ods.kdm1 h
    WHERE h.c2='X' AND h.c3='A' AND btrim(h.c4::text) IN ('35','37')
      AND btrim(h.c1::text)=h.sucursal::text
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_purchase_doc_lines AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      CASE btrim(h.c4::text) WHEN '35' THEN 'XA3501' ELSE 'XA3701' END AS doctype,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      btrim(l.c7::text)                              AS linea,
      NULLIF(btrim(l.c8::text),'')                   AS sku,
      NULLIF(btrim(l.c10::text),'')                  AS nombre,
      ${NUM('l.c9', 4)}                              AS cantidad,
      NULLIF(btrim(l.c11::text),'')                  AS unidad,
      ${NUM('l.c12', 4)}                             AS costo_unitario,
      ${NUM('l.c13', 2)}                             AS importe,
      now()                                          AS computed_at,
      -- RA-PRO.43/45: el EMPAQUE que declara el proveedor en la línea. NULL = no lo declaró
      -- (por eso NUMN y no NUM: un 0 acá se leería como "una caja de cero piezas").
      NULLIF(btrim(l.c55::text),'')                  AS unidad_caja,
      ${NUMN('l.c58', 4)}                            AS unidades_por_caja,
      ${NUMN('l.c57', 4)}                            AS costo_caja
    FROM kepler_ods.kdm1 h
    JOIN kepler_ods.kdm2 l
      ON l.sucursal=h.sucursal AND l.c1=h.c1 AND l.c2=h.c2 AND l.c3=h.c3 AND l.c4=h.c4 AND l.c6=h.c6
    WHERE h.c2='X' AND h.c3='A' AND btrim(h.c4::text) IN ('35','37')
      AND btrim(h.c1::text)=h.sucursal::text
  `);

  // La OC con su cadena resuelta: el decode de "OC abierta" vive UNA vez y ningún servicio ni
  // importer vuelve a escribirlo.
  //
  // ⚠ Va directo sobre `kepler_ods.kdm1`, NO sobre `erp_purchase_docs`, y compara las columnas
  // CRUDAS (`c4=35`, `c37=35`, `c39=c6`) en vez de las saneadas con btrim. Se midió: la versión
  // encima de la vista base tardaba **331 s** contra ~2 s ésta. Motivo: el índice que sostiene la
  // cadena es `ix_ods_kdm1_xa_c39 (sucursal, c39, c37)` sobre columnas crudas, y envolverlas en
  // btrim() lo inutiliza — un seq scan por OC. El btrim se queda donde no cuesta: en la SALIDA.
  // (Mismo patrón que GOTCHAS "mismo SQL NO implica mismo plan" al repointear al ODS.)
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_purchase_orders AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      h.c9::date                                     AS doc_date,
      (CURRENT_DATE - h.c9::date)                    AS dias_abierta,
      NULLIF(btrim(h.c10::text),'')                  AS proveedor_code,
      NULLIF(btrim(h.c32::text),'')                  AS proveedor_nombre,
      NULLIF(btrim(h.c22::text),'')                  AS proveedor_rfc,
      NULLIF(btrim(h.c24::text),'')                  AS concepto,
      NULLIF(btrim(h.c30::text),'')                  AS condicion_pago,
      ${NUM('h.c16', 2)}                             AS monto,
      COALESCE(NULLIF(btrim(h.c43::text),''), 'N')   AS estatus,
      ('md_'||h.sucursal)::text                      AS source_branch,
      EXISTS (
        SELECT 1
          FROM kepler_ods.kdm1 vale
          JOIN kepler_ods.kdm1 oe
            ON oe.sucursal=vale.sucursal AND oe.c1=vale.c1
           AND oe.c2='X' AND oe.c3='A' AND oe.c4='40' AND oe.c37='37' AND oe.c39=vale.c6
         WHERE vale.sucursal=h.sucursal AND vale.c1=h.c1
           AND vale.c2='X' AND vale.c3='A' AND vale.c4='37'
           AND vale.c37='35' AND vale.c39=h.c6
      )                                              AS cerrada,
      now()                                          AS computed_at
    FROM kepler_ods.kdm1 h
    WHERE h.c2='X' AND h.c3='A' AND h.c4='35' AND h.sucursal=h.c1
  `);

  await knex.raw('GRANT SELECT ON analytics.erp_purchase_orders TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.erp_purchase_orders IS
    'RA-PRO.45.1 — Órdenes de compra de Kepler (X-A-35) con la cadena ya resuelta: cerrada = tiene '
    'vale X-A-37 con orden de entrada X-A-40 aguas abajo. Único lugar donde vive el decode de '
    '"OC abierta"; lo leen el fact del pedido, el detalle de En camino y la bandeja de OC abiertas.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_purchase_orders');
  // Las columnas agregadas a las vistas base se quedan: quitarlas exigiría DROP+CREATE y las
  // versiones previas no las usaban, así que sobran sin estorbar.
};
