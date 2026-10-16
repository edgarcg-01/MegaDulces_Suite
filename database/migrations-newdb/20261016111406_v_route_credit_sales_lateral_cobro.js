/* eslint-disable no-console */
/**
 * `[VEC.28]` — **4,093 ms → 171 ms: dejar de unir un CTE con otro CTE.**
 *
 * Cierra el agujero de rendimiento que abrió `[VEC.26]` y que `[VEC.27]` redujo a la mitad sin
 * resolver. El plan de `EXPLAIN (ANALYZE)` señaló dos nodos y los dos son el mismo error:
 *
 *     CTE Scan on col c ....... (actual rows=305.70 loops=41789)   <- 12.8 M toques
 *     Unique (el CTE car) ..... (actual rows=304.19 loops=140)     <- recomputado 140 veces
 *
 * ⭐ **La lección: un CTE no tiene índices ni estadísticas.** Unir dos CTEs deja al planner con
 * estimaciones de adivinanza, y elige bucle anidado sobre una relación que no puede sondear. No
 * era `erp_collections` el problema de fondo —aunque `[VEC.27]` la midió bien en 96 %—: era la
 * FORMA de unir. Por eso aquel arreglo bajó de 6,627 a 2,343 ms y ahí se quedó.
 *
 * ── Qué cambia ──────────────────────────────────────────────────────────────────────────────
 *   1. El CTE `col` DESAPARECE. La cuenta del cobro se resuelve con `LEFT JOIN LATERAL` dentro
 *      de la misma pasada que agrega los abonos: una búsqueda por índice por abono (351 hoy),
 *      en vez de una relación aparte que después hay que cruzar.
 *   2. `car`, `cta` y `apl` pasan a `MATERIALIZED` explícito, para que cada uno se calcule UNA
 *      vez. `car` se estaba recomputando por cada fila de salida.
 *
 * Medido en prod, la consulta que hace la pantalla (45 días):
 *
 *     [VEC.26] ...... 4,348 / 6,627 ms
 *     [VEC.27] ...... 2,236 / 2,784 ms
 *     ésta ..........   169 /   171 / 209 ms      ✔ bajo la regla de 500 ms
 *
 * ⛔ La corrección de `[VEC.26]` queda INTACTA: el saldo sigue saliendo de la fórmula del
 * árbitro (`GREATEST(0, cargo - aplicado)`), `sobre_aplicado` sigue declarando los 3 documentos
 * con aplicaciones superseded, y los tipos siguen saliendo de `v_kepler_sale_doc_class`.
 *
 * ⚠️ La deuda con nombre de `[VEC.27]` SIGUE ABIERTA y no la cierra esta migración: la
 * resolución de cuenta duplica la de `analytics.erp_collections`. El arreglo de fondo es
 * factorizarla a su propia vista y que ambas lean ESA.
 */
'use strict';

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const TIPOS_ABONO = "ARRAY['5','7','21','25','30','35','40']";

