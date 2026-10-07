'use strict';
/**
 * `[RA-DYN.U1]` — **Unir lo que ya sabemos: las señales del motor de margen, al lado del pedido.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-01: de las ~34 variables que deberían pesar en un pedido, el
 * motor mira **8**. Otras **16 ya están medidas y publicadas** — casi todas en
 * `analytics.mv_price_signals`, que alimenta `/comercial/precios/motor` y lleva un registro de
 * 51 señales con su cobertura (`analytics.price_signal_registry`).
 *
 * El comprador abre `/compras/pedido` y no ve ninguna. Decide cuánto comprar sin saber que el
 * costo subió 10.4% en esa plaza, que lleva 163 días sin comprarle a ese proveedor, o que el
 * mismo artículo se está pagando 22.7% más caro aquí que en la plaza de al lado.
 *
 * **No se construye nada nuevo: se deriva.** Es una VISTA (regla principal del proyecto: cero
 * importers, derivar en vez de materializar una segunda copia del mismo hecho).
 *
 * ── ⛔ LO QUE ESTA VISTA SE NIEGA A TRAER, Y POR QUÉ ─────────────────────────────────────────
 * `mv_price_signals` también publica existencia y cobertura (`e3_existencia`,
 * `e1_dias_cobertura`, `e3_estado_inventario`). **NO entran.** Medido en prod, para el SKU 88022
 * en Morelia Madero:
 *
 *     ERP en vivo (analytics.v_erp_stock_on_hand) ...  36 PAQ
 *     analytics.replenishment_plan .................  36 PAQ   ← cuadra
 *     analytics.mv_price_signals ...................  83 PAQ   ← foto vieja
 *
 * y la cobertura que de ahí sale dice **133 días** donde el pedido dice 3. Las 8 plazas de ese
 * SKU cuadran al PAQ entre el ERP y el plan; la matvista deriva en 7 de 8 (+1, +1, +6, 0, 0, +3,
 * **+47**, +104). Traer esa columna metería una contradicción en la misma fila.
 *
 * El árbitro es el ERP (ADR-059): **la existencia la manda `v_erp_stock_on_hand`**, que es de
 * donde ya la lee `/almacen/inventory/existencia`. Las señales de COSTO y DEMANDA de la matvista
 * sí sirven — su rezago no las invalida porque no son una foto de inventario.
 *
 * ── ⚠️ LÍMITE DE ALCANCE QUE VIAJA CON LA VISTA ─────────────────────────────────────────────
 * `mv_price_signals` **no tiene `tenant_id`** (105 columnas, ninguna). Se la construyó para un
 * solo inquilino y su clave es `(sucursal, sku)` en texto. El puente de acá ancla en el lado que
 * SÍ está alcanzado por RLS (`replenishment_plan`) y cruza por `warehouse.code` + `sku`. Con un
 * segundo inquilino que repita un SKU, ese cruce mezcla. **Declarado, no resuelto**: arreglarlo
 * es de la matvista, no de esta vista, y hoy hay un solo inquilino.
 *
 * ── Lo que NO calcula, a propósito ──────────────────────────────────────────────────────────
 * El **mínimo de pedido** se expone crudo (`min_order_boxes`, `min_order_amount`) y NO se
 * resuelve por celda: un mínimo es del PROVEEDOR y se cumple con la canasta entera, no con un
 * renglón. Calcular «cuánto le falta a esta fila» daría un número que no significa nada.
 * `compras-existencia-critica.component.ts:753` ya agrupa por proveedor y avisa — ese es el
 * grano correcto, y es el que debe reusarse.
 *
 * ── ⛔ ESTE COMMIT NO CAMBIA NINGÚN NÚMERO PUBLICADO ────────────────────────────────────────
 * Sólo agrega una vista. Nadie la consume todavía; el sugerido de `/compras/pedido` sale igual
 * hoy que ayer. Cablearla a la pantalla es un commit aparte, con su antes/después.
 */

