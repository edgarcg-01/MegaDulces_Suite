'use strict';
/**
 * `[PQ.157]` C0 — **El costo de cada renglón de la aplicación `X-A-20`, contra el de su OC**, derivado
 * (`derive-no-copy`, regla 1 / ADR-056): `commercial.v_application_line_cost`, un renglón por renglón de
 * aplicación viva (sin CL005), encadenado a su OC por la orden de entrada (`X-A-40`) y el vale (`X-A-37`).
 * Es la base de «validar el costo al aplicar» (anexo R §3c y §3d): qué renglones llegaron a un costo
 * distinto del pedido, cuánto, y en qué escala.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_RECEPCION_EN_KEPLER.md` §3d y §9 (`[PQ.157]`).
 *
 * ── La cadena (medida: el 100 % de los renglones de aplicación viene así) ────────────────────────
 *  aplicación `kdm2.c20..c23` → orden de entrada → su `c20..c23` → vale → su `c20..c23` → OC. El vale
 *  sin OC (`c20 = 0`) queda `sin_oc`: no hay precio pedido contra el cual validar (su referencia será
 *  la lista de precios del proveedor, `[PQ.155]`).
 *
 * ── La escala (el rótulo `c11` miente, anexo R §3b.5) ───────────────────────────────────────────
 *  Una OC escrita en `CJA` se aplica con el precio de la PIEZA y el mismo rótulo. Si el cociente de
 *  precios cae entre 0.5× y 2× es la misma escala; si no, el factor sale de la ficha de ESA sucursal
 *  (`kdii.c81`, `kdii.c84` y `c84/c81`), el candidato más cercano dentro de la misma banda. Si ningún
 *  factor de la ficha casa → `otra_escala_sin_factor`; si dos casan casi igual → `otra_escala_ambigua`.
 *  Nunca se adivina un entero: redondear el cociente haría circular el veredicto de «sube» o «baja».
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-25) ──
 *  · 60 días: 11,908 renglones de aplicación; 9,534 llegan a una OC ($85.2 M) y 2,374 salen de un vale
 *    sin OC ($22.2 M).
 *  · Corte de «igual»: entre 1 centavo y 0.5 % hay 67 renglones con $2,296 en 60 días; arriba del 0.5 %
 *    empieza lo que pesa (0.5–3 %: 225 renglones, $52 mil; 3–10 %: 745, $771 mil).
 *  · Escala: 1,240 renglones con el cociente fuera de 0.5–2×. Con los factores de la ficha casan 1,236,
 *    ninguno ambiguo; ⭐ testigo independiente: en 1,074 (87 %) la CANTIDAD también cambió por ese mismo
 *    factor (la cantidad no se usa para elegirlo). Ya escalados: 755 iguales, 231 suben y 250 bajan —
 *    $385 mil de cambio de costo que tratarlos como «otra escala» habría escondido.
 *  · Resultado (60 d): igual 7,847 · sube 1,029 (+$1.17 M) · baja 651 (−$511 mil) · sin_oc 2,374 ·
 *    otra_escala_sin_factor 6 · sin_precio 1. Distinto de la OC: 17.6 % de los renglones comparables.
 *  · Control con respuesta conocida: la vista y una versión en JS que lee `kdm2`/`kdii` por su cuenta
 *    dan el MISMO estado en 11,908 de 11,908 renglones. Cero duplicados.
 *  · Costo: 60 días 1.5 s; una aplicación 0.01 s; un proveedor en 120 días 0.05 s; entera 0.8 s.
 *    No hace falta matvista.
 *
 * Sólo DDL de una vista (sin datos, sin re-login). Idempotente (`CREATE OR REPLACE VIEW`).
 *
 * @param { import("knex").Knex } knex
 */

/** Igual = a 1 centavo o menos, o a 0.5 % o menos (medido arriba). */
const TOL = 0.005;
const CENTAVO = 0.01;
/** La misma escala: el cociente de precios dentro de 0.5–2×; la misma banda decide qué factor de la ficha casa. */
const BANDA = 2;
/** Ambiguo: el segundo factor queda a menos del doble de distancia (log) que el primero, y el primero no es exacto. */
const AMBIGUO = 2;
const EXACTO = 0.005;

const VISTA = 'commercial.v_application_line_cost';
/** La compuerta pide el ODS de prod; con menos aplicaciones es una base de pruebas y se declara. */
const APLICACIONES_DE_PROD = 5000;
/** Piso de renglones comparables en 60 días (medido 9,527) y techo de no clasificables (medido 7 de 11,908). */
const PISO_COMPARABLES = 5000;
const TECHO_NO_CLASIFICABLES = 0.01;

const ESTADOS = ['igual', 'sube', 'baja', 'sin_oc', 'sin_precio', 'otra_escala_sin_factor', 'otra_escala_ambigua'];

