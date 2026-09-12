/**
 * VK.1 — ⭐⭐ LA MEDIDA QUE KEPLER HACE, COPIADA DE SU PROPIA FÓRMULA.
 *
 * Edgar, 2026-09-12: *"cerremos kepler, la prioridad es tener una verdad absoluta de Kepler. El
 * punto no es ir conciliando o parchando, es copiar su fórmula para encontrar la medida que ellos
 * hacen; una vez con la medida, trabajar con todas las unidades de medida."*
 *
 * ── El giro ─────────────────────────────────────────────────────────────────────────────────
 *
 * Todo lo anterior (ADR-055/057/059, `v_product_box_factor`, `v_unit_truth`) **arbitra**: ordena
 * testigos —`kdii.c84`, la etiquetera, el override, lo pagado al proveedor— y elige. Eso responde
 * *"¿cuál de mis fuentes miente menos?"*.
 *
 * Kepler no necesita que lo arbitren: **declara su conversión en cada renglón** y calcula con
 * ella. Verificado sobre 90 d, `U-D` 8/10/12, capturados en su propia sucursal:
 *
 * ```text
 *            renglones completos      c9 = c56 x c58        %
 *   U-D-10        694,769              694,693          99.9891
 *   U-D-8          17,039               17,033          99.9648
 *   U-D-12          8,237                8,233          99.9514
 * ```
 *
 * `c9` (cantidad base) `= c56` (cantidad vendida) `× c58` (factor). **Ésa es su fórmula**, y se
 * cumple al 99.99% — incluido `U-D-8`, el doctype que se venía declarando "no arbitrable" porque
 * `c62` está vacío. La unidad nunca necesitó a `c62`: el costo era un testigo EXTERNO que se
 * buscaba para confirmar el factor, y el factor no hay que confirmarlo — **Kepler calcula con él**.
 *
 * ── ⭐ Y `c58` no es "el factor de caja": es un PELDAÑO ──────────────────────────────────────
 *
 * Leerlo como un número por producto fue el error de fondo. `c58` convierte la unidad **vendida**
 * (`c55`) a la unidad **base** (`c11`) de ese renglón, y Kepler usa varias:
 *
 * ```text
 *   c58 = 1     661,960 renglones (91.9%)   <- vendido en la unidad base
 *   c58 > 1      58,134 renglones ( 8.1%)   <- vendido en una unidad mayor
 *
 *   vendida=PAQ  base=PZA   35,425 renglones   factor medio 11.00
 *   vendida=CJA  base=PAQ   10,759 renglones   factor medio 16.32
 *   vendida=CJA  base=PZA    6,933 renglones   factor medio 35.57
 *   vendida=BTO  base=KG     2,083 renglones   factor medio 20.72
 *   vendida=KG   base=500    1,961 renglones   factor medio  2.00
 * ```
 *
 * O sea la medida de Kepler es una **ESCALERA** (`PZA → PAQ → CJA`), no un escalar. Comparar
 * `v_warehouse_box_factor` —un número— contra esto daba "92% difiere", y ese 92% era un **error
 * de categoría**: un número contra una escalera.
 *
 * ── Coherencia, medida antes de construir ───────────────────────────────────────────────────
 *
 * ```text
 *   peldanos (sku x desde x hasta) .. 7,741  sobre 5,384 SKUs   (365 d)
 *   con UN factor unico ............. 7,506  (96.96%)
 *   con factor AMBIGUO .............. 235    (56,406 renglones)  <- se marcan, no se promedian
 *
 *   forma: 3,458 SKUs con 1 peldano · 1,591 con 2 · 259 con 3 · 58 con 4 · 16 con 5 · 2 con 6
 * ```
 *
 * ── Qué es esta vista, y qué NO ─────────────────────────────────────────────────────────────
 *
 * Es **lo que Kepler hizo**, no lo que debería hacer: un peldaño existe acá porque Kepler lo
 * aplicó en un renglón real. No hay default, no hay respaldo, no hay herencia de otra fuente.
 * Donde Kepler nunca vendió un SKU en cierta unidad, **no hay fila** — y esa ausencia es
 * información, no un cero.
 *
 * ⚠️ **NO compone la escalera.** Hay `PZA→PAQ` (11) y `PAQ→CJA` (16.32), y también un `PZA→CJA`
 * DIRECTO observado (35.57 medio): componer daría ~179 y el directo dice otra cosa. Cuál manda es
 * una pregunta aparte que pide su propia verificación — se deja declarada en vez de multiplicar
 * peldaños y publicar el producto.
 *
 * ⚠️ Materializada por costo (GOTCHAS §19): escanear 365 d de `kdm2` en cada consulta no es
 * viable. El pecado sería materializar un valor **inventado**; acá cada fila sale de renglones
 * reales y se puede rastrear a ellos.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_kepler_unit_ladder';

// Las SIETE columnas de la PK de kdm1. Unir por 5 casa el documento equivocado (R.5).
const J7 = `h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
            AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6`;

const SQL = `
CREATE MATERIALIZED VIEW ${MV} AS
WITH renglon AS (
  SELECT d.sucursal,
         btrim(d.c8)                                                        AS sku,
         NULLIF(btrim(d.c11), '')                                           AS unidad_base,
         NULLIF(btrim(d.c55), '')                                           AS unidad_vendida,
         round(NULLIF(regexp_replace(d.c58, '[^0-9.-]', '', 'g'), '')::numeric, 4)  AS factor,
         round(NULLIF(regexp_replace(d.c9::text, '[^0-9.-]', '', 'g'), '')::numeric, 4) AS cant_base,
         round(NULLIF(regexp_replace(d.c56, '[^0-9.-]', '', 'g'), '')::numeric, 4)  AS cant_vendida,
         round(NULLIF(regexp_replace(d.c13::text, '[^0-9.-]', '', 'g'), '')::numeric, 2) AS importe,
         h.c9::date                                                         AS fecha
    FROM kepler_ods.kdm2 d
    JOIN kepler_ods.kdm1 h ON ${J7}
   WHERE d.c2 = 'U' AND d.c3 = 'D'
     AND btrim(d.c4::text) IN ('8', '10', '12')
     AND h.c9 >= current_date - 365
     AND d.sucursal = btrim(d.c1))
SELECT sku,
       unidad_vendida,
       unidad_base,
       -- El factor que Kepler MAS USO para ese peldano. Con un solo valor es el valor;
       -- con varios queda marcado ambiguo y el consumidor decide, no esta vista.
       mode() WITHIN GROUP (ORDER BY factor)          AS factor,
       count(DISTINCT factor)::int                    AS factores_distintos,
       (count(DISTINCT factor) > 1)                   AS ambiguo,
       min(factor)                                    AS factor_min,
       max(factor)                                    AS factor_max,
       count(*)::int                                  AS renglones,
       count(DISTINCT sucursal)::int                  AS sucursales,
       -- La prueba de que se esta leyendo la formula de Kepler y no otra cosa: su identidad.
       count(*) FILTER (WHERE cant_base IS NOT NULL AND cant_vendida IS NOT NULL
                          AND abs(cant_base - cant_vendida * factor) <= 0.001)::int AS renglones_identidad_ok,
       round(sum(COALESCE(importe, 0)), 2)            AS importe,
       min(fecha)                                     AS primer_visto,
       max(fecha)                                     AS ultimo_visto
  FROM renglon
 WHERE sku IS NOT NULL AND btrim(sku) <> ''
   AND unidad_base IS NOT NULL AND unidad_vendida IS NOT NULL
   AND factor > 0
 GROUP BY 1, 2, 3`;

exports.up = async function up(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(SQL);
  await knex.raw(`CREATE UNIQUE INDEX mv_kepler_unit_ladder_pk
                    ON ${MV} (sku, unidad_vendida, unidad_base)`);
  await knex.raw(`CREATE INDEX mv_kepler_unit_ladder_sku ON ${MV} (sku)`);
  await knex.raw(`ANALYZE ${MV}`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    'VK.1 - LA MEDIDA QUE KEPLER HACE. Cada fila es un peldano (sku, unidad_vendida -> unidad_base) con el factor que Kepler REALMENTE aplico en renglones de venta (kdm2.c58), ventana 365 d, U-D 8/10/12. NO arbitra ni compone: reproduce la formula c9 = c56 x c58, que se cumple en 99.99%. Sin default ni respaldo: donde Kepler nunca vendio en esa unidad NO hay fila, y esa ausencia es informacion. ambiguo = Kepler uso mas de un factor para el mismo peldano (235 de 7,741): se marca, no se promedia.'`);

  // ── Auto-verificación ──────────────────────────────────────────────────────────────────────
  const g = (await knex.raw(`
    SELECT count(*)::int peldanos, count(DISTINCT sku)::int skus,
           count(*) FILTER (WHERE ambiguo)::int ambiguos,
           count(*) FILTER (WHERE factor > 1)::int mayores_a_uno,
           sum(renglones)::bigint renglones,
           sum(renglones_identidad_ok)::bigint identidad_ok
      FROM ${MV}`)).rows[0];
  const pctId = (100 * Number(g.identidad_ok) / Number(g.renglones)).toFixed(4);
  console.log(`  [vk1] ${g.peldanos} peldanos sobre ${g.skus} SKUs · ambiguos ${g.ambiguos}`
    + ` · con factor > 1: ${g.mayores_a_uno}`);
  console.log(`  [vk1] ⭐ la identidad de Kepler (c9 = c56 x c58) se cumple en `
    + `${Number(g.identidad_ok).toLocaleString('en-US')} de `
    + `${Number(g.renglones).toLocaleString('en-US')} renglones = ${pctId}%`);

  // ⭐⭐ El gate que define la fase: si la identidad NO se cumpliera, no estariamos leyendo la
  // formula de Kepler sino tres columnas sueltas, y toda la vista seria una invencion.
  if (Number(pctId) < 99) {
    throw new Error(`la identidad de Kepler se cumple en ${pctId}%: no se esta reproduciendo su `
      + 'formula. Abortado antes de publicar una medida inventada');
  }
  if (g.peldanos < 1000) throw new Error(`solo ${g.peldanos} peldanos: la ventana quedo corta`);
  if (g.ambiguos < 1) {
    throw new Error('CERO peldanos ambiguos: imposible sobre 5,000 SKUs. O el mode() los tapo, '
      + 'o el conteo de factores distintos no esta mirando lo que cree');
  }

  // ⭐ PRUEBA NEGATIVA — la escalera tiene que tener ESCALONES, no un solo nivel. Si todos los
  // peldanos fueran factor 1, estariamos materializando "no se convierte nada" y la vista no
  // aportaria nada sobre no tenerla.
  if (g.mayores_a_uno < 100) {
    throw new Error(`solo ${g.mayores_a_uno} peldanos con factor > 1: la escalera no tiene `
      + 'escalones, revisar el filtro');
  }

  // El caso que abrio todo, si Kepler lo vendio en mas de una unidad.
  const caso = (await knex.raw(`
    SELECT unidad_vendida, unidad_base, factor, renglones, ambiguo
      FROM ${MV} WHERE sku = '96504' ORDER BY factor DESC`)).rows;
  if (caso.length) {
    caso.forEach((x) => console.log(`  [vk1] 96504: ${x.unidad_vendida} -> ${x.unidad_base}`
      + ` = ${x.factor} (${x.renglones} renglones${x.ambiguo ? ', AMBIGUO' : ''})`));
  } else {
    console.log('  [vk1] 96504 no tiene peldanos en Kepler (solo se vendio en su unidad base)');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
