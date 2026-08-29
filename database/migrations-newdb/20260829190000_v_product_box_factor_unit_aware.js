/**
 * [UM.1] — `analytics.v_product_box_factor` deja de devolver DOS unidades en la
 * misma columna, y aprende a desconfiar del granel.
 *
 * RA-PRO.38 creó este resolvedor para que cada reporte no inventara su propia
 * precedencia. Funcionó, pero la investigación de unidades (2026-08-29, medida
 * contra prod 365d — `docs/UNIDADES_DE_MEDIDA.md`) encontró que el factor que
 * devuelve **no siempre cuenta lo mismo**:
 *
 *   fuente          contra el ancla `kdii.c84`        veredicto
 *   ─────────────   ──────────────────────────────    ──────────────────────────
 *   kepler_c84      359/359 = piezas por caja         ✅ piezas, verificado
 *   override        193/193 = piezas por caja         ✅ piezas, verificado (humano)
 *   etiquetera      532/532 = piezas por caja         ✅ piezas
 *   factor_sale     168 piezas / 128 paquetes         ⚠️ AMBIGUO por SKU
 *
 * `factor_sale` no tiene una unidad: la mitad cuenta piezas y un tercio cuenta
 * paquetes, sin nada que los distinga. Y 815 de los 905 SKUs que hoy resuelven
 * por ahí **ni siquiera existen en Kepler**, así que no hay con qué anclarlos.
 * No se puede convertir — sólo se puede declarar.
 *
 * Y la guarda anti-pallet **no ve el granel**: sólo dispara cuando hay una caja
 * interior con que comparar. Medido: **201 SKUs de peso con $49.3M de venta**
 * traen `box_factor > 1` sin una sola marca de sospecha (130 vía `kepler_c84`,
 * encabezados por las bolsas ALTOS 1KG con factor 20). En granel `c84` son kilos
 * por bulto, no piezas por caja.
 *
 * Qué cambia:
 *   · `box_factor` y `source` — SIN CAMBIOS. Cero impacto para quien ya los lee.
 *   · `+ factor_unit`  'pieces' | 'ambiguous' — qué cuenta el número.
 *   · `+ unit_base`    la unidad base REAL del ERP (`kdii.c11`), con la basura
 *                      ('500', '250', '2KG'…) normalizada a NULL. El catálogo
 *                      discrepa con esto en 73.6%, así que `unit_sale` no sirve.
 *   · `+ is_weight`    producto de peso: la caja no aplica.
 *   · `is_master_suspect` ahora TAMBIÉN marca granel, factores imposibles
 *     (>1000 piezas: `99997 ETIQUETAS`=16,500, `45205 RAQUETA`=1,200) y todo lo
 *     que venga de `factor_sale`. Sólo suma marcas — la dirección segura: quien
 *     gatea en `NOT is_master_suspect` publica menos, nunca más.
 *
 * Costo: +184 ms por el agregado de `kdii` (66,666 filas → 9,528 SKUs). La vista
 * pasa de ~170 ms a ~350 ms. Aceptable para reportes; si molestara, `kdii` se
 * pre-agrega en `analytics.product_box_factor` (que ya lo alimenta un feed).
 *
 * Idempotente (CREATE OR REPLACE). Sin cambio de datos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
    WITH ladder AS (
      -- La escalera del ERP. Excluye CEDIS '00' (trae valuación de prueba) y
      -- consolida con MAX: c84 es estable entre sucursales (3 de 2,419 = 0.12%).
      SELECT c1 AS sku,
             MAX(NULLIF(btrim(c11), '')) AS u_base,
             MAX(c81)                    AS f_paq,
             MAX(c84)                    AS f_caja
        FROM kepler_ods.kdii
       WHERE sucursal <> '00'
       GROUP BY c1
    ), src AS (
      SELECT p.tenant_id, p.id AS product_id,
             COALESCE(p.factor_sale, 1)::numeric AS fs,
             lbl.bs::numeric                     AS etiq,
             kbf.box_factor::numeric             AS c84,
             uov.box_factor::numeric             AS ovr,
             -- Unidad base real del ERP. Los valores que son CANTIDADES y no
             -- unidades ('500', '250', '400', '2KG'…) se anulan: es más honesto
             -- no saber la unidad que afirmar una que no existe.
             CASE WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$' THEN upper(l.u_base) END AS unit_base
        FROM catalog.products p
        LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
                     FROM commercial.product_label_prices
                    GROUP BY tenant_id, product_id) lbl
               ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
        LEFT JOIN analytics.product_box_factor kbf
               ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
        LEFT JOIN commercial.product_unit_overrides uov
               ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
        LEFT JOIN ladder l ON l.sku = p.sku
       WHERE p.deleted_at IS NULL
    ), r AS (
      SELECT src.*,
             src.fs > 1 AND src.etiq > 1 AND src.fs = src.etiq AS inner_ok,
             GREATEST(CASE WHEN src.fs   > 1 THEN src.fs   ELSE 1 END,
                      CASE WHEN src.etiq > 1 THEN src.etiq ELSE 1 END) AS inner_box,
             src.unit_base IN ('KG', 'KGS') AS is_weight
        FROM src
    ), resolved AS (
      SELECT r.*,
             GREATEST(COALESCE(ovr,
               CASE WHEN inner_ok AND c84 >= 3 * fs THEN fs
                    WHEN c84  > 1 THEN c84
                    WHEN etiq > 1 THEN etiq
                    WHEN fs   > 1 THEN fs
                    ELSE 1 END), 1) AS box_factor,
             CASE WHEN ovr IS NOT NULL THEN 'override'
                  WHEN inner_ok AND c84 >= 3 * fs THEN 'inner_box_guard'
                  WHEN c84  > 1 THEN 'kepler_c84'
                  WHEN etiq > 1 THEN 'etiquetera'
                  WHEN fs   > 1 THEN 'factor_sale'
                  ELSE 'default' END AS source
        FROM r
    )
    -- El ORDEN de las columnas existentes NO se toca: CREATE OR REPLACE VIEW
    -- sólo admite AGREGAR al final. Las nuevas van después de 'source'.
    SELECT tenant_id, product_id,
           -- COALESCE a FALSE: la versión anterior devolvía NULL (no false) para
           -- todo producto sin c84, que es la mayoría. Un "WHERE NOT
           -- is_master_suspect" los descartaba en silencio y un
           -- "WHERE is_master_suspect" tampoco los traía: caían en el limbo de la
           -- lógica de tres valores. Ahora la bandera es un booleano de verdad.
           COALESCE(
             -- anti-pallet original: c84 es un múltiplo grande de una caja interior
             (c84 > 1 AND inner_box > 1 AND c84 >= 3 * inner_box)
             -- granel: en kilos la "caja" no es piezas por caja
             OR (is_weight AND box_factor > 1)
             -- imposible: ninguna caja de dulcería trae >1000 piezas
             OR box_factor > 1000
             -- sin unidad determinable
             OR (source = 'factor_sale' AND box_factor > 1)
           , FALSE) AS is_master_suspect,
           box_factor, source,
           -- ── columnas nuevas (UM.1) ──
           unit_base, is_weight,
           -- Qué CUENTA el factor. factor_sale es ambiguo por SKU (50% piezas,
           -- 38% paquetes) y no hay forma de distinguirlos: se declara, no se
           -- adivina. Quien convierta a cajas debe exigir 'pieces'.
           CASE WHEN source IN ('factor_sale', 'inner_box_guard') THEN 'ambiguous'
                WHEN box_factor > 1 THEN 'pieces'
                ELSE 'n/a' END AS factor_unit
      FROM resolved`);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);
};

/**
 * Revierte la LÓGICA (vuelve al `is_master_suspect` de RA-PRO.38), no el
 * conjunto de columnas: `analytics.erp_sales_invoice_lines` y
 * `analytics.v_sales_demand_truth` dependen de esta vista, así que un `DROP`
 * exigiría `CASCADE` y se llevaría dos vistas ajenas por delante. Las tres
 * columnas nuevas son informativas y quedarse no rompe nada; borrarlas sí.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
    WITH src AS (
      SELECT p.tenant_id, p.id AS product_id,
             COALESCE(p.factor_sale, 1)::numeric AS fs,
             lbl.bs::numeric AS etiq, kbf.box_factor::numeric AS c84, uov.box_factor::numeric AS ovr
        FROM catalog.products p
        LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
                     FROM commercial.product_label_prices GROUP BY tenant_id, product_id) lbl
               ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
        LEFT JOIN analytics.product_box_factor kbf
               ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
        LEFT JOIN commercial.product_unit_overrides uov
               ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
       WHERE p.deleted_at IS NULL
    ), r AS (
      SELECT src.*, src.fs > 1 AND src.etiq > 1 AND src.fs = src.etiq AS inner_ok,
             GREATEST(CASE WHEN src.fs > 1 THEN src.fs ELSE 1 END,
                      CASE WHEN src.etiq > 1 THEN src.etiq ELSE 1 END) AS inner_box
        FROM src
    )
    SELECT tenant_id, product_id,
           -- lógica ORIGINAL de RA-PRO.38: sólo la guarda anti-pallet
           (c84 > 1 AND inner_box > 1 AND c84 >= 3 * inner_box) AS is_master_suspect,
           GREATEST(COALESCE(ovr,
             CASE WHEN inner_ok AND c84 >= 3 * fs THEN fs
                  WHEN c84 > 1 THEN c84 WHEN etiq > 1 THEN etiq
                  WHEN fs > 1 THEN fs ELSE 1 END), 1) AS box_factor,
           CASE WHEN ovr IS NOT NULL THEN 'override'
                WHEN inner_ok AND c84 >= 3 * fs THEN 'inner_box_guard'
                WHEN c84 > 1 THEN 'kepler_c84' WHEN etiq > 1 THEN 'etiquetera'
                WHEN fs > 1 THEN 'factor_sale' ELSE 'default' END AS source,
           -- Se conservan por dependencia (ver comentario del down), inertes.
           NULL::text AS unit_base, FALSE AS is_weight, 'n/a'::text AS factor_unit
      FROM r`);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);
};
