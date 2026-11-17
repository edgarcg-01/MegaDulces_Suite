'use strict';
/**
 * `[CANON.6.21]` Oleada 8b, paso 2 (cierre): los otros tres materializados de `existencia-aux` —factor de caja por
 * producto, factor de caja por almacén y costo unitario de Kepler— se podrán mantener POR LLAVE, igual que el precio
 * (migración 20261114124213). Sin tocar nada de lo que hay, crea:
 *   · las tablas `analytics.resolved_product_box_factor`, `analytics.warehouse_box_factor` y
 *     `analytics.kepler_unit_cost`, con la llave y las columnas de `mv_product_box_factor`, `mv_warehouse_box_factor` y
 *     `mv_kepler_unit_cost` (la primera no se llama `product_box_factor` porque ese nombre ya es una de sus FUENTES: el
 *     factor capturado en Kepler). Nacen VACÍAS y sin lectores hasta el paso 5;
 *   · `analytics.resolved_product_box_factor_de(skus)`, `analytics.warehouse_box_factor_de(skus)` y
 *     `analytics.kepler_unit_cost_de(skus)`: con `NULL` leen la VISTA de siempre (`v_product_box_factor`,
 *     `v_warehouse_box_factor`, `v_kepler_unit_cost`), que sigue siendo donde vive la regla; con una lista, la MISMA regla
 *     con la llave metida en cada pieza (abajo, por qué hace falta);
 *   · `analytics.recalcular_existencia(skus)` reemplazada: además del precio, recalcula y escribe las tres tablas, sólo
 *     lo que cambió, y devuelve una fila por tabla.
 *
 * ── Por qué una plantilla y no «la vista filtrada» (prod, sólo lectura, 2026-11-17) ─────────────────────────────────
 *  · ⛔ Corrige lo anotado el 2026-11-14 («`v_product_box_factor` 3–10 ms, `v_warehouse_box_factor` 210–540 ms por
 *    lote»): aquello se midió con `SELECT count(*) … WHERE sku = ANY`, y con `count(*)` el planeador QUITA los
 *    `LEFT JOIN` que no aportan columnas — justo las piezas caras. Con las columnas de verdad, la vista filtrada cuesta
 *    lo mismo sea 1 SKU o 800: factor por almacén 3–4.7 s (12–18 s con `jit`), factor por producto ~400 ms, costo
 *    ~180 ms. La llave no llega a las piezas agrupadas (la escalera de Kepler por sucursal, la de costo por proveedor,
 *    la moda de las etiquetas, el `GROUP BY` de `kdik`) porque se une a ellas por `JOIN`, no por `WHERE`. Evaluarla
 *    producto por producto (`LATERAL … OFFSET 0`) tampoco: 2.2 s por producto en el factor por almacén.
 *  · La forma de la plantilla: cada vista se escribe UNA vez, en la plantilla de abajo. Con `k = null` su texto es
 *    IDÉNTICO, letra por letra, a `pg_get_viewdef(vista, false)` de prod (verificado para las cuatro); con `k` la llave
 *    entra en cada pieza agrupada, siempre por la columna con que se agrupa (así se quitan GRUPOS enteros y ninguno se
 *    parte). Medido contra la vista completa en la misma foto, lotes de 1/10/50/200/800 SKUs vendidos ayer y al azar
 *    (`jit = off`): IDÉNTICO en los 60 casos.
 *      factor por almacén 0.2–0.4 s hasta 200 SKUs, ~1 s con 800 (completa 9.5 s; con `jit` 20 s)
 *      factor por producto 80–150 ms hasta 200 SKUs, 0.2–0.25 s con 800 (completa ~0.55 s)
 *      costo unitario 15–60 ms hasta 200 SKUs, 0.12–0.23 s con 800 (completa 0.6–1 s)
 *  · ⛔ La regla vive en la VISTA y su plantilla debe ser su copia exacta. El `up()` lo EXIGE: compara la plantilla con
 *    la definición viva y se niega si difieren (alguien cambió la vista y su forma por llave quedaría vieja). El que
 *    cambie una de estas cuatro vistas en una migración nueva cambia también su plantilla y reemplaza estas funciones;
 *    la prueba `test-newdb-factores-por-llave` revisa que ninguna migración posterior toque una de ellas sin hacerlo.
 *    Y el recálculo completo del primer movimiento de cada día (paso 4) cuenta cualquier diferencia que se escape.
 *  · Las piezas que la llave alcanza sin plantilla se dejan como vista: `v_kepler_unit_ladder` (fila por fila: el
 *    filtro baja solo hasta `kdii`), `commercial.v_product_label_prices` (agrupa por producto: se filtra por los
 *    `product_id` de esos SKUs, borrados incluidos), `v_kepler_item_cost` y los dos peldaños nocturnos (índice).
 *  · `jit = off` en las funciones, como el precio: con `jit` la vista completa del factor por almacén tarda el doble.
 *  · Ritmo de las fuentes (contadores de prod desde el 1-nov): `kdii` ~1,000 cambios al día, etiquetas ~2,600,
 *    `catalog.products` ~18,500 (casi todos en columnas que estas reglas no leen: el paso 3 debe filtrar por columna).
 *    Ninguna de las tres depende de `kdm1`/`kdm2` salvo por los dos peldaños, que se refrescan de noche.
 *
 * ⛔ No toca las matviews, ni el carril, ni ningún lector: sólo crea objetos nuevos y reemplaza la función del paso
 *    anterior (que nadie llama todavía). Sin candados sobre tablas de la ingesta.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const PRECIO = require('./20261114124213_canon621_price_truth_por_llave.js');

const { MAX_POR_LLAVE } = PRECIO;
const PRECIO_T = 'analytics.price_truth';
const PRECIO_COLS = ['tenant_id', 'warehouse_id', 'sucursal', 'product_id', 'sku', 'precio', 'fuente', 'lineas_pos',
  'precio_config', 'rechazo', 'precio_lista', 'veredicto'];

// ── Las plantillas ─────────────────────────────────────────────────────────────────────────────────────────────────
// k = null → el texto EXACTO de pg_get_viewdef(vista, false) en prod (2026-11-17). k = { K, I } → la misma regla con la
// llave en cada pieza: K = expresión text[] de SKUs ya recortados; I = expresión uuid[] con los productos de esos SKUs.
const f = (k, expr) => (k ? ` AND (${expr} = ANY (${k.K}))` : '');

/** analytics.v_product_box_factor */
const reglaFactorProducto = (k) => ` WITH ladder AS (
         SELECT kdii.c1 AS sku,
            max(NULLIF(btrim(kdii.c11), ''::text)) AS u_base,
            max(kdii.c81) AS f_paq,
            max(kdii.c84) AS f_caja
           FROM kepler_ods.kdii
          WHERE (kdii.sucursal <> '00'::text)${f(k, 'btrim(kdii.c1)')}
          GROUP BY kdii.c1
        ), src AS (
         SELECT p.tenant_id,
            p.id AS product_id,
            (COALESCE(p.factor_sale, 1))::numeric AS fs,
            (lbl.bs)::numeric AS etiq,
            kbf.box_factor AS c84,
            uov.box_factor AS ovr,
            l.f_paq,
            l.f_caja,
            br.rung_max AS compra_rung,
            br.peldanos AS compra_peldanos,
                CASE
                    WHEN (upper(l.u_base) ~ '^[A-Z]{2,4}$'::text) THEN upper(l.u_base)
                    ELSE NULL::text
                END AS unit_base
           FROM (((((catalog.products p
             LEFT JOIN ( SELECT v_product_label_prices.tenant_id,
                    v_product_label_prices.product_id,
                    max(v_product_label_prices.box_size) AS bs
                   FROM commercial.v_product_label_prices${k ? `
                  WHERE (v_product_label_prices.product_id = ANY (${k.I}))` : ''}
                  GROUP BY v_product_label_prices.tenant_id, v_product_label_prices.product_id) lbl ON (((lbl.tenant_id = p.tenant_id) AND (lbl.product_id = p.id))))
             LEFT JOIN analytics.product_box_factor kbf ON (((kbf.tenant_id = p.tenant_id) AND (kbf.product_id = p.id))))
             LEFT JOIN commercial.product_unit_overrides uov ON (((uov.tenant_id = p.tenant_id) AND (uov.product_id = p.id) AND (uov.deleted_at IS NULL))))
             LEFT JOIN ladder l ON ((l.sku = (p.sku)::text)))
             LEFT JOIN analytics.mv_kepler_bought_rung br ON ((br.sku = btrim((p.sku)::text))))
          WHERE (p.deleted_at IS NULL)${f(k, 'btrim((p.sku)::text)')}
        ), r AS (
         SELECT src.tenant_id,
            src.product_id,
            src.fs,
            src.etiq,
            src.c84,
            src.ovr,
            src.unit_base,
            src.compra_rung,
            ((COALESCE(src.f_paq, (1)::numeric) <= (1)::numeric) AND (COALESCE(src.f_caja, (1)::numeric) <= (1)::numeric) AND (src.compra_peldanos = 1) AND (src.compra_rung >= (1)::numeric)) AS compra_ok,
            ((src.fs > (1)::numeric) AND (src.etiq > (1)::numeric) AND (src.fs = src.etiq)) AS inner_ok,
            GREATEST(
                CASE
                    WHEN (src.fs > (1)::numeric) THEN src.fs
                    ELSE (1)::numeric
                END,
                CASE
                    WHEN (src.etiq > (1)::numeric) THEN src.etiq
                    ELSE (1)::numeric
                END) AS inner_box,
            (src.unit_base = ANY (ARRAY['KG'::text, 'KGS'::text])) AS is_weight
           FROM src
        ), resolved AS (
         SELECT r.tenant_id,
            r.product_id,
            r.fs,
            r.etiq,
            r.c84,
            r.ovr,
            r.unit_base,
            r.inner_ok,
            r.inner_box,
            r.is_weight,
            GREATEST(COALESCE(
                CASE
                    WHEN ((r.ovr IS NOT NULL) AND (NOT ((r.ovr = (1)::numeric) AND (GREATEST(COALESCE(r.c84, (1)::numeric), COALESCE(r.etiq, (1)::numeric), COALESCE(r.fs, (1)::numeric)) > (1)::numeric)))) THEN r.ovr
                    ELSE NULL::numeric
                END,
                CASE
                    WHEN (r.inner_ok AND (r.c84 >= ((3)::numeric * r.fs))) THEN r.fs
                    WHEN (r.c84 > (1)::numeric) THEN r.c84
                    WHEN (r.compra_ok AND ((r.etiq > (1)::numeric) OR (r.fs > (1)::numeric))) THEN r.compra_rung
                    WHEN (r.etiq > (1)::numeric) THEN r.etiq
                    WHEN (r.fs > (1)::numeric) THEN r.fs
                    ELSE (1)::numeric
                END), (1)::numeric) AS box_factor,
                CASE
                    WHEN ((r.ovr IS NOT NULL) AND (r.ovr = (1)::numeric) AND (GREATEST(COALESCE(r.c84, (1)::numeric), COALESCE(r.etiq, (1)::numeric), COALESCE(r.fs, (1)::numeric)) > (1)::numeric)) THEN 'override_no_dato'::text
                    WHEN (r.ovr IS NOT NULL) THEN 'override'::text
                    WHEN (r.inner_ok AND (r.c84 >= ((3)::numeric * r.fs))) THEN 'inner_box_guard'::text
                    WHEN (r.c84 > (1)::numeric) THEN 'kepler_c84'::text
                    WHEN (r.compra_ok AND ((r.etiq > (1)::numeric) OR (r.fs > (1)::numeric))) THEN 'kepler_peldano_comprado'::text
                    WHEN (r.etiq > (1)::numeric) THEN 'etiquetera'::text
                    WHEN (r.fs > (1)::numeric) THEN 'factor_sale'::text
                    ELSE 'default'::text
                END AS source
           FROM r
        )
 SELECT tenant_id,
    product_id,
    COALESCE((((c84 > (1)::numeric) AND (inner_box > (1)::numeric) AND (c84 >= ((3)::numeric * inner_box))) OR (is_weight AND (box_factor > (1)::numeric)) OR (box_factor > (1000)::numeric) OR ((source = 'factor_sale'::text) AND (box_factor > (1)::numeric))), false) AS is_master_suspect,
    box_factor,
    source,
    unit_base,
    is_weight,
        CASE
            WHEN (source = ANY (ARRAY['factor_sale'::text, 'inner_box_guard'::text])) THEN 'ambiguous'::text
            WHEN (box_factor > (1)::numeric) THEN 'pieces'::text
            ELSE 'n/a'::text
        END AS factor_unit
   FROM resolved;`;

