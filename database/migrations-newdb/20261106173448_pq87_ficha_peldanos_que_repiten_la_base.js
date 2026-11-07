'use strict';
/**
 * `[PQ.87]` Una ficha de Kepler cuyos peldaños REPITEN la base es una unidad única (factor 1),
 * no «rótulo sin factor ni costo».
 *
 * El caso (2026-11-06, Morelia Abastos): la OC 0000346 de Lico salió con el ROLLO MINI GUAYABA
 * (15151) a $0.76 el paquete; en Kepler cuesta $30.45. La ficha de Kepler lo tiene así en las
 * nueve sucursales:
 *
 *     Base PAQ $30.45 · Unidad Dos PAQ ×1 $30.45 · Unidad Tres PAQ ×1 $30.45
 *
 * Es un producto que se compra por paquete, sin caja. Esta vista lo declaraba
 * `rotulo_sin_factor_ni_costo` (factor NULL) porque los peldaños tienen rótulo; con eso
 * `v_warehouse_box_factor` caía al `factor_sale` del catálogo (40, ya marcado sospechoso), la
 * mesa pedía «cajas de 40» y el envío dividía el costo de Kepler (que es por paquete) entre 40.
 *
 * Regla nueva, sólo cuando ningún peldaño tiene factor efectivo (> 1): si cada peldaño superior
 * está vacío o repite la base —mismo rótulo, factor ≤ 1 y costo vacío o igual al de la base
 * (±1 %)— y al menos uno tiene rótulo, el producto es `unidad_unica` con factor 1. Un peldaño con
 * OTRO rótulo y factor 1 (PAQ / CJA ×1) sigue siendo ignorancia: no se afirma nada.
 * La gemela en TS es `factorFichaKepler` (ficha-kepler.ts), con la misma regla y sus negativas.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-06) ────────────────────────────────────────
 *  · Control: el cuerpo vigente corrido como subconsulta = la vista, EXCEPT ALL 0 y 0 filas.
 *  · 86,144 filas antes y después. Cambian 2,503 filas (279 SKU): rotulo_sin_factor_ni_costo
 *    → unidad_unica, factor NULL → 1. Ninguna otra fila cambia.
 *  · En mv_warehouse_box_factor (almacenes Kepler) eso cambia de valor 523 celdas (60 productos):
 *    342 de `factor_sale`, 180 de `override` y 1 de `kepler_peldano_vendido`, todas de >1 a 1.
 *    Otras 1,962 celdas ya valían 1 y sólo cambian de fuente.
 *  · Testigo independiente (el costo PAGADO, `rung_bf_esperado` del plan): en las celdas que
 *    cambian y tienen veredicto, 142 están marcadas `x2_deflactada` con divisor esperado mediana
 *    1.00 (140 de 142 entre 0.85 y 1.18). Ninguna marcada `ok` con la caja vieja. 87 sin compras
 *    que arbitrar.
 *
 * No cambia columnas: `CREATE OR REPLACE` conserva permisos y dependientes. Sólo DDL de una
 * vista; la caja de la mesa cambia cuando se refresquen `mv_warehouse_box_factor` y el plan.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const NUEVA = `
 WITH src AS (
         SELECT btrim(k.sucursal) AS sucursal,
            btrim(k.c1) AS sku,
            NULLIF(upper(btrim(k.c11)), ''::text) AS u1_label,
            NULLIF(upper(btrim(k.c80)), ''::text) AS u2_label,
            NULLIF(upper(btrim(k.c83)), ''::text) AS u3_label,
            NULLIF(regexp_replace(k.c81::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f2_cap,
            NULLIF(regexp_replace(k.c84::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f3_cap,
            NULLIF(regexp_replace(k.c77, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo1,
            NULLIF(regexp_replace(k.c78::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo2,
            NULLIF(regexp_replace(k.c79::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo3,
            NULLIF(regexp_replace(k.c87::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen1,
            NULLIF(regexp_replace(k.c88::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen2,
            NULLIF(regexp_replace(k.c89::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen3,
            NULLIF(regexp_replace(k.c90::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv1,
            NULLIF(regexp_replace(k.c91::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv2,
            NULLIF(regexp_replace(k.c92::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv3
           FROM kepler_ods.kdii k
          WHERE btrim(COALESCE(k.c1, ''::text)) <> ''::text
        ), d AS (
         SELECT src.sucursal,
            src.sku,
            src.u1_label,
            src.u2_label,
            src.u3_label,
            src.f2_cap,
            src.f3_cap,
            src.costo1,
            src.costo2,
            src.costo3,
            src.margen1,
            src.margen2,
            src.margen3,
            src.pv1,
            src.pv2,
            src.pv3,
                CASE
                    WHEN src.costo1 > 0::numeric AND src.costo2 > 0::numeric THEN src.costo2 / src.costo1
                    ELSE NULL::numeric
                END AS f2_costo,
                CASE
                    WHEN src.costo1 > 0::numeric AND src.costo3 > 0::numeric THEN src.costo3 / src.costo1
                    ELSE NULL::numeric
                END AS f3_costo,
                CASE
                    WHEN src.f2_cap > 1::numeric THEN src.f2_cap
                    WHEN src.costo1 > 0::numeric AND src.costo2 > 0::numeric AND (src.costo2 / src.costo1) > 1::numeric THEN round(src.costo2 / src.costo1)
                    ELSE NULL::numeric
                END AS f2_eff,
                CASE
                    WHEN src.f3_cap > 1::numeric THEN src.f3_cap
                    WHEN src.costo1 > 0::numeric AND src.costo3 > 0::numeric AND (src.costo3 / src.costo1) > 1::numeric THEN round(src.costo3 / src.costo1)
                    ELSE NULL::numeric
                END AS f3_eff
           FROM src
        ), e AS (
         SELECT d.sucursal,
            d.sku,
            d.u1_label,
            d.u2_label,
            d.u3_label,
            d.f2_cap,
            d.f3_cap,
            d.costo1,
            d.costo2,
            d.costo3,
            d.margen1,
            d.margen2,
            d.margen3,
            d.pv1,
            d.pv2,
            d.pv3,
            d.f2_costo,
            d.f3_costo,
            d.f2_eff,
            d.f3_eff,
                CASE
                    WHEN d.f3_eff IS NOT NULL AND d.f3_eff >= COALESCE(d.f2_eff, 0::numeric) THEN 3
                    WHEN d.f2_eff IS NOT NULL THEN 2
                    ELSE 1
                END AS peldano_caja
           FROM d
        )
 SELECT sucursal,
    sku,
    u1_label,
    u2_label,
    u3_label,
    f2_cap,
    f3_cap,
    round(f2_costo, 4) AS f2_costo,
    round(f3_costo, 4) AS f3_costo,
    costo1,
    costo2,
    costo3,
    margen1,
    margen2,
    margen3,
    pv1,
    pv2,
    pv3,
    peldano_caja,
        CASE peldano_caja
            WHEN 3 THEN u3_label
            WHEN 2 THEN u2_label
            ELSE u1_label
        END AS unidad_caja,
        CASE peldano_caja
            WHEN 3 THEN f3_cap
            WHEN 2 THEN f2_cap
            ELSE 1::numeric
        END AS factor_capturado,
        CASE peldano_caja
            WHEN 3 THEN round(f3_costo, 4)
            WHEN 2 THEN round(f2_costo, 4)
            ELSE 1::numeric
        END AS factor_del_costo,
        CASE
            WHEN peldano_caja = 3 THEN f3_eff
            WHEN peldano_caja = 2 THEN f2_eff
            WHEN u2_label IS NULL AND u3_label IS NULL THEN 1::numeric
            WHEN peldano_caja = 1 AND costo1 > 0::numeric AND (u2_label IS NOT NULL OR u3_label IS NOT NULL) AND (u2_label IS NULL OR (u2_label = u1_label AND COALESCE(f2_cap, 0::numeric) <= 1::numeric AND (COALESCE(costo2, 0::numeric) = 0::numeric OR abs(costo2 - costo1) <= 0.01 * costo1))) AND (u3_label IS NULL OR (u3_label = u1_label AND COALESCE(f3_cap, 0::numeric) <= 1::numeric AND (COALESCE(costo3, 0::numeric) = 0::numeric OR abs(costo3 - costo1) <= 0.01 * costo1))) THEN 1::numeric
            ELSE NULL::numeric
        END AS factor_caja,
        CASE
            WHEN peldano_caja = 3 AND f3_cap > 1::numeric AND f3_costo > 1::numeric AND round(f3_cap) <> round(f3_costo) THEN 'capturado_contradice_al_costo'::text
            WHEN peldano_caja = 3 AND f3_cap > 1::numeric THEN 'capturado'::text
            WHEN peldano_caja = 3 THEN 'derivado_del_costo'::text
            WHEN peldano_caja = 2 AND f2_cap > 1::numeric AND f2_costo > 1::numeric AND round(f2_cap) <> round(f2_costo) THEN 'capturado_contradice_al_costo'::text
            WHEN peldano_caja = 2 AND f2_cap > 1::numeric THEN 'capturado'::text
            WHEN peldano_caja = 2 THEN 'derivado_del_costo'::text
            WHEN u2_label IS NULL AND u3_label IS NULL AND COALESCE(costo2, 0::numeric) = 0::numeric AND COALESCE(costo3, 0::numeric) = 0::numeric THEN 'unidad_unica'::text
            WHEN peldano_caja = 1 AND costo1 > 0::numeric AND (u2_label IS NOT NULL OR u3_label IS NOT NULL) AND (u2_label IS NULL OR (u2_label = u1_label AND COALESCE(f2_cap, 0::numeric) <= 1::numeric AND (COALESCE(costo2, 0::numeric) = 0::numeric OR abs(costo2 - costo1) <= 0.01 * costo1))) AND (u3_label IS NULL OR (u3_label = u1_label AND COALESCE(f3_cap, 0::numeric) <= 1::numeric AND (COALESCE(costo3, 0::numeric) = 0::numeric OR abs(costo3 - costo1) <= 0.01 * costo1))) THEN 'unidad_unica'::text
            WHEN u2_label IS NULL AND u3_label IS NULL THEN 'unidad_unica_con_costo_superior'::text
            ELSE 'rotulo_sin_factor_ni_costo'::text
        END AS factor_source,
        CASE
            WHEN costo1 > 0::numeric AND pv1 > 0::numeric AND margen1 IS NOT NULL THEN abs(costo1 * (1::numeric + margen1 / 100::numeric) - pv1) <= 0.02
            ELSE NULL::boolean
        END AS pv_base_cuadra
   FROM e`;

// La definición tal cual estaba en prod el 2026-11-06 (pg_get_viewdef): la usa el down.
const PREVIA = `
 WITH src AS (
         SELECT btrim(k.sucursal) AS sucursal,
            btrim(k.c1) AS sku,
            NULLIF(upper(btrim(k.c11)), ''::text) AS u1_label,
            NULLIF(upper(btrim(k.c80)), ''::text) AS u2_label,
            NULLIF(upper(btrim(k.c83)), ''::text) AS u3_label,
            NULLIF(regexp_replace(k.c81::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f2_cap,
            NULLIF(regexp_replace(k.c84::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS f3_cap,
            NULLIF(regexp_replace(k.c77, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo1,
            NULLIF(regexp_replace(k.c78::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo2,
            NULLIF(regexp_replace(k.c79::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS costo3,
            NULLIF(regexp_replace(k.c87::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen1,
            NULLIF(regexp_replace(k.c88::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen2,
            NULLIF(regexp_replace(k.c89::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS margen3,
            NULLIF(regexp_replace(k.c90::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv1,
            NULLIF(regexp_replace(k.c91::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv2,
            NULLIF(regexp_replace(k.c92::text, '[^0-9.]'::text, ''::text, 'g'::text), ''::text)::numeric AS pv3
           FROM kepler_ods.kdii k
          WHERE btrim(COALESCE(k.c1, ''::text)) <> ''::text
        ), d AS (
         SELECT src.sucursal,
            src.sku,
            src.u1_label,
            src.u2_label,
            src.u3_label,
            src.f2_cap,
            src.f3_cap,
            src.costo1,
            src.costo2,
            src.costo3,
            src.margen1,
            src.margen2,
            src.margen3,
            src.pv1,
            src.pv2,
            src.pv3,
                CASE
                    WHEN src.costo1 > 0::numeric AND src.costo2 > 0::numeric THEN src.costo2 / src.costo1
                    ELSE NULL::numeric
                END AS f2_costo,
                CASE
                    WHEN src.costo1 > 0::numeric AND src.costo3 > 0::numeric THEN src.costo3 / src.costo1
                    ELSE NULL::numeric
                END AS f3_costo,
                CASE
                    WHEN src.f2_cap > 1::numeric THEN src.f2_cap
                    WHEN src.costo1 > 0::numeric AND src.costo2 > 0::numeric AND (src.costo2 / src.costo1) > 1::numeric THEN round(src.costo2 / src.costo1)
                    ELSE NULL::numeric
                END AS f2_eff,
                CASE
                    WHEN src.f3_cap > 1::numeric THEN src.f3_cap
                    WHEN src.costo1 > 0::numeric AND src.costo3 > 0::numeric AND (src.costo3 / src.costo1) > 1::numeric THEN round(src.costo3 / src.costo1)
                    ELSE NULL::numeric
                END AS f3_eff
           FROM src
        ), e AS (
         SELECT d.sucursal,
            d.sku,
            d.u1_label,
            d.u2_label,
            d.u3_label,
            d.f2_cap,
            d.f3_cap,
            d.costo1,
            d.costo2,
            d.costo3,
            d.margen1,
            d.margen2,
            d.margen3,
            d.pv1,
            d.pv2,
            d.pv3,
            d.f2_costo,
            d.f3_costo,
            d.f2_eff,
            d.f3_eff,
                CASE
                    WHEN d.f3_eff IS NOT NULL AND d.f3_eff >= COALESCE(d.f2_eff, 0::numeric) THEN 3
                    WHEN d.f2_eff IS NOT NULL THEN 2
                    ELSE 1
                END AS peldano_caja
           FROM d
        )
 SELECT sucursal,
    sku,
    u1_label,
    u2_label,
    u3_label,
    f2_cap,
    f3_cap,
    round(f2_costo, 4) AS f2_costo,
    round(f3_costo, 4) AS f3_costo,
    costo1,
    costo2,
    costo3,
    margen1,
    margen2,
    margen3,
    pv1,
    pv2,
    pv3,
    peldano_caja,
        CASE peldano_caja
            WHEN 3 THEN u3_label
            WHEN 2 THEN u2_label
            ELSE u1_label
        END AS unidad_caja,
        CASE peldano_caja
            WHEN 3 THEN f3_cap
            WHEN 2 THEN f2_cap
            ELSE 1::numeric
        END AS factor_capturado,
        CASE peldano_caja
            WHEN 3 THEN round(f3_costo, 4)
            WHEN 2 THEN round(f2_costo, 4)
            ELSE 1::numeric
        END AS factor_del_costo,
        CASE
            WHEN peldano_caja = 3 THEN f3_eff
            WHEN peldano_caja = 2 THEN f2_eff
            WHEN u2_label IS NULL AND u3_label IS NULL THEN 1::numeric
            ELSE NULL::numeric
        END AS factor_caja,
        CASE
            WHEN peldano_caja = 3 AND f3_cap > 1::numeric AND f3_costo > 1::numeric AND round(f3_cap) <> round(f3_costo) THEN 'capturado_contradice_al_costo'::text
            WHEN peldano_caja = 3 AND f3_cap > 1::numeric THEN 'capturado'::text
            WHEN peldano_caja = 3 THEN 'derivado_del_costo'::text
            WHEN peldano_caja = 2 AND f2_cap > 1::numeric AND f2_costo > 1::numeric AND round(f2_cap) <> round(f2_costo) THEN 'capturado_contradice_al_costo'::text
            WHEN peldano_caja = 2 AND f2_cap > 1::numeric THEN 'capturado'::text
            WHEN peldano_caja = 2 THEN 'derivado_del_costo'::text
            WHEN u2_label IS NULL AND u3_label IS NULL AND COALESCE(costo2, 0::numeric) = 0::numeric AND COALESCE(costo3, 0::numeric) = 0::numeric THEN 'unidad_unica'::text
            WHEN u2_label IS NULL AND u3_label IS NULL THEN 'unidad_unica_con_costo_superior'::text
            ELSE 'rotulo_sin_factor_ni_costo'::text
        END AS factor_source,
        CASE
            WHEN costo1 > 0::numeric AND pv1 > 0::numeric AND margen1 IS NOT NULL THEN abs(costo1 * (1::numeric + margen1 / 100::numeric) - pv1) <= 0.02
            ELSE NULL::boolean
        END AS pv_base_cuadra
   FROM e`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_kepler_unit_ladder AS ${NUEVA}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_kepler_unit_ladder AS ${PREVIA}`);
};
