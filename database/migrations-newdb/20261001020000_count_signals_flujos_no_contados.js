/**
 * `[EXP.3]` — Los tres flujos que el motor de conciliación NO contaba.
 *
 * Recrea `analytics.mv_erp_count_line_signals` (de `[EXP.1b]`) sumándole tres documentos de
 * Kepler que mueven existencia y que el roll-forward ignora. El resto de la matvista —grano,
 * testigos, partición, la pista `excede_la_venta`— no cambia: ver `20260930240000`.
 *
 * ## La pregunta que lo originó
 *
 * *¿en la interfaz ya consideramos todas las variables externas?* La respuesta era **no**, y
 * medirlo sobre la pila `sin_explicacion` de sep-2026 dio: **182 de 818 SKUs (22%) por
 * $119,569 — el 48% del dinero** tenían un movimiento registrado que nadie miraba.
 *
 * ## ⭐ Los doctypes se ARBITRARON, no se eligieron
 *
 * Mismo procedimiento que usó IC.10 para sus cuatro: agregar uno por uno y quedarse sólo con
 * los que **suben** el porcentaje de SKUs donde el motor cuadra. Medido sobre los 18,310
 * renglones juzgables del histórico:
 *
 * | doctype | qué es | signo | SKUs que toca | cuadre sin → con |
 * |---|---|---|---:|---|
 * | `N-D-5`      | Salida de almacén     | resta | 589 | **2.04% → 28.01%** |
 * | `U-A-21/25`  | Devolución de cliente | suma  | 970 | **6.49% → 23.51%** |
 * | `X-D-40`     | Devolución de compra  | resta |  25 | **0.00% → 20.00%** |
 *
 * Acumulado: el cuadre global pasa de **46.570% a 48.356%** (8,527 → 8,854 SKUs, **+327**).
 *
 * ## ⛔ Y uno que se midió y se RECHAZÓ
 *
 * `U-D-8` (Factura Telemarketing) y `U-D-12` (Factura Contado No Fiscal). El catálogo las
 * llama facturas y mi lectura decía que eran venta sin contar. **Restarlas derrumba el cuadre
 * de 27.25% a 3.15%** sobre los 2,951 SKUs que tocan, y el global de 46.57% a **44.20%**: esa
 * mercancía **ya está en `U-D-10`**. Son re-facturación, igual que `U-D-5` y `U-D-6`.
 * Queda escrito para que nadie las agregue leyendo el catálogo.
 *
 * ⭐ También se descartaron por SER INTENCIÓN, no movimiento: `X-A-30` requisición,
 * `X-A-35` orden de compra, `X-A-37` vale, `X-A-40` orden de entrada y `U-D-40` **pedido**.
 * Aparecían con volumen alto (16,583 unidades el primero) y no mueven un gramo: sólo
 * `X-A-20` «Aplica Orden Entrada» asienta.
 *
 * ## ⛔ El flujo explica FILA POR FILA, no en bloque
 *
 * `flujo_explica` es cierto sólo cuando aplicar los flujos **cierra** el residuo del
 * roll-forward. Medido: en bloque gana 402 y **rompe 75** — que valen **$0**, son SKUs sin
 * costo. Con la condición por fila gana los 402 y no rompe ninguno. Y 645 renglones más
 * **acercan** el residuo sin cerrarlo: eso se publica igual (`rf_residuo_con_flujos`), porque
 * «se acerca» también es información.
 *
 * ## ⚠️ Lo que esto NO arregla, y hay que decirlo
 *
 * El lugar correcto de estos tres doctypes es el **roll-forward**, no esta matvista: ahí
 * entrarían al `esperado` y el veredicto saldría bien desde el origen. No se hizo porque de
 * `mv_erp_count_rollforward` cuelga una cascada de **cinco objetos** que llega al motor de
 * precios (`v_price_signals` → `mv_price_signals` → `v_price_action`), y recrearla tumba
 * `/comercial/rentabilidad` varios minutos. Es una operación aparte, con su propia ventana.
 *
 * **Mientras tanto, el roll-forward sigue mal atribuyendo 402 SKUs por $216,657** — de los
 * cuales **$157,565 los llama MERMA** y tienen documento que los explica. La misma cifra viaja
 * a la familia `F9 · Merma` de `v_price_signals`.
 *
 * ⚠️ Dato operativo: el catálogo ofrece cinco motivos de salida (`N-D-5-1..5`: almacén,
 * ajuste, destrucción, muestra, carta porte) y la operación **usa sólo el genérico** — 596
 * documentos desde nov-2025, todos serie 1. El ERP no puede decir POR QUÉ salió la mercancía.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const [{ ok, patron }] = (await knex.raw(`
    SELECT (to_regclass('analytics.mv_erp_physical_count_variance') IS NOT NULL
        AND to_regclass('analytics.mv_erp_count_rollforward') IS NOT NULL
        AND to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL
        AND to_regclass('analytics.inventory_health') IS NOT NULL
        AND to_regclass('analytics.erp_goods_receipt_lines') IS NOT NULL) AS ok,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='analytics'
                      AND table_name='v_sku_count_variance_history'
                      AND column_name='patron') AS patron`)).rows;

  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  [EXP.1b] falta alguna fuente — matvista omitida');
    return;
  }
  if (!patron) {
    throw new Error(
      '[EXP.1b] v_sku_count_variance_history no tiene la columna patron: corre antes '
      + '20260930230000_sku_variance_history_patron.js. Recalcular el patron aca crearia la '
      + 'segunda definicion, que es justo lo que esa migracion vino a evitar.');
  }

  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_line_signals');

  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_count_line_signals AS
    WITH base AS (
      -- El grano del SKU. ATENCION: cantidad e importe vienen SIN signo en la matvista de
      -- IC.12; la direccion la lleva la columna signo. Se publican el bruto (cuadra con la
      -- pantalla por linea) y el neto (la variacion real del SKU), mas la bandera de cuando
      -- difieren. El veredicto se calcula sobre el NETO.
      SELECT v.tenant_id, v.warehouse_id, v.warehouse_code, v.kepler_sucursal, v.kepler_almacen,
             v.fecha, v.sku,
             max(v.product_id::text)::uuid                 AS product_id,
             max(v.descripcion)                            AS descripcion,
             max(v.unidad_erp)                             AS unidad_erp,
             count(*)::int                                 AS lineas,
             count(DISTINCT v.folio)::int                  AS folios,
             (count(DISTINCT v.signo) > 1)                 AS signos_mezclados,
             sum(v.cantidad * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END) AS cantidad_neta,
             sum(v.importe  * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END) AS importe_neto,
             sum(v.importe)                                AS importe_bruto,
             bool_or(v.costo_veredicto = 'peldano_arriba') AS peldano_arriba,
             sum(v.importe_en_costo_contado * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END)
               FILTER (WHERE v.costo_veredicto = 'peldano_arriba') AS importe_en_costo_contado
        FROM analytics.mv_erp_physical_count_variance v
       WHERE v.tipo_evento = 'conteo'
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    ),
    hist AS MATERIALIZED (
      -- MATERIALIZED a proposito: la vista escanea kdm1/kdm2 tres veces por dentro y sin esto
      -- se deriva una vez por cada uso. El patron y la retencion se LEEN, no se recalculan
      -- (EXP.1a los bajo a SQL para que haya una sola definicion).
      SELECT * FROM analytics.v_sku_count_variance_history
    ),
    rec AS MATERIALIZED (
      -- erp_goods_receipt_lines es una VISTA sin indices: unirla por fila la re-evalua y la
      -- consulta pasa de 1.2 s a mas de 120 s. Se materializa una vez, acotada a la ventana.
      SELECT h.warehouse_id, l.sku, h.receipt_date, h.folio, l.unidad, l.costo_unitario,
             l.cantidad
        FROM analytics.erp_goods_receipt_lines l
        JOIN analytics.erp_goods_receipts h
          ON h.tenant_id = l.tenant_id AND h.sucursal = l.sucursal AND h.folio = l.folio
       WHERE h.warehouse_id IS NOT NULL
         AND h.receipt_date >= (SELECT min(fecha) FROM base) - 180
         AND h.receipt_date <= (SELECT max(fecha) FROM base)
    ),
    oe AS (
      -- La ULTIMA entrada ANTES del conteo, no la ultima de todas: una recepcion posterior no
      -- puede explicar lo que se conto antes.
      SELECT DISTINCT ON (b.warehouse_id, b.fecha, b.sku)
             b.warehouse_id, b.fecha, b.sku,
             r.receipt_date AS oe_fecha, r.folio AS oe_folio, r.unidad AS oe_unidad,
             r.costo_unitario AS oe_costo_unitario, r.cantidad AS oe_cantidad
        FROM base b
        JOIN rec r ON r.warehouse_id = b.warehouse_id AND r.sku = b.sku
         AND r.receipt_date <= b.fecha AND r.receipt_date >= b.fecha - 180
       ORDER BY b.warehouse_id, b.fecha, b.sku, r.receipt_date DESC, r.folio
    ),
    flujo AS MATERIALIZED (
      -- [EXP.3] LOS TRES FLUJOS QUE EL ROLL-FORWARD NO CUENTA, arbitrados uno por uno.
      --
      -- El motor de conciliacion suma 4 doctypes (compra X-A-20, recepcion U-A-50, venta
      -- U-D-10, envio U-D-41). Estos tres mueven existencia y no estaban:
      --
      --   N-D-5    Salida de almacen        resta   589 SKUs: cuadre 2.04% -> 28.01%
      --   U-A-21/25 Devolucion de cliente   suma    970 SKUs: cuadre 6.49% -> 23.51%
      --   X-D-40   Devolucion de compra     resta    25 SKUs: cuadre 0.00% -> 20.00%
      --
      -- ⛔ Y UNO QUE SE MIDIO Y SE RECHAZO: U-D-8 Factura Telemarketing + U-D-12 Factura
      -- Contado No Fiscal. El catalogo las llama facturas y parecian venta que faltaba contar;
      -- restarlas DERRUMBA el cuadre de 27.25% a 3.15% sobre los 2,951 SKUs que tocan, y el
      -- global de 46.57% a 44.20%. Esa mercancia YA esta en U-D-10: son re-facturacion, igual
      -- que U-D-5 y U-D-6. No las agregues.
      --
      -- La ventana es la del PAR del roll-forward, (desde, hasta], la misma que el motor usa.
      SELECT r.tenant_id, r.warehouse_id, r.sku, r.hasta,
             coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='N' AND m.c3='D' AND m.c4::int=5), 0)
               AS flujo_salida,
             coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='U' AND m.c3='A' AND m.c4::int IN (21,25)), 0)
               AS flujo_devolucion_cliente,
             coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='X' AND m.c3='D' AND m.c4::int=40), 0)
               AS flujo_devolucion_compra
        FROM analytics.mv_erp_count_rollforward r
        JOIN kepler_ods.kdm1 m
          ON m.sucursal = r.kepler_sucursal
         -- ⛔ ANTI-REPLICA: sin esto la 03 arrastra cabeceras del almacen 02.
         AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         AND m.c9::date > r.desde AND m.c9::date <= r.hasta
         AND (   (m.c2='N' AND m.c3='D' AND m.c4::int = 5)
              OR (m.c2='U' AND m.c3='A' AND m.c4::int IN (21,25))
              OR (m.c2='X' AND m.c3='D' AND m.c4::int = 40))
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
         AND btrim(l.c8) = r.sku
       WHERE r.veredicto <> 'no_recontado'
       GROUP BY 1, 2, 3, 4
    ),
    j AS (
      SELECT b.*,
             rf.veredicto            AS rf_veredicto,
             rf.no_explicado         AS rf_no_explicado,
             rf.importe_no_explicado AS rf_importe_no_explicado,
             hi.veces_contado, hi.veces_descuadro,
             hi.pesos_abs  AS pesos_abs_hist,
             hi.pesos_neto AS pesos_neto_hist,
             hi.retencion, hi.patron,
             ih.avg_daily_units AS demanda_diaria,
             (b.fecha >= current_date - 90) AS demanda_aplicable,
             CASE WHEN ih.avg_daily_units > 0 AND b.fecha >= current_date - 90
                  THEN round(b.cantidad_neta / ih.avg_daily_units, 1) END AS dias_de_venta,
             oe.oe_fecha, oe.oe_folio, oe.oe_unidad, oe.oe_costo_unitario, oe.oe_cantidad,
             coalesce(fl.flujo_salida, 0)             AS flujo_salida,
             coalesce(fl.flujo_devolucion_cliente, 0) AS flujo_devolucion_cliente,
             coalesce(fl.flujo_devolucion_compra, 0)  AS flujo_devolucion_compra,
             (fl.tenant_id IS NOT NULL)               AS flujo_medido
        FROM base b
        -- hasta = fecha: UN roll-forward por renglon, el par que TERMINA en este conteo.
        -- Medido: maximo 1 fila por par. Sin esta igualdad el join abanica.
        LEFT JOIN analytics.mv_erp_count_rollforward rf
          ON rf.tenant_id = b.tenant_id AND rf.warehouse_id = b.warehouse_id
         AND rf.hasta = b.fecha AND rf.sku = b.sku
        LEFT JOIN hist hi
          ON hi.tenant_id = b.tenant_id AND hi.warehouse_id = b.warehouse_id AND hi.sku = b.sku
        LEFT JOIN analytics.inventory_health ih
          ON ih.tenant_id = b.tenant_id AND ih.warehouse_id = b.warehouse_id
         AND ih.product_id = b.product_id
        LEFT JOIN oe
          ON oe.warehouse_id = b.warehouse_id AND oe.fecha = b.fecha AND oe.sku = b.sku
        -- Misma llave que el roll-forward: el par que TERMINA en este conteo.
        LEFT JOIN flujo fl
          ON fl.tenant_id = b.tenant_id AND fl.warehouse_id = b.warehouse_id
         AND fl.hasta = b.fecha AND fl.sku = b.sku
    ),
    k AS (
      SELECT j.*,
             CASE WHEN j.importe_neto > 0 THEN 'sobrante'
                  WHEN j.importe_neto < 0 THEN 'faltante' ELSE 'cuadra' END AS signo,
             -- PISTA, no explicacion: su placebo mide 16.9% en sobrantes contra 10.1% en
             -- faltantes (razon 1.67x, estable en todos los umbrales). Ordena la pila; no la
             -- vacia. La ventana de 90 dias NO es un numero elegido: es la ventana sobre la que
             -- avg_daily_units esta medido (import-inventory-health.js).
             (j.importe_neto > 0 AND j.dias_de_venta > 90) AS excede_la_venta,
             CASE WHEN j.demanda_diaria IS NULL  THEN 'sin_demanda_registrada'
                  WHEN NOT j.demanda_aplicable   THEN 'conteo_anterior_a_la_ventana'
                  WHEN j.demanda_diaria = 0      THEN 'sin_venta_en_90d'
                  ELSE 'medida' END AS demanda_motivo,
             (j.oe_unidad IS NOT NULL AND j.unidad_erp IS NOT NULL
              AND j.oe_unidad IS DISTINCT FROM j.unidad_erp) AS oe_unidad_discrepa,
             -- Solo los testigos que PARTICIPAN en la particion. La demanda no produce ninguna
             -- explicacion, asi que tampoco puede impedir que se emita otra.
             array_remove(ARRAY[
               CASE WHEN j.rf_veredicto IS NULL OR j.rf_veredicto = 'no_recontado'
                    THEN 'rollforward' END,
               CASE WHEN j.veces_contado IS NULL OR j.veces_contado < 2 THEN 'historial' END
             ], NULL) AS testigos_faltantes,
             current_date AS demanda_ventana_hasta,
             -- [EXP.3] El residuo del roll-forward DESPUES de aplicar los tres flujos.
             round((j.rf_no_explicado + j.flujo_salida - j.flujo_devolucion_cliente + j.flujo_devolucion_compra), 4) AS rf_residuo_con_flujos,
             -- ⭐ El flujo EXPLICA el renglon sólo si CIERRA la brecha, fila por fila. No se
             -- recalcula a ciegas: medido sobre los 18,310 juzgables, aplicarlo en bloque
             -- gana 402 y ROMPE 75 (que valen $0, son SKUs sin costo). Con la condicion por
             -- fila gana los 402 y no rompe ninguno.
             (j.rf_no_explicado IS NOT NULL
              AND abs(j.rf_no_explicado) >= 0.01
              AND abs((j.rf_no_explicado + j.flujo_salida - j.flujo_devolucion_cliente + j.flujo_devolucion_compra)) < 0.01) AS flujo_explica,
             -- Cual de los tres pesa mas. Se publica siempre, explique o no: 645 renglones
             -- mas ACERCAN el residuo sin cerrarlo, y eso tambien es informacion.
             CASE WHEN greatest(abs(j.flujo_salida), abs(j.flujo_devolucion_cliente),
                                abs(j.flujo_devolucion_compra)) = 0 THEN NULL
                  WHEN abs(j.flujo_salida) >= abs(j.flujo_devolucion_cliente)
                   AND abs(j.flujo_salida) >= abs(j.flujo_devolucion_compra)
                    THEN 'salida_de_almacen'
                  WHEN abs(j.flujo_devolucion_cliente) >= abs(j.flujo_devolucion_compra)
                    THEN 'devolucion_de_cliente'
                  ELSE 'devolucion_de_compra' END AS flujo_dominante
        FROM j
    )
    SELECT k.*,
           CASE WHEN k.peldano_arriba                                 THEN 'costo_de_caja'
                WHEN k.rf_veredicto = 'cuadra'                        THEN 'movimientos_lo_explican'
                -- [EXP.3] Un documento que el motor no suma, y que CIERRA la brecha.
                WHEN k.flujo_explica                                  THEN k.flujo_dominante
                WHEN k.veces_contado >= 2 AND k.patron = 'merma'       THEN 'merma_sostenida'
                WHEN k.veces_contado >= 2 AND k.patron = 'sobra'       THEN 'sobra_sostenida'
                WHEN k.veces_contado >= 2 AND k.patron = 'se_compensa' THEN 'se_compensa'
                WHEN cardinality(k.testigos_faltantes) > 0             THEN 'no_medido'
                ELSE 'sin_explicacion' END AS explicacion
      FROM k
  `);

  await knex.raw(`CREATE UNIQUE INDEX ux_erpcls_grano
    ON analytics.mv_erp_count_line_signals (tenant_id, warehouse_id, fecha, sku)`);
  await knex.raw(`CREATE INDEX ix_erpcls_evento
    ON analytics.mv_erp_count_line_signals (tenant_id, warehouse_id, fecha)`);
  await knex.raw(`CREATE INDEX ix_erpcls_sku
    ON analytics.mv_erp_count_line_signals (tenant_id, sku)`);
  await knex.raw(`CREATE INDEX ix_erpcls_explicacion
    ON analytics.mv_erp_count_line_signals (tenant_id, explicacion)`);

  await knex.raw('GRANT SELECT ON analytics.mv_erp_count_line_signals TO app_runtime');

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_count_line_signals IS
    'EXP.3 (sobre EXP.1b) - Suma tres flujos ARBITRADOS que el roll-forward no cuenta: N-D-5 salida de almacen (cuadre 2.04%% a 28.01%%), U-A-21/25 devolucion de cliente (6.49%% a 23.51%%) y X-D-40 devolucion de compra (0%% a 20%%); global 46.570%% a 48.356%%. RECHAZADO con medicion: U-D-8/U-D-12, que DERRUMBAN el cuadre a 3.15%% porque esa mercancia ya esta en U-D-10. flujo_explica es por FILA (cierra el residuo), no en bloque. ⚠️ El lugar correcto de los tres es el roll-forward, pero de el cuelga una cascada de 5 objetos hasta el motor de precios: mientras tanto ese motor sigue llamando MERMA a $157,565 que tienen documento. - EXP.1b - Senales del descuadre del conteo fisico, por (almacen, fecha, SKU). Es la LLAVE que faltaba: el roll-forward, el historial, la demanda y las ordenes de entrada existian pero ninguno estaba indexado por SKU. Grano de SKU a proposito: la matvista de IC.12 es por LINEA y trae 1,483 filas de mas sobre el mismo universo. cantidad e importe vienen SIN signo en la fuente, asi que aca se publican importe_bruto (cuadra con la pantalla por linea) e importe_neto (la variacion real); 504 pares traen los dos signos el mismo dia y $4,376,696 se cancelan solos, todos en el almacen 02 entre nov-2025 y ene-2026. explicacion es una PARTICION evaluada en orden; no_medido NO significa que no haya causa, significa que falta un testigo (casi siempre el roll-forward o el historial, porque un almacen contado una sola vez no tiene con que compararse). excede_la_venta es una PISTA, no una explicacion: su placebo dispara en 10.1%% de los faltantes donde no explica nada. La matvista NO soporta RLS: filtrar tenant_id a mano.'`);

  const [{ filas, mezclados, pila, pesos_pila }] = (await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE signos_mezclados)::int AS mezclados,
           count(*) FILTER (WHERE explicacion = 'sin_explicacion')::int AS pila,
           round(sum(abs(importe_neto)) FILTER (WHERE explicacion = 'sin_explicacion'))::bigint
             AS pesos_pila
      FROM analytics.mv_erp_count_line_signals`)).rows;
  // eslint-disable-next-line no-console
  const [{ explicados }] = (await knex.raw(
    `SELECT count(*) FILTER (WHERE flujo_explica)::int AS explicados
       FROM analytics.mv_erp_count_line_signals`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[EXP.3] ${filas} pares · ${mezclados} con signos mezclados · `
    + `${explicados} explicados por un flujo que el motor no contaba · `
    + `pila accionable: ${pila} SKUs / $${pesos_pila}`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_line_signals');
};