const VISTA = `
  CREATE OR REPLACE VIEW analytics.v_route_credit_sales AS
  WITH fac AS MATERIALIZED (
    SELECT btrim(h.sucursal) AS wh,
           btrim(h.c12)      AS route_no,
           btrim(h.c6)       AS folio,
           (h.c4)::int       AS dt,
           (h.c5)::int       AS sub,
           k.doc_code,
           k.nombre          AS doc_nombre,
           h.c9::date        AS fecha,
           h.c16             AS importe,
           COALESCE(h.c14, 0::numeric) AS iva,
           COALESCE(h.c15, 0::numeric) AS ieps,
           NULLIF(btrim(COALESCE(h.c10, '')), '') AS cliente_code,
           NULLIF(btrim(COALESCE(v.c3, '')), '')  AS route_name
      FROM kepler_ods.kdm1 h
      -- El tipo se PREGUNTA, no se enumera. Ver [VEC.25].
      JOIN analytics.v_kepler_sale_doc_class k
        ON k.doc_code = 'UD' || lpad((h.c4)::int::text, 2, '0') || lpad((h.c5)::int::text, 2, '0')
       AND k.clase = 'credito'
      LEFT JOIN kepler_ods.kduv v
        ON btrim(v.sucursal) = btrim(h.sucursal) AND btrim(v.c2) = btrim(h.c12)
     WHERE h.c2 = 'U' AND h.c3 = 'D'
       AND btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]'
       AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
       AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
       AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date
  ),
  -- El CARGO en el libro. MATERIALIZED: sin eso se recalculaba por cada fila de salida.
  car AS MATERIALIZED (
    SELECT DISTINCT ON (btrim(e.c1), (e.c4)::int, btrim(e.c6))
           btrim(e.c1)   AS wh,
           (e.c4)::int   AS dt,
           btrim(e.c6)   AS folio,
           e.c10::date   AS vence,
           NULLIF(btrim(e.c16), '') AS estatus,
           round(e.c11, 2) AS cargo
      FROM kepler_ods.kdue e
      JOIN fac f ON btrim(e.c1) = f.wh AND (e.c4)::int = f.dt AND btrim(e.c6) = f.folio
     WHERE e.c29 = 'C'
     ORDER BY btrim(e.c1), (e.c4)::int, btrim(e.c6), e.c7
  ),
  -- Catálogo de cuentas de tesorería: 212 filas.
  cta AS MATERIALIZED (
    SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS clave, btrim(k.c2) AS nombre,
           CASE WHEN btrim(k.c5) NOT LIKE '102%' THEN 'puente'
                WHEN upper(btrim(COALESCE(k.c3, ''))) = 'EFECTIVO' THEN 'caja'
                ELSE 'banco' END AS tipo
      FROM kepler_ods.kdb1 k
     WHERE btrim(COALESCE(k.c1, '')) <> ''
     ORDER BY btrim(k.c1), k.sucursal
  ),
  /**
   * Los abonos CON su cuenta, en una sola pasada. El LATERAL hace una búsqueda por índice por
   * abono contra el documento de cobro; antes esto era un CTE aparte que había que cruzar, y el
   * planner lo recorría 41,789 veces.
   */
  abo AS MATERIALIZED (
    SELECT btrim(m.c1)  AS wh,
           (m.c9)::int  AS dt,
           (m.c10)::int AS sub,
           btrim(m.c11) AS folio,
           btrim(m.c6)  AS cobro_folio,
           btrim((m.c4)::text) AS abono_tipo,
           round(sum(m.c13), 2) AS monto,
           max(cob.cobro_date)  AS cobro_date,
           max(cob.medio)       AS medio_cobro,
           max(cob.cuenta)      AS cuenta_tesoreria
      FROM kepler_ods.kdm5 m
      JOIN fac f ON btrim(m.c1) = f.wh AND btrim(m.c11) = f.folio
                AND (m.c9)::int = f.dt AND (m.c10)::int = f.sub
      LEFT JOIN LATERAL (
        SELECT mm.c9::date AS cobro_date,
               CASE WHEN btrim(COALESCE(mm.c45, '')) = '' THEN 'sin_declarar'
                    ELSE COALESCE(b.tipo, 'no_resuelve') END AS medio,
               b.nombre AS cuenta
          FROM kepler_ods.kdm1 mm
          LEFT JOIN cta b ON b.clave = btrim(mm.c45)
         WHERE btrim(mm.sucursal) = btrim(m.c1) AND btrim(mm.c6) = btrim(m.c6)
           AND (mm.c4)::int = (m.c4)::int AND (mm.c5)::int = (m.c5)::int
           AND mm.c2 = 'U' AND mm.c3 = 'A'
           AND btrim(COALESCE(mm.c43, '')) <> 'C'
         LIMIT 1
      ) cob ON true
     WHERE m.c2 = 'U' AND btrim(m.c8) = 'D'
       AND btrim((m.c4)::text) = ANY (${TIPOS_ABONO})
     GROUP BY 1,2,3,4,5,6
  ),
  apl AS MATERIALIZED (
    SELECT a.wh, a.dt, a.sub, a.folio,
           round(sum(a.monto), 2) AS aplicado,
           count(*)::integer      AS n_abonos,
           jsonb_agg(jsonb_build_object(
             'folio', a.cobro_folio, 'monto', a.monto, 'tipo', a.abono_tipo,
             'medio', a.medio_cobro, 'cuenta', a.cuenta_tesoreria,
             'fecha', a.cobro_date::text) ORDER BY a.cobro_folio) AS cobros
      FROM abo a
     GROUP BY a.wh, a.dt, a.sub, a.folio
  )
  SELECT '${TENANT}'::uuid AS tenant_id,
         f.wh              AS warehouse_code,
         f.route_no,
         f.route_name,
         'WIN-' || f.route_no AS route_code,
         f.folio,
         f.fecha,
         car.vence,
         f.cliente_code,
         f.importe,
         f.iva,
         f.ieps,
         f.importe - f.iva - f.ieps AS neto,
         round(f.importe - round(GREATEST(0::numeric,
               COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)), 2), 2) AS cobrado,
         round(GREATEST(0::numeric,
               COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)), 2) AS saldo,
         COALESCE(apl.n_abonos, 0) AS n_abonos,
         apl.cobros,
         car.estatus,
         CASE
           WHEN round(GREATEST(0::numeric,
                COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)), 2) <= 0.02
             THEN 'cobrada'
           WHEN car.vence IS NULL THEN 'sin_vencimiento'
           WHEN car.vence < (now() AT TIME ZONE 'America/Mexico_City')::date THEN 'vencida'
           ELSE 'vigente'
         END AS cobranza,
         CASE
           WHEN car.vence IS NULL THEN NULL::integer
           ELSE (now() AT TIME ZONE 'America/Mexico_City')::date - car.vence
         END AS dias_vencida,
         f.doc_code,
         f.doc_nombre,
         -- ⛔ Lo que el GREATEST esconde, se declara. Ver [VEC.26].
         (COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)) < -0.02 AS sobre_aplicado
    FROM fac f
    LEFT JOIN car ON car.wh = f.wh AND car.dt = f.dt AND car.folio = f.folio
    LEFT JOIN apl ON apl.wh = f.wh AND apl.dt = f.dt AND apl.sub = f.sub AND apl.folio = f.folio`;

exports.up = async function up(knex) {
  await knex.raw(VISTA);
  await knex.raw('GRANT SELECT ON analytics.v_route_credit_sales TO PUBLIC');
};

/** `down` NO-OP: volver atrás devolvería la pantalla de 4 segundos. */
exports.down = async function down() {};
