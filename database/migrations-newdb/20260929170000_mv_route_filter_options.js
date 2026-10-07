/**
 * `[AUD-DAT.17]` — **Los dos combos de `/dashboard/ventas-detalle` costaban 96 segundos.**
 *
 * ── EL SÍNTOMA, MEDIDO ──────────────────────────────────────────────────────────────────────
 * La pantalla abre cuatro llamadas en paralelo y la más lenta manda. Medido en
 * `pg_stat_statements` (ventana de 4 d) el 2026-09-29:
 *
 *     combo de CLIENTES ....... 96,303 ms de promedio · 116,793 ms el peor · 490 M páginas
 *     reporte principal .......      1–4 ms   (lee el rollup `sales_by_route_monthly`)
 *
 * O sea que la pantalla no es lenta por el reporte: es lenta por **dos listas desplegables**.
 *
 * ── LA CAUSA ────────────────────────────────────────────────────────────────────────────────
 * Los dos combos leían `analytics.v_route_sales_lines`, que es el contrato **ENRIQUECIDO** del
 * desglose por ticket: sobre un UNION de tres ramas agrega, **por línea**, un LATERAL a
 * `wincaja.articulos` (rótulo de unidad) y otro LATERAL anidado a `wincaja.pagos_dia` →
 * `wincaja.formas_pago` (forma de pago dominante).
 *
 * Un combo de clientes sólo necesita `cliente` e `importe`. Pagaba los dos LATERAL igual, sobre
 * **1,194,719 líneas** de dos años (986,224 Wincaja ruta + 208,495 del push). Y Postgres no los
 * puede eliminar: llevan `ORDER BY … LIMIT 1`, así que se ejecutan una vez por fila.
 *
 * Es el mismo defecto que `[RR-PROMO.6]` ya midió y corrigió para la vista hermana
 * (`v_seller_sales_lines`): *"el mismo dato sin las columnas que este consumidor no lee"*.
 *
 * ── POR QUÉ MATERIALIZAR, Y NO SÓLO ADELGAZAR ───────────────────────────────────────────────
 * Verificado contra prod antes de escribir esto, el universo completo de clientes a 2 años:
 *
 *     enriquecida (hoy) .... 6,298 clientes · $88,125,359.60 · 69,608 ms
 *     lean (sin LATERAL) ... 6,298 clientes · $88,125,359.60 · 12,490 ms
 *
 * **Idéntico al centavo y 5.6× más rápido** — pero 12.5 s sigue lejos del gate de 1 s, porque el
 * piso lo pone `wincaja.v_sales_lines`, que ya es una vista cara. Y esto es un **catálogo**: la
 * lista de clientes y de SKUs que se ofrecen para filtrar no cambia dentro de una sesión.
 * Materializar por COSTO es legítimo (`GOTCHAS` §19); lo prohibido es materializar un valor
 * inventado, y acá cada fila sale de la primaria y se puede reconstruir.
 *
 * ⚠️ **FRESCURA DECLARADA:** se refresca una vez al día. Un cliente que compró hoy por primera
 * vez aparece en el combo mañana. Por eso la matvista lleva `computed_at`: el dato de cuándo se
 * calculó viaja CON la fila, no en la cabeza de quien la lee (ADR-056).
 *
 * ⚠️ **NO es un universo nuevo.** Las tres ramas son las MISMAS de `v_route_sales_lines`,
 * incluida la tercera (`VEC-PH-H`, vecinal histórico de PH con su corte del 2026-06-28), que sí
 * entra porque esa vista la publica como `sale_channel='ruta_venta'`. Reusar
 * `v_seller_sales_lines` —que ya es lean— habría sido más corto y **habría perdido esa rama**,
 * que ella excluye a propósito. El candado `test-newdb-route-filter-options.js` compara las dos
 * y truena si divergen.
 */

const MV = 'analytics.mv_route_filter_options';

/** El universo LEAN: las tres ramas de `v_route_sales_lines` sin el enriquecimiento por línea. */
const LINEAS = `
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'ruta_venta'
     AND vl.business_date >= (CURRENT_DATE - INTERVAL '2 years')
  UNION ALL
  SELECT rpl.tenant_id, rpl.cliente, rpl.sku, rpl.importe
    FROM analytics.route_push_lines rpl
   WHERE rpl.business_date >= (CURRENT_DATE - INTERVAL '2 years')
  UNION ALL
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'preventa_vecinal' AND vl.source_branch = '10'
     AND vl.business_date < '2026-06-28'::date
     AND vl.business_date >= (CURRENT_DATE - INTERVAL '2 years')`;

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS ${MV} AS
    WITH lineas AS (${LINEAS})
    -- ── CLIENTES ────────────────────────────────────────────────────────────────────────────
    SELECT l.tenant_id,
           'cliente'::text AS kind,
           l.cliente       AS value,
           COALESCE(cn.name, l.cliente) AS label,
           sum(l.importe)  AS rev,
           now()           AS computed_at
      FROM lineas l
      LEFT JOIN LATERAL (SELECT DISTINCT ON (cliente) nombre AS name
                           FROM wincaja.clientes c
                          WHERE c.tenant_id = l.tenant_id AND c.cliente = l.cliente
                          ORDER BY cliente, source_dataset DESC) cn ON true
     WHERE l.cliente IS NOT NULL AND btrim(l.cliente) <> '' AND l.cliente <> '0001'
     GROUP BY l.tenant_id, l.cliente, cn.name

    UNION ALL

    -- ── PRODUCTOS ───────────────────────────────────────────────────────────────────────────
    SELECT l.tenant_id,
           'sku'::text AS kind,
           l.sku       AS value,
           COALESCE(pn.name, l.sku) AS label,
           sum(l.importe) AS rev,
           now()       AS computed_at
      FROM lineas l
      LEFT JOIN LATERAL (SELECT DISTINCT ON (sku) nombre AS name
                           FROM catalog.products p
                          WHERE p.tenant_id = l.tenant_id AND p.sku = l.sku AND p.deleted_at IS NULL
                          ORDER BY sku) pn ON true
     WHERE l.sku IS NOT NULL
     GROUP BY l.tenant_id, l.sku, pn.name
    WITH NO DATA`);

  // ⛔ UNIQUE obligatorio: sin él `REFRESH MATERIALIZED VIEW CONCURRENTLY` no es posible y el
  // refresco bloquearía a los lectores. Las 21 matvistas de esta base lo tienen, sin excepción.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_route_filter_options
                    ON ${MV} (tenant_id, kind, value)`);
  // El combo ordena por venta DESC y corta en 5,000: que salga del índice, no de un sort.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_mv_route_filter_options_rev
                    ON ${MV} (tenant_id, kind, rev DESC NULLS LAST)`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    '[AUD-DAT.17] Catalogo de los combos de /dashboard/ventas-detalle (cliente y sku, 2 anios).
     Mismo universo que analytics.v_route_sales_lines pero SIN su enriquecimiento por linea
     (LATERAL a articulos y a pagos_dia/formas_pago), que esos combos no leen y costaba 96 s.
     Verificado identico al centavo: 6,298 clientes / $88,125,359.60. Refresco diario: la
     frescura viaja en computed_at. Candado: test-newdb-route-filter-options.js'`);

  // `app_runtime` sólo lee. El REFRESH lo hace el owner (`KNEX_NEW_DB_ADMIN`), como las otras 21.
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`).catch(() => { /* rol ausente en dev */ });
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