/** analytics.v_supplier_cost_ladder (su forma por llave sólo se usa DENTRO del factor por almacén) */
const reglaEscaleraProveedor = (k) => ` WITH montos AS (
         SELECT btrim(kdpv_prov_prod.c2) AS sku,
            NULLIF(kdpv_prov_prod.c4, (0)::numeric) AS box_cost,
            NULLIF(kdpv_prov_prod.c8, (0)::numeric) AS u1,
            NULLIF(kdpv_prov_prod.c9, (0)::numeric) AS u2,
            NULLIF(kdpv_prov_prod.c10, (0)::numeric) AS u3
           FROM kepler_ods.kdpv_prov_prod
          WHERE ((NULLIF(kdpv_prov_prod.c4, (0)::numeric) IS NOT NULL) AND (btrim(COALESCE(kdpv_prov_prod.c2, ''::text)) <> ''::text))${f(k, 'btrim(kdpv_prov_prod.c2)')}
        ), agg AS (
         SELECT montos.sku,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((montos.box_cost)::double precision)) AS box_cost,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((montos.u1)::double precision)) AS u1_cost,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((montos.u2)::double precision)) AS u2_cost,
            percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((montos.u3)::double precision)) AS u3_cost,
            (count(*))::integer AS sucursales
           FROM montos
          GROUP BY montos.sku
        ), rot AS (
         SELECT btrim(kdii.c1) AS sku,
            mode() WITHIN GROUP (ORDER BY NULLIF(btrim(kdii.c11), ''::text)) AS u1_label,
            mode() WITHIN GROUP (ORDER BY NULLIF(btrim(kdii.c80), ''::text)) AS u2_label,
            mode() WITHIN GROUP (ORDER BY NULLIF(btrim(kdii.c83), ''::text)) AS u3_label
           FROM kepler_ods.kdii
          WHERE (btrim(COALESCE(kdii.c1, ''::text)) <> ''::text)${f(k, 'btrim(kdii.c1)')}
          GROUP BY (btrim(kdii.c1))
        )
 SELECT a.sku,
    a.box_cost,
    a.u1_cost,
    a.u2_cost,
    a.u3_cost,
    r.u1_label,
    r.u2_label,
    r.u3_label,
        CASE
            WHEN (a.u1_cost > (0)::double precision) THEN (a.box_cost / a.u1_cost)
            ELSE NULL::double precision
        END AS units_per_box,
    a.sucursales
   FROM (agg a
     LEFT JOIN rot r ON ((r.sku = a.sku)));`;

