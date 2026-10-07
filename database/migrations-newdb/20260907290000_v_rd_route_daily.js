/**
 * RD.2 — `analytics.v_rd_route_daily`: la venta de la Ruta Directa por ruta y por día,
 * declarando con qué se calculó cada cifra.
 *
 * POR QUÉ ESTA VISTA
 * El tablero manual `INDICADORES RD 2026.xlsx` mide 13 rutas (PH 21/22/23/26/27/28,
 * Morelia 321/322, Canindo 501-505) con tres columnas por día: COSTO, SUBTOTAL y VENTA.
 * Al reconciliarlo celda por celda contra prod (2,446 celdas ruta×día) aparecieron dos
 * defectos del dato, además del corrimiento de fecha que arregló RD.1:
 *
 * ── 1) `v_route_sales_lines.importe` MEZCLA NETO Y BRUTO ────────────────────────────────
 * Los tramos Wincaja ponen ahí `detalles_mov_almacen.valor_venta`, que es venta SIN
 * impuestos. El tramo del push (`analytics.route_push_lines`, camionetas de PH desde
 * 2026-06-29 y rutas vecinales Kepler) pone `mart.ventas.importe`, que es venta CON
 * impuestos. Medido: 312 celdas ruta×día del tramo push, razón 1.0001 contra la columna
 * VENTA del Excel — o sea el push casa con la venta bruta, no con el subtotal.
 * Cualquier suma que cruce el cutover del 29-jun suma peras con manzanas, ~+9.9%.
 * Ya afecta dinero: `route-promo.service.ts` usa `importe` para el umbral `min_importe`
 * del motor de incentivos Y para resolver la unidad por precio (`importe/qty` contra el
 * precio de catálogo), y `route-adherence.service.ts` lo suma directo.
 *
 * `importe` NO se toca: mover esa columna cambiaría pagos y pantallas sin medirlo, que es
 * justo el pecado de RS.12b. Esta vista deriva las dos formas y ROTULA cuál es cuál.
 *
 * ── 2) EL COSTO HISTÓRICO DE WINCAJA NO ES ESTABLE ──────────────────────────────────────
 * `SUBTOTAL` del Excel casa **98.0%** exacto (1,934 de 1,974 celdas) y `VENTA` **97.2%**,
 * pero `COSTO` sólo **14.1%**. No es un problema de fórmula: en la ruta 27 las TRES
 * columnas casan al centavo (141/150), así que el Excel copia las mismas tres expresiones
 * que calculamos acá. La diferencia está en el VALOR de `valor_costo`, y la causa está
 * medida: el importer reescribe TODAS las líneas en cada corrida — las 357k líneas de
 * ruta, incluidas las de enero, tienen `imported_at` de hoy, un solo día distinto. Wincaja
 * re-expresa el costo de ventas pasadas cuando se mueve su costo promedio, y la réplica
 * carga la re-expresión de hoy, no la que la persona vio en enero.
 *
 * Consecuencia: **no existe hoy un costo histórico reproducible de la venta en ruta**. El
 * margen de un mes cerrado cambia solo, cada noche, sin que nadie toque nada. Por eso
 * `costo_status` sale rotulado y no se publica un margen como si fuera estable. Guardar el
 * costo del día cuando se lee (snapshot) es RD.3 — el caso de "histórico" que la regla #1
 * admite como tabla real.
 *
 * ── LAS TASAS ───────────────────────────────────────────────────────────────────────────
 * Para el tramo Wincaja el bruto se arma con la tasa de la LÍNEA (`d.iva`, `d.ieps`), que
 * son PORCENTAJES (16, 8, 0) y no montos — sumarlas no significa nada.
 * Para el tramo push no hay tasa por línea, así que el neto se DERIVA del catálogo. Se
 * probaron las dos fuentes contra el Excel como árbitro (312 celdas):
 *     wincaja.articulos.iva_venta/ieps_venta  → +0.251%   ← se usa ésta
 *     catalog.products.iva_rate/ieps_rate     → −2.011%
 * Ojo con la escala, que difiere entre las dos: `wincaja.articulos` viene en PORCENTAJE
 * (16) y `catalog.products` en FRACCIÓN (0.16). Probar la unidad de los dos lados antes de
 * dividir; la primera pasada de esta medición dio −9.35% justamente por eso.
 * El neto del push nunca es exacto: `subtotal_origen` lo declara.
 *
 * Vista (derive-no-copy) sobre la vista principal: sin tabla nueva y sin importer.
 * `analytics.*` no lleva RLS → el filtro de tenant lo pone el consumidor, como el resto
 * del schema. `security_invoker` para que herede los permisos de quien pregunta.
 *
 * @param { import("knex").Knex } knex
 */

