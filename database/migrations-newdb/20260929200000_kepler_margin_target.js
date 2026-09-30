'use strict';
/**
 * `[PR.E0c]` — **La meta de margen sale de Kepler, y se convierte UNA sola vez.**
 *
 * Decisión de Edgar (2026-09-29): *"Kepler ya maneja un margen. Ese es el margen que tomamos
 * como base."* Correcto — y el dato **ya estaba publicado**: `analytics.v_kepler_unit_ladder`
 * expone `margen1/2/3`, uno por peldaño, desde `kdii.c87/c88/c89`. Esta vista **no materializa
 * nada nuevo**: unpivotea la escalera y le agrega lo único que faltaba, la **conversión de
 * escala** y el **veredicto**.
 *
 * ── ⭐ EL HALLAZGO QUE OBLIGA A CONVERTIR ──────────────────────────────────────────────────
 * `c87` es **markup sobre el COSTO**, no margen sobre la venta:
 *
 *     PV = costo x (1 + c87/100) x (1 + impuesto)
 *
 * Medido sobre 83,949 fichas **sin depender de la tasa fiscal** — el residuo
 * (PV/costo)/(1+m/100) tiene que caer en un factor fiscal conocido:
 *
 *   · se comporta como MARKUP sobre costo : 83,202 = **99.11 %**
 *   · se comporta como MARGEN sobre venta :  4,280 =   5.10 %
 *   · y los residuos más frecuentes son **1.0800** (IEPS 8), **1.0000** (exento),
 *     **1.1600** (IVA 16) — exactos. No es coincidencia: es la fórmula.
 *
 * ⛔ Toda la Fase MR y la pantalla de rentabilidad miden **margen sobre venta**. Publicar el 22 %
 * de Kepler junto a un 14 % de margen realizado es comparar dos reglas distintas con el mismo
 * nombre. La conversión es aritmética y va **en un solo lugar**:
 *
 *     margen_venta = 100 x markup / (100 + markup)
 *
 * Verificado contra la propia Fase CE: el `70001` tiene markup 19.7070 y CE publica su margen
 * estándar en **16.46 %** — que es exactamente 100 x 19.7070 / 119.7070.
 *
 * ── ⭐⭐ Y EL MARGEN NO ES UNO POR SKU: ES UNO POR PELDAÑO ─────────────────────────────────
 * Medido: **58,027 filas** donde el peldaño base y la Unidad Dos **difieren**. Mediana de la
 * base **22.00 %**, mediana de la Unidad Dos **13.79 %** — la caja se vende con ~8 pp menos de
 * margen que la pieza, y es deliberado: es la estructura de mayoreo.
 *
 * Por eso esta vista tiene **una fila por peldaño** y no una por SKU. Colapsarla al peldaño base
 * le pondría la meta de la PIEZA a lo que se vende en CAJA.
 *
 * ── Lo que esta vista NO hace ──────────────────────────────────────────────────────────────
 * ⛔ No decide cuál peldaño aplica — eso lo resuelve `analytics.v_unit_truth` (ADR-057), que ya
 * tiene el testigo y el método. Acá se publican los tres y el consumidor elige con método.
 * ⛔ No inventa un margen donde Kepler no lo capturó: va **NULL con veredicto**, nunca 0. Un SKU
 * sin margen capturado no es un SKU de margen cero.
 *
 * Cobertura medida: **97.38 %** de las fichas y **99.96 %** de la venta de 90 días.
 *
 * VISTA derive-no-copy sobre una vista que ya deriva del ODS. Aditiva.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_kepler_margin_target';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_kepler_unit_ladder') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.E0c] falta analytics.v_kepler_unit_ladder (Fase U/CE)');

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH escalera AS (
      SELECT sucursal, sku,
             1 AS peldano, u1_label AS unidad, 1::numeric AS factor,
             margen1 AS markup_pct, costo1 AS costo, pv1 AS precio_ficha,
             (peldano_caja = 1) AS es_caja
        FROM analytics.v_kepler_unit_ladder
      UNION ALL
      SELECT sucursal, sku,
             2, u2_label, NULLIF(f2_cap, 0)::numeric,
             margen2, costo2, pv2, (peldano_caja = 2)
        FROM analytics.v_kepler_unit_ladder
      UNION ALL
      SELECT sucursal, sku,
             3, u3_label, NULLIF(f3_cap, 0)::numeric,
             margen3, costo3, pv3, (peldano_caja = 3)
        FROM analytics.v_kepler_unit_ladder
    )
    SELECT
      sucursal, sku, peldano, unidad, factor, es_caja,
      NULLIF(costo, 0)        AS costo_estandar,
      NULLIF(precio_ficha, 0) AS precio_ficha,

      -- El markup tal como Kepler lo captura. Se conserva CRUDO para poder auditar la ficha.
      CASE WHEN markup_pct > 0 AND markup_pct < 1000 THEN round(markup_pct::numeric, 4) END
        AS markup_pct,

      -- ⭐ LA CONVERSION, en el unico lugar donde vive: markup sobre costo -> margen sobre venta.
      -- ⛔ NULL cuando no hay markup capturado. Un SKU sin meta no es un SKU con meta CERO, y
      --    publicarlo como 0 haria que el motor le exija margen nulo (o sea, que lo regale).
      CASE WHEN markup_pct > 0 AND markup_pct < 1000
           THEN round((100.0 * markup_pct / (100.0 + markup_pct))::numeric, 4) END
        AS margen_venta_pct,

      -- ⛔ El veredicto responde UNA sola pregunta: ¿Kepler capturó la meta?
      -- El costo es OTRA pregunta y va en su propia columna. El dry-run contra prod encontró
      -- que mezclarlas declaraba 1,012 filas "sin meta" que SÍ la tienen: les falta el costo,
      -- que hace falta para reconstruir el PRECIO, no para saber cuál es la META.
      -- Es la trampa de ADR-057: cuando un CASE mezcla dos preguntas, la precedencia le miente
      -- a una de las dos.
      CASE
        WHEN markup_pct IS NULL   THEN 'sin_ficha'
        WHEN markup_pct = 0       THEN 'sin_margen_capturado'
        WHEN markup_pct < 0       THEN 'markup_negativo'
        WHEN markup_pct >= 1000   THEN 'markup_fuera_de_rango'
        ELSE                           'capturado'
      END AS veredicto,

      -- Separada a propósito: sin costo la meta sigue siendo válida, pero el precio de la ficha
      -- no se puede reconstruir ni auditar. El consumidor decide si le alcanza.
      (NULLIF(costo, 0) IS NOT NULL) AS costo_presente
    FROM escalera
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $$[PR.E0c] La META de margen que Kepler ya maneja, por (sucursal, SKU, PELDANO).
    Deriva de analytics.v_kepler_unit_ladder (margen1/2/3 <- kdii.c87/c88/c89). NO materializa
    nada nuevo. La CONVERSION vive SOLO aca: kdii.c87 es MARKUP SOBRE COSTO, no margen sobre
    venta -- medido, 99.11% se comporta como markup contra 5.10% como margen, y el residuo
    (PV/costo)/(1+m/100) cae exacto en 1.0800 (IEPS) / 1.0000 (exento) / 1.1600 (IVA), o sea
    que el tercer factor de la formula es fiscal. margen_venta = 100m/(100+m).
    Una fila por PELDANO porque el margen NO es uno por SKU: 58,027 filas donde la base y la
    Unidad Dos difieren, mediana base 22.00% contra 13.79% de la Unidad Dos -- la caja se vende
    con menos margen que la pieza, deliberadamente. Colapsar al peldano base le pondria la meta
    de la PIEZA a lo que se vende en CAJA. Sin markup capturado va NULL con veredicto, NUNCA 0.
    Cual peldano aplica lo decide v_unit_truth (ADR-057), no esta vista.
    Cobertura medida 2026-09-29: 97.38% de las fichas, 99.96% de la venta de 90 dias.
    VISTA derive-no-copy, security_invoker.$$`);

  // ── Compuerta, con sus pruebas NEGATIVAS ──────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto = 'capturado')::int capturados,
           count(*) FILTER (WHERE veredicto <> 'capturado'
                              AND margen_venta_pct IS NOT NULL)::int fantasma,
           /**
            * ⛔ ESTRICTO, no >=. La invariante real es margen <= markup SIEMPRE, y el empate
            * existe de verdad: con round(...,4), un markup de 0.0001 da margen 0.0001. Son 72
            * filas medidas contra prod. Usar >= las declaraba rotas — y es EXACTAMENTE el error
            * de [PR.W1.1] de ayer: comparar dos números redondeados en órdenes distintos.
            * Acá la holgura NO es tolerancia: es reconocer que el empate es legítimo.
            */
           count(*) FILTER (WHERE margen_venta_pct IS NOT NULL
                              AND (margen_venta_pct > markup_pct
                                OR margen_venta_pct <= 0
                                OR margen_venta_pct >= 100))::int conversion_rota,
           count(*) FILTER (WHERE margen_venta_pct IS NOT NULL
                              AND margen_venta_pct = markup_pct)::int empate_por_redondeo,
           count(*) FILTER (WHERE margen_venta_pct = 0)::int en_cero,
           count(*) FILTER (WHERE veredicto = 'capturado' AND NOT costo_presente)::int sin_costo,
           count(DISTINCT sku)::int skus
      FROM ${VIEW}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.E0c] ${g.filas} filas · ${g.skus} SKUs · capturados ${g.capturados} · `
    + `fantasma ${g.fantasma} · conversion rota ${g.conversion_rota} · en cero ${g.en_cero}`
    + ` · empate por redondeo ${g.empate_por_redondeo} · con meta y sin costo ${g.sin_costo}`);

  // ⛔ Las tres formas de mentir que esta vista tiene prohibidas:
  //    · publicar una meta donde Kepler no capturo markup (fantasma)
  //    · una conversion que no baje el numero (margen sobre venta SIEMPRE < markup sobre costo)
  //    · una meta de CERO, que el motor leeria como "regalalo"
  if (g.fantasma > 0 || g.conversion_rota > 0 || g.en_cero > 0) {
    throw new Error(`[PR.E0c] la vista miente: ${g.fantasma} metas sin markup, `
      + `${g.conversion_rota} conversiones rotas, ${g.en_cero} metas en cero.`);
  }
  if (g.capturados === 0) {
    throw new Error('[PR.E0c] cero metas capturadas — la escalera no trae margen.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
