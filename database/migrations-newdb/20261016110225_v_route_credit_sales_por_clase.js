/* eslint-disable no-console */
/**
 * `[VEC.26]` — **La venta a crédito deja de preguntar «¿es el tipo 8?» y pregunta «¿es crédito?»**
 *
 * Segunda mitad de `[VEC.25]`. Aquella puso la definición en un solo lugar; ésta hace que el
 * consumidor la LEA, que es lo que convierte la definición en sistema.
 *
 * ── Qué cambia ──────────────────────────────────────────────────────────────────────────────
 *
 *   ANTES:  c4::integer = 8   escrito en fac, en car y en abo (tres CTEs, tres copias)
 *   AHORA:  JOIN analytics.v_kepler_sale_doc_class ... AND clase = 'credito'
 *
 * Medido en prod al aplicarla, rutas vecinales, todo el histórico:
 *
 *   UD0801 'Factura Telemarketing' ...  61 docs ...   $429,680.65   <- lo único que se veía
 *   UD1301 'Factura Cred No Fiscal' .. 340 docs ... $3,245,522.84   <- NUEVO
 *
 * ⛔ Y **una ruta entera**: `1V006 «RUTA VECINAL MORELIA ABASTOS»`, $721,860.44, que nunca emitió
 * un ticket de caja y por eso no existía para ninguna pantalla.
 *
 * ── ⭐⭐ El defecto de fondo que apareció al generalizar: el SALDO no se recalcula ───────────
 *
 * Al cruzar contra el árbitro (`analytics.erp_receivable_documents`, ADR-059) la versión vieja
 * daba **$20,673.48 de menos** en `UD1301`. Localizado a TRES folios, y el patrón es inequívoco
 * — folio `0006567`, sucursal `00`, factura de **$10,771.08** con TRES aplicaciones en `kdm5`:
 *
 *     cobro 0027050 ... $10,771.08   (el total)
 *     cobro 0028490 ... $10,770.00   } la misma deuda, aplicada otra vez y partida
 *     cobro 0028491 ...      $1.08   }
 *
 * O sea que **`kdm5` conserva las aplicaciones superseded**, y sumarlas da un saldo NEGATIVO.
 * El árbitro no cae ahí porque usa `GREATEST(0, cargo - aplicado)`. Esta vista ahora usa **la
 * misma fórmula sobre las mismas entradas**, así que coincide por construcción y no por suerte:
 *
 *     UD1301 saldo $515,893.71 = $515,893.71 del árbitro  ✔
 *     UD0801 saldo $151,937.08 = $151,937.08 del árbitro  ✔
 *
 * ⚠️ Pero recortar en cero **esconde** la sobre-aplicación, y eso no se hace (ADR-056): sale la
 * columna `sobre_aplicado`, hoy `true` en 3 de 401 documentos. El número cuadra Y el problema se
 * declara.
 *
 * ⭐ `cobrado` se DERIVA como `importe - saldo` en vez de sumar el detalle, para que las tres
 * cifras de la pantalla cierren siempre entre sí. El detalle (`cobros`) sigue publicándose: sirve
 * para «¿dónde entró el dinero?», que es su pregunta, no para decidir cuánto se debe.
 *
 * ── Rendimiento ─────────────────────────────────────────────────────────────────────────────
 * Leer el árbitro directamente costaba **46 s** (arrastra catálogos de cliente). Replicar su
 * fórmula acotada a los folios de estas rutas: **332 / 352 / 364 ms** — por debajo de los 547 ms
 * de la vista anterior, que además ya estaba del lado malo de la regla de 500 ms.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` sólo deja AGREGAR columnas al final. Las 20 que había se conservan
 * en el mismo orden y con el mismo tipo; `doc_code`, `doc_nombre` y `sobre_aplicado` van después.
 */
'use strict';

const TENANT = '00000000-0000-0000-0000-00000000d01c';

/**
 * Los tipos de abono que el canónico considera aplicación. ⛔ La lista NO incluye el `65`: ya
 * costó un saldo negativo de −$377.11 en el prototipo de `[VEC.21]`, cazado justamente por el
 * cruce contra el árbitro.
 */
const TIPOS_ABONO = "ARRAY['5','7','21','25','30','35','40']";

const VISTA = `
  CREATE OR REPLACE VIEW analytics.v_route_credit_sales AS
  WITH fac AS (
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
  abo AS (
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
  col AS MATERIALIZED (
    SELECT c.sucursal, btrim(c.folio) AS folio, c.doc_prefix,
           c.medio_cobro, c.cuenta_tesoreria, c.cobro_date
      FROM analytics.erp_collections c
     WHERE (c.sucursal, btrim(c.folio), c.doc_prefix)
           IN (SELECT abo.wh, abo.cobro_folio, abo.cobro_prefix FROM abo)
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

/**
 * ⛔ `down` deliberadamente NO-OP. Volver atrás reintroduciría `c4 = 8` —o sea, esconder otra vez
 * $3,245,522.84— y además devolvería el saldo que el árbitro contradice. Si hubiera que revertir,
 * se hace con una migración nueva que diga por qué.
 */
exports.down = async function down() {};
