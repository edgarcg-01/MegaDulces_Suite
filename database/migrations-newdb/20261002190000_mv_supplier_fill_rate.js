'use strict';
/**
 * `[RA-DYN.U6]` — **El cumplimiento del proveedor se MATERIALIZA, y ahora sí por la razón justa.**
 *
 * ── Qué corrige esta migración ───────────────────────────────────────────────────────────────
 * La anterior (`20261002180000`) dejó `analytics.v_supplier_fill_rate` como **vista**, con este
 * argumento: *"2.7 s el universo completo y 0.2 s filtrada por proveedor, así que derivar alcanza"*.
 *
 * **Los 0.2 s eran de otra consulta.** Yo los medí poniendo el filtro del proveedor **dentro** de
 * la CTE que lee las recepciones; la vista lo recibe **sobre el resultado**, después del
 * `GROUP BY`. El predicado no puede bajar hasta ahí, así que cualquier lectura —filtrada o no—
 * paga el universo entero. Medido contra prod el 2026-10-02 sobre la vista ya desplegada:
 *
 *     SELECT ... WHERE proveedor_nombre = 'MONDELEZ ...'   → no termina en 60 s
 *     SELECT count(*) FROM v_supplier_fill_rate            → no termina en 60 s
 *
 * Y quitar `MATERIALIZED` de las CTEs tampoco destraba el pushdown: se probó, mismo resultado.
 *
 * ⚠️ Es la trampa que este repo ya tiene anotada —*medir la consulta REAL, no una parecida*— y
 * la pisé igual. Dejo el detalle porque el error no fue el diseño sino **la medición que lo
 * sostuvo**: un número correcto sobre una forma que el consumidor no puede ejecutar.
 *
 * ── Lo que SÍ sigue valiendo de la vuelta anterior ───────────────────────────────────────────
 * El arreglo de la consulta, que fue enorme y es el que hace viable materializar:
 *
 *     forma con LEFT JOIN entre dos CTEs ...  90 días  49 s  ·  365 días  >50 min sin terminar
 *     forma de UNA pasada con FILTER .......  90 días 0.7 s  ·  365 días      2.7 s
 *
 * La causa era que una CTE materializada no tiene estadísticas: el planificador estimaba
 * `rows=1`, elegía Nested Loop y reescaneaba la relación de recibidos entera por cada fila de
 * pedidos (16,349 × 16,067 ≈ **263 millones de comparaciones**). Con el folio de la OC y el del
 * vale apilados en UNA relación etiquetada, unidos una sola vez y pivotados con `FILTER`, no hay
 * join final que explote. Las dos formas sobre el mismo dato dan **0 filas con cifra distinta**.
 *
 * Gracias a eso, construir la matvista cuesta **~3 min**, no los 50+ de la primera versión.
 *
 * ── El balance que decide ────────────────────────────────────────────────────────────────────
 * Construir una vez cada noche: ~3 min. Leerla: milisegundos. Contra una vista que cobra el
 * universo completo **en cada lectura**. Materializar por costo es legítimo; lo que la regla
 * prohíbe es materializar un valor inventado, y acá cada fila sale de la cadena del ERP.
 *
 * ⚠️ El refresco va `CONCURRENTLY` —por eso el índice único— para no dejar la tabla vacía
 * mientras corre.
 *
 * ⛔ **No cambia ningún número publicado**: nadie consume esto todavía.
 */

const MV = 'analytics.mv_supplier_fill_rate';
const V = 'analytics.v_supplier_fill_rate';
const VL = 'analytics.v_supplier_fill_rate_lines';