const SQL = `
  CREATE OR REPLACE VIEW analytics.v_rd_route_daily WITH (security_invoker = true) AS
  WITH tasa AS (
    -- Tasa de venta del catálogo Wincaja, en PORCENTAJE. Sólo para el tramo push,
    -- que no trae impuesto por línea. Cobertura medida: 100% de los SKUs del push.
    SELECT DISTINCT ON (tenant_id, articulo)
           tenant_id, articulo,
           COALESCE(iva_venta, 0)  AS iva_pct,
           COALESCE(ieps_venta, 0) AS ieps_pct
    FROM wincaja.articulos
    ORDER BY tenant_id, articulo, source_dataset DESC
  )
  SELECT
    sl.tenant_id,
    sl.source_branch                                  AS route_code,
    sl.business_date,
    sl.source,

    -- SUBTOTAL (sin impuestos). Wincaja: el dato del ERP. Push: derivado de la tasa.
    round(sum(
      CASE WHEN sl.source = 'push'
           THEN sl.importe / (1 + t.iva_pct / 100.0 + t.ieps_pct / 100.0)
           ELSE sl.importe
      END
    )::numeric, 2)                                    AS subtotal,
    CASE WHEN sl.source = 'push' THEN 'derivado_tasa_wincaja' ELSE 'erp' END
                                                      AS subtotal_origen,

    -- VENTA (con impuestos). Wincaja: la tasa viene por línea. Push: ya viene bruto.
    round(sum(
      CASE WHEN sl.source = 'push'
           THEN sl.importe
           ELSE sl.importe * (1 + COALESCE(sl.iva, 0) / 100.0 + COALESCE(sl.ieps, 0) / 100.0)
      END
    )::numeric, 2)                                    AS venta,
    CASE WHEN sl.source = 'push' THEN 'erp' ELSE 'derivado_tasa_linea' END
                                                      AS venta_origen,

    -- COSTO. Existe sólo en el tramo Wincaja, y ahí se re-expresa en cada corrida.
    CASE WHEN sl.source = 'push' THEN NULL
         ELSE round(sum(sl.costo)::numeric, 2)
    END                                               AS costo,
    CASE WHEN sl.source = 'push' THEN 'sin_dato_en_la_fuente'
         ELSE 'erp_reexpresado_cada_corrida'
    END                                               AS costo_status,

    count(*)::int                                     AS lineas,
    count(DISTINCT sl.consecutivo)::int               AS tickets
  FROM analytics.v_route_sales_lines sl
  LEFT JOIN tasa t
    ON t.tenant_id = sl.tenant_id AND t.articulo = sl.sku
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source
`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  await knex.raw(`GRANT SELECT ON analytics.v_rd_route_daily TO app_runtime`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_rd_route_daily IS
      'RD.2 — venta de Ruta Directa por ruta x dia, con procedencia. subtotal/venta traen su *_origen porque el tramo push (PH desde 2026-06-29, vecinales Kepler) guarda BRUTO donde Wincaja guarda NETO y su neto hay que derivarlo de la tasa de catalogo (+0.25% medido contra el Excel de INDICADORES RD). costo sale NULL en el push y rotulado erp_reexpresado_cada_corrida en Wincaja: el importer reescribe todas las lineas en cada corrida, asi que el costo de un mes cerrado cambia solo. Verificado: SUBTOTAL 98.0% exacto y VENTA 97.2% contra 1,974 celdas del workbook.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_rd_route_daily`);
};
