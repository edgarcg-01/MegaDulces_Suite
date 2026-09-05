/**
 * D.1 — DICTAMEN DE EXISTENCIA: en qué se apoya cada número, y qué lo contradice.
 *
 * POR QUÉ ESTA VISTA EXISTE, Y POR QUÉ NO SE LLAMA "verdad".
 * Edgar pidió "una verdad absoluta en las existencias". La verdad absoluta del SALDO no es
 * alcanzable hoy, y no es limitación nuestra: Kepler guarda
 *
 *     existencia = c4(inicial) + c8(entradas acumuladas) - c9(salidas acumuladas)
 *
 * y **c4 vale 0 en el 100% de las 27,217 filas** (medido 2026-09-05; ya documentado como bug de
 * datos de Kepler en el header de 20260902170000). O sea la existencia de Kepler ES el flujo: no
 * hay un segundo testigo contra el cual cuadrarla, y comparar la suma de movimientos contra kdil
 * es CIRCULAR — dos lecturas del mismo dato. La Fase SM ya se detuvo por esto mismo
 * (01_TRACKER_PROGRESO.md:594 "detector completitud, diferido, existencia buggy").
 *
 * Lo que sí se puede, y es lo que hace esta vista: decir, celda por celda, EN QUÉ SE APOYA el
 * número y QUÉ LO CONTRADICE. Hoy publicamos con la misma confianza una celda sólida y una
 * imposible, porque GREATEST(...,0) convierte lo imposible en cero.
 *
 * ── DOS EJES, no una lista ────────────────────────────────────────────────────────────────
 * apoyo    : conteo_fisico > baseline_real > solo_flujo
 * objecion : nunca_entro > faltante > negativo_menor > unidad_sin_verificar > desfasado > ninguna
 *
 * ── LO MEDIDO EN PROD AL ESCRIBIRLA (2026-09-05) — es el contraste del test ────────────────
 *   2,183 saldos negativos en Kepler (sucursal 01 al 16.4%; el peor -15,710), $2,331,687 a costo,
 *   y 1,985 de ellos (91%) vendieron en los ultimos 90 dias — no es basura historica.
 *     · nunca_entro     998 casos / $404,740   — salio mercancia que NUNCA se registro entrando
 *     · faltante        410 casos / $1,609,938 — el hueco supera el 15% de las salidas
 *     · negativo_menor  775 casos / $317,008   — mediana 8%, COMPATIBLE con el baseline perdido
 *
 * ⚠️ HIPOTESIS DESCARTADA, y vale registrarla: probamos si los negativos eran otro caso de peldaño
 * cruzado (entradas en cajas, salidas en piezas). NO lo son — la razon mediana salidas/entradas es
 * 1.08, no un factor de caja de 10-24. Son faltantes reales, no error de unidad.
 *
 * ⚠️ negativo_menor NO es una anomalia operativa: es lo que produce el baseline perdido. Por eso
 * se declara pero NO abre expediente (D.3). Llenar la bandeja con 775 casos que un defecto
 * conocido ya explica la volveria inservible.
 *
 * ⚠️ ESTA VISTA NO REEMPLAZA a analytics.v_erp_stock_on_hand y NO se debe "unificar" con ella.
 * Aquella clampa a cero y alimenta replenishment_plan -> el pedido sugerido y la valuacion; un
 * saldo -5,553 entrando ahi como demanda negativa tiene efectos que este trabajo no puede acotar.
 * Esta expone el CRUDO y la lee unicamente la pantalla de Existencia. Ver D.2 del plan.
 *
 * derive-no-copy + security_invoker: la RLS de warehouses/products filtra el tenant sola.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_existencia_dictamen');

  await knex.raw(`
    CREATE VIEW analytics.v_existencia_dictamen AS
    WITH kep AS (
      -- Rama Kepler. Se replica EXACTO el recorte de la vista canonica (k.sucursal = k.c1 y los
      -- tres pseudo-SKU) para que las dos hablen del mismo universo; si divergen, el candado
      -- qty_publicada == GREATEST(qty_cruda, 0) lo caza.
      -- Nota: c1 es el ALMACEN, no la sucursal (ERP_KEPLER regla 7). El filtro deja el almacen
      -- principal. Medido: el unico almacen secundario con existencia es el 02 de la sucursal 03,
      -- y esta MUERTO (sin un movimiento desde 2026-01-07), asi que excluirlo es correcto.
      SELECT w.tenant_id,
             w.id                                AS warehouse_id,
             w.code                              AS warehouse_code,
             pr.id                               AS product_id,
             pr.sku,
             'kepler'::text                      AS erp,
             0::numeric                          AS baseline,
             sum(k.c8)::numeric                  AS entradas,
             sum(k.c9)::numeric                  AS salidas,
             sum(k.c4 + k.c8 - k.c9)::numeric    AS qty_cruda,
             -- 1800-01-01 es el centinela de "nunca" de Kepler; se normaliza a NULL para que
             -- nadie lo lea como una fecha real.
             NULLIF(max(k.c6), '1800-01-01 06:36:36'::timestamp) AS ult_compra,
             NULLIF(max(k.c7), '1800-01-01 06:36:36'::timestamp) AS ult_venta
        FROM kepler_ods.kdil k
        JOIN commercial.warehouses w
             ON w.kepler_code = k.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
        JOIN catalog.products pr
             ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
       WHERE k.sucursal = k.c1
         AND btrim(k.c3) NOT IN ('00001', '00002', '00022')
       GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
    ),
    win AS (
      -- Rama Wincaja. A diferencia de Kepler, aca los tres terminos del kardex SON columnas
      -- reales. Medido: la identidad inicial + entrada - salida == existencia cuadra al 100.0%
      -- en las 46,551 filas, y 6,207 pares tienen existencia_inicial <> 0 — la unica rama con
      -- baseline parcial de verdad.
      -- Se va a wincaja.existencias y no a v_stock porque esa vista NO expone los tres terminos.
      SELECT w.tenant_id,
             w.id                                     AS warehouse_id,
             w.code                                   AS warehouse_code,
             pr.id                                    AS product_id,
             pr.sku,
             'wincaja'::text                          AS erp,
             sum(COALESCE(e.existencia_inicial, 0))::numeric AS baseline,
             sum(COALESCE(e.entrada, 0))::numeric     AS entradas,
             sum(COALESCE(e.salida, 0))::numeric      AS salidas,
             sum(COALESCE(e.existencia, 0))::numeric  AS qty_cruda,
             max(e.fecha_ult_compra)                  AS ult_compra,
             max(e.fecha_ult_venta)                   AS ult_venta
        FROM wincaja.existencias e
        JOIN commercial.warehouses w
             ON w.tenant_id = e.tenant_id AND w.wincaja_source_branch = e.source_branch
            AND w.kepler_code IS NULL AND w.deleted_at IS NULL
        JOIN catalog.products pr
             ON pr.tenant_id = e.tenant_id AND pr.sku::text = e.articulo AND pr.deleted_at IS NULL
       WHERE e.source_dataset = 'actual'
         AND e.existencia IS NOT NULL
       GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
    ),
    base AS (
      SELECT * FROM kep
      UNION ALL
      SELECT * FROM win
    ),
    ctx AS (
      SELECT b.*,
             COALESCE(p.cost_with_tax, p.cost_base, 0)::numeric AS costo_unitario,
             rp.rung_veredicto,
             vbf.base_label,
             -- Un folio de conteo RECONCILIADO es el unico respaldo real del saldo. Hoy hay 6
             -- folios y NINGUNO reconciliado, asi que esta rama esta dormida a proposito: es la
             -- estructura para el dia que Almacen opere conteos (ver "fuera de alcance" del plan).
             -- El almacen NO esta en el item: lo hereda del folio (inventory_counts.warehouse_id).
             EXISTS (
               SELECT 1
                 FROM commercial.inventory_count_items ci
                 JOIN commercial.inventory_counts cc
                      ON cc.tenant_id = ci.tenant_id AND cc.id = ci.count_id
                     AND cc.reconciled_at IS NOT NULL
                     AND cc.warehouse_id = b.warehouse_id
                WHERE ci.tenant_id = b.tenant_id
                  AND ci.product_id = b.product_id
             ) AS con_conteo
        FROM base b
        LEFT JOIN catalog.products p
               ON p.tenant_id = b.tenant_id AND p.id = b.product_id
        LEFT JOIN analytics.replenishment_plan rp
               ON rp.tenant_id = b.tenant_id AND rp.warehouse_id = b.warehouse_id
              AND rp.product_id = b.product_id
        LEFT JOIN analytics.v_warehouse_box_factor vbf
               ON vbf.tenant_id = b.tenant_id AND vbf.warehouse_id = b.warehouse_id
              AND vbf.product_id = b.product_id
    )
    SELECT c.tenant_id,
           c.warehouse_id,
           c.warehouse_code,
           c.product_id,
           c.sku,
           c.erp,
           -- El numero que la pantalla publica hoy. El clamp va DESPUES de sumar, igual que la
           -- vista canonica: GREATEST(sum(...), 0) y no sum(GREATEST(...,0)).
           GREATEST(c.qty_cruda, 0)                       AS qty_publicada,
           c.qty_cruda,
           c.baseline,
           c.entradas,
           c.salidas,
           c.ult_compra,
           c.ult_venta,
           c.costo_unitario,
           c.base_label,
           c.rung_veredicto,
           -- ⚠️ El dinero va NULL cuando el PELDAÑO esta en disputa. Multiplicar una cantidad
           -- cuya unidad no esta verificada por un costo da una cifra inventada — es la regla
           -- U.2b / ADR-055, la misma que ya rige en la matriz. NULL nunca es cero.
           CASE WHEN c.rung_veredicto IS NULL
                THEN round((GREATEST(c.qty_cruda, 0) * c.costo_unitario)::numeric, 2)
           END AS valor_existencia,
           CASE WHEN c.rung_veredicto IS NULL
                THEN round((abs(LEAST(c.qty_cruda, 0)) * c.costo_unitario)::numeric, 2)
           END AS valor_faltante,
           -- Cuanto pesa el hueco contra lo que salio. Es lo que separa "falta una entrada" de
           -- "el baseline perdido lo explica".
           CASE WHEN c.salidas > 0 AND c.qty_cruda < 0
                THEN round((abs(c.qty_cruda) / c.salidas)::numeric, 4) END         AS hueco_pct,
           (c.ult_venta > now() - interval '90 days')                              AS vivo,

           -- EJE 1 — en que se apoya el numero.
           CASE WHEN c.con_conteo            THEN 'conteo_fisico'
                WHEN c.baseline <> 0         THEN 'baseline_real'
                ELSE                              'solo_flujo'
           END AS apoyo,

           -- EJE 2 — que lo contradice. La columna objecion es la PRINCIPAL (gana la primera que
           -- aplica) y es la que se filtra y se pinta; objeciones las trae TODAS, porque una celda puede
           -- tener el saldo imposible Y ademas la unidad en disputa, y perder eso al elegir una
           -- sola escondería la mitad del problema justo en los casos peores.
           CASE
             WHEN c.entradas = 0 AND c.salidas > 0                    THEN 'nunca_entro'
             WHEN c.qty_cruda < 0 AND c.salidas > 0
                  AND abs(c.qty_cruda) / c.salidas > 0.15             THEN 'faltante'
             WHEN c.qty_cruda < 0                                     THEN 'negativo_menor'
             WHEN c.rung_veredicto IN ('x1_inflada', 'x2_deflactada') THEN 'unidad_sin_verificar'
             WHEN c.qty_cruda > 0
                  AND GREATEST(c.ult_compra, c.ult_venta) < now() - interval '365 days'
                                                                      THEN 'sin_movimiento'
             ELSE                                                          'ninguna'
           END AS objecion,
           array_remove(ARRAY[
             CASE WHEN c.entradas = 0 AND c.salidas > 0 THEN 'nunca_entro' END,
             CASE WHEN c.qty_cruda < 0 AND c.salidas > 0
                       AND abs(c.qty_cruda) / c.salidas > 0.15 THEN 'faltante' END,
             CASE WHEN c.qty_cruda < 0 AND NOT (c.salidas > 0
                       AND abs(c.qty_cruda) / c.salidas > 0.15) THEN 'negativo_menor' END,
             CASE WHEN c.rung_veredicto IN ('x1_inflada', 'x2_deflactada')
                       THEN 'unidad_sin_verificar' END,
             CASE WHEN c.qty_cruda > 0
                       AND GREATEST(c.ult_compra, c.ult_venta) < now() - interval '365 days'
                       THEN 'sin_movimiento' END
           ], NULL) AS objeciones
      FROM ctx c
  `);

  await knex.raw('ALTER VIEW analytics.v_existencia_dictamen SET (security_invoker = true)');

  await knex.raw(`COMMENT ON VIEW analytics.v_existencia_dictamen IS
    'D.1 — Dictamen de existencia por producto x almacen: en que se apoya el numero (apoyo) y que lo contradice (objecion). NO es la verdad del saldo: Kepler no guarda baseline (kdil.c4 = 0 en el 100%), asi que su existencia ES el flujo. Expone qty_cruda SIN clamp — la vista canonica v_erp_stock_on_hand lo aplasta a cero y alimenta el pedido sugerido, por eso NO se toca. Lector unico: la pantalla de Existencia. Ver docs/UNIDADES_DE_MEDIDA.md y el ADR-056.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_existencia_dictamen');
};
