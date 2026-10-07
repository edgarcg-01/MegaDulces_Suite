'use strict';
/**
 * `[PR.S1]` — **El precio sugerido, con la fórmula del propio ERP y la procedencia de cada factor.**
 *
 * ── La tesis, y por qué NO es un modelo ────────────────────────────────────────────────────
 * Kepler fija el precio con una fórmula cerrada, verificada en la Fase CE:
 *
 *     PV = costo × (1 + markup/100) × (1 + impuesto/100)
 *
 * El sugerido **no hay que inventarlo**: es esa misma fórmula con el **costo de hoy** en lugar
 * del costo con el que se fijó el precio. Eso lo vuelve **auditable renglón por renglón** — no
 * hay coeficientes que explicar, sólo tres factores que se pueden ver.
 *
 * ⭐ **Prueba de cordura, medida contra prod:** con el costo ESTÁNDAR (el de la ficha) la fórmula
 * tiene que devolver el precio que Kepler publica hoy. Lo hace en **82,419 de 83,327 = 98.91 %**.
 * Esa compuerta corre en cada aplicación: si baja, la fórmula dejó de describir al ERP.
 *
 * ── ⛔ LOS DOS DEFECTOS QUE ESTO CORRIGE, medidos antes de construir ───────────────────────
 *
 * **1. El peldaño.** `kdik.c16` NO siempre viene en el peldaño base: en 396 de 33,221 celdas
 * viene en `unidad_dos`/`unidad_tres` o no se resuelve. Comparar ese costo contra el PV del
 * peldaño base produce disparates del tamaño del factor de caja — medido en el primer intento:
 * un producto de $5.00 proponía **$127.84** (×25), otro de $17.76 proponía **$177.58** (×10).
 * ⭐ Por eso se usa **`costo_reposicion_base`**, que la Fase CE ya resolvió. El primer cálculo
 * daba un upside de **$19.41 M** anualizado que era **falso**.
 *
 * **2. La tasa.** `v_kepler_standard_cost.impuesto_pct` se **observa del renglón de venta** de
 * los últimos 30 días — así que un SKU que no vendió en esa plaza no tiene tasa, y sin tasa la
 * fórmula pierde un factor entero (⚠️ medido: eso hacía que una celda propusiera **bajar $6.37**
 * por no saber que el producto lleva IEPS).
 *
 * ⭐ Pero la tasa **no depende de la sucursal ni de la ventana**: es del producto. Y hay una
 * tercera vía que nadie había usado — **se despeja de la propia ficha**:
 *
 *     PV / (costo × (1 + markup/100))  =  (1 + impuesto/100)
 *
 * Cobertura medida de cada vía: observada **23.1 %** · propagada entre plazas **49.3 %** ·
 * **despejada de la ficha 96.0 %** · unión **97.2 %**.
 * ⛔ Y se validan entre sí: donde la observada y la despejada se solapan, **coinciden en
 * 19,614 de 19,760 = 99.26 %**. No es una conveniencia: es el mismo testigo que ya había
 * probado que `c87` es markup sobre costo y no margen sobre venta (`[PR.E0c]`).
 *
 * ── El resultado ──────────────────────────────────────────────────────────────────────────
 * La fórmula pasa de evaluar el **22.3 %** de las celdas al **37.5 %** — pero la métrica que
 * importa no es ésa, es la **venta**: evalúa el **99.81 %** ($37.72 M de $37.79 M en 30 d).
 * Lo que queda ciego son **$72,191** de plazas que no compran ese SKU (se surten por traspaso).
 *
 * ── ⛔ Lo que esta vista NO hace ──────────────────────────────────────────────────────────
 * ⛔ **No aplica el precio.** Kepler es read-only por decisión (ADR-040). Esto propone; el
 *    humano decide y captura. `commercial.price_proposals` guarda la decisión.
 * ⛔ **No propone bajar por debajo de un piso** — porque **no hay piso** (`margen_minimo` sigue
 *    NULL hasta D13). Las bajadas se publican como **observación**, no como recomendación.
 * ⛔ **No inventa un sugerido sin sus tres factores**: va NULL con `motivo_no_calculable`.
 * ⛔ **No publica lo absurdo**: una propuesta fuera de ±50 % se marca `fuera_de_cordura`
 *    (135 celdas / $58,896) — es la firma de un peldaño mal resuelto, no una oportunidad.
 *
 * VISTA derive-no-copy sobre `analytics.v_kepler_standard_cost`. Aditiva.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_suggestion';

/** Fuera de esta banda la propuesta no se publica: es la firma de un insumo mal resuelto. */
const CORDURA = 0.5;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_kepler_standard_cost') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S1] falta analytics.v_kepler_standard_cost (Fase CE)');

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH base AS (
      SELECT sucursal, sku, nombre, unidad_base,
             costo_estandar, costo_reposicion, costo_reposicion_base, peldano_reposicion,
             ultimo_costo, ultimo_costo_al,
             margen_ficha_pct, precio_ficha, impuesto_pct, impuesto_tasas_distintas,
             impuesto_renglones, unidades_base_30d, venta_neta_30d, actividad_al,
             veredicto AS veredicto_costo, desviacion_pct
        FROM analytics.v_kepler_standard_cost
    ),
    /**
     * Via B de la tasa: la tasa es del PRODUCTO. Si el SKU vendio en CUALQUIER plaza, esa tasa
     * sirve para todas. mode() y no avg() a proposito: una tasa fiscal no se promedia.
     */
    tasa_producto AS (
      SELECT sku,
             mode() WITHIN GROUP (ORDER BY impuesto_pct)  AS tasa,
             count(DISTINCT impuesto_pct)::int            AS tasas_distintas
        FROM base WHERE impuesto_pct IS NOT NULL GROUP BY sku
    ),
    /**
     * ⭐ Via C: se DESPEJA de la ficha. PV/(costo x (1+markup)) = (1+impuesto).
     * Se acepta solo si el residuo cae sobre un factor fiscal REAL (0 / 8 / 16 / 25.28), con
     * tolerancia estrecha. Si cae en cualquier otro lado, la ficha no cuadra y NO se inventa.
     */
    tasa_ficha AS (
      SELECT b.sucursal, b.sku,
             (SELECT x.t
                FROM (VALUES (0.0), (8.0), (16.0), (25.28)) AS x(t)
               WHERE b.costo_estandar > 0 AND b.margen_ficha_pct > 0 AND b.precio_ficha > 0
                 AND abs((b.precio_ficha / (b.costo_estandar * (1 + b.margen_ficha_pct/100.0)))
                         - (1 + x.t/100.0)) < 0.004
               ORDER BY abs((b.precio_ficha / (b.costo_estandar * (1 + b.margen_ficha_pct/100.0)))
                         - (1 + x.t/100.0))
               LIMIT 1) AS tasa
        FROM base b
    ),
    resuelto AS (
      SELECT b.*,
             tp.tasa AS tasa_propagada, tp.tasas_distintas,
             tf.tasa AS tasa_de_ficha,
             COALESCE(b.impuesto_pct, tp.tasa, tf.tasa)   AS tasa_usada,
             CASE WHEN b.impuesto_pct IS NOT NULL THEN 'observada_en_venta'
                  WHEN tp.tasa        IS NOT NULL THEN 'propagada_del_producto'
                  WHEN tf.tasa        IS NOT NULL THEN 'despejada_de_la_ficha'
             END AS tasa_fuente,
             -- ⛔ costo_reposicion_base, NO costo_reposicion: ese viene en el peldano de COMPRA.
             COALESCE(b.costo_reposicion_base, b.ultimo_costo) AS costo_hoy,
             CASE WHEN b.costo_reposicion_base IS NOT NULL THEN 'costo_reposicion'
                  WHEN b.ultimo_costo          IS NOT NULL THEN 'ultima_compra'
             END AS costo_fuente
        FROM base b
        LEFT JOIN tasa_producto tp ON tp.sku = b.sku
        LEFT JOIN tasa_ficha    tf ON tf.sucursal = b.sucursal AND tf.sku = b.sku
    ),
    calculado AS (
      SELECT r.*,
             -- El sugerido: la MISMA formula del ERP, con el costo de hoy.
             CASE WHEN r.costo_hoy > 0 AND r.margen_ficha_pct > 0 AND r.tasa_usada IS NOT NULL
                  THEN round((r.costo_hoy * (1 + r.margen_ficha_pct/100.0)
                                          * (1 + r.tasa_usada/100.0))::numeric, 2)
             END AS precio_sugerido,
             -- ⭐ El CONTROL: la misma formula con el costo de la FICHA tiene que devolver el PV
             --    que Kepler publica. Es lo que prueba que la formula describe al ERP.
             CASE WHEN r.costo_estandar > 0 AND r.margen_ficha_pct > 0 AND r.tasa_usada IS NOT NULL
                  THEN round((r.costo_estandar * (1 + r.margen_ficha_pct/100.0)
                                               * (1 + r.tasa_usada/100.0))::numeric, 2)
             END AS precio_reconstruido
        FROM resuelto r
    )
    SELECT
      sucursal, sku, nombre, unidad_base,

      -- ── LOS TRES FACTORES, cada uno con su procedencia ──────────────────────────────
      costo_estandar                                   AS costo_con_el_que_se_fijo,
      costo_hoy, costo_fuente,
      costo_reposicion_base, peldano_reposicion, ultimo_costo, ultimo_costo_al,
      margen_ficha_pct                                 AS markup_pct,
      round((100.0 * margen_ficha_pct
             / NULLIF(100.0 + margen_ficha_pct, 0))::numeric, 4) AS margen_venta_pct,
      tasa_usada, tasa_fuente, tasa_propagada, tasa_de_ficha, impuesto_renglones,
      tasas_distintas,

      -- ── EL PRECIO ───────────────────────────────────────────────────────────────────
      precio_ficha                                     AS precio_actual,
      precio_sugerido,
      precio_reconstruido,
      CASE WHEN precio_sugerido IS NOT NULL AND precio_ficha > 0
           THEN round((precio_sugerido - precio_ficha)::numeric, 2) END AS delta_mxn,
      CASE WHEN precio_sugerido IS NOT NULL AND precio_ficha > 0
           THEN round((100.0 * (precio_sugerido - precio_ficha) / precio_ficha)::numeric, 2)
      END AS delta_pct,

      -- ⭐ El control, como BANDERA: si la formula no reproduce el precio de hoy, el sugerido
      --    de esa fila no se puede defender aunque salga un numero.
      CASE WHEN precio_reconstruido IS NULL THEN NULL
           ELSE abs(precio_reconstruido - precio_ficha) <= 0.02 END AS formula_reproduce_actual,

      -- ── EL VEREDICTO ────────────────────────────────────────────────────────────────
      CASE
        WHEN margen_ficha_pct IS NULL OR margen_ficha_pct <= 0 THEN 'sin_markup_en_ficha'
        WHEN tasa_usada IS NULL                                THEN 'sin_tasa'
        WHEN costo_hoy IS NULL OR costo_hoy <= 0               THEN 'sin_costo_de_hoy'
        WHEN precio_ficha IS NULL OR precio_ficha <= 0         THEN 'sin_precio_actual'
        WHEN precio_sugerido >  precio_ficha * ${1 + CORDURA}  THEN 'fuera_de_cordura'
        WHEN precio_sugerido <  precio_ficha * ${1 - CORDURA}  THEN 'fuera_de_cordura'
        WHEN abs(precio_sugerido - precio_ficha) <= 0.01       THEN 'al_dia'
        WHEN precio_sugerido >  precio_ficha                   THEN 'subir'
        ELSE                                                        'bajar'
      END AS veredicto,

      -- Por que NO se puede calcular. Se muestra; no se esconde detras de un guion.
      CASE
        WHEN margen_ficha_pct IS NULL OR margen_ficha_pct <= 0
          THEN 'la ficha de Kepler no tiene margen capturado en este peldano'
        WHEN tasa_usada IS NULL
          THEN 'no se pudo resolver la tasa: el SKU no vendio en ninguna plaza y la ficha no cuadra contra ningun factor fiscal conocido'
        WHEN costo_hoy IS NULL OR costo_hoy <= 0
          THEN 'esta plaza no compra el SKU (se surte por traspaso): no hay costo de reposicion ni ultima compra'
        WHEN precio_ficha IS NULL OR precio_ficha <= 0
          THEN 'la ficha no tiene precio de venta'
      END AS motivo_no_calculable,

      -- ── CONTEXTO para el desglose ───────────────────────────────────────────────────
      veredicto_costo, desviacion_pct,
      unidades_base_30d, venta_neta_30d, actividad_al,
      CASE WHEN precio_sugerido IS NOT NULL AND precio_ficha > 0 AND venta_neta_30d > 0
             AND precio_sugerido <= precio_ficha * ${1 + CORDURA}
             AND precio_sugerido >= precio_ficha * ${1 - CORDURA}
           THEN round((venta_neta_30d * (precio_sugerido - precio_ficha)
                       / precio_ficha)::numeric, 2)
      END AS impacto_30d_mxn
    FROM calculado
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $$[PR.S1] El PRECIO SUGERIDO por (sucursal, SKU), con la formula del propio ERP:
    PV = costo x (1+markup) x (1+impuesto), reemplazando el costo con el que se fijo el precio
    por el costo de HOY. No es un modelo: es auditable renglon por renglon.
    CONTROL: con el costo estandar la formula debe devolver el precio que Kepler publica --
    82,419/83,327 = 98.91%, y la bandera formula_reproduce_actual lo dice por fila.
    DOS defectos corregidos y medidos: (1) se usa costo_reposicion_base, NO costo_reposicion --
    kdik.c16 viene en el peldano de COMPRA en 396 celdas y eso producia disparates del tamano
    del factor de caja ($5.00 proponiendo $127.84), con un upside falso de $19.41M anualizado;
    (2) la tasa se resuelve por CASCADA -- observada en venta (23.1%) > propagada del producto
    (49.3%) > DESPEJADA DE LA FICHA (96.0%), union 97.2%, y las vias coinciden en 99.26% donde
    se solapan. Sin la cascada, un SKU que no vendio en 30 dias perdia el factor fiscal entero
    y proponia BAJAR el precio. Cobertura: 37.5% de las celdas pero 99.81% de la VENTA.
    NO aplica el precio (Kepler es read-only, ADR-040), NO propone bajar contra un piso que no
    existe (margen_minimo NULL hasta D13: las bajadas son OBSERVACION), NO inventa un sugerido
    sin sus tres factores (NULL con motivo_no_calculable) y NO publica lo absurdo
    (fuera_de_cordura a mas de 50%: 135 celdas / $58,896, firma de un insumo mal resuelto).
    VISTA derive-no-copy sobre v_kepler_standard_cost, security_invoker.$$`);

  // ── Compuerta ────────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE precio_sugerido IS NOT NULL)::int calculables,
           count(*) FILTER (WHERE precio_sugerido IS NULL AND motivo_no_calculable IS NULL)::int mudas,
           count(*) FILTER (WHERE veredicto IN ('subir','bajar','al_dia')
                              AND precio_sugerido IS NULL)::int veredicto_sin_numero,
           count(*) FILTER (WHERE precio_reconstruido IS NOT NULL)::int control_evaluable,
           count(*) FILTER (WHERE formula_reproduce_actual)::int control_ok,
           count(*) FILTER (WHERE veredicto = 'fuera_de_cordura')::int absurdos,
           round(sum(venta_neta_30d)::numeric, 0) AS venta,
           round(sum(venta_neta_30d) FILTER (WHERE precio_sugerido IS NOT NULL)::numeric, 0) AS venta_cubierta
      FROM ${VIEW}`)).rows;

  const ctrl = g.control_evaluable ? (100 * g.control_ok / g.control_evaluable) : 0;
  const cob = Number(g.venta) ? (100 * Number(g.venta_cubierta) / Number(g.venta)) : 0;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S1] ${g.filas} filas · calculables ${g.calculables} · `
    + `⭐ control ${ctrl.toFixed(2)}% · cobertura de VENTA ${cob.toFixed(2)}% · `
    + `fuera de cordura ${g.absurdos} · mudas ${g.mudas}`);

  /**
   * ⛔ Las tres formas de mentir que esta vista tiene prohibidas:
   *   · quedarse muda — sin sugerido Y sin motivo, que se lee igual que "no hay nada que hacer"
   *   · dar un veredicto accionable sin el número que lo sostiene
   *   · seguir publicando cuando la fórmula dejó de describir al ERP
   */
  if (g.mudas > 0) {
    throw new Error(`[PR.S1] ${g.mudas} filas sin sugerido Y sin motivo: una ausencia muda se `
      + 'lee como "no hay nada que hacer".');
  }
  if (g.veredicto_sin_numero > 0) {
    throw new Error(`[PR.S1] ${g.veredicto_sin_numero} filas con veredicto accionable y sin `
      + 'precio sugerido.');
  }
  if (ctrl < 95) {
    throw new Error(`[PR.S1] el control cayó a ${ctrl.toFixed(2)}% (mínimo 95): la fórmula dejó `
      + 'de reproducir el precio que Kepler publica. No se puede sugerir con ella.');
  }
  if (cob < 90) {
    throw new Error(`[PR.S1] la cobertura de venta cayó a ${cob.toFixed(2)}% (mínimo 90).`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