const sinPuntoYComa = (s) => s.replace(/;\s*$/, '');
const sub = (k, regla, vista) => (k ? `( ${sinPuntoYComa(regla(k)).trim()})` : vista);

/** analytics.v_warehouse_box_factor */
const reglaFactorAlmacen = (k) => ` WITH wh AS (
         SELECT w.tenant_id,
            w.id,
            w.code,
            w.kepler_code,
            w.wincaja_source_branch
           FROM commercial.warehouses w
          WHERE ((w.deleted_at IS NULL) AND ((w.kepler_code IS NOT NULL) OR (w.wincaja_source_branch IS NOT NULL)))
        ), wcf AS (
         SELECT w.tenant_id,
            w.id AS warehouse_id,
            a.articulo AS sku,
            a.factor_venta AS fv,
            a.unidad_venta AS unidad
           FROM (wh w
             JOIN wincaja.articulos a ON (((a.tenant_id = w.tenant_id) AND (a.source_branch = w.wincaja_source_branch) AND (a.source_dataset = 'actual'::text))))
          WHERE ((w.kepler_code IS NULL) AND ((a.factor_venta > (1)::numeric) OR ((a.factor_venta = (1)::numeric) AND (btrim(upper(a.unidad_venta)) = 'CJA'::text))))${f(k, 'btrim(a.articulo)')}
        ), base AS (
         SELECT w.tenant_id,
            w.id AS warehouse_id,
            w.code AS warehouse_code,
            w.kepler_code,
            p.id AS product_id,
            p.sku,
            GREATEST(COALESCE(wcf.fv, bfx.box_factor, (1)::numeric), (1)::numeric) AS f_previo,
            wcf.fv AS wcf_fv,
            wcf.unidad AS wcf_unidad,
            bfx.source AS bfx_source,
            bfx.is_weight,
            bfx.is_master_suspect,
            sr.rung_max,
            kul.factor_caja AS kul_factor,
            kul.factor_source AS kul_source,
            lad.u3_label AS lad_u3,
            lad.u1_label AS lad_u1
           FROM ((((((wh w
             JOIN catalog.products p ON (((p.tenant_id = w.tenant_id) AND (p.deleted_at IS NULL)${f(k, 'btrim((p.sku)::text)')})))
             LEFT JOIN ${sub(k, reglaFactorProducto, 'analytics.v_product_box_factor')} bfx ON (((bfx.tenant_id = p.tenant_id) AND (bfx.product_id = p.id))))
             LEFT JOIN ${sub(k, reglaEscaleraProveedor, 'analytics.v_supplier_cost_ladder')} lad ON ((lad.sku = (p.sku)::text)))
             LEFT JOIN wcf ON (((wcf.warehouse_id = w.id) AND (wcf.sku = (p.sku)::text))))
             LEFT JOIN analytics.mv_kepler_sold_rung sr ON (((sr.sucursal = w.kepler_code) AND (sr.sku = (p.sku)::text))))
             LEFT JOIN ${k ? `( SELECT * FROM analytics.v_kepler_unit_ladder WHERE (v_kepler_unit_ladder.sku = ANY (${k.K})))` : 'analytics.v_kepler_unit_ladder'} kul ON (((kul.sucursal = w.kepler_code) AND (kul.sku = btrim((p.sku)::text)))))
        )
 SELECT tenant_id,
    warehouse_id,
    warehouse_code,
    product_id,
    sku,
        CASE
            WHEN ((kepler_code IS NOT NULL) AND (kul_factor IS NOT NULL)) THEN GREATEST(kul_factor, (1)::numeric)
            WHEN ((kepler_code IS NOT NULL) AND (bfx_source = 'kepler_peldano_comprado'::text)) THEN f_previo
            WHEN ((f_previo = (1)::numeric) AND (kepler_code IS NOT NULL) AND (rung_max > (1)::numeric)) THEN rung_max
            ELSE f_previo
        END AS box_factor,
        CASE
            WHEN ((kepler_code IS NOT NULL) AND (kul_factor IS NOT NULL)) THEN
            CASE kul_source
                WHEN 'unidad_unica'::text THEN 'kepler_unidad_unica'::text
                WHEN 'derivado_del_costo'::text THEN 'kepler_ficha_costo'::text
                WHEN 'capturado_contradice_al_costo'::text THEN 'kepler_ficha_contradice_costo'::text
                ELSE 'kepler_ficha'::text
            END
            WHEN ((kepler_code IS NOT NULL) AND (bfx_source = 'kepler_peldano_comprado'::text)) THEN 'kepler_peldano_comprado'::text
            WHEN ((f_previo = (1)::numeric) AND (kepler_code IS NOT NULL) AND (rung_max > (1)::numeric)) THEN 'kepler_peldano_vendido'::text
            WHEN (wcf_fv IS NOT NULL) THEN 'wincaja_factor_venta'::text
            ELSE COALESCE(bfx_source, 'none'::text)
        END AS factor_source,
        CASE
            WHEN (kepler_code IS NOT NULL) THEN 'kepler'::text
            ELSE 'wincaja'::text
        END AS erp,
    lad_u3 AS box_label,
    COALESCE(wcf_unidad, lad_u1) AS base_label,
    COALESCE(is_weight, false) AS is_weight,
    COALESCE(is_master_suspect, false) AS is_master_suspect
   FROM base;`;

