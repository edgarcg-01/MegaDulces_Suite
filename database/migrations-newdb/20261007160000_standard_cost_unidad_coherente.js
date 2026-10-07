/* eslint-disable no-console */
/**
 * [CE.13] LA FILA DECIA DOS COSAS DISTINTAS DEL MISMO NUMERO.
 *
 * En /compras/costo-estandar conviven dos afirmaciones sobre el costo de reposicion:
 *
 *   · la ARITMETICA -> peldano_reposicion, que resuelve comparando kdik.c16 contra los
 *     peldanos de la propia ficha (c77/c78/c79). Le pregunta a Kepler. Esta bien.
 *   · el RELATO -> "Este costo lo dejo <documento> ... 12.5 KG a $50.93", que sale de
 *     mv_kepler_cost_origin, donde el documento se elige por PARECIDO DE PRECIO
 *     (abs(mv.precio / c.c16 - 1) <= 0.01) y se desempata con fecha DESC, folio DESC.
 *
 * La unidad que se imprime es la del documento que gano ese desempate, y nada garantiza que
 * sea el peldano en el que vive c16. Medido en el SKU 30540:
 *
 *     plaza 00 -> 19 documentos dentro del 1%, con DOS etiquetas distintas ("500" y "KG")
 *     plaza 05 ->  2 documentos dentro del 1%, con DOS etiquetas distintas
 *
 * En la 05 el desempate eligio "KG" sobre un costo que es de la unidad base de 500 g: la fila
 * publica un numero resuelto como base y lo rotula en kilos.
 *
 * -- Lo que NO se hace, y por que ----------------------------------------------------------
 * NO se le hace caso a la etiqueta en vez de a la razon. Se probo y se REFUTO: hay 63 filas
 * que declaran PZA con razones de 12, 20 y 40 que calcan exacto a factor_dos -- el rotulo
 * miente seguido y la aritmetica lo atrapa. Confiar en la etiqueta habria roto 63 filas sanas.
 *
 * Tampoco se corrige el numero. Se DECLARA que las dos afirmaciones no concuerdan (ADR-056),
 * igual que la pantalla ya declara el "No se pudo atribuir" del 24.7%.
 *
 * -- Los tres NULL, que no son el mismo -----------------------------------------------------
 * origen_unidad_coherente es ternaria. NULL cuando no hay con que juzgar: sin etiqueta, sin
 * peldano resuelto, o -- el caso que obligo la guarda -- cuando el rotulo CHOCA entre peldanos.
 * Medido: 21,496 de 86,802 filas de v_kepler_unit_ladder tienen el rotulo de la unidad base
 * IGUAL al de la segunda (24.8%), asi que casar por nombre es ambiguo en un cuarto del
 * catalogo. Sin esa guarda la columna habria juzgado contra el primer peldano que coincidiera.
 */

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_kepler_standard_cost
      WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT e.sucursal, e.sku,
             e.u1_label, e.u2_label, e.u3_label, e.f2_cap, e.f3_cap,
             e.costo1, e.costo2, e.costo3, e.margen1, e.pv1
        FROM analytics.v_kepler_unit_ladder e
    ), erp AS (
      -- sucursal = btrim(c1) es el anti-replica, identico al de analytics.v_kepler_unit_cost.
      SELECT k.sucursal, btrim(k.c2) AS sku,
             NULLIF(max(k.c16)::numeric, 0) AS costo_reposicion,
             max(k.c18) AS ultimo_costo,
             -- 1800-01-01 es el centinela de nulo de Kepler: 55.6% de las fechas. NULL, no 1800.
             NULLIF(max(k.c17)::date, '1800-01-01'::date) AS ultimo_costo_al
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), nom AS (
      SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre
        FROM kepler_ods.kdii ORDER BY btrim(c1), sucursal
    ), base AS (
      SELECT f.sucursal, f.sku, n.nombre,
             f.u1_label AS unidad_base, f.u2_label AS unidad_dos, f.u3_label AS unidad_tres,
             f.f2_cap AS factor_dos, f.f3_cap AS factor_tres,
             NULLIF(f.costo1, 0) AS costo_estandar,
             NULLIF(f.costo2, 0) AS costo_estandar_u2,
             NULLIF(f.costo3, 0) AS costo_estandar_u3,
             f.margen1 AS margen_ficha_pct,
             NULLIF(f.pv1, 0) AS precio_ficha,
             e.costo_reposicion, NULLIF(e.ultimo_costo, 0) AS ultimo_costo,
             CASE WHEN e.ultimo_costo_al >= DATE '1900-01-01'
                  THEN to_char(e.ultimo_costo_al, 'YYYY-MM-DD') END AS ultimo_costo_al,
             a.impuesto_pct, a.impuesto_tasas_distintas, a.renglones AS impuesto_renglones,
             a.unidades_base AS unidades_base_30d,
             a.venta_bruta   AS venta_bruta_30d,
             a.venta_neta    AS venta_neta_30d,
             a.ventana_hasta AS actividad_al,
             o.origen_doctype, o.origen_nombre, o.origen_nombre_ambiguo, o.origen_familia,
             o.origen_fecha_txt, o.origen_folio, o.origen_precio, o.origen_cantidad, o.origen_unidad,
             o.origen_almacen, o.origen_doc_id, o.origen_doc_renglones, o.origen_doc_total
        FROM ficha f
        LEFT JOIN nom n ON n.sku = f.sku
        LEFT JOIN erp e ON e.sucursal = f.sucursal AND e.sku = f.sku
        LEFT JOIN analytics.mv_kepler_standard_cost_activity a
               ON a.sucursal = f.sucursal AND a.sku = f.sku
        LEFT JOIN analytics.mv_kepler_cost_origin o
               ON o.sucursal = f.sucursal AND o.sku = f.sku
    ), peld AS (
      -- ⭐ EL ARREGLO ES EL ORDEN, no un umbral nuevo. [CE.8] probaba "razon < 2 => base" ANTES
      -- que los peldanos, asi que con f2 = 2 el atajo posicional ganaba aunque el peldaño dos
      -- estuviera 26x mas cerca (el caso 30540). Ahora los peldanos se prueban PRIMERO y el
      -- atajo queda de respaldo. La banda de +/-25% de los peldanos es la misma de [CE.8]: un
      -- factor es un entero exacto, asi que un peldaño que "casi" casa no casa.
      --
      -- ⛔ Se descarto elegir "el candidato mas cercano" con un umbral de desempate: probado
      -- contra los casos reales, un desempate de 3x volvia ambiguo al 17182 (razon 1.99 con
      -- f2 = 12), que esta BIEN clasificado como base. La asimetria es real y hay que
      -- respetarla: un peldaño tiene que casar fino, la deriva de costo no tiene tope.
      SELECT b.*,
             CASE
               WHEN b.costo_estandar IS NULL OR b.costo_reposicion IS NULL
                 OR b.costo_estandar <= 0 OR b.costo_reposicion <= 0 THEN NULL
               WHEN b.costo_reposicion / b.costo_estandar < 0.5 THEN 'testigo_inverosimil'
               WHEN b.factor_dos > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_dos - 1) <= 0.25
                 THEN 'unidad_dos'
               WHEN b.factor_tres > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_tres - 1) <= 0.25
                 THEN 'unidad_tres'
               -- medido: no existe ningun f2 < 2 (minimo 2.00 sobre 6,518 pares), asi que una
               -- razon < 2 que no caso en ningun peldaño es el base con su deriva.
               WHEN b.costo_reposicion / b.costo_estandar < 2 THEN 'base'
               ELSE 'no_resuelto'
             END AS peldano_reposicion
        FROM base b
    ), norm AS (
      SELECT p.*,
             CASE p.peldano_reposicion
               WHEN 'base'        THEN p.costo_reposicion
               WHEN 'unidad_dos'  THEN p.costo_reposicion / NULLIF(p.factor_dos, 0)
               WHEN 'unidad_tres' THEN p.costo_reposicion / NULLIF(p.factor_tres, 0)
               ELSE NULL
             END AS costo_reposicion_base
        FROM peld p
    )
    SELECT n.sucursal, n.sku, n.nombre,
           n.unidad_base, n.unidad_dos, n.unidad_tres, n.factor_dos, n.factor_tres,
           n.costo_estandar, n.costo_estandar_u2, n.costo_estandar_u3,
           n.margen_ficha_pct, n.precio_ficha,
           n.impuesto_pct, n.impuesto_tasas_distintas, n.impuesto_renglones,
           CASE WHEN n.costo_estandar IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                            * (1 + n.impuesto_pct / 100), 2)
           END AS precio_reconstruido,
           CASE
             WHEN n.precio_ficha IS NULL OR n.costo_estandar IS NULL
               OR n.margen_ficha_pct IS NULL THEN NULL
             WHEN n.impuesto_pct IS NULL THEN NULL
             ELSE abs(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                       * (1 + n.impuesto_pct / 100) - n.precio_ficha) <= 0.02
           END AS precio_cuadra,
           CASE
             WHEN n.precio_ficha IS NULL THEN 'sin_precio_en_ficha'
             WHEN n.costo_estandar IS NULL THEN 'sin_costo_estandar'
             WHEN n.margen_ficha_pct IS NULL THEN 'sin_margen_en_ficha'
             WHEN n.impuesto_pct IS NULL THEN 'impuesto_no_medido_sin_venta'
             ELSE NULL
           END AS precio_cuadra_motivo,
           n.costo_reposicion, n.peldano_reposicion, n.costo_reposicion_base,
           n.ultimo_costo, n.ultimo_costo_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar > 0
                THEN round(((n.costo_reposicion_base / n.costo_estandar) - 1) * 100, 3)
           END AS desviacion_pct,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                THEN round(n.costo_reposicion_base - n.costo_estandar, 4)
           END AS desviacion_por_unidad,
           CASE
             WHEN n.costo_estandar IS NULL                     THEN 'sin_estandar'
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                  THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                   THEN 'sin_testigo'
             -- tres maneras distintas de no poder comparar, con tres arreglos distintos
             WHEN n.peldano_reposicion = 'testigo_inverosimil' THEN 'testigo_inverosimil'
             WHEN n.peldano_reposicion = 'no_resuelto'         THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar   THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d,
           -- ── [CE.9] las columnas nuevas van AL FINAL ────────────────────────────────────
           -- La plaza 00 es OFICINAS: 9,632 fichas, cero venta. No se esconde: se DECLARA, y el
           -- consumidor decide (el servicio la filtra por default).
           (n.sucursal <> '00') AS es_plaza_operativa,
           -- Salida A de la decision: si se captura el costo nuevo, Kepler conserva el margen y
           -- RECALCULA EL PRECIO. Medido: el precio siguio al costo en el 74.02% de 6,501 cambios
           -- reales, y solo en el 1.28% se quedo quieto.
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_reposicion_base * (1 + n.margen_ficha_pct / 100)
                                                   * (1 + n.impuesto_pct / 100), 2)
           END AS precio_si_conserva_margen,
           -- Salida B: si el precio NO se mueve, este es el margen que de verdad se esta sacando.
           -- Misma convencion que margen_ficha_pct: markup sobre el costo, precio NETO.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2)
           END AS margen_real_pct,
           -- 272 fichas (9.4% de las evaluables) pierden dinero en cada venta HOY. Es la lista
           -- que importa mañana, no las 6,300.
           -- [CE.10] Se deriva del MISMO numero redondeado que se publica, no del crudo.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2) < 0
           END AS vende_bajo_costo,
           -- ── [CE.11] POR QUE el costo del ERP esta donde esta ──────────────────────────
           -- El ultimo movimiento NO de venta cuyo precio casa con kdik.c16 dentro del 1%.
           -- Medido: explica 25,071 de 33,286 pares (75.3%), y el 71.3% de esos es INVENTARIO
           -- FISICO, no una compra. Lo que no se explica llega NULL: ausencia, no cero.
           n.origen_familia, n.origen_doctype, n.origen_nombre, n.origen_nombre_ambiguo,
           n.origen_fecha_txt, n.origen_folio, n.origen_precio, n.origen_cantidad, n.origen_unidad,
           -- [CE.12] el ALMACEN que dejo el costo (kdm2.c1 = kdik.c1 por construccion), el
           -- numero de documento tal cual lo escribe Kepler, y el TAMANO del papel: sin eso
           -- un renglon de 1 PAQ se lee como si el movimiento entero hubiera sido de 1 PAQ.
           n.origen_almacen, n.origen_doc_id, n.origen_doc_renglones, n.origen_doc_total,
           -- ── [CE.13] LA ETIQUETA DEL DOCUMENTO CONTRA EL PELDANO QUE RESOLVIO LA ARITMETICA ──
           -- La columna origen_unidad NO decide el peldano: llega de mv_kepler_cost_origin, que elige el
           -- documento por PARECIDO DE PRECIO (abs(precio/c16 - 1) <= 0.01) y desempata por
           -- fecha/folio. Medido en el SKU 30540: la plaza 00 tiene 19 documentos dentro del 1%
           -- con DOS etiquetas distintas ("500" y "KG") y la 05 tiene dos -- o sea que la unidad
           -- que se imprime salio de un desempate, no de evidencia.
           -- Cuando esa etiqueta contradice al peldano, la fila dice dos cosas distintas del
           -- mismo numero. No se corrige ninguna: se DECLARA que no concuerdan (ADR-056).
           -- NULL = no se pudo juzgar, y son TRES casos distintos: sin etiqueta, sin peldano
           -- resuelto, o el rotulo choca entre peldanos -- esto ultimo pasa en 21,496 de 86,802
           -- filas de la escalera (24.8%), asi que comparar por nombre es ambiguo en un cuarto
           -- del catalogo y ahi no se afirma nada.
           CASE
             WHEN n.origen_unidad IS NULL OR n.peldano_reposicion IS NULL
               OR n.peldano_reposicion IN ('no_resuelto', 'testigo_inverosimil') THEN NULL
             WHEN coalesce((btrim(n.origen_unidad) = btrim(n.unidad_base))::int, 0)
                + coalesce((btrim(n.origen_unidad) = btrim(n.unidad_dos))::int, 0)
                + coalesce((btrim(n.origen_unidad) = btrim(n.unidad_tres))::int, 0) <> 1 THEN NULL
             WHEN btrim(n.origen_unidad) = btrim(n.unidad_base)  THEN n.peldano_reposicion = 'base'
             WHEN btrim(n.origen_unidad) = btrim(n.unidad_dos)   THEN n.peldano_reposicion = 'unidad_dos'
             WHEN btrim(n.origen_unidad) = btrim(n.unidad_tres)  THEN n.peldano_reposicion = 'unidad_tres'
           END AS origen_unidad_coherente
      FROM norm n`);

  // No se heredan en un CREATE OR REPLACE (ADR-057): se re-aplican siempre.
  await knex.raw(`ALTER VIEW analytics.v_kepler_standard_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_standard_cost TO app_runtime`);

  const d = (await knex.raw(`
    SELECT count(*) FILTER (WHERE origen_unidad_coherente IS TRUE)::int  AS concuerdan,
           count(*) FILTER (WHERE origen_unidad_coherente IS FALSE)::int AS contradicen,
           count(*) FILTER (WHERE origen_unidad_coherente IS NULL)::int  AS no_medido,
           count(*) FILTER (WHERE origen_unidad_coherente IS FALSE
                              AND veredicto IN ('estandar_bajo','estandar_alto'))::int AS accionables
      FROM analytics.v_kepler_standard_cost`)).rows[0];

  console.log('  [CE.13] etiqueta vs peldano: ' + d.concuerdan + ' concuerdan · '
            + d.contradicen + ' se CONTRADICEN (' + d.accionables + ' con veredicto accionable) · '
            + d.no_medido + ' no se pueden juzgar');
  if (Number(d.concuerdan) === 0) {
    throw new Error('[CE.13] NINGUNA fila concuerda: la comparacion de rotulos esta rota');
  }
};

exports.down = async function down(knex) {
  console.log('  [CE.13] down: re-aplicar 20260930170000 (la vista sin origen_unidad_coherente).');
  void knex;
};
