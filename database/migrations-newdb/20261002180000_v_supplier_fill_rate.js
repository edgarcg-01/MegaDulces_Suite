'use strict';
/**
 * `[RA-DYN.U5]` — **El cumplimiento del proveedor: ¿me surtiste lo que te pedí?**
 *
 * ── La herramienta que al comprador le faltaba ───────────────────────────────────────────────
 * `catalog.suppliers.fill_rate_override` lleva **0 de 1,318** proveedores capturados, y el motor
 * de pedido tiene una columna `fill_rate` que nunca recibió un número. Al sentarse a negociar, el
 * comprador podía decir cuánto compró y a qué precio, pero **no si se lo entregaron**.
 *
 * ── Dos cosas lo destrabaron, y ninguna era el modelo ────────────────────────────────────────
 * 1. **El índice que le faltaba al lado de compra del ODS** (`ix_kdm2_compra_doc`, mig
 *    20261002160000). Sin él una sola búsqueda de OC barría 58,065 páginas; con él, 10.
 * 2. **Quitar el join final.** La primera versión de esta consulta armaba dos CTEs —lo pedido y
 *    lo recibido— y las unía con un LEFT JOIN. Ahí estaba TODO el costo: una CTE materializada
 *    no tiene estadísticas, el planificador estimaba `rows=1`, elegía Nested Loop y reescaneaba
 *    la relación de recibidos **entera por cada fila** de pedidos: 16,349 × 16,067 ≈ **263
 *    millones de comparaciones**. Medido contra prod el 2026-10-02:
 *
 *        forma con LEFT JOIN ...  90 días  49 s   ·  365 días  >50 min sin terminar
 *        forma de una pasada ...  90 días 0.7 s   ·  365 días      2.7 s
 *
 *    Mismo resultado: las dos formas corridas **sobre el mismo dato** dan **0 filas con cifra
 *    distinta** (la diferencia de 2 filas son renglones de cantidad 0, que esta versión filtra).
 *
 * ⭐ **Por eso esto es una VISTA y no una matvista.** La versión anterior de este archivo creaba
 * una matvista con refresco nocturno, y era la decisión correcta **para una consulta de 50
 * minutos**. Arreglada la consulta, esa justificación desapareció: 2.7 s el universo completo y
 * **0.2 s filtrado por un proveedor**, que es el caso real (*"voy a pedirle a éste, ¿cómo se
 * portó?"*). Derivar en vez de materializar es la regla principal del proyecto; materializar se
 * justifica por costo, y el costo ya no está. De paso se ahorra el job nocturno, su umbral, el
 * índice único y la ventana de datos rancios.
 *
 * ── Cómo se mide, y por qué la comparación es válida ─────────────────────────────────────────
 * La cadena es `X-A-35` (orden de compra) → `X-A-37` (vale de entrada), y el puente son
 * `oc_folio` / `vale_folio` de `analytics.erp_goods_receipts` (el documento `XA2001`).
 * Medido: **10,240 de 12,713 recepciones (80.6%)** de los últimos 12 meses traen los dos.
 *
 * ⭐ La resta es legítima sin resolver unidades: sobre 2,932 pares (OC, vale) del mismo SKU,
 * **2,932 vienen en la MISMA unidad (100%)** y sólo 3 difieren en factor de caja. Dentro de una
 * cadena Kepler no cambia de peldaño — lo contrario de lo que pasa entre venta y compra
 * (ADR-055/057), así que valía medirlo antes de restar.
 *
 * ⚠️ **Una OC puede recibirse en varias entregas.** 9,466 de ~9,750 llegan de una sola vez, pero
 * 284 vienen partidas. Por eso `recibido` suma **todas** las entregas de esa OC: comparar contra
 * una sola acusaría al proveedor de algo que sí entregó.
 *
 * ── ⛔ LO QUE ESTE NÚMERO NO PUEDE DISTINGUIR ────────────────────────────────────────────────
 * 1. **Un renglón cancelado por nosotros se ve igual que uno que el proveedor no surtió.** Kepler
 *    no marca la cancelación en la línea. `veredicto` dice *qué pasó*, no *de quién fue la culpa*.
 * 2. **Efecto de borde**: un renglón surtido justo después del corte cuenta como faltante.
 * 3. Sólo entra lo que tiene OC: las compras sin orden previa (19.4%) quedan fuera.
 *
 * ── El control que lo vuelve publicable ──────────────────────────────────────────────────────
 * Un indicador donde TODOS salen mal no mide al proveedor, mide un defecto propio. Medido a 90
 * días el reparto **discrimina**: de 28 % (BIMBO, 75 renglones) a **100 % con cero faltantes** en
 * seis proveedores de 26 a 94 renglones. El candado vigila esa premisa, no sólo el número.
 *
 * ⛔ **No cambia ningún número publicado**: agrega objetos que nadie consume todavía.
 */

