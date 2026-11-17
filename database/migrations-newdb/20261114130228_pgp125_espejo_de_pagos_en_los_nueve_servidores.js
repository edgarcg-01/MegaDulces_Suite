'use strict';
/**
 * `[PGP.125]` — **El espejo de pagos a proveedor ve los nueve servidores de Kepler, no sólo CEDIS.**
 *
 * `analytics.erp_supplier_payments` filtraba `kdm1.sucursal = '00'`. Comprobantes de pago
 * (`/finanzas/pagos-comprobantes` y la zona «Comprobantes PDF» del Calendario) busca ahí el pago de cada
 * comprobante, así que un pago capturado en otra sucursal **nunca empataba**: en la prueba del 2026-11-14 con
 * los 101 comprobantes de noviembre, 33 de los 65 ya capturados eran de 01–08, y al buscar a mano el folio de
 * FERRERO (Morelia Abastos 0000788) el buscador ofrecía el 0000788 de CEDIS, de otro proveedor y de enero.
 *
 * ── Qué hace ──────────────────────────────────────────────────────────────────────────────────
 *  1. `analytics.erp_supplier_payments_servidores`: la MISMA definición con los nueve servidores (cada
 *     documento leído en SU servidor: `c1 = sucursal`) y la cuenta de tesorería resuelta con el catálogo
 *     `kdb1` de ESE servidor (llave `sucursal|clave`).
 *  2. `analytics.erp_supplier_payments` pasa a ser esa vista filtrada a `'00'`: UNA definición, y sus ~20
 *     consumidores (rentabilidad, flujo, Maat, control de pagos…) y 3 vistas dependientes ven lo mismo que hoy.
 *     Sólo Comprobantes de pago lee la de nueve servidores.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-14) ─────────────────────────────────────────────
 *  · Identidad: la nueva filtrada a '00' contra la de hoy, EXCEPT en los dos sentidos = 0 y 0 sobre 4,990
 *    filas; control (un `source_branch` plantado distinto) = 4,990, o sea el instrumento sí ve diferencias.
 *  · Cobertura: +794 pagos de 01–08, todos con su cuenta resuelta (0 `no_resuelve`).
 *  · Tiempos, 5 corridas: consumidor de 00 (conteo oct–nov) 49–59 ms hoy vs 48–59 ms; con la cuenta
 *    (`medio_pago`) 87–131 vs 74–97 ms; la búsqueda del comprobante, ahora en 9 servidores, 104–126 ms.
 *    ⚠️ La primera versión unía `kdb1` por (sucursal, clave) y DUPLICABA el tiempo de los consumidores
 *    (67 → 128 ms): Postgres dejaba de poder quitar el join que no se usa. Por eso la llave compuesta.
 *
 * Sin ODS (base de desarrollo pelada) no hay de dónde derivar: no hace nada. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const SERVIDORES = `
  SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio) '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
      q.sucursal, q.folio, q.doc_prefix, q.pago_date, q.proveedor_code, q.proveedor_nombre, q.proveedor_rfc, q.concepto, q.monto,
      'md_' || q.sucursal AS source_branch,
      now() AS computed_at,
      q.metodo_pago, q.descuento,
      w.id AS warehouse_id,
      CASE
        WHEN btrim(COALESCE(q.cuenta_tes, ''::text)) = ''::text THEN 'sin_declarar'::text
        ELSE COALESCE(b.tipo, 'no_resuelve'::text)
      END AS medio_pago,
      b.nombre AS cuenta_tesoreria
    FROM (SELECT kdm1.sucursal::text AS sucursal,
        btrim(kdm1.c6) AS folio,
        CASE btrim(kdm1.c4::text) WHEN '26'::text THEN 'XD2601'::text WHEN '60'::text THEN 'XD6001'::text ELSE 'XD2501'::text END AS doc_prefix,
        CASE
          WHEN lower(btrim(kdm1.c31)) ~~ 'tra%'::text THEN 'transferencia'::text
          WHEN lower(btrim(kdm1.c31)) ~~ 'che%'::text THEN 'cheque'::text
          WHEN lower(btrim(kdm1.c31)) ~~ 'ant%'::text THEN 'anticipo'::text
          ELSE NULL::text
        END AS metodo_pago,
        kdm1.c9::date AS pago_date,
        NULLIF(btrim(kdm1.c10), ''::text) AS proveedor_code,
        NULLIF(btrim(kdm1.c32), ''::text) AS proveedor_nombre,
        NULLIF(btrim(kdm1.c22), ''::text) AS proveedor_rfc,
        NULLIF(btrim(kdm1.c24), ''::text) AS concepto,
        round(COALESCE(NULLIF(regexp_replace(kdm1.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
        round(COALESCE(NULLIF(regexp_replace(kdm1.c84, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS descuento,
        btrim(kdm1.c45) AS cuenta_tes
      FROM kepler_ods.kdm1
      WHERE kdm1.c2 = 'X'::text AND kdm1.c3 = 'D'::text AND (btrim(kdm1.c4::text) = ANY (ARRAY['25'::text, '26'::text, '60'::text]))
        AND btrim(kdm1.c10) ~~* 'C%'::text
        AND btrim(kdm1.c1) = kdm1.sucursal
        AND btrim(COALESCE(kdm1.c43, ''::text)) <> 'C'::text) q
    LEFT JOIN commercial.warehouses w ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
    LEFT JOIN (SELECT DISTINCT ON ((kdb1.sucursal || '|' || btrim(kdb1.c1))) kdb1.sucursal || '|' || btrim(kdb1.c1) AS llave,
        btrim(kdb1.c2) AS nombre,
        CASE
          WHEN btrim(kdb1.c5) !~~ '102%'::text THEN 'puente'::text
          WHEN upper(btrim(COALESCE(kdb1.c3, ''::text))) = 'EFECTIVO'::text THEN 'caja'::text
          ELSE 'banco'::text
        END AS tipo
      FROM kepler_ods.kdb1
      WHERE btrim(COALESCE(kdb1.c1, ''::text)) <> ''::text
      ORDER BY (kdb1.sucursal || '|' || btrim(kdb1.c1))) b ON b.llave = q.sucursal || '|' || q.cuenta_tes
    ORDER BY q.sucursal, q.doc_prefix, q.folio`;

/** La definición EXACTA de hoy (`pg_get_viewdef` sobre prod, 2026-11-14), para el `down`. */
const VIEJA = `
   SELECT DISTINCT ON (q.sucursal, q.doc_prefix, q.folio) '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
      q.sucursal,
      q.folio,
      q.doc_prefix,
      q.pago_date,
      q.proveedor_code,
      q.proveedor_nombre,
      q.proveedor_rfc,
      q.concepto,
      q.monto,
      'md_00'::text AS source_branch,
      now() AS computed_at,
      q.metodo_pago,
      q.descuento,
      w.id AS warehouse_id,
          CASE
              WHEN btrim(COALESCE(q.cuenta_tes, ''::text)) = ''::text THEN 'sin_declarar'::text
              ELSE COALESCE(b.tipo, 'no_resuelve'::text)
          END AS medio_pago,
      b.nombre AS cuenta_tesoreria
     FROM ( SELECT '00'::text AS sucursal,
              btrim(kdm1.c6) AS folio,
                  CASE btrim(kdm1.c4::text)
                      WHEN '26'::text THEN 'XD2601'::text
                      WHEN '60'::text THEN 'XD6001'::text
                      ELSE 'XD2501'::text
                  END AS doc_prefix,
                  CASE
                      WHEN lower(btrim(kdm1.c31)) ~~ 'tra%'::text THEN 'transferencia'::text
                      WHEN lower(btrim(kdm1.c31)) ~~ 'che%'::text THEN 'cheque'::text
                      WHEN lower(btrim(kdm1.c31)) ~~ 'ant%'::text THEN 'anticipo'::text
                      ELSE NULL::text
                  END AS metodo_pago,
              kdm1.c9::date AS pago_date,
              NULLIF(btrim(kdm1.c10), ''::text) AS proveedor_code,
              NULLIF(btrim(kdm1.c32), ''::text) AS proveedor_nombre,
              NULLIF(btrim(kdm1.c22), ''::text) AS proveedor_rfc,
              NULLIF(btrim(kdm1.c24), ''::text) AS concepto,
              round(COALESCE(NULLIF(regexp_replace(kdm1.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
              round(COALESCE(NULLIF(regexp_replace(kdm1.c84, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS descuento,
              btrim(kdm1.c45) AS cuenta_tes
             FROM kepler_ods.kdm1
            WHERE kdm1.c2 = 'X'::text AND kdm1.c3 = 'D'::text AND (btrim(kdm1.c4::text) = ANY (ARRAY['25'::text, '26'::text, '60'::text])) AND btrim(kdm1.c10) ~~* 'C%'::text AND kdm1.sucursal = '00'::text AND btrim(kdm1.c1) = '00'::text AND btrim(COALESCE(kdm1.c43, ''::text)) <> 'C'::text) q
       LEFT JOIN commercial.warehouses w ON w.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND w.code::text = q.sucursal AND w.deleted_at IS NULL
       LEFT JOIN ( SELECT DISTINCT ON ((btrim(kdb1.c1))) btrim(kdb1.c1) AS clave,
              btrim(kdb1.c2) AS nombre,
                  CASE
                      WHEN btrim(kdb1.c5) !~~ '102%'::text THEN 'puente'::text
                      WHEN upper(btrim(COALESCE(kdb1.c3, ''::text))) = 'EFECTIVO'::text THEN 'caja'::text
                      ELSE 'banco'::text
                  END AS tipo
             FROM kepler_ods.kdb1
            WHERE btrim(COALESCE(kdb1.c1, ''::text)) <> ''::text
            ORDER BY (btrim(kdb1.c1)), kdb1.sucursal) b ON b.clave = q.cuenta_tes
    ORDER BY q.sucursal, q.doc_prefix, q.folio;`;

