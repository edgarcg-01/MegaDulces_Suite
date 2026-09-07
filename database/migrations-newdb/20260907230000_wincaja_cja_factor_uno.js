/**
 * `[W1.1]` — En un almacén de Wincaja, cuando Wincaja dice `CJA` con `factor_venta = 1`, el divisor
 * es 1. Hoy gana el de Kepler (~21) y es el espejo del bug que ADR-055 cerró.
 *
 * ── El defecto ─────────────────────────────────────────────────────────────────────────────
 * `analytics.v_warehouse_box_factor` toma el divisor de `wincaja.articulos.factor_venta` sólo
 * `WHERE a.factor_venta > 1`. Ese `> 1` no distingue dos cosas distintas:
 *
 *   · `unidad_venta = 'CJA'` + `fv = 1` → **DECLARACIÓN** coherente: "mi unidad de venta YA es la
 *     caja". Divisor 1. Es información, no ausencia.
 *   · `unidad_venta = 'PZA'` + `fv = 1` → **AUSENCIA** de captura: "1 pieza = 1 caja" no se sostiene
 *     en dulcería. Ahí el fallback al factor de Kepler es lo menos malo, y se deja como está.
 *
 * Al descartar la declaración, el `COALESCE(wcf.fv, bfx.box_factor, 1)` cae al `box_factor` de
 * Kepler, que está en unidades BASE — en el almacén donde manda Wincaja. ADR-055 cerró el caso
 * inverso (dividía entre 140 en vez de 14); éste divide entre ~21 en vez de 1.
 *
 * Se acota a `CJA` a propósito, con la medición que lo justifica (rama 30, `actual`): con `fv = 1`
 * hay 1,872 PZA / 193 CJA / 152 KGS, y con `fv > 1` hay 13,282 PZA. O sea el campo está poblado
 * para unos PZA y no para otros → en PZA el 1 no declara nada. En CJA sí: `CJA` con factor 1 es la
 * única combinación auto-consistente.
 *
 * ── Medido en prod antes de aplicar ────────────────────────────────────────────────────────
 *   · filas que cambian de divisor: **150** (15 SKUs × los 10 almacenes de Wincaja).
 *   · de ésas, con existencia: **8** (7 en MD-30, 1 en MD-32, 0 en el CEDIS).
 *   · **el delta sobre los totales publicados es CERO**, y por una razón que conviene registrar:
 *     las 8 ya traen `replenishment_plan.rung_veredicto = 'x2_deflactada'`, así que el árbitro que
 *     ya existe **había detectado este defecto** y la pantalla muestra la cantidad NATIVA con su
 *     rótulo en vez de inventar cajas (ver el `CASE WHEN rung_veredicto IS NULL` de
 *     `existencia.service.ts`). El beneficio real del arreglo es que esas 8 celdas pueden volver a
 *     ser MEDIBLES en la próxima corrida del nocturno, en vez de quedar en `sin_valuar`.
 *   · por qué son 15 y no más: de los 193 `CJA + fv=1` de la rama 30, **109 no están en
 *     `catalog.products`**, **65 ya reciben divisor 1** por `default` (correcto) y 19 heredan de
 *     Kepler, de los cuales 15 con divisor > 1.
 *
 * ── Frenos verificados antes de tocar la vista ─────────────────────────────────────────────
 *   · **abanico (Fase FKJ):** `wcf` se une por (warehouse_id, sku), así que agregar filas al CTE
 *     podría duplicar el producto. NO puede: `wincaja.articulos` tiene PK
 *     `(tenant_id, source_branch, source_dataset, articulo)` → 0 grupos con más de una fila, y
 *     **0 SKUs** con una fila `fv > 1` Y otra `CJA + fv = 1` a la vez. Testigo a comparar después:
 *     la vista da **11,212 filas == 11,212 productos** en cada uno de los 16 almacenes.
 *   · **escritura de `CJA`:** una sola variante (4,128 filas, largo 3). El `btrim(upper(...))` va
 *     igual, por si mañana entra con espacios.
 *   · **`CREATE OR REPLACE`, nunca `DROP`:** la vista está viva y `DROP` sobre una vista con planes
 *     cacheados tira `0A000` (GOTCHAS). El orden y el nombre de las 12 columnas NO cambian, que es
 *     lo único que `CREATE OR REPLACE` no perdona.
 *   · **`security_invoker = true`** se re-declara: sin él la vista dejaría de respetar el RLS del
 *     que consulta.
 *
 * ⚠️ Sigue siendo un DIVISOR DE PRESENTACIÓN: no convierte el dato base. Cada almacén conserva su
 * unidad nativa (ADR-055); lo que se unifica es CÓMO SE MUESTRA.
 *
 * ⚠️ El efecto en pantalla no es inmediato: `existencia.service.ts` prefiere
 * `analytics.replenishment_plan.display_bf`, que el nocturno resuelve LEYENDO esta vista. Las filas
 * que aún no están en el fact usan `vbf.box_factor` y cambian ya; el resto, en la próxima corrida
 * de `import-replenishment-plan.js`.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = (cond) => `
  CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor WITH (security_invoker = true) AS
  WITH wh AS (
    SELECT tenant_id, id, code, kepler_code, wincaja_source_branch
      FROM commercial.warehouses
     WHERE deleted_at IS NULL
       AND (kepler_code IS NOT NULL OR wincaja_source_branch IS NOT NULL)
  ), wcf AS (
    -- Driven desde los almacenes, NO desde articulos: la tabla trae ~275k filas repartidas entre
    -- decenas de source_branch y agregarla entera costaba 545 ms. El join por el prefijo del PK
    -- (tenant_id, source_branch, source_dataset) deja la vista completa en ~140 ms.
    -- source_dataset='actual' ES OBLIGATORIO: articulos guarda tambien 'concentrada'.
    SELECT w.tenant_id, w.id AS warehouse_id, a.articulo AS sku,
           a.factor_venta::numeric AS fv, a.unidad_venta AS unidad
      FROM wh w
      JOIN wincaja.articulos a
        ON a.tenant_id = w.tenant_id
       AND a.source_branch = w.wincaja_source_branch
       AND a.source_dataset = 'actual'
     WHERE w.kepler_code IS NULL AND (${cond})
  )
  SELECT w.tenant_id,
         w.id                       AS warehouse_id,
         w.code                     AS warehouse_code,
         p.id                       AS product_id,
         p.sku,
         -- Unidades NATIVAS de este almacen por CAJA. Es el divisor para mostrar cantidades.
         GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1), 1)::numeric AS box_factor,
         CASE WHEN wcf.fv IS NOT NULL THEN 'wincaja_factor_venta'
              ELSE COALESCE(bfx.source, 'none') END                AS factor_source,
         CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
         lad.u3_label                                              AS box_label,
         COALESCE(wcf.unidad, lad.u1_label)                        AS base_label,
         COALESCE(bfx.is_weight, false)                            AS is_weight,
         COALESCE(bfx.is_master_suspect, false)                    AS is_master_suspect
    FROM wh w
    JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN analytics.v_product_box_factor bfx
      ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
    LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku
    LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku`;

// La condición nueva: el factor de Wincaja manda cuando declara un factor (> 1) O cuando declara
// que su unidad de venta YA es la caja (`CJA` con factor 1).
const COND_NUEVA = `a.factor_venta > 1
       OR (a.factor_venta = 1 AND btrim(upper(a.unidad_venta)) = 'CJA')`;
const COND_VIEJA = `a.factor_venta > 1`;

exports.up = async function up(knex) {
  await knex.raw(VISTA(COND_NUEVA));
  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');

  // Freno de salida: si el cambio abanicó, la vista devuelve más filas que productos por almacén.
  // Se mide y se LANZA (la migración corre en transacción → rollback), en vez de confiar en que el
  // análisis previo siga siendo cierto cuando esto corra.
  const { rows } = await knex.raw(`
    SELECT count(*)::int AS malos FROM (
      SELECT warehouse_code, count(*) AS filas, count(DISTINCT product_id) AS productos
        FROM analytics.v_warehouse_box_factor GROUP BY 1
       HAVING count(*) <> count(DISTINCT product_id)) t`);
  if (Number(rows[0].malos) > 0) {
    throw new Error(
      `[W1.1] la vista abanicó: ${rows[0].malos} almacén(es) con más filas que productos. ` +
      'Revisar si wincaja.articulos dejó de ser único por (tenant, rama, dataset, articulo).',
    );
  }

  const { rows: r2 } = await knex.raw(`
    SELECT count(*)::int AS n FROM analytics.v_warehouse_box_factor
     WHERE erp = 'wincaja' AND factor_source = 'wincaja_factor_venta' AND box_factor = 1`);
  console.log(`[W1.1] filas con divisor 1 declarado por Wincaja (CJA): ${r2[0].n}  (medido antes: 150)`);
};

exports.down = async function down(knex) {
  await knex.raw(VISTA(COND_VIEJA));
  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');
};