const VIEW = 'analytics.v_purchase_decision_signals';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW} AS
    WITH disp AS (
      -- Dispersión del costo del MISMO sku entre plazas: el argumento de negociación más fuerte
      -- que tenemos hoy. Medido: 3,077 de 5,333 SKUs con más de 5% de diferencia entre plazas.
      SELECT sku,
             min(a1_costo_hoy)            AS costo_min,
             max(a1_costo_hoy)            AS costo_max,
             count(DISTINCT sucursal)     AS plazas
        FROM analytics.mv_price_signals
       WHERE a1_costo_hoy > 0
       GROUP BY sku
    )
    SELECT
      rp.tenant_id,
      rp.warehouse_id,
      w.code                                AS warehouse_code,
      rp.product_id,
      rp.sku,
      rp.nombre,
      rp.supplier_id,
      sup.name                              AS supplier_name,

      ---------------------------------------------------------------- COSTO (para negociar)
      ps.a1_costo_hoy                       AS costo_reposicion,
      ps.a2_costo_ficha                     AS costo_ficha,
      ps.a3_ultimo_costo                    AS costo_ultima_compra,
      ps.a3_dias_sin_comprar                AS dias_sin_comprar,
      ps.a6_deriva_costo_pct                AS costo_deriva_pct,
      -- Qué costo se está usando. NUNCA 0 por ausencia: el motivo viaja en el rótulo.
      CASE WHEN ps.a1_costo_hoy  > 0 THEN 'reposicion'
           WHEN ps.a2_costo_ficha > 0 THEN 'ficha'
           ELSE 'sin_dato' END              AS costo_fuente,
      CASE WHEN ps.a2_costo_ficha > 0 AND ps.a1_costo_hoy > 0
           THEN round(((ps.a1_costo_hoy / ps.a2_costo_ficha) - 1) * 100, 2)
      END                                   AS costo_vs_ficha_pct,

      ------------------------------------------------- DISPERSIÓN ENTRE PLAZAS (mismo artículo)
      d.costo_min                           AS costo_min_red,
      d.costo_max                           AS costo_max_red,
      d.plazas                              AS costo_plazas_medidas,
      CASE WHEN d.plazas > 1 AND d.costo_min > 0
           THEN round(((d.costo_max / d.costo_min) - 1) * 100, 2)
      END                                   AS costo_dispersion_pct,
      -- Una sola plaza con costo NO es dispersión cero: es que no se puede comparar.
      CASE WHEN d.plazas IS NULL  THEN 'sin_costo'
           WHEN d.plazas = 1      THEN 'una_sola_plaza'
           ELSE 'medida' END                AS costo_dispersion_veredicto,

      ---------------------------------------------------------------- MARGEN (qué defiende el precio)
      ps.a4_margen_realizado_pct            AS margen_realizado_pct,
      ps.m1_meta_margen                     AS meta_margen_pct,
      ps.a4_dif_vs_meta_pp                  AS margen_dif_vs_meta_pp,

      ---------------------------------------------------------------- DEMANDA (más allá del promedio)
      ps.b5_iad                             AS demanda_iad,
      ps.b5_banda                           AS demanda_banda,
      ps.b10_lift_max                       AS canasta_lift,
      ps.b10_socios                         AS canasta_socios,
      ps.g5_promo_vigente                   AS promo_vigente,

      ---------------------------------------------------------------- PÉRDIDA (lo que se va sin venderse)
      ps.a10_no_explicado_vs_vendido_pct    AS merma_vs_vendido_pct,
      ps.e4_reportes_faltante               AS faltantes_reportados,
      ps.e4_ultimo_reporte                  AS faltante_ultimo,

      ---------------------------------------------------------------- PROVEEDOR (lo que amarra)
      sup.min_order_boxes                   AS min_order_boxes,
      sup.min_order_amount                  AS min_order_amount,
      sup.colchon_days                      AS colchon_days,
      sup.credit_days                       AS credit_days,
      sup.lead_time_days                    AS lead_time_capturado,
      sup.fill_rate_override                AS fill_rate,
      sup.is_critical                       AS proveedor_critico,

      ---------------------------------------------------------------- PROCEDENCIA (ADR-056)
      ps.calculado_al                       AS senales_calculadas_al,
      -- Lo que no se pudo medir se ENUMERA. Una fila sin señales llega NULL a un LEFT JOIN y se
      -- lee como sana; esta columna es la que impide esa lectura.
      ARRAY_REMOVE(ARRAY[
        CASE WHEN ps.sku IS NULL                      THEN 'sin_fila_en_senales' END,
        CASE WHEN ps.a1_costo_hoy IS NULL             THEN 'costo_reposicion' END,
        CASE WHEN ps.a6_deriva_costo_pct IS NULL      THEN 'costo_deriva' END,
        CASE WHEN ps.a4_margen_realizado_pct IS NULL  THEN 'margen_realizado' END,
        CASE WHEN ps.b5_iad IS NULL                   THEN 'momentum' END,
        CASE WHEN sup.id IS NULL                      THEN 'proveedor' END,
        CASE WHEN sup.min_order_boxes IS NULL
              AND sup.min_order_amount IS NULL        THEN 'minimo_de_pedido' END,
        CASE WHEN sup.fill_rate_override IS NULL      THEN 'fill_rate' END,
        CASE WHEN sup.credit_days IS NULL             THEN 'dias_de_credito' END
      ], NULL)                              AS senales_sin_dato

      FROM analytics.replenishment_plan rp
      JOIN commercial.warehouses w
        ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
      -- ⚠️ El puente es (code, sku) en TEXTO porque la matvista no tiene las llaves. Ver el
      -- límite de alcance en la cabecera.
      LEFT JOIN analytics.mv_price_signals ps
        ON ps.sucursal = w.code AND ps.sku = rp.sku
      LEFT JOIN disp d
        ON d.sku = rp.sku
      LEFT JOIN catalog.suppliers sup
        ON sup.tenant_id = rp.tenant_id AND sup.id = rp.supplier_id
  `);

  await knex.raw(`
    COMMENT ON VIEW ${VIEW} IS
      '[RA-DYN.U1] Las senales del motor de margen y las restricciones del proveedor, al lado '
      'de cada celda del pedido. DERIVADA, nunca materializada. NO trae existencia ni cobertura '
      'de mv_price_signals: medido 2026-10-01, esa matvista publica 83 PAQ donde el ERP dice 36. '
      'La existencia la manda analytics.v_erp_stock_on_hand (ADR-059).'
  `);

  // ⚠️ `security_invoker` y el GRANT van EXPLÍCITOS: no se heredan en un CREATE OR REPLACE
  // (lección U.7 / ADR-057). Sin lo primero la vista leería con los permisos del dueño y
  // saltaría el RLS de `replenishment_plan`.
  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  // ── Verificación dentro de la migración: si algo de esto no quedó, truena acá y no en prod ──
  const { rows: opts } = await knex.raw(
    `SELECT unnest(c.reloptions) AS o
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_purchase_decision_signals'`);
  if (!opts.some((x) => String(x.o).includes('security_invoker=true'))) {
    throw new Error('[RA-DYN.U1] la vista quedó SIN security_invoker: saltaría el RLS');
  }

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${VIEW}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[RA-DYN.U1] app_runtime no puede leer la vista');

  // Prueba NEGATIVA de la regla que justifica esta vista: la existencia de la matvista NO entra.
  // Un gate sin prueba negativa es una intención.
  const { rows: cols } = await knex.raw(
    `SELECT a.attname FROM pg_attribute a
       JOIN pg_class t ON t.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'analytics' AND t.relname = 'v_purchase_decision_signals'
        AND a.attnum > 0`);
  const prohibidas = cols
    .map((c) => c.attname)
    .filter((c) => /existencia|cobertura_dias|estado_inventario/.test(c));
  if (prohibidas.length) {
    throw new Error(
      `[RA-DYN.U1] la vista trae existencia de mv_price_signals (${prohibidas.join(', ')}): ` +
      'esa columna está rezagada y contradice al ERP');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
