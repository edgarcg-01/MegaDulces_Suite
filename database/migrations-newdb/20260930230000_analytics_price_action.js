'use strict';
/**
 * `[PR.L1]` — **Capa 3 · la LOGICA. Y no es un optimizador: es un triage con evidencia.**
 *
 * ── ⛔⛔ Tres disenos de motor, medidos y REFUTADOS antes de escribir esta vista ───────────
 *
 * **1 · El sugerido del ERP** (`v_price_suggestion`, escrito el 29-sep, nunca aplicado). Su
 * formula es `PV = costo x (1+markup) x (1+impuesto)` con el costo de hoy. Se puede probar que
 * **es la deriva de costo y nada mas**, porque el markup y el impuesto se cancelan:
 *
 *     precio_sug / precio_actual = costo_hoy / costo_ficha
 *
 * Medido: dice **"al dia" sobre $29.4 M** -el 78 % de la venta-, propone subir en $4.5 M y
 * ⛔ **propone BAJAR en $3.76 M**. No es un motor de precios: es un detector de desfase de costo.
 *
 * **2 · El grupo par por plaza** ("el mismo SKU rinde 16 % en la 03 y 9 % en la 05, subamos la
 * 05"). Daba **$4.45 M anualizado**. ⛔ **El placebo lo mato**: agrupar las celdas **al azar**
 * produce una brecha MAYOR ($878,959 contra $365,802, razon **0.42x**). La "oportunidad" era el
 * artefacto de medir distancia a un percentil alto dentro de cualquier grupo con dispersion.
 *
 * **3 · La fuga de descuento entre clientes** (spread mediano 7.23 % con >=5 clientes). ⛔ Al
 * preguntar si el precio sigue al VOLUMEN, **369 de 461 celdas (80 %) muestran "mas volumen =
 * menor precio"**: eso es politica de descuento, no fuga. Invertidas quedan **13 celdas /
 * $125,802**, que son un ERROR con monto cierto, no una oportunidad de $8 M.
 *
 * ── ⭐⭐ Lo que sobrevive, y por eso esta vista tiene la forma que tiene ──────────────────
 * Sobrevive lo que es **aritmetica verificable** o **regla de operacion**, no una afirmacion
 * causal sobre el volumen:
 *
 *   · **escalera incoherente** -- la caja sale mas cara por pieza que la pieza. Es un error del
 *     catalogo, cierto por construccion.
 *   · **costo que subio y precio que no se movio** -- 2,246 celdas, $405,268 de venta.
 *   · **aterrizaje** -- el alza implicita de aterrizar es aritmetica; lo que el A/B mide es si
 *     el VOLUMEN aguanta, y hasta entonces se declara.
 *   · **restricciones** -- sobrestock $14.5 M, agotado $8.7 M, fatiga $18.5 M, promo $2.1 M.
 *     No son upside: son **que NO hacer**, y mueven mas masa que cualquier peso.
 *
 * ── ⭐⭐ Por que NO hay pesos inventados ──────────────────────────────────────────────────
 * El plan pedia "cada propuesta nombra las 3 senales que mas pesaron" (R7). La solucion obvia
 * -ponderar 29 senales- exige 29 coeficientes que **nadie midio**, y ADR-021 ya documenta que
 * el aprendizaje de pesos (L4) nunca se construyo ni en Horus ni en Thot.
 *
 * ⭐ Aca el aporte de cada senal se mide **en pesos**, y el problema desaparece: las tres que
 * mas pesaron son **las tres de mayor monto**. Un monto se mide; un peso se inventa.
 *
 * ⛔ Y lo que no se puede expresar en dinero **no es un aporte**: es una restriccion (bloquea)
 * o contexto (se muestra). No se cuela al numero por la puerta de atras.
 *
 * ── ⛔ Lo que esta vista NO hace ──────────────────────────────────────────────────────────
 * ⛔ No aplica precios: Kepler es read-only (ADR-040) y la decision fue que **todo pasa por
 *    humano**. Propone; una persona aprueba.
 * ⛔ No propone bajar contra un piso de margen, porque **no hay piso** (D2 sigue abierta).
 * ⛔ No inventa una accion donde no hay evidencia: el default es `sin_accion_defendible`, que
 *    es la mayoria de las celdas y **se publica como tal**.
 *
 * Lee de `analytics.mv_price_signals` y no de la vista: la vista se desarma bajo un LIMIT
 * ([PR.S2.4]) y esta pantalla se consulta justamente asi.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_action';
const MV = 'analytics.mv_price_signals';

/** El costo tiene que haberse movido mas que esto para que "revisar costo" sea una accion. */
const DERIVA_MIN = 5;
/** Y el precio tiene que llevar quieto al menos esto, o no es un olvido sino algo reciente. */
const DIAS_QUIETO = 90;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${MV}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.L1] falta analytics.mv_price_signals ([PR.S2.4])');

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
      CASE c.accion_calc
        WHEN 'corregir_escalera' THEN c.venta_30d
        WHEN 'revisar_costo'     THEN c.ap_deriva_costo_mxn
        WHEN 'liberar_capital'   THEN c.g2_valor_anual
        WHEN 'aterrizar_precio'  THEN c.ap_aterrizaje_mxn
      END AS monto_en_juego_mxn,

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
        WHEN c.venta_30d IS NULL OR c.venta_30d <= 0
          THEN 'este par no vendio en 30 dias: el desfase es real pero su exposicion en dinero no se puede medir'
        WHEN c.accion_calc = 'liberar_capital' AND c.g2_valor_anual IS NULL
          THEN 'sin valor anual calculado para este par: el capital inmovilizado no se puede cifrar'
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
            ('descuento_dado',       c.ap_fuga_mxn),
            ('merma',                c.ap_merma_mxn)
          ) AS v(senal, mxn)
         WHERE mxn IS NOT NULL AND mxn <> 0
      ) z
    ) t
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.L1] Capa 3 del motor de margen: un TRIAGE con evidencia, no un optimizador.
    ⛔ Tres disenos de motor se midieron y se REFUTARON antes de escribir esto: (1) el sugerido
    del ERP es identicamente la deriva de costo -markup e impuesto se cancelan- y dice "al dia"
    sobre el 78% de la venta mientras propone BAJAR en $3.76M; (2) el grupo par por plaza daba
    $4.45M anualizado y su PLACEBO lo mato -agrupar al azar da una brecha MAYOR, razon 0.42x-;
    (3) la fuga de descuento resulto politica de volumen en el 80% de las celdas, quedan 13
    invertidas por $125,802.
    ⭐⭐ NO hay pesos inventados: el aporte de cada senal se mide EN PESOS, asi que "las 3 que
    mas pesaron" (R7 del plan) son las 3 de mayor monto absoluto. Un monto se mide; un peso se
    inventa, y ADR-021 ya documenta que el aprendizaje de pesos nunca se construyo.
    ⛔ Lo que no se puede expresar en dinero NO es un aporte: es un bloqueo (sin existencia,
    promo vigente, movido hace menos de 21 dias, reportado faltante) o contexto. Las
    restricciones mueven mas masa que cualquier ponderacion: $14.5M de sobrestock, $18.5M de
    fatiga, $8.7M de agotado.
    ⭐ El default es sin_accion_defendible y es la mayoria de las celdas: se publica como tal.
    Lee de mv_price_signals y no de la vista porque la vista se desarma bajo un LIMIT.$c$`);

  // ── Compuertas ──────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE accion = 'corregir_escalera')::int escalera,
           count(*) FILTER (WHERE accion = 'revisar_costo')::int costo,
           count(*) FILTER (WHERE accion = 'liberar_capital')::int capital,
           count(*) FILTER (WHERE accion = 'aterrizar_precio')::int aterrizar,
           count(*) FILTER (WHERE accion = 'sin_accion_defendible')::int sin_accion,
           count(*) FILTER (WHERE NOT accionable)::int bloqueadas,
           count(*) FILTER (WHERE s1_senal IS NOT NULL)::int con_aporte,
           -- ⛔ una accion sin monto es una recomendacion sin consecuencia
           -- ⛔ ni monto ni motivo: eso si es una recomendacion sin consecuencia
           count(*) FILTER (WHERE accion <> 'sin_accion_defendible'
                              AND monto_en_juego_mxn IS NULL
                              AND monto_motivo IS NULL)::int accion_sin_monto,
           count(*) FILTER (WHERE accion <> 'sin_accion_defendible'
                              AND monto_en_juego_mxn IS NULL)::int accion_sin_cifra,
           -- ⛔ un aporte publicado como el mayor cuando hay otro mas grande
           count(*) FILTER (WHERE s2_mxn IS NOT NULL
                              AND abs(s1_mxn) < abs(s2_mxn))::int orden_roto,
           -- ⛔ certeza 'aritmetica' sobre algo que no lo es
           count(*) FILTER (WHERE certeza = 'sin_evidencia'
                              AND accion <> 'sin_accion_defendible')::int certeza_incoherente,
           count(*) FILTER (WHERE accionable AND cardinality(bloqueos) > 0)::int accionable_bloqueada
      FROM ${VIEW}`)).rows;
  const ms = Date.now() - t0;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.L1] ${g.filas.toLocaleString()} filas en ${ms} ms · escalera ${g.escalera} `
    + `· costo ${g.costo} · capital ${g.capital} · aterrizar ${g.aterrizar.toLocaleString()} `
    + `· ⭐ sin accion defendible ${g.sin_accion.toLocaleString()} `
    + `(${((100 * g.sin_accion) / g.filas).toFixed(1)} %)`);
  // eslint-disable-next-line no-console
  console.log(`  · [PR.L1] bloqueadas ${g.bloqueadas.toLocaleString()} · con aporte medido en `
    + `pesos ${g.con_aporte.toLocaleString()}`);

  if (g.filas !== 86163) throw new Error(`[PR.L1] ${g.filas} filas y el grano es 86,163.`);
  if (g.accion_sin_monto > 0) {
    throw new Error(`[PR.L1] ${g.accion_sin_monto} acciones sin monto Y SIN MOTIVO: una `
      + 'recomendacion sin consecuencia medible ni explicacion no se puede priorizar ni defender.');
  }
  if (g.accion_sin_cifra > 0) {
    // eslint-disable-next-line no-console
    console.log(`  · [PR.L1] ⓘ ${g.accion_sin_cifra.toLocaleString()} acciones sin cifra de `
      + 'exposicion, cada una con su motivo escrito (no vendieron en 30 dias)');
  }
  if (g.orden_roto > 0) {
    throw new Error(`[PR.L1] ${g.orden_roto} filas donde el segundo aporte es MAYOR que el `
      + 'primero: R7 estaria nombrando las senales equivocadas.');
  }
  if (g.certeza_incoherente > 0) {
    throw new Error(`[PR.L1] ${g.certeza_incoherente} acciones con certeza 'sin_evidencia'.`);
  }
  if (g.accionable_bloqueada > 0) {
    throw new Error(`[PR.L1] ${g.accionable_bloqueada} filas marcadas accionables CON bloqueos.`);
  }
  /**
   * ⭐ El default tiene que ser la MAYORIA. Si un dia casi todas las celdas tuvieran accion,
   *    seria senal de que el triage dejo de discriminar -- y un tablero donde todo es urgente
   *    no prioriza nada.
   */
  if (g.sin_accion < g.filas * 0.5) {
    throw new Error(`[PR.L1] solo ${g.sin_accion} celdas sin accion defendible de ${g.filas}: `
      + 'el triage dejo de discriminar.');
  }
  if (ms > 8000) throw new Error(`[PR.L1] la vista tarda ${ms} ms.`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