/** analytics.v_kepler_unit_cost */
const reglaCostoUnitario = (k) => ` WITH kk AS (
         SELECT d.kepler_code,
            d.sku,
            max(d.costo_unitario) AS costo_unitario
           FROM analytics.v_kepler_item_cost d${k ? `
          WHERE (d.sku = ANY (${k.K}))` : ''}
          GROUP BY d.kepler_code, d.sku
        )
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.kepler_code,
    p.id AS product_id,
    p.sku,
    kk.costo_unitario
   FROM ((kk
     JOIN commercial.warehouses w ON (((w.kepler_code = kk.kepler_code) AND (w.deleted_at IS NULL))))
     JOIN catalog.products p ON (((p.tenant_id = w.tenant_id) AND ((p.sku)::text = kk.sku) AND (p.deleted_at IS NULL))))
  WHERE ((kk.costo_unitario IS NOT NULL) AND (kk.costo_unitario > (0)::numeric));`;

/** Las cuatro vistas cuya plantilla debe ser copia exacta (las tres reglas y la escalera que el factor por almacén mete dentro). */
const PLANTILLAS = [
  ['analytics.v_product_box_factor', reglaFactorProducto],
  ['analytics.v_supplier_cost_ladder', reglaEscaleraProveedor],
  ['analytics.v_warehouse_box_factor', reglaFactorAlmacen],
  ['analytics.v_kepler_unit_cost', reglaCostoUnitario],
];

