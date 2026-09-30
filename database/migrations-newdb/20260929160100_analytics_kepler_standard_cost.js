'use strict';
/**
 * `[CE.1]` — **`analytics.v_kepler_standard_cost`: el costo estándar de cada producto, con qué
 * se lo contrasta y qué no se pudo contrastar.**
 *
 * ── Qué ES el costo estándar (decodificado 2026-09-29) ─────────────────────────────────
 *
 * Vive en la ficha del producto (`kepler_ods.kdii`), **uno por peldaño**: `c77`/`c78`/`c79`, con
 * su margen (`c87`/`c88`/`c89`) y su precio (`c90`/`c91`/`c92`). Es **predeterminado**: cambia por
 * escalón cuando alguien edita la ficha, no con cada compra (`70001` pasó de 63.86 a 66.52).
 *
 * ⭐ **No es decorativo: es el que FIJA el precio de venta.** Medido contra prod, 42,424 filas:
 *
 *     precio_ficha = costo_estandar × (1 + margen%) × (1 + impuesto%)     41,470 = 97.75 %
 *
 * ⛔ **El tercer factor es el que faltaba.** `analytics.v_kepler_unit_ladder.pv_base_cuadra`
 * prueba la fórmula SIN impuesto y por eso declara que la ficha no cuadra en el **79.3 %** de las
 * filas: es un falso positivo masivo que hace ver roto un catálogo sano. Acá se prueba con el
 * impuesto y el mismo universo cuadra al **97.75 %**. (Verificado en los dos regímenes: `70001`
 * IEPS 8 % → 66.52 × 1.19707 × 1.08 = 86.00 = `c90`; `17023` IVA 16 % → 43.97 × 1.25 × 1.16 =
 * 63.76 = `c90`.)
 *
 * Es también el costo que el POS congela en el renglón de venta (`kdm2.c62`).
 *
 * ── Contra qué se lo contrasta ─────────────────────────────────────────────────────────
 *
 * El testigo es `kepler_ods.kdik.c16` = el costo del ERP por sucursal, con el **anti-réplica**
 * que `kdik` exige: `sucursal = btrim(c1)` (la suc 03 arrastra cabeceras del almacén 02 de La
 * Piedad, congeladas el 2026-01-07 — publicarlas sería doble conteo). Es **la misma regla, literal,
 * que `analytics.v_kepler_unit_cost`**, el primitivo con el que se valúa el inventario publicado.
 *
 * ⚠️ **Se lee `kdik` directo y NO se consume `v_kepler_unit_cost`, con motivo medido.** Ese
 * primitivo hace `JOIN commercial.warehouses` + `JOIN catalog.products`, o sea que **sólo existe
 * para los SKUs que nuestro catálogo ya mapeó**. Consumirlo dejaba **57,782 de 86,638 filas
 * (66.69 %) `sin_testigo`** — dos tercios del catálogo de Kepler sin contraste, justo lo que esta
 * pantalla existe para auditar. La diferencia no está en la regla sino en el ALCANCE: acá el
 * universo es el catálogo del ERP, no el nuestro.
 * ⭐ Para que las dos no puedan divergir igual, el candado `test-newdb-standard-cost` exige que
 * **donde las dos tienen fila, el costo coincida** — si alguien toca una regla, se pone rojo.
 *
 * ⚠️ **Qué es el testigo, con precisión (medido 2026-09-29).** `c16` es un **promedio ponderado
 * de las entradas acumuladas**: contra `c8/c5`, sobre los 33,089 pares con el anti-réplica puesto,
 * coincide en **61.06 %** con mediana de la razón **1.0000**. Sobre el subconjunto que SÍ compró
 * desde jun-2026 (9,814 pares) coincide con la **última compra** en **72.41 %** — no porque sea un
 * costo de reposición, sino porque el promedio **converge** a la última compra cuando el precio es
 * estable. `c18` (último costo) coincide con la última compra en 21.50 % y **falta** en buena parte.
 *
 * ⛔ **Retractación, para que nadie la reconstruya:** en el primer borrador de esta fase escribí que
 * el *"20.2 % coincide con la última compra"* de `ERP_KEPLER.md` §2.1 **describía a `c18`**, porque
 * mi 21.50 % se le parecía. Es falso: el 20.2 % se midió sobre otra VENTANA (90 d), no sobre otra
 * columna. *Una medición sobre otro universo es otra afirmación, no una corrección de la primera.*
 * Por eso acá `costo_reposicion` es sólo el NOMBRE de la columna en la respuesta, y lo que la vista
 * afirma es la comparación, nunca que `c16` sea el costo de reponer hoy.
 *
 * ── ⛔ La trampa que obliga a la columna `peldano_reposicion` ───────────────────────────
 *
 * **`c16` NO siempre está en el mismo peldaño que `c77`.** Medido, 36,640 pares:
 * base 95.83 % · unidad dos 0.60 % · unidad tres 0.07 % · **no cae en ninguno 3.50 %**.
 * Restar sin resolver el peldaño produce desviaciones de 10× y 20× que parecen rezago de costo
 * y son un cambio de unidad — la trampa de ADR-055/057 otra vez.
 *
 * Y no es teórico: sobre el inventario publicado, **71 celdas valúan $1,776,847 donde su costo
 * estándar dice $161,625** (razón mediana 10.53×), más 4 celdas en unidad tres ($32,601) y 498
 * sin resolver ($888,718) — **~$2.54 M en disputa** de $55.8 M.
 *
 * Por eso `desviacion_pct` es **NULL cuando el peldaño no resuelve**, con el motivo en
 * `veredicto = 'no_comparable'`. No se elige un peldaño por descarte: se declara (ADR-056).
 *
 * ⚠️ La banda del peldaño es ±25 % relativo y **no puede confundir dos peldaños** porque los
 * factores están lejos (mediana `f2` = 10). El candado `test-newdb-standard-cost` trae la
 * prueba negativa: ninguna fila puede caer en dos peldaños a la vez.
 *
 * ── El umbral de `al_dia` no es inventado ──────────────────────────────────────────────
 *
 * Es **un centavo**: la resolución con la que Kepler guarda el costo. Con esa banda, de 27,495
 * pares comparables → `al_dia` 70.36 % · `estandar_bajo` 5,847 · `estandar_alto` 2,302.
 * `estandar_bajo` es el que cuesta dinero: subdeclara el COGS e infla el margen publicado.
 *
 * ── El reparto medido contra prod (86,638 filas) ───────────────────────────────────────
 *
 *     sin_operacion  52,606  60.72 %   la ficha existe en las 9 plazas aunque el producto no
 *     al_dia         22,218  25.64 %   opere ahi -- no es un hueco, es el maestro replicado
 *     estandar_bajo   6,960   8.03 %   +$233,205 de COGS subdeclarado en 30 d
 *     estandar_alto   3,016   3.48 %   -$159,541
 *     no_comparable     939   1.08 %   el peldano no resuelve -> se DECLARA, no se resta
 *     sin_estandar      475   0.55 %
 *     sin_testigo       424   0.49 %   vendio y el ERP no le tiene costo: el hueco REAL
 *
 * ⚠️ **Estos $73,664 netos NO son los $983,862 de la brecha documento-vs-kardex.** Son dos
 * preguntas distintas contra testigos distintos: acá es *el costo de la ficha contra el costo
 * de reposicion del ERP*; allá es *el costo que el documento de venta congelo contra el que el
 * kardex (`kdij.c13`) cobro por el mismo renglon*. No se suman ni se sustituyen.
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('analytics.v_kepler_unit_ladder') IS NOT NULL
        AND to_regclass('analytics.v_kepler_unit_cost')   IS NOT NULL
        AND to_regclass('kepler_ods.kdik')                IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  faltan v_kepler_unit_ladder / v_kepler_unit_cost / kdik - vista omitida');
    return;
  }
  const [{ hay_act }] = (await knex.raw(`
    SELECT to_regclass('analytics.mv_kepler_standard_cost_activity') IS NOT NULL AS hay_act`)).rows;
  if (!hay_act) throw new Error('[CE.1] falta analytics.mv_kepler_standard_cost_activity ([CE.0])');

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_standard_cost
      WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT e.sucursal, e.sku,
             e.u1_label, e.u2_label, e.u3_label,
             e.f2_cap, e.f3_cap,
             e.costo1, e.costo2, e.costo3,
             e.margen1, e.pv1
        FROM analytics.v_kepler_unit_ladder e
    ), erp AS (
      -- sucursal = btrim(c1) es el anti-replica, identico al de analytics.v_kepler_unit_cost.
      -- El max() es el mismo desempate de ese primitivo y no deberia agrupar mas de una fila:
      -- el candado lo verifica.
      SELECT k.sucursal, btrim(k.c2) AS sku,
             NULLIF(max(k.c16)::numeric, 0) AS costo_reposicion,
             max(k.c18)       AS ultimo_costo,
             max(k.c17)::date AS ultimo_costo_al
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
             e.costo_reposicion, NULLIF(e.ultimo_costo, 0) AS ultimo_costo, e.ultimo_costo_al,
             a.impuesto_pct, a.impuesto_tasas_distintas, a.renglones AS impuesto_renglones,
             a.unidades_base AS unidades_base_30d,
             a.venta_bruta   AS venta_bruta_30d,
             a.venta_neta    AS venta_neta_30d,
             a.ventana_hasta AS actividad_al
        FROM ficha f
        LEFT JOIN nom n ON n.sku = f.sku
        LEFT JOIN erp e ON e.sucursal = f.sucursal AND e.sku = f.sku
        LEFT JOIN analytics.mv_kepler_standard_cost_activity a
               ON a.sucursal = f.sucursal AND a.sku = f.sku
    ), peld AS (
      SELECT b.*,
             CASE
               WHEN b.costo_estandar IS NULL OR b.costo_reposicion IS NULL THEN NULL
               WHEN abs(b.costo_reposicion / b.costo_estandar - 1) <= 0.25
                 THEN 'base'
               WHEN b.factor_dos > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_dos - 1) <= 0.25
                 THEN 'unidad_dos'
               WHEN b.factor_tres > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_tres - 1) <= 0.25
                 THEN 'unidad_tres'
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
             WHEN n.impuesto_pct IS NULL THEN NULL   -- sin venta no se pudo medir el impuesto
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
             WHEN n.costo_estandar IS NULL                    THEN 'sin_estandar'
             -- la ficha existe en las 9 sucursales AUNQUE el producto no opere en esa plaza:
             -- 52,606 de 86,638 filas. Separarlo de sin_testigo es lo que deja ver el hueco
             -- REAL (424 filas que SI vendieron y el ERP no les tiene costo).
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                 THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                  THEN 'sin_testigo'
             WHEN n.peldano_reposicion = 'no_resuelto'        THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar  THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           -- el dinero SOLO cuando las dos magnitudes estan en la unidad base
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d
      FROM norm n`);

  await knex.raw(`GRANT SELECT ON analytics.v_kepler_standard_cost TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_kepler_standard_cost IS
    $$[CE.1] Costo estandar de Kepler (kdii.c77, el que fija el precio: PV = costo x (1+margen) x
    (1+impuesto), cuadra 97.75%) contrastado contra el costo del ERP por sucursal
    (v_kepler_unit_cost, con anti-replica). peldano_reposicion resuelve en que unidad viene el
    testigo -- 4.17% NO cae en ningun peldano y ahi desviacion_pct es NULL y el veredicto es
    no_comparable, NUNCA 0. al_dia = diferencia <= 1 centavo (la resolucion de almacenamiento).
    impuesto_pct se OBSERVA en el renglon de venta (no esta en kdii) y es NULL sin venta.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_standard_cost`);
};