const SELECT_SQL = `
WITH r AS (
  SELECT h.sucursal, h.c1 AS almacen, h.c5 AS subtipo, h.c6 AS folio, a.c7 AS renglon,
         h.c9::date AS fecha_aplicacion, NULLIF(btrim(h.c67), '') AS capturado_por, btrim(h.c10) AS proveedor_code,
         btrim(a.c8) AS sku, btrim(a.c11) AS unidad, a.c9::numeric AS cantidad,
         a.c12 AS precio_aplicacion, a.c13 AS importe_aplicacion,
         oe.c5 AS oe_subtipo, oe.c6 AS oe_folio, oe.c12 AS precio_orden_entrada,
         v.c5 AS vale_subtipo, v.c6 AS vale_folio,
         oc.c5 AS oc_subtipo, oc.c6 AS oc_folio, oc.c7 AS oc_renglon, oc.c12 AS precio_oc,
         (btrim(coalesce(och.c67, '')) = 'SUITE') AS oc_de_la_suite,
         fi.c81 AS f2, fi.c84 AS f3
    FROM kepler_ods.kdm1 h
    JOIN kepler_ods.kdm2 a ON a.sucursal = h.sucursal AND a.c1 = h.c1 AND a.c2 = 'X' AND a.c3 = 'A' AND a.c4 = 20
                          AND a.c5 = h.c5 AND a.c6 = h.c6
    LEFT JOIN kepler_ods.kdm2 oe ON oe.sucursal = a.sucursal AND oe.c1 = a.c1 AND oe.c2 = 'X' AND oe.c3 = 'A' AND oe.c4 = 40
                                AND a.c20 = 40 AND oe.c5 = a.c21 AND oe.c6 = a.c22 AND oe.c7 = a.c23
    LEFT JOIN kepler_ods.kdm2 v ON v.sucursal = oe.sucursal AND v.c1 = oe.c1 AND v.c2 = 'X' AND v.c3 = 'A' AND v.c4 = 37
                               AND oe.c20 = 37 AND v.c5 = oe.c21 AND v.c6 = oe.c22 AND v.c7 = oe.c23
    LEFT JOIN kepler_ods.kdm2 oc ON oc.sucursal = v.sucursal AND oc.c1 = v.c1 AND oc.c2 = 'X' AND oc.c3 = 'A' AND oc.c4 = 35
                                AND v.c20 = 35 AND oc.c5 = v.c21 AND oc.c6 = v.c22 AND oc.c7 = v.c23
    LEFT JOIN kepler_ods.kdm1 och ON och.sucursal = oc.sucursal AND och.c1 = oc.c1 AND och.c2 = 'X' AND och.c3 = 'A'
                                 AND och.c4 = 35 AND och.c5 = oc.c5 AND och.c6 = oc.c6
    LEFT JOIN kepler_ods.kdii fi ON btrim(fi.sucursal) = a.sucursal AND btrim(fi.c1) = btrim(a.c8)
   WHERE h.c2 = 'X' AND h.c3 = 'A' AND h.c4 = 20 AND btrim(h.c1) = h.sucursal
     AND btrim(coalesce(h.c43, '')) <> 'C' AND btrim(h.c10) <> 'CL005'
),
-- El cociente es siempre ≥ 1 (el precio mayor entre el menor); «oc_mayor» dice de qué lado está la unidad grande.
e AS (
  SELECT r.*, (precio_oc > precio_aplicacion) AS oc_mayor,
         CASE WHEN precio_oc > 0 AND precio_aplicacion > 0
              THEN greatest(precio_oc, precio_aplicacion) / least(precio_oc, precio_aplicacion) END AS cociente
    FROM r
),
-- Fuera de la banda: los factores de la ficha que caen en ella, el más cercano (log) y la distancia del segundo.
k AS (
  SELECT e.*, c.k1, c.d1, c.d2
    FROM e
    LEFT JOIN LATERAL (
      SELECT (array_agg(x.k ORDER BY x.d))[1] AS k1, (array_agg(x.d ORDER BY x.d))[1] AS d1, (array_agg(x.d ORDER BY x.d))[2] AS d2
        FROM (SELECT DISTINCT kk AS k, abs(ln(e.cociente / kk)) AS d
                FROM unnest(ARRAY[e.f2, e.f3, e.f3 / NULLIF(e.f2, 0)]) AS u(kk)
               WHERE kk > 1.0001 AND e.cociente / kk > ${1 / BANDA} AND e.cociente / kk < ${BANDA}) x
    ) c ON e.cociente >= ${BANDA}
),
s AS (
  SELECT k.*,
         CASE WHEN cociente IS NULL THEN NULL
              WHEN cociente < ${BANDA} THEN 1::numeric
              WHEN k1 IS NULL OR (d2 IS NOT NULL AND d2 < ${AMBIGUO} * d1 AND d1 > ${EXACTO}) THEN NULL
              ELSE k1 END AS factor
    FROM k
)
SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
       s.sucursal, s.almacen, s.subtipo, s.folio, s.renglon, s.fecha_aplicacion, s.capturado_por, s.proveedor_code,
       s.sku, s.unidad, s.cantidad, s.precio_aplicacion, s.importe_aplicacion, s.precio_orden_entrada,
       s.oe_subtipo, s.oe_folio, s.vale_subtipo, s.vale_folio, s.oc_subtipo, s.oc_folio, s.oc_renglon, s.oc_de_la_suite,
       s.precio_oc,
       CASE WHEN s.cociente IS NULL THEN NULL WHEN s.cociente < ${BANDA} THEN 'misma'
            WHEN s.oc_mayor THEN 'oc_en_unidad_mayor' ELSE 'aplicacion_en_unidad_mayor' END AS escala,
       s.factor AS factor_escala,
       round(x.peq, 6) AS precio_oc_equivalente,
       x.estado_costo,
       CASE WHEN x.estado_costo IN ('igual', 'sube', 'baja') THEN round((s.precio_aplicacion / x.peq - 1) * 100, 2) END AS variacion_pct,
       CASE WHEN x.estado_costo IN ('sube', 'baja') THEN round(s.cantidad * (s.precio_aplicacion - x.peq), 2) END AS pesos_vs_oc
  FROM s
  CROSS JOIN LATERAL (
    SELECT p.peq, CASE
             WHEN s.precio_oc IS NULL THEN 'sin_oc'
             WHEN s.cociente IS NULL THEN 'sin_precio'
             WHEN s.factor IS NULL AND s.k1 IS NOT NULL THEN 'otra_escala_ambigua'
             WHEN s.factor IS NULL THEN 'otra_escala_sin_factor'
             WHEN abs(s.precio_aplicacion - p.peq) <= ${CENTAVO} OR abs(s.precio_aplicacion / p.peq - 1) <= ${TOL} THEN 'igual'
             WHEN s.precio_aplicacion > p.peq THEN 'sube'
             ELSE 'baja' END AS estado_costo
      FROM (SELECT CASE WHEN s.factor IS NULL THEN NULL WHEN s.factor = 1 THEN s.precio_oc
                        WHEN s.oc_mayor THEN s.precio_oc / s.factor ELSE s.precio_oc * s.factor END AS peq) p
  ) x`;