/** Las tres tablas: llave y columnas de su matview; `alcance` = qué filas guardadas cubre una lista de SKUs. */
const OBJETOS = [
  {
    objeto: 'resolved_product_box_factor', vista: 'analytics.v_product_box_factor', regla: reglaFactorProducto,
    mv: 'analytics.mv_product_box_factor', pk: ['tenant_id', 'product_id'],
    cols: [['tenant_id', 'uuid'], ['product_id', 'uuid'], ['is_master_suspect', 'boolean'], ['box_factor', 'numeric'],
      ['source', 'text'], ['unit_base', 'text'], ['is_weight', 'boolean'], ['factor_unit', 'text']],
    // Sin columna sku: cubre los productos de esos SKUs (borrados incluidos, para que su fila salga).
    alcance: 't.product_id = ANY (v_ids)', indice: null,
  },
  {
    objeto: 'warehouse_box_factor', vista: 'analytics.v_warehouse_box_factor', regla: reglaFactorAlmacen,
    mv: 'analytics.mv_warehouse_box_factor', pk: ['tenant_id', 'warehouse_id', 'product_id'],
    cols: [['tenant_id', 'uuid'], ['warehouse_id', 'uuid'], ['warehouse_code', 'varchar(50)'], ['product_id', 'uuid'],
      ['sku', 'varchar(20)'], ['box_factor', 'numeric'], ['factor_source', 'text'], ['erp', 'text'], ['box_label', 'text'],
      ['base_label', 'text'], ['is_weight', 'boolean'], ['is_master_suspect', 'boolean']],
    alcance: 'btrim((t.sku)::text) = ANY (p_skus)', indice: 'btrim((sku)::text)',
  },
  {
    objeto: 'kepler_unit_cost', vista: 'analytics.v_kepler_unit_cost', regla: reglaCostoUnitario,
    mv: 'analytics.mv_kepler_unit_cost', pk: ['tenant_id', 'warehouse_id', 'product_id'],
    cols: [['tenant_id', 'uuid'], ['warehouse_id', 'uuid'], ['kepler_code', 'text'], ['product_id', 'uuid'],
      ['sku', 'varchar(20)'], ['costo_unitario', 'numeric']],
    alcance: 'btrim((t.sku)::text) = ANY (p_skus)', indice: 'btrim((sku)::text)',
  },
];
const tabla = (o) => `analytics.${o.objeto}`;
const fn = (o) => `analytics.${o.objeto}_de`;
const sinModificador = (t) => t.replace(/\(\d+\)$/, '');
const IDS = `ARRAY(SELECT p.id FROM catalog.products p WHERE btrim((p.sku)::text) = ANY (p_skus))`;

