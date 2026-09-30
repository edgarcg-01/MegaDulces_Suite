'use strict';
/**
 * `[CE.8]` — **La banda del peldaño estaba inventada, y escondía $280,813 de deriva REAL.**
 *
 * `[CE.1]` clasificaba el peldaño del testigo con una banda de **±25 % alrededor de 1**, elegida
 * a ojo. Investigando el hueco que la propia fase declaró, la banda resultó ser el problema:
 *
 * ```text
 * los 939 'no_resuelto', desglosados por razon = c16 / c77
 *   a · c16 < 0.5x el estandar ....  208 celdas   mediana 0.001   $21,550 de venta 30 d
 *   b · 0.5x .. 0.8x .............   119          mediana 0.680   $18,604
 *   d · 1.25x .. 2x .............. * 494 *        mediana 1.334   $280,813   <-- deriva NORMAL
 *   e · 2x .. 5x .................    75          mediana 2.748   $20,863
 *   f · mas de 5x ................    43          mediana 15.304  $12,772
 * ```
 *
 * ⛔ **La clase `d` es deriva de costo, no un problema de unidad.** Un costo que subió 33 % no es
 * un cambio de peldaño; mi banda lo empujaba a `no_comparable`, donde la vista se NIEGA a publicar
 * desviación. O sea: **declaraba "no se puede medir" algo que sí se podía**, que es la falla
 * simétrica de dibujar un cero (ADR-056). Y no es marginal: **494 celdas con $280,813 de venta.**
 *
 * ── La banda nueva NO es inventada: sale de medir el factor ────────────────────────────
 *
 * Un peldaño sólo puede estar POR ENCIMA del base (el base es el más chico). Y medido sobre
 * `kdii` de la suc 01, 6,518 pares con `f2 > 1`:
 *
 * ```text
 *   f2 minimo ...... 2.00      pares con f2 < 2 ...... 0
 *   f2 p05 ......... 6.00      pares con f2 < 3 ...... 48
 *   f2 mediana ..... 18.00
 * ```
 *
 * **No existe ningún factor menor a 2**, así que **una razón < 2 no puede ser un peldaño**: es el
 * base, con la deriva que tenga. Ésa es la banda, y es una medición, no un gusto.
 *
 * ⚠️ Límite declarado: 48 SKUs tienen `f2 = 2`, y ahí una razón de 1.9 es ambigua entre "deriva
 * del 90 %" y "peldaño de 2 con 5 % de deriva". Se resuelve como base y se declara acá.
 *
 * ── Y un estado nuevo, porque el testigo a veces está VACÍO, no bajo ────────────────────
 *
 * La clase `a` no es "el costo bajó": es que **`kdik.c16` está vacío**. Medido sobre las 207
 * celdas con razón < 0.5: **120 tienen `c16` por debajo de UN PESO** y **91 por debajo de un
 * centavo** (mínimo `0.000004`), contra un costo de ficha con mediana **$38.90**. Publicar eso
 * como "el estándar está 99.9 % alto" sería inventar una conclusión sobre un testigo que no
 * existe. Va a `testigo_inverosimil`, sin desviación y sin impacto — igual que `no_comparable`.
 *
 * ── ⚠️ Lo que este cambio NO arregla, y hay que dejar dicho ─────────────────────────────
 *
 * `[CE]` afirmó que la causa raíz del desalineamiento de peldaño era que **la unidad base se
 * contradice entre compra y venta**. Medido: la contradicción **existe pero es chica y explica
 * poco**. De 382 pares donde el rótulo de la entrada difiere del de la ficha:
 *
 * ```text
 *   A · SOLO el rotulo difiere (razon ~1.000) ....  210 pares / 136 SKUs   <-- 55 %, NO es unidad
 *   B · unidad real distinta = f2 ................   55 pares /  33 SKUs
 *   C · unidad real distinta = f3 ................    8 pares /   7 SKUs
 *   E · sin explicar .............................  109 pares /  75 SKUs
 * ```
 *
 * O sea la contradicción REAL son **63 pares / 40 SKUs**, no el catálogo — y cruzada contra las
 * celdas rotas explica **19.1 %** de `unidad_dos` (33 de 173) y 23.8 % de `unidad_tres` (5 de 21).
 * El resto **no es que esté sin explicar: es que no se puede medir** — 123 de esas 173 celdas
 * **no tienen ninguna entrada en 180 días**, así que no hay con qué juzgarlas.
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_kepler_standard_cost') IS NOT NULL AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  no existe analytics.v_kepler_standard_cost - [CE.8] omitido');
    return;
  }

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
               -- el testigo esta VACIO, no bajo: 120 de 207 por debajo de UN PESO contra una
               -- ficha de mediana $38.90, y 91 por debajo de un centavo. No es deriva.
               WHEN b.costo_reposicion / b.costo_estandar < 0.5 THEN 'testigo_inverosimil'
               -- medido: no existe ningun f2 < 2 (minimo 2.00, p05 6.00, mediana 18.00), asi que
               -- una razon < 2 NO puede ser un peldano. Es el base, con la deriva que tenga.
               WHEN b.costo_reposicion / b.costo_estandar < 2 THEN 'base'
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
             WHEN n.costo_estandar IS NULL                    THEN 'sin_estandar'
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                 THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                  THEN 'sin_testigo'
             -- dos maneras distintas de no poder comparar, y se distinguen a proposito:
             -- el testigo esta VACIO / el testigo esta en una unidad que no se resuelve.
             WHEN n.peldano_reposicion = 'testigo_inverosimil' THEN 'testigo_inverosimil'
             WHEN n.peldano_reposicion = 'no_resuelto'        THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar  THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d
      FROM norm n`);

  // `CREATE OR REPLACE VIEW` NO conserva ni el grant ni las reloptions de forma confiable:
  // se re-aplican siempre, y el candado verifica las dos cosas.
  await knex.raw(`ALTER VIEW analytics.v_kepler_standard_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_standard_cost TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_kepler_standard_cost IS
    $$[CE.8] Costo estandar de Kepler (kdii.c77, el que fija el precio) contra el costo del ERP
    por sucursal (kdik.c16, anti-replica sucursal=btrim(c1), identico a v_kepler_unit_cost).
    El peldano se resuelve con una banda MEDIDA: no existe ningun f2 < 2 (minimo 2.00 sobre 6,518
    pares), asi que razon < 2 es el peldano base con su deriva. razon < 0.5 es testigo_inverosimil
    (120 de 207 con c16 < $1 contra fichas de mediana $38.90): el testigo esta VACIO, no bajo.
    Lo no comparable NUNCA publica desviacion ni impacto. impuesto_pct se OBSERVA en el renglon de
    venta y es NULL sin venta.$$`);
};

exports.down = async function down(knex) {
  // El rollback deja la vista como la dejo [CE.1]; se re-aplica esa migracion si hace falta.
  // eslint-disable-next-line no-console
  console.log('  [CE.8] down: re-aplicar 20260929160100 para volver a la banda anterior');
};
