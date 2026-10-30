'use strict';
/**
 * `[PR.V10]` — **El «capital inmovilizado» era el consumo de un AÑO, y la escalera publicaba su
 * venta entera como si fuera dinero en juego.** Lo encontró la auditoría de
 * `/comercial/precios/motor` del 2026-10-30 (`AUD-DAT.25`), mirando renglones.
 *
 * ── ⛔ 1 · Un flujo anual con rótulo de saldo ─────────────────────────────────────────────
 * `[PR.L1.1]` sacó `g2_valor_anual` de la columna de flujo y lo llamó «SALDO de inventario».
 * No lo es: `v_abc_class.annual_value` = `avg_daily_units × 365 × costo_unitario`, o sea el
 * **costo de lo que se vende en un año**. La pantalla lo publicaba con el texto *«Es un saldo, no
 * un flujo»*.
 *
 * Lo medido antes (prod, sólo lectura, `mv_price_signals` del 2026-10-29), sobre las 7,397
 * celdas de `liberar_capital`:
 *  · publicado ......................................... $81,324,719
 *  · su existencia × el costo para VALUAR (canónico) ... $34,966,179  (2.3× menos)
 *  · la existencia de TODAS las celdas, igual valuada .. $71,661,813
 *    ⛔ Se publicaba más capital «inmovilizado» del que hay en inventario en toda la empresa.
 *  · control de renglón: SKU 63018 en la plaza 01, 4,035 unidades × $52.68 (kdik, `confirmado`)
 *    = $212,564; la pantalla decía $1,162,879.
 *
 * ⭐ El saldo honesto es **existencia × costo para valuar**: `e3_existencia` (la misma que ya
 * decide que la celda está en sobrestock) × `analytics.mv_erp_unit_cost.costo_unitario`, el
 * resolvedor canónico de VERDAD_ABSOLUTA §12. ⚠️ Es la existencia ENTERA, no el excedente:
 * qué parte sobra sobre la cobertura objetivo exige una regla que nadie firmó, y la pantalla lo
 * dice en vez de inventarla.
 *
 * ⛔ No se usa `v_erp_stock_truth`, el árbitro del valor: medido el mismo día, **una consulta
 * sobre ella pasa de 240 s**. Leída en cada carga de la pantalla, la habría tirado.
 *
 * ── ⛔ 2 · La escalera mezclaba unidades en la barra ──────────────────────────────────────
 * `corregir_escalera` publicaba como monto **toda la venta de 30 días** del par, mientras que
 * aterrizar, subir y revisar el costo publican un **incremento**. Las barras de la pantalla
 * decían «comparten escala» y comparaban una venta con un incremento. Es el mismo error que
 * `[PR.L1.1]` corrigió para el capital. Ahora la escalera va con monto NULL y su motivo, y la
 * pantalla la presenta como **venta expuesta**, aparte.
 *
 * ── ⭐ 3 · `monto_unidad`: la unidad viaja con el dato ─────────────────────────────────────
 * La pantalla partía las acciones según si tenían flujo o capital. Así, una acción con monto
 * NULL caía en «Sin decisión posible» aunque sí tuviera decisión. Ahora la vista declara la
 * unidad: `flujo_30d` · `venta_expuesta_30d` · `saldo_existencia` · NULL.
 *
 * ── ⭐ 4 · R7 deja de cobrarse en cada lectura ────────────────────────────────────────────
 * Recorrer esta vista costaba ~370 ms contra 9 ms de la MV de abajo: el `CROSS JOIN LATERAL`
 * de R7 corría en las 86,816 filas aunque la consulta no pidiera ninguna señal. Con
 * `LEFT JOIN LATERAL … ON true` sobre un agregado sin GROUP BY (devuelve exactamente una fila),
 * el planificador puede quitar el join cuando nadie lee `s1..s3`. Medido abajo, en el gate.
 *
 * ── ⭐ 5 · «Aterrizar el precio» deja de llamarse aritmética (decisión del PM, 2026-10-30) ─────
 * El criterio de aterrizar es el umbral D4 (`fn_precio_umbral_percepcion`): 0.16 % bajo $10 …
 * 6.48 % entre $100 y $500. Es la **mediana de nuestros propios cambios de precio** (245,665
 * cambios en 180 días), no una medición de cómo reacciona el cliente. Que un alza menor «no se
 * note» es un supuesto razonado, y la definición de certeza lo dice textual: *el monto es cierto,
 * la reacción del volumen no se midió* → `efecto_no_medido`. Sigue siendo una acción aparte de
 * subir (alzas bajo el umbral); lo que cambia es de qué se le llama. Lo resuelve el A/B.
 *
 * Idempotente (DROP + CREATE; la vista no tiene dependientes, medido en `pg_depend`).
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_action';
const MV = 'analytics.mv_price_signals';
const COSTO = 'analytics.mv_erp_unit_cost';
const DERIVA_MIN = 5;

/** El SELECT de la vista. Se exporta para que la prueba ejerza ESTE cuerpo y no una copia. */
const cuerpo = () => `
    WITH base AS (
      SELECT s.*,
        CASE WHEN s.a6_deriva_costo_pct IS NOT NULL AND s.venta_30d > 0
             THEN round((s.venta_30d * s.a6_deriva_costo_pct / 100.0)::numeric, 2) END
          AS ap_deriva_costo_mxn,
        s.a4_dif_vs_meta_mxn AS ap_dif_meta_mxn,
        CASE WHEN s.d1_alza_99_pct IS NOT NULL AND s.venta_30d > 0
             THEN round((s.venta_30d * s.d1_alza_99_pct / 100.0)::numeric, 2) END
          AS ap_aterrizaje_mxn,
        CASE WHEN s.c2_fuga_pct IS NOT NULL AND s.c0_neto_30d > 0
             THEN round((s.c0_neto_30d * s.c2_fuga_pct / 100.0)::numeric, 2) END
          AS ap_fuga_mxn,
        CASE WHEN s.a10_no_explicado_vs_vendido_pct < 0 AND s.venta_30d > 0
             THEN round((s.venta_30d * s.a10_no_explicado_vs_vendido_pct / 100.0)::numeric, 2) END
          AS ap_merma_mxn,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN s.f5_veredicto = 'no_subir_sin_existencia'
               THEN 'sin_existencia' END,
          CASE WHEN s.f11_veredicto = 'promo_vigente'
               THEN 'promocion_vigente' END,
          CASE WHEN s.f7_veredicto = 'movido_hace_poco'
               THEN 'movido_hace_menos_de_21_dias' END,
          CASE WHEN s.f12_veredicto = 'reportado_faltante'
               THEN 'el_mostrador_lo_reporto_faltante' END
        ], NULL) AS bloqueos
      FROM ${MV} s
    ),
    conf AS (
      SELECT b.*,
        CASE
          WHEN b.f8_veredicto = 'escalera_incoherente'
            THEN 'corregir_escalera'
          WHEN b.a6_deriva_costo_pct >= ${DERIVA_MIN} AND b.d5_cambios_90d IS NULL
            THEN 'revisar_costo'
          WHEN b.f5_veredicto = 'habilita_bajar' AND b.venta_30d > 0
            THEN 'liberar_capital'
          WHEN b.d1_candidato_99 IS NOT NULL AND b.venta_30d > 0
               AND b.d1_alza_99_pct IS NOT NULL
               AND b.d1_alza_99_pct > 20
            THEN 'precio_atipico'
          WHEN b.d1_candidato_99 IS NOT NULL AND b.venta_30d > 0
               AND b.d1_alza_99_pct IS NOT NULL
               AND b.d1_alza_99_pct <= b.d4_umbral_percepcion
            THEN 'aterrizar_precio'
          WHEN b.d1_candidato_99 IS NOT NULL AND b.venta_30d > 0
               AND b.d1_alza_99_pct IS NOT NULL
            THEN 'subir_precio'
          ELSE 'sin_accion_defendible'
        END AS accion_calc,
        ((b.f1_cobertura  = 'completa')::int + (b.f2_cobertura <> 'sin_dato')::int
       + (b.f3_cobertura  = 'completa')::int + (b.f4_cobertura <> 'sin_dato')::int
       + (b.f5_cobertura  = 'completa')::int + (b.f6_cobertura <> 'sin_dato')::int
       + (b.f7_cobertura  = 'completa')::int + (b.f8_cobertura  = 'completa')::int
       + (b.f9_cobertura  = 'completa')::int + (b.f10_cobertura = 'completa')::int
       + (b.f11_cobertura = 'completa')::int + (b.f12_cobertura = 'completa')::int
       + (b.f13_cobertura = 'completa')::int) AS familias_con_evidencia
      FROM base b
    )
    SELECT
      c.sucursal, c.sku, c.nombre,
      c.precio_actual, c.venta_30d, c.unidades_30d,

      c.accion_calc AS accion,
      CASE c.accion_calc
        WHEN 'corregir_escalera' THEN 'aritmetica'
        WHEN 'revisar_costo'     THEN 'aritmetica'
        WHEN 'liberar_capital'   THEN 'regla_de_operacion'
        -- [PR.V10] Decision del PM (2026-10-30): aterrizar NO es aritmetica. El umbral D4 es la
        --    mediana de NUESTROS cambios de precio (fn_precio_umbral_percepcion), no una medicion
        --    de como reacciona el cliente: que no lo note es un supuesto, y el A/B lo mide.
        WHEN 'aterrizar_precio'  THEN 'efecto_no_medido'
        WHEN 'subir_precio'      THEN 'efecto_no_medido'
        WHEN 'precio_atipico'    THEN 'fuera_de_alcance'
        ELSE                          'sin_evidencia'
      END AS certeza,

      c.bloqueos,
      (cardinality(c.bloqueos) = 0) AS accionable,
      CASE WHEN cardinality(c.bloqueos) > 0
           THEN 'hay restricciones activas: ' || array_to_string(c.bloqueos, ', ')
      END AS motivo_no_accionable,

      t.s1_senal, t.s1_mxn, t.s2_senal, t.s2_mxn, t.s3_senal, t.s3_mxn,
      t.aportes_medibles,

      -- ══ EL DINERO EN JUEGO: sólo FLUJO de 30 días, una sola unidad en toda la columna ══
      -- [PR.V10] La escalera publicaba aquí su venta ENTERA: no es un incremento y no se
      --    ordena contra los otros. Va NULL con su motivo; su venta ya viaja en venta_30d.
      CASE c.accion_calc
        WHEN 'revisar_costo'     THEN c.ap_deriva_costo_mxn
        WHEN 'aterrizar_precio'  THEN c.ap_aterrizaje_mxn
        WHEN 'subir_precio'      THEN c.ap_aterrizaje_mxn
      END AS monto_en_juego_mxn,

      -- ⭐ [PR.V10] La unidad del dinero de ESTA acción. La pantalla agrupa por aquí, no por
      --    si una columna llegó NULL.
      CASE c.accion_calc
        WHEN 'revisar_costo'     THEN 'flujo_30d'
        WHEN 'aterrizar_precio'  THEN 'flujo_30d'
        WHEN 'subir_precio'      THEN 'flujo_30d'
        WHEN 'corregir_escalera' THEN 'venta_expuesta_30d'
        WHEN 'liberar_capital'   THEN 'saldo_existencia'
      END AS monto_unidad,

      -- ⛔ [PR.V10] El SALDO: existencia × costo para valuar. Antes era g2_valor_anual, el
      --    consumo de un AÑO a costo, y sumaba más que todo el inventario de la empresa.
      CASE WHEN c.accion_calc = 'liberar_capital' AND c.e3_existencia > 0 AND k.costo_unitario > 0
           THEN round((c.e3_existencia * k.costo_unitario)::numeric, 2)
      END AS capital_inmovilizado_mxn,

      CASE
        WHEN c.accion_calc = 'sin_accion_defendible' THEN NULL
        WHEN c.accion_calc = 'precio_atipico'
          THEN 'aterrizar este precio implicaria un alza de mas de 20%: no es un precio ordinario (recargas, servicios, productos de paso). Necesita la marca de INTOCABLE, que no existe -- es la senal G4 del registro, declarada no_existe'
        WHEN c.accion_calc = 'liberar_capital'
          THEN 'es un SALDO (la existencia valuada a costo), no un flujo de 30 dias: no se ordena contra los otros montos. Es la existencia ENTERA, no el excedente: la cobertura objetivo no esta firmada. Va en capital_inmovilizado_mxn'
        WHEN c.accion_calc = 'corregir_escalera'
          THEN 'la escalera incoherente expone la venta de 30 dias del par, que NO es un incremento: corregirla no tiene un monto calculable sin saber que peldano se mueve. Va en venta_30d y no se ordena contra los otros montos'
        WHEN c.venta_30d IS NULL OR c.venta_30d <= 0
          THEN 'este par no vendio en 30 dias: el desfase es real pero su exposicion en dinero no se puede medir'
      END AS monto_motivo,

      c.ap_deriva_costo_mxn, c.ap_dif_meta_mxn, c.ap_aterrizaje_mxn,
      c.ap_fuga_mxn, c.ap_merma_mxn,

      c.a4_margen_realizado_pct AS margen_realizado_pct,
      c.m1_meta_margen          AS meta_margen_pct,
      c.a4_dif_vs_meta_pp       AS dif_vs_meta_pp,
      c.a1_costo_hoy, c.a2_costo_ficha, c.a6_deriva_costo_pct,
      c.d1_terminacion, c.d1_candidato_99, c.d4_umbral_percepcion,
      c.d1_alza_99_pct,
      c.d5_cambios_90d, c.d6_dias_sin_cambio,
      c.e1_dias_cobertura, c.e3_estado_inventario, c.g2_clase_abc,
      c.d8_prima_caja_pct, c.f8_veredicto,
      c.familias_con_evidencia,
      13 AS familias_totales,
      c.calculado_al,
      -- [PR.V10] Las unidades detras del saldo, para que la pantalla diga de donde sale.
      c.e3_existencia
    FROM conf c
    /**
     * ⭐ [PR.V10] El costo para VALUAR de ESTA celda, sólo si es de liberar_capital.
     *    · Un agregado sin GROUP BY devuelve exactamente una fila: el planificador QUITA el join
     *      cuando la consulta no lee el saldo (medido: count(*) ~50 ms).
     *    · El WHERE por acción hace que en las otras 79,419 celdas no se busque nada.
     *    ⛔ Se midieron otras dos formas y las dos se descartaron (prod, 2026-10-30, con carga):
     *      - join a un mapeo sucursal × SKU con GROUP BY: la cola filtrada por liberar_capital
     *        tardó 35–45 SEGUNDOS (plan catastrófico con ese filtro). Esta forma: 335–400 ms.
     *      - subconsulta escalar en el SELECT: 1.7 s al sumar las 7,397 celdas.
     */
    LEFT JOIN LATERAL (
      SELECT max(u.costo_unitario) AS costo_unitario
        FROM commercial.warehouses w
        JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = c.sku
                               AND p.deleted_at IS NULL
        JOIN ${COSTO} u ON u.tenant_id = w.tenant_id AND u.warehouse_id = w.id
                       AND u.product_id = p.id
       WHERE c.accion_calc = 'liberar_capital'
         AND w.kepler_code = c.sucursal AND w.deleted_at IS NULL
    ) k ON true
    -- ⭐ [PR.V10] LEFT JOIN ... ON true, no CROSS JOIN: un agregado sin GROUP BY devuelve
    --    exactamente una fila, y asi el planificador puede quitar el join cuando nadie lee R7.
    LEFT JOIN LATERAL (
      SELECT
        max(CASE WHEN rn = 1 THEN senal END) s1_senal,
        max(CASE WHEN rn = 1 THEN mxn   END) s1_mxn,
        max(CASE WHEN rn = 2 THEN senal END) s2_senal,
        max(CASE WHEN rn = 2 THEN mxn   END) s2_mxn,
        max(CASE WHEN rn = 3 THEN senal END) s3_senal,
        max(CASE WHEN rn = 3 THEN mxn   END) s3_mxn,
        count(*)::int aportes_medibles
      FROM (
        SELECT senal, mxn, row_number() OVER (ORDER BY abs(mxn) DESC) rn
          FROM (VALUES
            ('deriva_de_costo',      c.ap_deriva_costo_mxn),
            ('contra_meta_de_ficha', c.ap_dif_meta_mxn),
            ('aterrizaje_del_precio', c.ap_aterrizaje_mxn),
            ('descuento_dado',       c.ap_fuga_mxn)
          ) AS v(senal, mxn)
         WHERE mxn IS NOT NULL AND mxn <> 0
      ) z
    ) t ON true
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const obj of [MV, COSTO, 'commercial.warehouses', 'catalog.products']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [obj])).rows;
    if (!hay) throw new Error(`[PR.V10] falta ${obj}`);
  }

  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`CREATE VIEW ${VIEW} WITH (security_invoker = true) AS ${cuerpo()}`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.L1/L1.1/L1.2/V10] Capa 3 del motor de margen: un TRIAGE con evidencia, no un optimizador.
    Cada accion declara su certeza (de que TIPO es la evidencia) y la unidad de su dinero
    (monto_unidad). monto_en_juego_mxn lleva SOLO flujo de 30 dias; la venta expuesta de la
    escalera va en venta_30d y el saldo de liberar_capital en capital_inmovilizado_mxn.
    ⛔ [PR.V10] capital_inmovilizado_mxn era g2_valor_anual -el consumo de un AÑO a costo- y
    sumaba $81.3M contra $35.0M de existencia valuada en las mismas celdas: mas capital
    "inmovilizado" que todo el inventario de la empresa. Ahora es existencia x costo para valuar.
    [PR.V10] aterrizar_precio es efecto_no_medido: el umbral D4 es la mediana de nuestros cambios
    de precio, no una medicion de la reaccion del cliente (decision del PM, 2026-10-30).$c$`);

  await knex.raw(`COMMENT ON COLUMN ${VIEW}.capital_inmovilizado_mxn IS
    $c$[PR.V10] SALDO: e3_existencia x analytics.mv_erp_unit_cost.costo_unitario (el costo para
    VALUAR, VERDAD_ABSOLUTA §12), solo en liberar_capital. Es la existencia ENTERA, no el
    excedente: la cobertura objetivo no esta firmada. NULL = sin existencia o sin costo para
    valuarla. ⛔ Antes era g2_valor_anual (consumo anual): no lo vuelvas a poner.$c$`);

  await knex.raw(`COMMENT ON COLUMN ${VIEW}.monto_unidad IS
    $c$[PR.V10] La unidad del dinero de la accion: flujo_30d (monto_en_juego_mxn) ·
    venta_expuesta_30d (venta_30d) · saldo_existencia (capital_inmovilizado_mxn) · NULL
    (sin monto). Las tres no se suman ni se ordenan juntas.$c$`);

  // ── Los candados. Cada uno es una manera en que esta vista YA mintio. ───────────────────
  const [g] = (await knex.raw(`
    WITH v AS (SELECT * FROM ${VIEW})
    SELECT count(*)::int filas,
           (SELECT count(*)::int FROM ${MV}) filas_mv,
           count(*) FILTER (WHERE accion = 'liberar_capital')::int liberar,
           count(*) FILTER (WHERE accion = 'liberar_capital'
                              AND capital_inmovilizado_mxn IS NOT NULL)::int liberar_con_saldo,
           round(sum(capital_inmovilizado_mxn)::numeric, 0) saldo,
           count(*) FILTER (WHERE monto_en_juego_mxn IS NOT NULL
                              AND monto_unidad IS DISTINCT FROM 'flujo_30d')::int unidad_mezclada,
           count(*) FILTER (WHERE accion = 'corregir_escalera'
                              AND monto_en_juego_mxn IS NOT NULL)::int escalera_en_flujo,
           count(*) FILTER (WHERE accion = 'liberar_capital'
                              AND monto_en_juego_mxn IS NOT NULL)::int saldo_en_flujo,
           count(*) FILTER (WHERE accion <> 'sin_accion_defendible'
                              AND monto_en_juego_mxn IS NULL AND monto_motivo IS NULL)::int mudas,
           count(*) FILTER (WHERE s2_mxn IS NOT NULL AND abs(s1_mxn) < abs(s2_mxn))::int orden_roto,
           count(*) FILTER (WHERE accion = 'aterrizar_precio'
                              AND d1_alza_99_pct > d4_umbral_percepcion)::int aterrizaje_perceptible,
           count(*) FILTER (WHERE accion = 'precio_atipico')::int atipico
      FROM v`)).rows;

  /**
   * ⛔⛔ LA PRUEBA NEGATIVA de esta corrección: un saldo de una PARTE del inventario no puede
   *    pasar del inventario ENTERO, valuado igual. Es la desigualdad que el número viejo violaba
   *    ($81.3M contra $71.7M) y que ninguna compuerta miraba.
   */
  const [{ inventario }] = (await knex.raw(`
    SELECT round(sum(s.e3_existencia * u.costo_unitario)::numeric, 0) inventario
      FROM ${MV} s
      JOIN commercial.warehouses w ON w.kepler_code = s.sucursal AND w.deleted_at IS NULL
      JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = s.sku AND p.deleted_at IS NULL
      JOIN ${COSTO} u ON u.tenant_id = w.tenant_id AND u.warehouse_id = w.id AND u.product_id = p.id
     WHERE s.e3_existencia > 0 AND u.costo_unitario > 0`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.V10] saldo de liberar_capital $${Number(g.saldo).toLocaleString()} en `
    + `${g.liberar_con_saldo.toLocaleString()} de ${g.liberar.toLocaleString()} celdas · `
    + `inventario valuado completo $${Number(inventario).toLocaleString()}`);

  if (g.filas !== g.filas_mv) throw new Error(`[PR.V10] ${g.filas} filas contra ${g.filas_mv} de la MV: el join del saldo duplico o perdio celdas.`);
  if (Number(g.saldo) > Number(inventario)) {
    throw new Error(`[PR.V10] el saldo ($${g.saldo}) pasa del inventario entero ($${inventario}): volvio el consumo anual.`);
  }
  if (g.liberar > 0 && g.liberar_con_saldo < g.liberar * 0.9) {
    throw new Error(`[PR.V10] solo ${g.liberar_con_saldo} de ${g.liberar} celdas de liberar_capital tienen saldo `
      + '(medido el 2026-10-30: 7,397 de 7,397). El join al costo dejo de encontrar: revisar las llaves.');
  }
  if (g.unidad_mezclada > 0) throw new Error(`[PR.V10] ${g.unidad_mezclada} montos de flujo con otra unidad.`);
  if (g.escalera_en_flujo > 0) throw new Error('[PR.V10] la venta de la escalera volvio a la columna de flujo.');
  if (g.saldo_en_flujo > 0) throw new Error('[PR.L1.1] el saldo volvio a la columna de flujo.');
  if (g.mudas > 0) throw new Error(`[PR.L1.2] ${g.mudas} acciones sin monto NI motivo.`);
  if (g.orden_roto > 0) throw new Error(`[PR.L1] ${g.orden_roto} ordenes rotos en R7.`);
  if (g.aterrizaje_perceptible > 0) throw new Error('[PR.L1.2] un aterrizaje implica un alza que el cliente percibe.');
  if (g.atipico === 0) throw new Error('[PR.L1.2] cero precios atipicos: el guardia no mide nada.');
};

/**
 * No se revierte: el `down` volveria a publicar el consumo de un año como si fuera inventario
 * parado. Mismo criterio que `[PR.L1.2]`, la migración anterior de esta vista.
 */
exports.down = async function down(knex) {
  void knex;
};

exports._cuerpo = cuerpo;