const COLUMNAS = 'tenant_id, sucursal, folio, doc_prefix, pago_date, proveedor_code, proveedor_nombre, proveedor_rfc, concepto, '
  + 'monto, source_branch, computed_at, metodo_pago, descuento, warehouse_id, medio_pago, cuenta_tesoreria';

async function otorgar(knex, vista) {
  await knex.raw(`GRANT SELECT ON ${vista} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${vista} TO dev_ro'; END IF; END $$`);
}

exports.up = async function up(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS a, to_regclass('kepler_ods.kdb1') AS b`);
  if (!ods.rows[0]?.a || !ods.rows[0]?.b) return;
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_supplier_payments_servidores AS ${SERVIDORES}`);
  await otorgar(knex, 'analytics.erp_supplier_payments_servidores');
  await knex.raw(`COMMENT ON VIEW analytics.erp_supplier_payments_servidores IS
    '[PGP.125] Pagos a proveedor (X-D-25/26/60) de los NUEVE servidores de Kepler, cada uno leído en su servidor y con su catálogo kdb1. analytics.erp_supplier_payments es esta misma filtrada a 00.'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_supplier_payments AS
    SELECT ${COLUMNAS} FROM analytics.erp_supplier_payments_servidores WHERE sucursal = '00'`);
  await otorgar(knex, 'analytics.erp_supplier_payments');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista de CEDIS vuelve a su definición propia y la nueva se va. */
exports.down = async function down(knex) {
  const r = await knex.raw(`SELECT to_regclass('analytics.erp_supplier_payments_servidores') AS v`);
  if (!r.rows[0]?.v) return;
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_supplier_payments AS ${VIEJA}`);
  await otorgar(knex, 'analytics.erp_supplier_payments');
  await knex.raw('DROP VIEW analytics.erp_supplier_payments_servidores');
};