exports.up = async function up(knex) {
  // La vista agregada se recrea al final apuntando a la matvista; la de renglones desaparece
  // porque la matvista ocupa su lugar exacto.
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(`DROP VIEW IF EXISTS ${VL}`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    WITH r AS MATERIALIZED (
      SELECT sucursal, oc_folio, vale_folio, proveedor_nombre, receipt_date
        FROM analytics.erp_goods_receipts
       WHERE receipt_date >= current_date - 365
         AND oc_folio IS NOT NULL AND vale_folio IS NOT NULL
    ),
    ocs AS MATERIALIZED (
      SELECT sucursal, oc_folio, max(proveedor_nombre) AS proveedor_nombre,
             min(receipt_date) AS primera_entrega, count(*)::int AS entregas
        FROM r GROUP BY 1, 2
    ),
    -- UNA SOLA PASADA: el folio de la OC y el del vale se apilan etiquetados, se unen una vez
    -- contra los renglones, y el pivote lo hace FILTER. Ver la cabecera: con un LEFT JOIN entre
    -- dos CTEs esto no terminaba en 50 minutos.
    claves AS MATERIALIZED (
      SELECT DISTINCT sucursal, oc_folio, oc_folio AS folio, 'XA3501'::text AS dt FROM r
      UNION ALL
      SELECT DISTINCT sucursal, oc_folio, vale_folio,        'XA3701'::text      FROM r
    ),
    -- ⛔ El puente al catalogo NO puede ser un JOIN directo por nombre: catalog.suppliers tiene
    -- HOMONIMOS -- "SAN SEBASTIAN" aparece 4 veces con codigos 524, 113, CS007 y 165, y
    -- "DISPONIBLE" otras 4. Un join asi multiplica la fila del renglon por cada homonimo y
    -- revienta el indice unico (fue exactamente lo que paso al aplicar la primera vez).
    -- Se resuelve a UNO, de forma determinista por codigo, y la ambiguedad se DECLARA en
    -- supplier_ambiguo: elegir en silencio seria inventar una identidad.
    prov AS (
      SELECT upper(btrim(name)) AS nm,
             (array_agg(id ORDER BY code, id))[1] AS supplier_id,
             count(*)::int                        AS homonimos
        FROM catalog.suppliers
       WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
       GROUP BY 1
    ),
    linea AS (
      SELECT k.sucursal, k.oc_folio, l.sku,
             max(l.nombre) FILTER (WHERE k.dt = 'XA3501')                AS nombre,
             max(l.unidad) FILTER (WHERE k.dt = 'XA3501')                AS unidad,
             COALESCE(sum(l.cantidad) FILTER (WHERE k.dt = 'XA3501'), 0) AS pedido,
             COALESCE(sum(l.importe)  FILTER (WHERE k.dt = 'XA3501'), 0) AS importe_pedido,
             -- Suma TODAS las entregas de esa OC: 9,466 de ~9,750 llegan de una sola vez, pero
             -- 284 vienen partidas y compararlas contra una sola acusaria al proveedor de algo
             -- que si entrego.
             COALESCE(sum(l.cantidad) FILTER (WHERE k.dt = 'XA3701'), 0) AS recibido
        FROM claves k
        JOIN analytics.erp_purchase_doc_lines l
          ON l.doctype = k.dt AND l.folio = k.folio AND l.sucursal = k.sucursal
       GROUP BY 1, 2, 3
    )
    SELECT
      '00000000-0000-0000-0000-00000000d01c'::uuid       AS tenant_id,
      f.sucursal, f.oc_folio, f.sku, f.nombre, f.unidad,
      o.proveedor_nombre,
      p.supplier_id,
      (p.homonimos > 1)                                 AS supplier_ambiguo,
      o.primera_entrega, o.entregas,
      f.pedido, f.recibido, f.importe_pedido,
      round(GREATEST(0, f.pedido - f.recibido)
            / NULLIF(f.pedido, 0) * f.importe_pedido, 2) AS importe_no_surtido,
      CASE
        WHEN f.recibido >= f.pedido THEN 'completo'
        WHEN f.recibido > 0         THEN 'parcial'
        ELSE 'no_surtido'
      END                                                AS veredicto,
      now()                                              AS calculado_al
      FROM linea f
      JOIN ocs o ON o.sucursal = f.sucursal AND o.oc_folio = f.oc_folio
      -- 97% de los 508 proveedores de las recepciones amarran con el catalogo por nombre
      -- normalizado (493). Los 15 que no quedan con supplier_id NULL y se declaran.
      LEFT JOIN prov p ON p.nm = upper(btrim(o.proveedor_nombre))
     WHERE f.pedido > 0
  `);

  // UNIQUE: lo exige REFRESH MATERIALIZED VIEW CONCURRENTLY.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_supplier_fill_rate ON ${MV} (sucursal, oc_folio, sku)`);
  await knex.raw(`CREATE INDEX ix_mv_supplier_fill_rate_prov ON ${MV} (supplier_id, veredicto)`);
  await knex.raw(`CREATE INDEX ix_mv_supplier_fill_rate_nombre ON ${MV} (proveedor_nombre)`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${V} AS
    SELECT
      f.tenant_id, f.supplier_id, f.proveedor_nombre,
      count(*)::int                                              AS renglones,
      count(*) FILTER (WHERE f.veredicto = 'completo')::int       AS completos,
      count(*) FILTER (WHERE f.veredicto = 'parcial')::int        AS parciales,
      count(*) FILTER (WHERE f.veredicto = 'no_surtido')::int     AS no_surtidos,
      round(100.0 * count(*) FILTER (WHERE f.veredicto = 'completo') / count(*), 1)
                                                                  AS pct_completos,
      -- Ponderado por DINERO, no por renglones: uno de $5 y uno de $500,000 no pesan igual en la
      -- conversacion. Las CANTIDADES no se suman entre SKUs (serian unidades distintas); el
      -- importe si es conmensurable.
      round(100.0 * (sum(f.importe_pedido) - sum(f.importe_no_surtido))
            / NULLIF(sum(f.importe_pedido), 0), 1)                AS fill_rate_mxn_pct,
      round(sum(f.importe_pedido), 2)                             AS importe_pedido,
      round(sum(f.importe_no_surtido), 2)                         AS importe_no_surtido,
      count(DISTINCT f.oc_folio)::int                             AS ordenes,
      max(f.primera_entrega)                                      AS ultima_orden,
      -- Sin esto, 100% se lee como "me surte todo" cuando puede ser "solo medi tres renglones".
      CASE WHEN count(*) < 25 THEN 'muestra_chica' ELSE 'medido' END AS veredicto_muestra,
      max(f.calculado_al)                                         AS calculado_al
      FROM ${MV} f
     GROUP BY f.tenant_id, f.supplier_id, f.proveedor_nombre
  `);

  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW ${MV} IS
      '[RA-DYN.U6] Lo pedido en la OC (X-A-35) contra lo recibido en el vale (X-A-37), renglon a '
      'renglon, 365 dias. MATERIALIZADA porque el predicado del proveedor NO puede bajar a traves '
      'del GROUP BY: como vista, cada lectura costaba el universo entero (>60 s). No distingue un '
      'renglon cancelado de uno no surtido -- Kepler no lo marca.'`);

  // ── Verificación ─────────────────────────────────────────────────────────────────────────
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int c FROM ${MV}`);
  if (!n.c) throw new Error('[RA-DYN.U6] la matvista quedó VACÍA');

  // ⭐ EL CONTROL, no el número: si NADIE llega a completo, o si TODOS llegan, el indicador no
  // mide al proveedor sino un defecto propio.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE pct_completos >= 99)::int perfectos,
           count(*) FILTER (WHERE pct_completos <= 70)::int flojos
      FROM ${V} WHERE veredicto_muestra = 'medido'`);
  if (!d.perfectos || !d.flojos) {
    throw new Error(
      `[RA-DYN.U6] el indicador no discrimina (perfectos=${d.perfectos}, flojos=${d.flojos}): ` +
      'si todos salen igual, no está midiendo al proveedor');
  }

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${V}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[RA-DYN.U6] app_runtime no puede leer la vista');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