/** Un bloque de recalcular_existencia: nuevo → borra lo que ya no sale → inserta/actualiza sólo lo distinto. */
function bloque({ objeto, t, origen, pk, cols, alcance }) {
  const lista = cols.join(', ');
  const cambio = cols.filter((c) => !pk.includes(c));
  return `
      v_ins := 0; v_upd := 0; v_del := 0;
      IF p_skus IS NULL OR cardinality(p_skus) > 0 THEN
        WITH nuevo AS MATERIALIZED (SELECT * FROM ${origen}),
        quitadas AS (
          DELETE FROM ${t} t
           WHERE (p_skus IS NULL OR ${alcance})
             AND NOT EXISTS (SELECT 1 FROM nuevo n WHERE ${pk.map((c) => `n.${c} = t.${c}`).join(' AND ')})
          RETURNING 1),
        escritas AS (
          INSERT INTO ${t} AS t (${lista})
          SELECT ${lista} FROM nuevo
          ON CONFLICT (${pk.join(', ')}) DO UPDATE
             SET ${cambio.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()
           WHERE (${cambio.map((c) => `t.${c}`).join(', ')}) IS DISTINCT FROM (${cambio.map((c) => `EXCLUDED.${c}`).join(', ')})
          RETURNING (t.xmax = 0) AS nueva)
        SELECT count(*) FILTER (WHERE e.nueva)::integer, count(*) FILTER (WHERE NOT e.nueva)::integer,
               (SELECT count(*) FROM quitadas)::integer
          INTO v_ins, v_upd, v_del
          FROM escritas e;
      END IF;
      objeto := '${objeto}'; insertadas := v_ins; actualizadas := v_upd; borradas := v_del;
      RETURN NEXT;`;
}

