'use strict';
/**
 * `[PGP.67]` — **Un pago CANCELADO en Kepler no salda la deuda.**
 *
 * Visto por Edgar el 2026-11-04: el gasto `XA1001-0000168` de Canindo (luz de CFE, $11,799, de la
 * solicitud `XA1501-0000203` por transferencia) no aparecía para programarlo en
 * `/finanzas/calendario-pagos`, y Kepler lo muestra con saldo de $11,799. La causa: se aplicó con la
 * transferencia `XD2601-0000351`, que después se CANCELÓ (`kdm1.c43 = 'C'`), y **Kepler no borra la
 * aplicación de un pago cancelado** de `kdxf` (el mismo comportamiento que `[GX.75]` documentó para
 * `kdm5`). La vista restaba esa aplicación y daba el documento por pagado.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-04) ───────────────────────────────────────
 *  · 1,710 pagos cancelados (`X-D-25/26/60`); la mayoría se volvió a pagar con un pago vigente.
 *  · La vista escondía **22 documentos con deuda viva, $335,033** (gastos `XA10` y facturas de
 *    mercancía). Antes: 3,018 docs · $139,703,053. Después: 3,040 · $140,038,086.
 *  · Tiempo de la vista: 322–338 ms → 360–464 ms (el presupuesto de la lista de deuda es 500 ms).
 *
 * ── Por qué el cruce lleva al PROVEEDOR (y el folio sin `btrim`) ───────────────────────────
 *  ⛔ El folio de un pago colisiona entre documentos (ERP_KEPLER §3.z): en la sucursal 02 hay dos
 *  `X-D-25` folio 0000001, uno cancelado del proveedor `01` y uno vigente de `GN001`. Cruzar sólo por
 *  folio daba por no pagados 3 gastos de $750 de `GN001` que sí están pagados. Con
 *  `(sucursal, c1, proveedor, tipo, subtipo, folio)` —el índice de `kdxf`, columna por columna— el
 *  cruce es exacto y además usa el índice: las dos formas que lo omitían tardaban 0.8 s, 12 s y 25 s.
 *
 * ⛔ Mismas 17 columnas, mismo orden y tipo: `CREATE OR REPLACE` conserva los GRANT y las vistas que
 * dependen de ésta (`v_pago_sugerido`, la deuda del calendario, el estado de cuenta de acreedores).
 * `aplicado` pasa a ser lo aplicado por pagos VIGENTES, que es lo que el nombre siempre afirmó.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_payables AS
    WITH doc AS MATERIALIZED (
      SELECT kdxe.sucursal,
             btrim(kdxe.c2) AS proveedor,
             kdxe.c4 AS doc_tipo,
             kdxe.c5 AS doc_sub,
             btrim(kdxe.c6) AS folio,
             nullif(btrim(kdxe.c16), '') AS referencia,
             CASE WHEN kdxe.c7 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c7::date ELSE NULL::date END AS fecha,
             CASE WHEN kdxe.c10 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c10::date ELSE NULL::date END AS vencimiento,
             kdxe.c11 AS importe
        FROM kepler_ods.kdxe
       WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A'::text
    ), apl AS MATERIALIZED (
      SELECT kdxf.sucursal, kdxf.c7 AS t, kdxf.c8 AS s, btrim(kdxf.c9) AS f, sum(kdxf.c10) AS aplicado
        FROM kepler_ods.kdxf
       WHERE btrim(kdxf.c1) = kdxf.sucursal
       GROUP BY kdxf.sucursal, kdxf.c7, kdxf.c8, (btrim(kdxf.c9))
    ), canc AS MATERIALIZED (
      -- [PGP.67] Los pagos cancelados, con el proveedor (kdm1.c10): el folio solo colisiona.
      SELECT DISTINCT m.sucursal, m.c1, m.c10, m.c4, m.c5, m.c6
        FROM kepler_ods.kdm1 m
       WHERE m.c3 = 'D' AND m.c4 IN ('25', '26', '60') AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal
    ), aplc AS MATERIALIZED (
      -- [PGP.67] Lo que esos pagos cancelados siguen "aplicando" en kdxf: se resta.
      SELECT x.sucursal, x.c7 AS t, x.c8 AS s, btrim(x.c9) AS f, sum(x.c10) AS cancelado
        FROM canc
        JOIN kepler_ods.kdxf x
          ON x.sucursal = canc.sucursal AND x.c1 = canc.c1 AND x.c2 = canc.c10
         AND x.c4 = canc.c4 AND x.c5 = canc.c5 AND x.c6 = canc.c6
       GROUP BY 1, 2, 3, 4
    ), prov AS MATERIALIZED (
      SELECT DISTINCT ON ((btrim(kdxd.c2))) btrim(kdxd.c2) AS ck, kdxd.c3 AS nombre, kdxd.c13 AS grupo
        FROM kepler_ods.kdxd
       ORDER BY (btrim(kdxd.c2)), (kdxd.sucursal <> '00'::text), kdxd.sucursal
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           d.sucursal, d.proveedor, p.nombre AS proveedor_nombre, p.grupo,
           d.doc_tipo, d.doc_sub, d.folio, d.fecha, d.vencimiento, d.importe,
           COALESCE(a.aplicado, 0::numeric) - COALESCE(ac.cancelado, 0::numeric) AS aplicado,
           d.importe - (COALESCE(a.aplicado, 0::numeric) - COALESCE(ac.cancelado, 0::numeric)) AS pendiente,
           CASE WHEN d.vencimiento IS NULL THEN NULL::boolean ELSE d.vencimiento < CURRENT_DATE END AS vencido,
           CASE WHEN d.vencimiento IS NULL THEN NULL::integer ELSE CURRENT_DATE - d.vencimiento END AS dias_vencido,
           CASE WHEN d.fecha IS NULL THEN NULL::boolean ELSE d.fecha < '2026-10-01'::date END AS anterior_al_corte,
           d.referencia
      FROM doc d
      LEFT JOIN apl a ON a.sucursal = d.sucursal AND a.t = d.doc_tipo AND a.s = d.doc_sub AND a.f = d.folio
      LEFT JOIN aplc ac ON ac.sucursal = d.sucursal AND ac.t = d.doc_tipo AND ac.s = d.doc_sub AND ac.f = d.folio
      LEFT JOIN prov p ON p.ck = d.proveedor
     WHERE (d.importe - (COALESCE(a.aplicado, 0::numeric) - COALESCE(ac.cancelado, 0::numeric))) > 0.005;
  `);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve la definición de `[PGP.12]`, palabra por palabra. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_payables AS
    WITH doc AS MATERIALIZED (
      SELECT kdxe.sucursal,
             btrim(kdxe.c2) AS proveedor,
             kdxe.c4 AS doc_tipo,
             kdxe.c5 AS doc_sub,
             btrim(kdxe.c6) AS folio,
             nullif(btrim(kdxe.c16), '') AS referencia,
             CASE WHEN kdxe.c7 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c7::date ELSE NULL::date END AS fecha,
             CASE WHEN kdxe.c10 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c10::date ELSE NULL::date END AS vencimiento,
             kdxe.c11 AS importe
        FROM kepler_ods.kdxe
       WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A'::text
    ), apl AS MATERIALIZED (
      SELECT kdxf.sucursal, kdxf.c7 AS t, kdxf.c8 AS s, btrim(kdxf.c9) AS f, sum(kdxf.c10) AS aplicado
        FROM kepler_ods.kdxf
       WHERE btrim(kdxf.c1) = kdxf.sucursal
       GROUP BY kdxf.sucursal, kdxf.c7, kdxf.c8, (btrim(kdxf.c9))
    ), prov AS MATERIALIZED (
      SELECT DISTINCT ON ((btrim(kdxd.c2))) btrim(kdxd.c2) AS ck, kdxd.c3 AS nombre, kdxd.c13 AS grupo
        FROM kepler_ods.kdxd
       ORDER BY (btrim(kdxd.c2)), (kdxd.sucursal <> '00'::text), kdxd.sucursal
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           d.sucursal, d.proveedor, p.nombre AS proveedor_nombre, p.grupo,
           d.doc_tipo, d.doc_sub, d.folio, d.fecha, d.vencimiento, d.importe,
           COALESCE(a.aplicado, 0::numeric) AS aplicado,
           d.importe - COALESCE(a.aplicado, 0::numeric) AS pendiente,
           CASE WHEN d.vencimiento IS NULL THEN NULL::boolean ELSE d.vencimiento < CURRENT_DATE END AS vencido,
           CASE WHEN d.vencimiento IS NULL THEN NULL::integer ELSE CURRENT_DATE - d.vencimiento END AS dias_vencido,
           CASE WHEN d.fecha IS NULL THEN NULL::boolean ELSE d.fecha < '2026-10-01'::date END AS anterior_al_corte,
           d.referencia
      FROM doc d
      LEFT JOIN apl a ON a.sucursal = d.sucursal AND a.t = d.doc_tipo AND a.s = d.doc_sub AND a.f = d.folio
      LEFT JOIN prov p ON p.ck = d.proveedor
     WHERE (d.importe - COALESCE(a.aplicado, 0::numeric)) > 0.005;
  `);
};
