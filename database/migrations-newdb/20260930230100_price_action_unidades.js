'use strict';
/**
 * `[PR.L1.1]` — **Dos errores de UNIDAD que las compuertas dejaron pasar y los renglones no.**
 *
 * `[PR.L1]` aplico con sus seis compuertas en verde: grano intacto, cero acciones sin monto ni
 * motivo, cero ordenes rotos en R7, cero certezas incoherentes. Despues se miraron **doce
 * renglones reales** y aparecieron dos defectos que ninguna compuerta podia ver, porque las dos
 * cifras estaban bien formadas -- solo que en la unidad equivocada.
 *
 * ⭐ *Una compuerta verifica que el numero EXISTA y sea coherente consigo mismo. Que MIDA lo que
 * dice medir lo verifica alguien mirando renglones.*
 *
 * ── ⛔ 1 · Un SALDO metido en una columna de FLUJO ────────────────────────────────────────
 * `liberar_capital` publicaba como monto el **valor anual del inventario** (`g2_valor_anual`),
 * mientras las otras tres acciones publican **dinero de 30 dias**. Resultado medido: esa accion
 * sumaba **$60,464,128** contra $409,475 de aterrizaje y $76,655 de escalera, y **los doce
 * primeros lugares de la cola eran todos suyos**. Una cola asi no prioriza: tapa.
 *
 * Es el mismo error que este repo ya pago tres veces con ADR-055 y ADR-057: *la unidad de una
 * columna no se hereda de su fuente*. Un saldo inmovilizado y un flujo de 30 dias no se ordenan
 * juntos, y convertirlo exigiria una **tasa de costo de capital que no existe** (decision D5,
 * abierta desde el plan).
 *
 * ⭐ Se separa: `capital_inmovilizado_mxn` lleva el saldo, con su nombre; `monto_en_juego_mxn`
 * va NULL con su motivo escrito. En la cola por dinero cae al final, que es lo honesto mientras
 * nadie firme la tasa.
 *
 * ── ⛔ 2 · Una razon que no es una tasa, multiplicada por la venta ────────────────────────
 * La merma entraba como aporte en pesos: `venta_30d x (no_explicado / vendido)`. Pero
 * `no_explicado/vendido` **no es una tasa aplicable a la venta**: es un cociente entre unidades
 * no explicadas y unidades vendidas de periodos de conteo que no coinciden con la ventana de 30
 * dias, y cuyos peldanos pueden diferir. Medido antes de cablearla, su mediana en el bucket de
 * merma es **-97.75 %** -- y multiplicar eso por la venta produjo aportes de **-$128,415** en
 * una sola celda, que barrieron con R7: las cinco primeras filas del desglose tenian `merma`
 * como senal numero uno.
 *
 * ⚠️ Lo peor es que yo mismo lo habia escrito en `[PR.S2.3]`: *"publicar una tasa de merma de
 * -97.75 % seria enganoso"*. Lo escribi, y tres horas despues la use como si fuera una tasa.
 *
 * ⭐ La merma **sale de los aportes** y se queda como contexto: su veredicto (`f9_veredicto`) y
 * su razon siguen publicados, porque la senal es real -- lo que no es real es su conversion a
 * pesos.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_action';
const MV = 'analytics.mv_price_signals';
const DERIVA_MIN = 5;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${MV}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.L1.1] falta analytics.mv_price_signals');

  /**
   * ⚠️ El primer intento envolvia la vista en SI MISMA (FROM (SELECT * FROM v_price_action)),
   * que es invalido -- una vista no se puede referenciar. Va el cuerpo completo.
   */
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);

  await knex.raw(`
    CREATE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH base AS (
      SELECT s.*,
        -- ══ LOS APORTES, EN PESOS ═════════════════════════════════════════════════════
        -- ⭐ Cada uno es dinero medido sobre la venta real de 30 dias. Lo que no se puede
        --    expresar en pesos no entra aca: entra como bloqueo o como contexto.

        -- 1 · El costo se movio y el precio no lo siguio.
        CASE WHEN s.a6_deriva_costo_pct IS NOT NULL AND s.venta_30d > 0
             THEN round((s.venta_30d * s.a6_deriva_costo_pct / 100.0)::numeric, 2) END
          AS ap_deriva_costo_mxn,

        -- 2 · Lo que se gana de MAS (o de menos) contra lo que la ficha pide.
        --     ⚠️ Medido: casi siempre es POSITIVO -- la meta de Kepler es un piso ya superado.
        s.a4_dif_vs_meta_mxn AS ap_dif_meta_mxn,

        -- 3 · El alza implicita de aterrizar el precio en .99.
        --     ⛔ Es aritmetica CIERTA sobre el precio; lo que NO se sabe es si el volumen
        --        aguanta, y eso es exactamente lo que el experimento A/B existe para medir.
        CASE WHEN s.d1_alza_99_pct IS NOT NULL AND s.venta_30d > 0
             THEN round((s.venta_30d * s.d1_alza_99_pct / 100.0)::numeric, 2) END
          AS ap_aterrizaje_mxn,

        -- 4 · El descuento que de verdad se dio sobre lista.
        --     ⚠️ NO es "dinero recuperable": medido, el 80 % sigue al volumen, o sea que es
        --        politica de descuento. Se publica como MONTO EN JUEGO, no como upside.
        CASE WHEN s.c2_fuga_pct IS NOT NULL AND s.c0_neto_30d > 0
             THEN round((s.c0_neto_30d * s.c2_fuga_pct / 100.0)::numeric, 2) END
          AS ap_fuga_mxn,

        -- 5 · Lo que se pierde por lo que desaparece del inventario.
        CASE WHEN s.a10_no_explicado_vs_vendido_pct < 0 AND s.venta_30d > 0
             THEN round((s.venta_30d * s.a10_no_explicado_vs_vendido_pct / 100.0)::numeric, 2) END
          AS ap_merma_mxn,

        -- ══ LOS BLOQUEOS ══════════════════════════════════════════════════════════════
        -- ⭐ No son pesos: son puertas cerradas. Y mueven mas masa que cualquier ponderacion
        --    -- sobrestock $14.5 M, fatiga $18.5 M, agotado $8.7 M, promo $2.1 M.
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
        -- ⭐ La accion se decide UNA vez aca y se referencia abajo: calcularla dos veces en dos
        --    CASE paralelos es como se desincronizan dos campos del mismo hecho.
        CASE
          WHEN b.f8_veredicto = 'escalera_incoherente'
            THEN 'corregir_escalera'
          WHEN b.a6_deriva_costo_pct >= ${DERIVA_MIN} AND b.d5_cambios_90d IS NULL
            THEN 'revisar_costo'
          WHEN b.f5_veredicto = 'habilita_bajar' AND b.venta_30d > 0
            THEN 'liberar_capital'
          WHEN b.d1_candidato_99 IS NOT NULL AND b.venta_30d > 0
            THEN 'aterrizar_precio'
          ELSE 'sin_accion_defendible'
        END AS accion_calc,
        -- ⭐ Cuantas de las 13 familias tuvieron evidencia en ESTA celda. No es un score de
        --    calidad: es el denominador honesto de cualquier cosa que se diga de ella.
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

      -- ══ LA ACCION ═══════════════════════════════════════════════════════════════════
      /**
       * ⭐ El orden es por CERTEZA, no por tamano. Primero lo que es cierto por aritmetica
       *    (un error del catalogo lo es aunque no venda), despues lo que abre una puerta, y
       *    al final el default HONESTO -- que es la mayoria de las celdas.
       */
      c.accion_calc AS accion,

      /**
       * ⛔ La certeza NO es una confianza inventada: dice de que TIPO es la evidencia.
       *    · aritmetica ......... se deduce de numeros del propio ERP y no puede estar mal
       *    · efecto_no_medido ... el monto es cierto pero la reaccion del volumen NO se midio
       *    · regla_de_operacion . es una politica, no una prediccion
       *    · sin_evidencia ...... no hay con que
       */
      CASE c.accion_calc
        WHEN 'corregir_escalera' THEN 'aritmetica'
        WHEN 'revisar_costo'     THEN 'aritmetica'
        WHEN 'liberar_capital'   THEN 'regla_de_operacion'
        WHEN 'aterrizar_precio'  THEN 'efecto_no_medido'
        ELSE                          'sin_evidencia'
      END AS certeza,

      c.bloqueos,
      (cardinality(c.bloqueos) = 0) AS accionable,
      CASE WHEN cardinality(c.bloqueos) > 0
           THEN 'hay restricciones activas: ' || array_to_string(c.bloqueos, ', ')
      END AS motivo_no_accionable,

      -- ══ ⭐⭐ R7 · LAS TRES SENALES QUE MAS PESARON, medidas en PESOS ════════════════
      t.s1_senal, t.s1_mxn, t.s2_senal, t.s2_mxn, t.s3_senal, t.s3_mxn,
      t.aportes_medibles,

      -- ══ EL DINERO EN JUEGO de la accion elegida ═════════════════════════════════════
      -- [PR.L1.1] El monto de liberar_capital ya NO sale de aca: g2_valor_anual es un SALDO
      --    de inventario y las otras tres acciones son FLUJO de 30 dias. Mezclados, esa accion
      --    sumaba $60,464,128 contra $409,475 del aterrizaje y se llevaba los DOCE primeros
      --    lugares de la cola. Una cola asi no prioriza: tapa.
      CASE c.accion_calc
        WHEN 'corregir_escalera' THEN c.venta_30d
        WHEN 'revisar_costo'     THEN c.ap_deriva_costo_mxn
        WHEN 'aterrizar_precio'  THEN c.ap_aterrizaje_mxn
      END AS monto_en_juego_mxn,

      -- El saldo, en su propia columna y con su propio nombre.
      CASE WHEN c.accion_calc = 'liberar_capital' THEN c.g2_valor_anual END
        AS capital_inmovilizado_mxn,

      /**
       * ⛔ Y cuando NO hay monto, POR QUE no lo hay. La compuerta original exigia monto en toda
       *    accion -"una recomendacion sin consecuencia no se puede priorizar"- y encontro 2,256
       *    filas: casi todas costos que se movieron en SKUs que no vendieron en 30 dias.
       *
       * ⭐ Forzarles un cero habria sido dibujar el dato que ADR-056 prohibe, y quitarles la
       *    accion habria escondido un desfase real. La salida honesta es la tercera: la accion
       *    se publica, el monto va NULL, y el motivo dice que la exposicion no se pudo medir
       *    porque no hubo venta. En la cola ordenada por dinero caen al final, que es donde van.
       */
      CASE
        WHEN c.accion_calc = 'sin_accion_defendible' THEN NULL
        WHEN c.accion_calc = 'liberar_capital'
          THEN 'el capital inmovilizado es un SALDO, no un flujo de 30 dias: no se ordena contra los otros montos, y sin tasa de costo de capital (D5 abierta) no se puede convertir. Va en capital_inmovilizado_mxn'
        WHEN c.venta_30d IS NULL OR c.venta_30d <= 0
          THEN 'este par no vendio en 30 dias: el desfase es real pero su exposicion en dinero no se puede medir'
      END AS monto_motivo,

      -- ══ LOS APORTES, todos, para el desglose ════════════════════════════════════════
      c.ap_deriva_costo_mxn, c.ap_dif_meta_mxn, c.ap_aterrizaje_mxn,
      c.ap_fuga_mxn, c.ap_merma_mxn,

      -- ══ CONTEXTO ════════════════════════════════════════════════════════════════════
      c.a4_margen_realizado_pct AS margen_realizado_pct,
      c.m1_meta_margen          AS meta_margen_pct,
      c.a4_dif_vs_meta_pp       AS dif_vs_meta_pp,
      c.a1_costo_hoy, c.a2_costo_ficha, c.a6_deriva_costo_pct,
      c.d1_terminacion, c.d1_candidato_99, c.d4_umbral_percepcion,
      c.d5_cambios_90d, c.d6_dias_sin_cambio,
      c.e1_dias_cobertura, c.e3_estado_inventario, c.g2_clase_abc,
      c.d8_prima_caja_pct, c.f8_veredicto,
      c.familias_con_evidencia,
      13 AS familias_totales,
      c.calculado_al
    FROM conf c
    CROSS JOIN LATERAL (
      /**
       * ⭐⭐ ACA VIVE R7. Se arma la lista de aportes con nombre y monto, se ordena por monto
       *    ABSOLUTO -- porque una perdida de $50,000 pesa igual que una ganancia de $50,000 --
       *    y se toman tres. Sin coeficientes: el orden lo da el dinero.
       */
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
            -- [PR.L1.1] La merma SALIO de aca: no_explicado/vendido no es una tasa aplicable a
            --    la venta -- es un cociente entre unidades de periodos de conteo que no
            --    coinciden con la ventana de 30 dias y cuyos peldanos pueden diferir. Su mediana
            --    en el bucket de merma es -97.75%, y por la venta daba -$128,415 en UNA celda:
            --    barria con el desglose entero. La senal es real; su conversion a pesos no.
            --    Yo mismo habia escrito esa advertencia en [PR.S2.3] y tres horas despues la
            --    use como si fuera una tasa.
          ) AS v(senal, mxn)
         WHERE mxn IS NOT NULL AND mxn <> 0
      ) z
    ) t
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.L1/L1.1] Capa 3 del motor de margen: un TRIAGE con evidencia, no un optimizador.
    ⛔ Tres disenos de motor se midieron y se REFUTARON antes de escribir esto: (1) el sugerido
    del ERP es identicamente la deriva de costo -markup e impuesto se cancelan- y dice "al dia"
    sobre el 78% de la venta mientras propone BAJAR en $3.76M; (2) el grupo par por plaza daba
    $4.45M anualizado y su PLACEBO lo mato -agrupar al azar da una brecha MAYOR, razon 0.42x-;
    (3) la fuga de descuento resulto politica de volumen en el 80% de las celdas.
    ⭐⭐ NO hay pesos inventados: el aporte de cada senal se mide EN PESOS, asi que las 3 que mas
    pesaron (R7 del plan) son las 3 de mayor monto absoluto. Un monto se mide; un peso se inventa,
    y ADR-021 documenta que el aprendizaje de pesos nunca se construyo ni en Horus ni en Thot.
    ⛔ [PR.L1.1] Dos errores de UNIDAD que las compuertas dejaron pasar y los renglones no: el
    capital inmovilizado -un SALDO- estaba en la columna de FLUJO y se llevaba los 12 primeros
    lugares de la cola; y la merma entraba a R7 como pesos cuando su razon no es una tasa
    aplicable a la venta. Una compuerta verifica que el numero EXISTA y sea coherente consigo
    mismo; que MIDA lo que dice medir lo verifica alguien mirando renglones.$c$`);

  await knex.raw(`COMMENT ON COLUMN ${VIEW}.capital_inmovilizado_mxn IS
    $c$[PR.L1.1] El SALDO de inventario de un par en sobrestock o muerto. Vive en su propia
    columna y NO en monto_en_juego_mxn porque un saldo no se ordena contra flujos de 30 dias:
    metido ahi sumaba $60,464,128 contra $409,475 del aterrizaje. Convertirlo a flujo exige una
    tasa de costo de capital que no existe (decision D5).$c$`);

  await knex.raw(`COMMENT ON COLUMN ${VIEW}.ap_merma_mxn IS
    $c$[PR.L1.1] ⛔ NO es un aporte y por eso salio de R7: no_explicado/vendido no es una tasa
    aplicable a la venta. Su mediana en el bucket de merma es -97.75% y multiplicada por la venta
    producia aportes de -$128,415 en una celda, que barrian con el desglose.$c$`);

  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE accion <> 'sin_accion_defendible'
                              AND monto_en_juego_mxn IS NULL AND monto_motivo IS NULL)::int mudas,
           count(*) FILTER (WHERE s2_mxn IS NOT NULL AND abs(s1_mxn) < abs(s2_mxn))::int orden_roto,
           count(*) FILTER (WHERE s1_senal = 'merma')::int merma_en_r7,
           count(*) FILTER (WHERE accion = 'liberar_capital'
                              AND monto_en_juego_mxn IS NOT NULL)::int saldo_en_flujo,
           count(*) FILTER (WHERE capital_inmovilizado_mxn IS NOT NULL)::int con_capital,
           round(sum(abs(monto_en_juego_mxn))::numeric, 0) flujo,
           round(sum(capital_inmovilizado_mxn)::numeric, 0) capital
      FROM ${VIEW}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.L1.1] ${g.filas.toLocaleString()} filas · dinero de FLUJO 30 d `
    + `$${Number(g.flujo).toLocaleString()} · capital inmovilizado (SALDO, aparte) `
    + `$${Number(g.capital).toLocaleString()} en ${g.con_capital.toLocaleString()} celdas`);

  if (g.filas !== 86163) throw new Error(`[PR.L1.1] ${g.filas} filas y el grano es 86,163.`);
  if (g.mudas > 0) throw new Error(`[PR.L1.1] ${g.mudas} acciones sin monto NI motivo.`);
  if (g.orden_roto > 0) throw new Error(`[PR.L1.1] ${g.orden_roto} ordenes rotos en R7.`);
  // ⛔ Las dos pruebas negativas de esta correccion: que los defectos NO puedan volver.
  if (g.merma_en_r7 > 0) {
    throw new Error(`[PR.L1.1] la merma volvio a R7 en ${g.merma_en_r7} filas: su razon no es `
      + 'una tasa aplicable a la venta.');
  }
  if (g.saldo_en_flujo > 0) {
    throw new Error(`[PR.L1.1] ${g.saldo_en_flujo} celdas de liberar_capital con monto de flujo: `
      + 'el saldo de inventario volvio a la columna equivocada.');
  }
};

exports.down = async function down(knex) {
  // No se revierte a mezclar saldo con flujo.
};