exports.SELECT_SQL = SELECT_SQL;
exports.VISTA = VISTA;
exports.ESTADOS = ESTADOS;
exports.TOL = TOL;
exports.CENTAVO = CENTAVO;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    $$[PQ.157] Cada renglon de la aplicacion X-A-20 viva (sin CL005) contra el de su OC, por la orden de entrada y el vale.
    precio_oc_equivalente = el precio de la OC llevado a la unidad de la aplicacion (factor de la ficha kdii si la escala difiere:
    el rotulo c11 miente). estado_costo: igual (<= 1 centavo o <= 0.5 %) | sube | baja | sin_oc (vale sin OC) | sin_precio |
    otra_escala_sin_factor | otra_escala_ambigua. pesos_vs_oc = cantidad x (precio aplicado - precio_oc_equivalente).
    derive-no-copy sobre kepler_ods. Filtrar por fecha_aplicacion, proveedor o folio: 60 dias ~1.5 s.$$`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON ${VISTA} TO dev_ro; END IF; END $$`);

  // Compuerta: con el ODS de prod, la vista tiene que clasificar casi todo y traer los comparables de siempre.
  // Un join roto de la cadena deja todo en `sin_oc`; uno de la ficha, todo lo escalado sin factor.
  const [{ aps }] = (await knex.raw(`SELECT count(*)::int AS aps FROM kepler_ods.kdm1 WHERE c2 = 'X' AND c3 = 'A' AND c4 = 20`)).rows;
  if (aps < APLICACIONES_DE_PROD) {
    console.log(`  · [PQ.157] NO MEDIDO: ${aps} aplicaciones en el ODS de esta base; la compuerta se exige con las de prod`);
    return;
  }
  const [m] = (await knex.raw(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE estado_costo IN ('igual', 'sube', 'baja'))::int AS comparables,
           count(*) FILTER (WHERE estado_costo IN ('sin_precio', 'otra_escala_sin_factor', 'otra_escala_ambigua'))::int AS no_clasificables,
           count(*) FILTER (WHERE escala IN ('oc_en_unidad_mayor', 'aplicacion_en_unidad_mayor') AND estado_costo IN ('igual', 'sube', 'baja'))::int AS escalados
      FROM ${VISTA} WHERE fecha_aplicacion >= current_date - 60`)).rows;
  if (!(m.comparables >= PISO_COMPARABLES) || m.no_clasificables > TECHO_NO_CLASIFICABLES * m.n || !(m.escalados > 0)) {
    throw new Error(`[PQ.157] ${VISTA} (60 d): ${m.n} renglones, ${m.comparables} comparables (piso ${PISO_COMPARABLES}), ` +
      `${m.no_clasificables} no clasificables (techo ${TECHO_NO_CLASIFICABLES * 100} %), ${m.escalados} escalados con la ficha (medido: 9,527 · 7 · 1,236).`);
  }
  console.log(`  ✓ [PQ.157] ${VISTA} (60 d): ${m.n} renglones · ${m.comparables} comparables · ${m.escalados} escalados con la ficha · ${m.no_clasificables} no clasificables`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada depende de ella todavía. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
