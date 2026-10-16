/* eslint-disable no-console */
/**
 * `[VEC.27]` — **La cuenta del cobro se resuelve ACOTADA: 3,558 ms → 175 ms.**
 *
 * ── El defecto, y es MÍO: lo introdujo `[VEC.26]` hace veinte minutos ───────────────────────
 * Al generalizar el crédito de 61 a 401 documentos, la consulta de la pantalla pasó de **547 ms
 * a 4,348–6,627 ms**. Correcto pero inusable: la regla dura del proyecto es >500 ms no funciona.
 *
 * Atribuido, no adivinado:
 *
 *     solo fac ............................   139 /   120 ms
 *     fac + abo ...........................   131 /   134 ms
 *     fac + abo + col (erp_collections) ... 3,844 / 3,558 ms   <- el 96 %
 *
 * Y el plan dice por qué: `CTE Scan on abo (rows=349 loops=28472)`. El `IN (SELECT ... FROM abo)`
 * recorría el CTE **una vez por cada fila** de `erp_collections`. Con 61 documentos el planner
 * elegía otra cosa y no dolía; con 401 son ~10 millones de comparaciones.
 *
 * ⛔ Y `analytics.erp_collections` **no se deja acotar**: tiene `DISTINCT ON` sobre todo el
 * universo, así que ni sondearla por llave sirve — una sola llave cuesta **78 ms**.
 *
 * ── Lo que se hace, y la deuda que deja CON NOMBRE ──────────────────────────────────────────
 * La cuenta de tesorería sale de `kdm1.c45` del documento de COBRO, y su nombre/tipo de `kdb1`
 * (212 filas). Esta vista lo resuelve así, acotado a las llaves de estas rutas.
 *
 * ⚠️ **Eso DUPLICA la lógica de cuenta de `erp_collections`, y hay que decirlo** — es
 * exactamente lo que `[VEC.25]` vino a combatir. Se acepta porque la alternativa medida es una
 * pantalla de 4 segundos, y se deja como **deuda con nombre** (ADR-056): el arreglo de fondo es
 * factorizar la resolución de cuenta a su propia vista y que `erp_collections` lea ESA, en vez de
 * que cada consumidor la reimplemente. No se hizo acá porque toca Fase CC, que no es mía hoy.
 *
 * ⭐ Probado por EQUIVALENCIA antes de mandarlo, sobre las 306 llaves reales:
 *
 *     filas 306 · solo_mio 0 · discrepan 0    (cuenta_tesoreria Y medio_cobro, idénticos)
 *     resolución acotada: 173 / 175 / 177 ms  (contra 3,558 ms)
 *
 * ⚠️ Una diferencia declarada: para `UA07xx` (CFDI con complemento de pago) `erp_collections`
 * prefiere `fecha_pago` del complemento y acá se usa la fecha del documento. Medido sobre 20,000
 * cobros: todos `UA05`, cero diferencias de fecha. Si aparecen `UA07`, la fecha del abono puede
 * quedar un día corrida — el monto y la cuenta no.
 *
 * `fac` y `abo` pasan a `MATERIALIZED` explícito: ya los referencian 3 y 2 veces, así que
 * Postgres los materializaba igual. Decirlo deja el plan estable en vez de a merced del conteo.
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
      -- ⭐ Acá vive el cambio: el tipo se pregunta, no se enumera.
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
  -- El CARGO en el libro: su vencimiento, su estatus y su importe. Se une por (sucursal, tipo,
  -- folio) y no sólo por folio: el folio NO es único entre tipos de documento.
  car AS (
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
  -- Las aplicaciones, por folio. Se une también por subtipo: kdm5 lo trae en c10.
  abo AS MATERIALIZED (
    SELECT btrim(m.c1)  AS wh,
           (m.c9)::int  AS dt,
           (m.c10)::int AS sub,
           btrim(m.c11) AS folio,
           btrim(m.c6)  AS cobro_folio,
           btrim((m.c4)::text) AS abono_tipo,
           'UA' || lpad(btrim((m.c4)::text), 2, '0') || lpad(btrim((m.c5)::text), 2, '0') AS cobro_prefix,
           round(sum(m.c13), 2) AS monto
      FROM kepler_ods.kdm5 m
      JOIN fac f ON btrim(m.c1) = f.wh AND btrim(m.c11) = f.folio
                AND (m.c9)::int = f.dt AND (m.c10)::int = f.sub
     WHERE m.c2 = 'U' AND btrim(m.c8) = 'D'
       AND btrim((m.c4)::text) = ANY (${TIPOS_ABONO})
     GROUP BY 1,2,3,4,5,6,7
  ),
  -- Las llaves de cobro que hay que resolver. 306 hoy: materializar es barato y
  -- deja que el join siguiente las hashee en vez de recorrerlas por cada fila ajena.
  llaves AS MATERIALIZED (
    SELECT DISTINCT wh, cobro_folio, cobro_prefix FROM abo
  ),
  -- El catalogo de cuentas de tesoreria. 212 filas.
  cta AS (
    SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS clave, btrim(k.c2) AS nombre,
           CASE WHEN btrim(k.c5) NOT LIKE '102%' THEN 'puente'
                WHEN upper(btrim(COALESCE(k.c3, ''))) = 'EFECTIVO' THEN 'caja'
                ELSE 'banco' END AS tipo
      FROM kepler_ods.kdb1 k
     WHERE btrim(COALESCE(k.c1, '')) <> ''
     ORDER BY btrim(k.c1), k.sucursal
  ),
  col AS MATERIALIZED (
    SELECT btrim(m.sucursal) AS sucursal,
           btrim(m.c6)       AS folio,
           'UA' || lpad((m.c4)::text, 2, '0') || lpad((m.c5)::text, 2, '0') AS doc_prefix,
           m.c9::date        AS cobro_date,
           CASE WHEN btrim(COALESCE(m.c45, '')) = '' THEN 'sin_declarar'
                ELSE COALESCE(b.tipo, 'no_resuelve') END AS medio_cobro,
           b.nombre          AS cuenta_tesoreria
      FROM kepler_ods.kdm1 m
      JOIN llaves l
        ON l.wh = btrim(m.sucursal) AND l.cobro_folio = btrim(m.c6)
       AND l.cobro_prefix = 'UA' || lpad((m.c4)::text, 2, '0') || lpad((m.c5)::text, 2, '0')
      LEFT JOIN cta b ON b.clave = btrim(m.c45)
     WHERE m.c2 = 'U' AND m.c3 = 'A' AND (m.c4)::int IN (5, 7)
       AND btrim(m.c1) = btrim(m.sucursal)
       AND btrim(COALESCE(m.c43, '')) <> 'C'
  ),
  apl AS (
    SELECT a.wh, a.dt, a.sub, a.folio,
           round(sum(a.monto), 2) AS aplicado,
           count(*)::integer      AS n_abonos,
           jsonb_agg(jsonb_build_object(
             'folio', a.cobro_folio, 'monto', a.monto, 'tipo', a.abono_tipo,
             'medio', c.medio_cobro, 'cuenta', c.cuenta_tesoreria,
             'fecha', c.cobro_date::text) ORDER BY a.cobro_folio) AS cobros
      FROM abo a
      LEFT JOIN col c ON c.sucursal = a.wh AND c.folio = a.cobro_folio AND c.doc_prefix = a.cobro_prefix
     GROUP BY a.wh, a.dt, a.sub, a.folio
  ),
  base AS (
    SELECT f.*, car.vence, car.estatus, car.cargo,
           COALESCE(apl.aplicado, 0::numeric) AS aplicado,
           COALESCE(apl.n_abonos, 0)          AS n_abonos,
           apl.cobros,
           -- La fórmula DEL ÁRBITRO, sobre las mismas entradas.
           round(GREATEST(0::numeric,
                 COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)), 2) AS saldo,
           -- ⛔ Lo que el GREATEST esconde, se declara.
           (COALESCE(car.cargo, f.importe) - COALESCE(apl.aplicado, 0::numeric)) < -0.02 AS sobre_aplicado
      FROM fac f
      LEFT JOIN car ON car.wh = f.wh AND car.dt = f.dt AND car.folio = f.folio
      LEFT JOIN apl ON apl.wh = f.wh AND apl.dt = f.dt AND apl.sub = f.sub AND apl.folio = f.folio
  )
  SELECT '${TENANT}'::uuid AS tenant_id,
         b.wh              AS warehouse_code,
         b.route_no,
         b.route_name,
         'WIN-' || b.route_no AS route_code,
         b.folio,
         b.fecha,
         b.vence,
         b.cliente_code,
         b.importe,
         b.iva,
         b.ieps,
         b.importe - b.iva - b.ieps AS neto,
         -- ⭐ Derivado, para que importe = cobrado + saldo cierre SIEMPRE en pantalla.
         round(b.importe - b.saldo, 2) AS cobrado,
         b.saldo,
         b.n_abonos,
         b.cobros,
         b.estatus,
         CASE
           WHEN b.saldo <= 0.02 THEN 'cobrada'
           WHEN b.vence IS NULL THEN 'sin_vencimiento'
           WHEN b.vence < (now() AT TIME ZONE 'America/Mexico_City')::date THEN 'vencida'
           ELSE 'vigente'
         END AS cobranza,
         CASE
           WHEN b.vence IS NULL THEN NULL::integer
           ELSE (now() AT TIME ZONE 'America/Mexico_City')::date - b.vence
         END AS dias_vencida,
         b.doc_code,
         b.doc_nombre,
         b.sobre_aplicado
    FROM base b`;


exports.up = async function up(knex) {
  await knex.raw(VISTA);
  await knex.raw('GRANT SELECT ON analytics.v_route_credit_sales TO PUBLIC');
};

/**  NO-OP: volver atras devolveria la pantalla de 4 segundos. */
exports.down = async function down() {};