/** El up() se niega si alguna de las cuatro vistas ya no es la que copia su plantilla. */
async function exigirPlantillasAlDia(knex) {
  for (const [vista, regla] of PLANTILLAS) {
    // search_path fijo: pg_get_viewdef califica los nombres según el search_path de la sesión.
    await knex.raw(`DO $chk$
      DECLARE sp text := current_setting('search_path'); d text;
      BEGIN
        PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
        d := CASE WHEN to_regclass('${vista}') IS NULL THEN NULL ELSE pg_get_viewdef('${vista}'::regclass, false) END;
        PERFORM set_config('search_path', sp, true);
        IF d IS DISTINCT FROM $plantilla$${regla(null)}$plantilla$ THEN
          RAISE EXCEPTION '[CANON.6.21] % %: su forma por llave quedaría vieja. Quien cambie esta vista cambia también su plantilla (migración 20261117085622) en una migración nueva.',
            '${vista}', CASE WHEN d IS NULL THEN 'no existe' ELSE 'ya no es la que copia su plantilla' END;
        END IF;
      END $chk$`);
  }
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await exigirPlantillasAlDia(knex);

  for (const o of OBJETOS) {
    await knex.raw(`
      CREATE TABLE IF NOT EXISTS ${tabla(o)} (
        ${o.cols.map(([c, t]) => `${c} ${t}${o.pk.includes(c) ? ' NOT NULL' : ''}`).join(',\n        ')},
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (${o.pk.join(', ')})
      )`);
    if (o.indice) await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${o.objeto}_sku ON ${tabla(o)} ((${o.indice}))`);
    await knex.raw(`COMMENT ON TABLE ${tabla(o)} IS
      '[CANON.6.21] La regla de ${o.vista} guardada POR LLAVE (la que hoy refresca ${o.mv} cada 5 minutos). La escribe '
      'SÓLO analytics.recalcular_existencia (por SKU al llegar el cambio, o completa con NULL). updated_at = cuándo cambió '
      'la fila de verdad. Nace vacía y sin lectores hasta el paso 5 de la oleada 8b.'`);

    const firma = o.cols.map(([c, t]) => `${c} ${sinModificador(t)}`).join(', ');
    const conIds = o.objeto !== 'kepler_unit_cost';
    await knex.raw(`
      CREATE OR REPLACE FUNCTION ${fn(o)}(p_skus text[])
      RETURNS TABLE (${firma})
      LANGUAGE plpgsql STABLE
      SET search_path = pg_catalog, pg_temp
      SET plan_cache_mode = force_custom_plan
      SET jit = off
      AS $fn$
      #variable_conflict use_column
      DECLARE v_ids uuid[];
      BEGIN
        IF p_skus IS NULL THEN
          RETURN QUERY SELECT ${o.cols.map(([c]) => `v.${c}`).join(', ')} FROM ${o.vista} v;
        ELSE
          ${conIds ? `v_ids := ${IDS};` : 'v_ids := NULL;'}
          RETURN QUERY ${sinPuntoYComa(o.regla({ K: 'p_skus', I: 'v_ids' })).trim()};
        END IF;
      END
      $fn$`);
    await knex.raw(`REVOKE ALL ON FUNCTION ${fn(o)}(text[]) FROM PUBLIC`);
    await knex.raw(`COMMENT ON FUNCTION ${fn(o)}(text[]) IS
      '[CANON.6.21] NULL = ${o.vista} tal cual (ahí vive la regla); una lista = la misma regla con la llave en cada pieza '
      '(plantilla de la migración 20261117085622, exigida idéntica a la vista).'`);
  }

  const bloques = [
    bloque({ objeto: 'price_truth', t: PRECIO_T, origen: 'analytics.price_truth_de(p_skus)',
      pk: ['tenant_id', 'warehouse_id', 'product_id'], cols: PRECIO_COLS, alcance: 't.sku = ANY (p_skus)' }),
    ...OBJETOS.map((o) => bloque({ objeto: o.objeto, t: tabla(o), origen: `${fn(o)}(p_skus)`, pk: o.pk,
      cols: o.cols.map(([c]) => c), alcance: o.alcance })),
  ];
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.recalcular_existencia(p_skus text[] DEFAULT NULL)
    RETURNS TABLE (objeto text, insertadas integer, actualizadas integer, borradas integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET jit = off
    AS $fn$
    #variable_conflict use_column
    DECLARE v_ins integer; v_upd integer; v_del integer; v_ids uuid[];
    BEGIN
      IF p_skus IS NOT NULL THEN
        p_skus := ARRAY(SELECT DISTINCT btrim(s) FROM unnest(p_skus) s WHERE btrim(COALESCE(s, '')) <> '');
        -- Arriba de ~800 SKUs, por llave cuesta más que todo junto (el precio: ~9 ms por SKU vendido; completo 7.7 s).
        -- Recalcular todo es correcto siempre: contiene a cualquier lista.
        IF cardinality(p_skus) > ${MAX_POR_LLAVE} THEN p_skus := NULL; END IF;
      END IF;
      IF p_skus IS NULL OR cardinality(p_skus) > 0 THEN
        -- Uno a la vez: el recálculo completo y el que drena no se cruzan.
        PERFORM pg_advisory_xact_lock(hashtext('analytics.recalcular_existencia'));
      END IF;
      -- Los productos de esos SKUs (borrados incluidos): el alcance de la tabla que no guarda el SKU.
      v_ids := CASE WHEN p_skus IS NULL THEN NULL ELSE ${IDS} END;
      ${bloques.join('\n')}
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION analytics.recalcular_existencia(text[]) FROM PUBLIC`);
  await knex.raw(`COMMENT ON FUNCTION analytics.recalcular_existencia(text[]) IS
    '[CANON.6.21] Recalcula por SKU (o todo, con NULL) las tablas de existencia-aux y escribe sólo lo que cambió: '
    'price_truth, resolved_product_box_factor, warehouse_box_factor y kepler_unit_cost. Devuelve por tabla cuántas filas '
    'insertó, actualizó y borró (con NULL, eso es el árbitro: lo que difería de lo guardado).'`);

  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        ${OBJETOS.map((o) => `GRANT SELECT ON ${tabla(o)} TO app_runtime;`).join(' ')}
        GRANT EXECUTE ON FUNCTION analytics.recalcular_existencia(text[]) TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        ${OBJETOS.map((o) => `GRANT SELECT ON ${tabla(o)} TO dev_ro;`).join(' ')}
      END IF;
    END $$`);

  // ── Verificación dentro de la migración: los permisos quedaron como se dice arriba ─────────────────────────────
  const { rows: [g] } = await knex.raw(`
    SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS sin_rol,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
             ${OBJETOS.map((o) => `has_table_privilege('app_runtime', '${tabla(o)}', 'SELECT')
             AND NOT has_table_privilege('app_runtime', '${tabla(o)}', 'INSERT')
             AND NOT has_function_privilege('app_runtime', '${fn(o)}(text[])', 'EXECUTE')`).join('\n             AND ')}
             AND has_function_privilege('app_runtime', 'analytics.recalcular_existencia(text[])', 'EXECUTE')
           END AS ok`);
  if (!g.sin_rol && !g.ok) throw new Error('[CANON.6.21] los permisos de app_runtime no quedaron como se declara');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita lo nuevo y deja `recalcular_existencia` como la dejó el paso del precio. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const o of OBJETOS) {
    await knex.raw(`DROP FUNCTION IF EXISTS ${fn(o)}(text[])`);
    await knex.raw(`DROP TABLE IF EXISTS ${tabla(o)}`);
  }
  await PRECIO.up(knex);
};

exports.PLANTILLAS = PLANTILLAS;
exports.OBJETOS = OBJETOS;
exports.sinPuntoYComa = sinPuntoYComa;
