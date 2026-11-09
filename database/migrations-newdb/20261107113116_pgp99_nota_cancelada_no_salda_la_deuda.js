'use strict';
/**
 * `[PGP.99]` — **Una nota de crédito o devolución CANCELADA en Kepler tampoco salda la deuda.**
 *
 * Reportado el 2026-11-07: la orden de entrada de Hershey `XA2001-0000684` (sucursal 01, `CH001`,
 * $168,671.33) no aparecía para capturarla en `/finanzas/calendario-pagos`. Kepler la debe:
 * `kdxe.c20` = $64,672.73. La causa es la de `[PGP.67]`, en otro tipo de documento: se le aplicó la
 * nota de crédito `X-D-55 0000130` por $103,998.60, se CANCELÓ (`kdm1.c43 = 'C'`) y se volvió a
 * capturar como `X-D-55 0000131` por lo mismo. Kepler **no borra** la aplicación cancelada de
 * `kdxf`, la vista sumaba las dos ($207,997.20 > $168,671.33), el pendiente salía negativo y el
 * `WHERE pendiente > 0.005` la escondía. `[PGP.67]` sólo restaba los pagos cancelados
 * (`25`/`26`/`60`), no las notas (`55`) ni las devoluciones (`40`).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-07) ───────────────────────────────────────
 *  · Documentos `D` cancelados que siguen aplicados en `kdxf`: `55` 51 docs ($6.26 M aplicado),
 *    `40` 7 docs ($44,560); `25`/`26`/`60` ya los cubría `[PGP.67]`. No hay otros tipos.
 *  · La vista escondía **23 documentos con deuda viva**: 13 de `CB005` (sucursal 01, $2.70 M, una
 *    sola nota `X-D-55 0000023` cancelada), el de Hershey, 2 de la sucursal 03 y 7 de `CR002`.
 *  · ⭐ Testigo: el saldo que Kepler GUARDA en la factura (`kdxe.c20`, ERP_KEPLER §pago) casa al
 *    centavo con el pendiente nuevo en **los 23 de 23**.
 *  · Antes: 3,148 docs · $151,060,578.18. Después: 3,171 · $153,853,047.88.
 *  · Tiempo de la vista (4 corridas): 349–412 ms → 370–417 ms (presupuesto de la lista: 500 ms).
 *
 * ⛔ Mismas 17 columnas, mismo orden y tipo que `[PGP.67]`: `CREATE OR REPLACE` conserva los GRANT y
 * las vistas que dependen de ésta. El único cambio es la lista de tipos de `canc`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** La vista de `[PGP.67]` con la lista de tipos cancelados que se restan como parámetro. */
const vista = (tipos) => `
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
      -- [PGP.99] También las notas de crédito (55) y devoluciones (40) canceladas.
      SELECT DISTINCT m.sucursal, m.c1, m.c10, m.c4, m.c5, m.c6
        FROM kepler_ods.kdm1 m
       WHERE m.c3 = 'D' AND m.c4 IN (${tipos}) AND m.c43 = 'C' AND btrim(m.c1) = m.sucursal
    ), aplc AS MATERIALIZED (
      -- [PGP.67] Lo que esos documentos cancelados siguen "aplicando" en kdxf: se resta.
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
  `;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(vista(`'25', '26', '40', '55', '60'`));
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve la lista de tipos de `[PGP.67]`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(vista(`'25', '26', '60'`));
};
