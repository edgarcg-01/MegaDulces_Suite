'use strict';
/**
 * `[VEC.21]` — **La venta a CRÉDITO de la ruta, con su cobro y la cuenta donde entró el dinero.**
 *
 * Edgar, 2026-10-15: *"se llama telemarketing pero son ventas a crédito que después… hay que
 * agregarlas aquí y cazarlas con su depósito, para conciliar el depósito, la factura y las ventas"*.
 *
 * ⛔ `U-D-8` se publicaba como *"venta de otro canal"* y se dejaba FUERA del total de la ruta,
 * esperando una decisión de negocio. **La decisión ya estaba tomada en el ERP y nadie la había
 * mirado:** Kepler lo registra como **CARGO EN CARTERA** — `UD0801` *"Factura Telemarketing"*,
 * 4,457 documentos y $30,345,234.05 en 2026, con cliente, vencimiento, saldo y estatus.
 *
 * ── La cadena, verificada salto por salto ───────────────────────────────────────────────────
 *
 *     kdm1 U-D-8            la ruta factura a crédito
 *       └─ kdue UD0801 (C)  cartera: vencimiento y estatus
 *            └─ kdm5        la APLICACIÓN: liga el abono con la factura que salda
 *                 └─ erp_collections   el cobro, con su MEDIO y su CUENTA DE TESORERÍA
 *
 * Medido ago→oct en las rutas vecinales: **39 facturas, $306,686.88** y **$128,053.43 sin
 * cobrar**, que hoy no se ven en ninguna pantalla. `2V004` no tiene un solo cobro aplicado.
 *
 * ── ⛔ Por qué NO lee `analytics.erp_receivable_documents`, que es el primitivo ──────────────
 *
 * No es por prolijidad: **cuesta 850–1,030 ms venga como venga**, y el plan dice por qué — su CTE
 * `src` materializa las **60,737 filas de TODA la cartera** antes de poder filtrar, así que el
 * predicado no se empuja. No se arregla con un índice; es la forma de la vista.
 *
 * Ésta lee `kdue`/`kdm5` **acotada al universo de RUTA** (decenas de documentos, no la cartera
 * entera) y mide **430–461 ms**. ⚠️ El riesgo de re-derivar es real, y por eso el candado
 * `test-newdb-route-credit-sales.js` **compara fila por fila contra el primitivo** y exige
 * igualdad: si alguien cambia allá la lista de doctypes de abono, acá se pone rojo.
 *
 * ── ⭐ Ese cruce ya pagó ANTES de que la vista existiera ────────────────────────────────────
 *
 * El prototipo sumaba TODAS las aplicaciones de `kdm5` y daba saldo **negativo** (−$377.11 en el
 * folio `0000547`): metía el tipo de abono **`65`**, que la canónica excluye de su lista. *Un
 * saldo negativo en una venta a crédito es imposible*, y sin el cruce salía publicado.
 *
 * ⛔ **Segunda trampa: el folio NO es único entre doctypes.** `kdm5` apunta a la factura con
 * `c8`/`c9`/`c10`, y filtrar sólo `c8`/`c9` metía aplicaciones de `UD1201` ($286.64 medidos). Más
 * grave: unir `erp_collections` sólo por `(sucursal, folio)` **multiplica filas** —el folio se
 * repite entre `doc_prefix`— e inflaba lo cobrado. Las dos llaves van completas.
 *
 * ⚠️ `col` va `AS MATERIALIZED` a propósito: sin eso el planner correlaciona `erp_collections`
 * por renglón y la vista pasa de **451 ms a 7,426 ms**.
 *
 * ⛔ `U-D-12` queda FUERA y eso no cambia: en estas rutas es espejo (98.2 % de solape, placebo 0,
 * y el arqueo lo ignora). Lo que entra acá es el crédito de verdad.
 *
 * Idempotente (`CREATE OR REPLACE`).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_credit_sales AS
    WITH fac AS (
      SELECT btrim(h.sucursal) AS wh, btrim(h.c12) AS route_no, btrim(h.c6) AS folio,
             h.c9::date AS fecha, h.c16 AS importe,
             COALESCE(h.c14,0::numeric) AS iva, COALESCE(h.c15,0::numeric) AS ieps,
             NULLIF(btrim(COALESCE(h.c10,'')),'') AS cliente_code,
             NULLIF(btrim(COALESCE(v.c3,'')),'') AS route_name
        FROM kepler_ods.kdm1 h
        LEFT JOIN kepler_ods.kduv v
          ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2)=btrim(h.c12)
       WHERE h.c2='U' AND h.c3='D' AND h.c4::integer=8
         AND btrim(COALESCE(h.c12,'')) ~ '^[0-9]V[0-9]'
         AND btrim(COALESCE(h.c1,''))=btrim(h.sucursal)
         AND COALESCE(NULLIF(btrim(h.c43),''),'')<>'C'
         AND h.c9::date <= (now() AT TIME ZONE 'America/Mexico_City')::date),
    car AS (
      -- El cargo en cartera. DISTINCT ON porque kdue puede traer el mismo documento más de una
      -- vez; se toma el más viejo, que es el que lo originó.
      SELECT DISTINCT ON (btrim(e.c1), btrim(e.c6))
             btrim(e.c1) AS wh, btrim(e.c6) AS folio,
             e.c10::date AS vence, NULLIF(btrim(e.c16),'') AS estatus
        FROM kepler_ods.kdue e JOIN fac f ON btrim(e.c1)=f.wh AND btrim(e.c6)=f.folio
       WHERE e.c29='C' AND btrim(e.c4::text)='8'
       ORDER BY btrim(e.c1), btrim(e.c6), e.c7),
    abo AS (
      -- ⛔ La llave de la FACTURA en kdm5 son c8+c9+c10, las tres. Sin c10 entran abonos de
      --    UD1201 por colisión de folio. Y la lista de tipos es la MISMA que usa el primitivo.
      SELECT btrim(m.c1) AS wh, btrim(m.c11) AS folio, btrim(m.c6) AS cobro_folio,
             btrim(m.c4::text) AS abono_tipo,
             ('UA'||lpad(btrim(m.c4::text),2,'0')||lpad(btrim(m.c5::text),2,'0')) AS cobro_prefix,
             round(sum(m.c13),2) AS monto
        FROM kepler_ods.kdm5 m
        JOIN fac f ON btrim(m.c1)=f.wh AND btrim(m.c11)=f.folio
       WHERE m.c2='U' AND btrim(m.c8)='D'
         AND btrim(m.c9::text)='8' AND btrim(m.c10::text)='1'
         AND btrim(m.c4::text) IN ('5','7','21','25','30','35','40')
       GROUP BY 1,2,3,4,5),
    col AS MATERIALIZED (
      -- ⚠️ MATERIALIZED o la vista pasa de 451 ms a 7,426 ms.
      SELECT c.sucursal, btrim(c.folio) AS folio, c.doc_prefix,
             c.medio_cobro, c.cuenta_tesoreria, c.cobro_date
        FROM analytics.erp_collections c
       WHERE (c.sucursal, btrim(c.folio), c.doc_prefix)
             IN (SELECT wh, cobro_folio, cobro_prefix FROM abo)),
    apl AS (
      SELECT a.wh, a.folio, round(sum(a.monto),2) AS cobrado, count(*)::int AS n_abonos,
             jsonb_agg(jsonb_build_object(
               'folio', a.cobro_folio, 'monto', a.monto, 'tipo', a.abono_tipo,
               'medio', c.medio_cobro, 'cuenta', c.cuenta_tesoreria,
               'fecha', c.cobro_date::text) ORDER BY a.cobro_folio) AS cobros
        FROM abo a
        LEFT JOIN col c
          ON c.sucursal=a.wh AND c.folio=a.cobro_folio AND c.doc_prefix=a.cobro_prefix
       GROUP BY 1,2)
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           f.wh AS warehouse_code, f.route_no, f.route_name,
           'WIN-'||f.route_no AS route_code,
           f.folio, f.fecha, car.vence, f.cliente_code,
           f.importe, f.iva, f.ieps, (f.importe - f.iva - f.ieps) AS neto,
           COALESCE(apl.cobrado, 0::numeric) AS cobrado,
           round(f.importe - COALESCE(apl.cobrado,0),2) AS saldo,
           COALESCE(apl.n_abonos,0) AS n_abonos, apl.cobros, car.estatus,
           -- ⚠️ 'sin_vencimiento' es un estado PROPIO: no se mezcla con 'vigente'. Sin fecha de
           --    vencimiento no se puede decir si está al día — es otra ausencia (ADR-056).
           CASE WHEN round(f.importe - COALESCE(apl.cobrado,0),2) <= 0.02 THEN 'cobrada'
                WHEN car.vence IS NULL THEN 'sin_vencimiento'
                WHEN car.vence < (now() AT TIME ZONE 'America/Mexico_City')::date THEN 'vencida'
                ELSE 'vigente' END AS cobranza,
           CASE WHEN car.vence IS NULL THEN NULL
                ELSE ((now() AT TIME ZONE 'America/Mexico_City')::date - car.vence) END AS dias_vencida
      FROM fac f
      LEFT JOIN car ON car.wh=f.wh AND car.folio=f.folio
      LEFT JOIN apl ON apl.wh=f.wh AND apl.folio=f.folio`);

  // ⚠️ ADR-057: `security_invoker` y los GRANT NO se dan por heredados.
  await knex.raw(`ALTER VIEW analytics.v_route_credit_sales SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_credit_sales TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_credit_sales TO dev_ro`);
  await knex.raw(`
    COMMENT ON VIEW analytics.v_route_credit_sales IS
      '[VEC.21] Venta a credito de las rutas (U-D-8 = UD0801 Factura Telemarketing) con su cargo en cartera, su cobro aplicado via kdm5 y la cuenta de tesoreria donde entro el dinero. U-D-12 queda fuera: en estas rutas es espejo.'`);
};

/** La vista es nueva y nadie deriva de ella todavía: deshacerla es tirarla. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_credit_sales`);
};