const VL = 'analytics.v_supplier_fill_rate_lines';
const V = 'analytics.v_supplier_fill_rate';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VL} AS
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
    -- UNA SOLA PASADA: el folio de la OC y el del vale se apilan en una relacion etiquetada, se
    -- une una sola vez contra los renglones, y el pivote lo hace FILTER. Sin join final no hay
    -- nested loop que explote. Ver la cabecera.
    claves AS MATERIALIZED (
      SELECT DISTINCT sucursal, oc_folio, oc_folio AS folio, 'XA3501'::text AS dt FROM r
      UNION ALL
      SELECT DISTINCT sucursal, oc_folio, vale_folio,        'XA3701'::text      FROM r
    ),
    linea AS (
      SELECT k.sucursal, k.oc_folio, l.sku,
             max(l.nombre) FILTER (WHERE k.dt = 'XA3501')                AS nombre,
             max(l.unidad) FILTER (WHERE k.dt = 'XA3501')                AS unidad,
             COALESCE(sum(l.cantidad) FILTER (WHERE k.dt = 'XA3501'), 0) AS pedido,
             COALESCE(sum(l.importe)  FILTER (WHERE k.dt = 'XA3501'), 0) AS importe_pedido,
             COALESCE(sum(l.cantidad) FILTER (WHERE k.dt = 'XA3701'), 0) AS recibido
        FROM claves k
        JOIN analytics.erp_purchase_doc_lines l
          ON l.doctype = k.dt AND l.folio = k.folio AND l.sucursal = k.sucursal
       GROUP BY 1, 2, 3
    )
    SELECT
      '00000000-0000-0000-0000-00000000d01c'::uuid       AS tenant_id,
      f.sucursal, f.oc_folio, f.sku, f.nombre, f.unidad,
      o.proveedor_nombre, s.id AS supplier_id,
      o.primera_entrega, o.entregas,
      f.pedido, f.recibido, f.importe_pedido,
      round(GREATEST(0, f.pedido - f.recibido)
            / NULLIF(f.pedido, 0) * f.importe_pedido, 2) AS importe_no_surtido,
      CASE
        WHEN f.recibido >= f.pedido THEN 'completo'
        WHEN f.recibido > 0         THEN 'parcial'
        ELSE 'no_surtido'
      END                                                AS veredicto
      FROM linea f
      JOIN ocs o ON o.sucursal = f.sucursal AND o.oc_folio = f.oc_folio
      -- 97% de los 508 proveedores de las recepciones amarran con el catalogo por nombre
      -- normalizado (493). Los 15 que no quedan con supplier_id NULL y se declaran: no se
      -- inventa un id ni se los esconde.
      LEFT JOIN catalog.suppliers s
        ON upper(btrim(s.name)) = upper(btrim(o.proveedor_nombre))
       AND s.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
     WHERE f.pedido > 0
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${V} AS
    SELECT
      f.tenant_id, f.supplier_id, f.proveedor_nombre,
      count(*)::int                                             AS renglones,
      count(*) FILTER (WHERE f.veredicto = 'completo')::int      AS completos,
      count(*) FILTER (WHERE f.veredicto = 'parcial')::int       AS parciales,
      count(*) FILTER (WHERE f.veredicto = 'no_surtido')::int    AS no_surtidos,
      round(100.0 * count(*) FILTER (WHERE f.veredicto = 'completo') / count(*), 1)
                                                                 AS pct_completos,
      -- Fill rate ponderado por DINERO, no por renglones: uno de $5 y uno de $500,000 no pesan
      -- igual en la conversacion. Las CANTIDADES no se suman entre SKUs (serian unidades
      -- distintas); el importe si es conmensurable.
      round(100.0 * (sum(f.importe_pedido) - sum(f.importe_no_surtido))
            / NULLIF(sum(f.importe_pedido), 0), 1)               AS fill_rate_mxn_pct,
      round(sum(f.importe_pedido), 2)                            AS importe_pedido,
      round(sum(f.importe_no_surtido), 2)                        AS importe_no_surtido,
      count(DISTINCT f.oc_folio)::int                            AS ordenes,
      max(f.primera_entrega)                                     AS ultima_orden,
      -- Lo que el numero NO cubre, al lado del numero: sin esto, 100% se lee como "me surte
      -- todo" cuando puede ser "solo medi tres renglones".
      CASE WHEN count(*) < 25 THEN 'muestra_chica' ELSE 'medido' END AS veredicto_muestra
      FROM ${VL} f
     GROUP BY f.tenant_id, f.supplier_id, f.proveedor_nombre
  `);

  // ⚠️ security_invoker y el GRANT van explícitos: no se heredan en un CREATE OR REPLACE
  // (lección U.7 / ADR-057).
  for (const v of [VL, V]) {
    await knex.raw(`ALTER VIEW ${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON ${v} TO app_runtime`);
  }

  await knex.raw(`
    COMMENT ON VIEW ${V} IS
      '[RA-DYN.U5] El cumplimiento por proveedor, para negociar. Derivada, no materializada: '
      '2.7 s el universo completo y 0.2 s filtrada por proveedor. fill_rate_mxn_pct pondera por '
      'DINERO. No distingue un renglon cancelado de uno no surtido -- Kepler no lo marca.'`);

  // ── Verificación dentro de la migración ──────────────────────────────────────────────────
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int c FROM ${V}`);
  if (!n.c) throw new Error('[RA-DYN.U5] la vista no devolvió una sola fila');

  // ⭐ EL CONTROL, no el número: si NADIE llega a completo, o si TODOS llegan, el indicador no
  // mide al proveedor sino un defecto propio.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE pct_completos >= 99)::int perfectos,
           count(*) FILTER (WHERE pct_completos <= 70)::int flojos,
           count(*)::int total
      FROM ${V} WHERE veredicto_muestra = 'medido'`);
  if (!d.perfectos || !d.flojos) {
    throw new Error(
      `[RA-DYN.U5] el indicador no discrimina (perfectos=${d.perfectos}, flojos=${d.flojos}, ` +
      `total=${d.total}): si todos salen igual, no está midiendo al proveedor`);
  }

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${V}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[RA-DYN.U5] app_runtime no puede leer la vista');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(`DROP VIEW IF EXISTS ${VL}`);
};
