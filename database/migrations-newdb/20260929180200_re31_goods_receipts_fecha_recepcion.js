'use strict';
/**
 * `[RE.31]` — **La fecha de recepción sale de Kepler: la captura del vale de entrada.**
 *
 * ── Para qué ───────────────────────────────────────────────────────────────────────────
 * El auxiliar de compras entrega a Finanzas lo recibido POR FECHA, y hay proveedores cuyo plazo
 * corre desde la recepción (RE.30). `analytics.erp_goods_receipts` sólo tenía la fecha del
 * documento (`c9`), y esa **es la fecha de factura**: la columna se llama `receipt_date` por
 * herencia, pero el vencimiento de Kepler = `c9` + plazo "fecha factura" en el 99.9%.
 * El nombre no se cambia (lo leen `fn_pair_goods_receipts`, `fn_goods_receipt_twin_candidates` y
 * varios servicios); se DECLARA acá y en el `COMMENT`.
 *
 * ── De dónde sale, y cómo se verificó (prod, 2026-09-29, sólo lectura) ────────────────────
 * `kdm1.c68 · c69 · c67` = fecha · hora · usuario de CAPTURA en Kepler (decodificado en
 * `docs/ERP_KEPLER.md` contra una cotización capturada a propósito: fecha, hora y usuario exactos).
 * Para la entrada se toma la del **vale de entrada (X-A-37)**, que es el documento de la llegada
 * física, alcanzado por la misma cadena que la vista ya recorre (aplicación X-A-20 → orden X-A-40
 * → vale X-A-37). Medido sobre 4,846 entradas jun–sep 2026:
 *   · la captura del vale nunca es posterior a la de la aplicación (4,513 iguales, 333 antes);
 *   · la hora de captura cae en horario laboral (07–21 h): es reloj del sistema, no un tecleo;
 *   · **árbitro independiente** — las fotos que la zona sube a `/compras/entradas` (reloj de
 *     NUESTRO servidor): 417 con foto, **0 fotos anteriores a la captura** del vale;
 *   · retraso contra la factura: 66% mismo día, 22% a 1–2 días, 11% a más de 2 (casi todo CEDIS).
 *   · ⚠️ 569 de 12,846 (4.4%) tienen factura con fecha POSTERIOR a la recepción (el proveedor
 *     facturó después de entregar). Es dato del ERP; no se corrige.
 * Límite, declarado: si el vale se capturó días después de la llegada, la fecha es la de captura.
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────────────────
 * `CREATE OR REPLACE VIEW` que agrega **4 columnas al final** (lo único que Postgres permite en
 * caliente) y reescribe el LATERAL al vale para leer, del MISMO renglón, `c39` (OC, como antes) y
 * `c68/c69/c67`:
 *   · `fecha_recepcion`          captura del vale; si no hay vale, la de la aplicación.
 *   · `fecha_recepcion_hora`     hora de esa captura (texto de Kepler).
 *   · `fecha_recepcion_usuario`  clave de usuario Kepler que capturó.
 *   · `fecha_recepcion_fuente`   'vale' | 'aplicacion' | NULL — de dónde salió.
 * Wincaja (30/32/50): las 4 van NULL — su `mp.fecha` no está verificada como fecha de llegada, y
 * poner la de factura sería inventarla.
 *
 * **Candado corrido ANTES de escribir esto** (la consulta nueva vs la vista viva en prod):
 * 12,846 renglones en ambas, **0 diferencias en las 19 columnas existentes en las dos
 * direcciones** (`EXCEPT ALL`), monto de 30 días idéntico ($51,202,834.22); 30 días 60 → 80 ms,
 * vista completa 202 → 314 ms. `fecha_recepcion_fuente = 'vale'` en las 12,846.
 *
 * ── Permisos y locks ────────────────────────────────────────────────────────────────────
 * La vista no tiene `security_invoker` y sus lectores son `app_runtime` y `dev_ro` (leído de
 * `relacl`, no de `information_schema`, que sólo muestra los grants que ve el usuario que consulta).
 * `CREATE OR REPLACE` los conserva, pero se re-aplican igual (lección ADR-057: no confiar).
 * `SET LOCAL lock_timeout = '3s'` (GOTCHAS §38): reemplazar una vista toma ACCESS EXCLUSIVE sobre
 * ella y la leen pantallas en caliente.
 *
 * Idempotente: si `fecha_recepcion` ya existe, no hace nada. `down` restaura la definición
 * anterior (la VIVA en prod el 2026-09-29, copiada de `pg_get_viewdef`) — como las columnas nuevas
 * van al final, Postgres no deja quitarlas con `CREATE OR REPLACE`: el `down` hace `DROP VIEW` +
 * `CREATE VIEW` en la misma transacción (sin dependientes: verificado en `pg_depend`).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

async function hasCol(knex, col) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('analytics.erp_goods_receipts')
        AND attname = ? AND attnum > 0 AND NOT attisdropped`, [col]);
  return rows.length > 0;
}

async function regrant(knex) {
  for (const role of ['app_runtime', 'dev_ro']) {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [role]);
    if (rows.length) await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipts TO ${role}`);
  }
}

exports.up = async function up(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t, to_regclass('analytics.erp_goods_receipts') AS v`);
  if (!ods.rows[0]?.t || !ods.rows[0]?.v) return;   // entorno sin ODS o sin la vista: nada que derivar
  if (await hasCol(knex, 'fecha_recepcion')) return;

  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.erp_goods_receipts AS
    SELECT '${M}'::uuid AS tenant_id,
        ap.sucursal,
        btrim(ap.c6) AS folio,
        'XA2001'::text AS doc_prefix,
        ap.c9::date AS receipt_date,
        NULLIF(btrim(ap.c10), ''::text) AS proveedor_code,
        NULLIF(btrim(ap.c32), ''::text) AS proveedor_nombre,
        NULLIF(btrim(ap.c22), ''::text) AS proveedor_rfc,
        oe.vale_folio,
        oe.oc_folio,
        NULLIF(btrim(ap.c24), ''::text) AS concepto,
        round(COALESCE(NULLIF(regexp_replace(ap.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
        'md_'::text || ap.sucursal AS source_branch,
        now() AS computed_at,
        dd.dup_of_sucursal,
        dd.dup_of_folio,
        wk.id AS warehouse_id,
        ap.c18::date AS fecha_vence,
        NULLIF(btrim(ap.c30), ''::text) AS condicion_pago,
        ap.c18::date - ap.c9::date AS dias_credito,
        COALESCE(oe.vale_cap_fecha, ap.c68::date) AS fecha_recepcion,
        CASE WHEN oe.vale_cap_fecha IS NOT NULL THEN oe.vale_cap_hora ELSE NULLIF(btrim(ap.c69::text), ''::text) END AS fecha_recepcion_hora,
        CASE WHEN oe.vale_cap_fecha IS NOT NULL THEN oe.vale_cap_usuario ELSE NULLIF(btrim(ap.c67::text), ''::text) END AS fecha_recepcion_usuario,
        CASE WHEN oe.vale_cap_fecha IS NOT NULL THEN 'vale'::text WHEN ap.c68 IS NOT NULL THEN 'aplicacion'::text ELSE NULL::text END AS fecha_recepcion_fuente
       FROM kepler_ods.kdm1 ap
         LEFT JOIN LATERAL ( SELECT NULLIF(btrim(oe_1.c39), ''::text) AS vale_folio,
                v.oc_folio, v.cap_fecha AS vale_cap_fecha, v.cap_hora AS vale_cap_hora, v.cap_usuario AS vale_cap_usuario
               FROM kepler_ods.kdm1 oe_1
                 LEFT JOIN LATERAL ( SELECT NULLIF(btrim(v_1.c39), ''::text) AS oc_folio,
                        v_1.c68::date AS cap_fecha,
                        NULLIF(btrim(v_1.c69::text), ''::text) AS cap_hora,
                        NULLIF(btrim(v_1.c67::text), ''::text) AS cap_usuario
                       FROM kepler_ods.kdm1 v_1
                      WHERE v_1.sucursal = oe_1.sucursal AND v_1.c2 = 'X'::text AND v_1.c3 = 'A'::text AND btrim(v_1.c4::text) = '37'::text AND btrim(v_1.c6) = btrim(oe_1.c39)
                      ORDER BY (btrim(v_1.c6))
                     LIMIT 1) v ON true
              WHERE oe_1.sucursal = ap.sucursal AND oe_1.c2 = 'X'::text AND oe_1.c3 = 'A'::text AND btrim(oe_1.c4::text) = '40'::text AND btrim(oe_1.c6) = btrim(ap.c39)
              ORDER BY (btrim(oe_1.c39))
             LIMIT 1) oe ON true
         LEFT JOIN commercial.warehouses wk ON wk.tenant_id = '${M}'::uuid AND wk.code::text = ap.sucursal AND wk.deleted_at IS NULL
         LEFT JOIN analytics.erp_goods_receipt_dedup dd ON dd.tenant_id = '${M}'::uuid AND ap.sucursal = '00'::text AND dd.cedis_folio = btrim(ap.c6) AND (dd.status = ANY (ARRAY['auto'::text, 'confirmado'::text]))
      WHERE ap.c2 = 'X'::text AND ap.c3 = 'A'::text AND btrim(ap.c4::text) = '20'::text AND btrim(ap.c1) = ap.sucursal AND btrim(COALESCE(ap.c43, ''::text)) <> 'C'::text
    UNION ALL
     SELECT '${M}'::uuid AS tenant_id,
        mp.source_branch AS sucursal,
        btrim(mp.documento) AS folio,
        'WCJ-'::text || btrim(mp.tipo) AS doc_prefix,
        mp.fecha::date AS receipt_date,
        NULLIF(btrim(mp.tercero), ''::text) AS proveedor_code,
        pr.nombre AS proveedor_nombre,
        pr.rfc AS proveedor_rfc,
        NULL::text AS vale_folio,
        NULL::text AS oc_folio,
        NULL::text AS concepto,
        round(COALESCE(mp.valor, 0::numeric) + COALESCE(mp.iva, 0::numeric) + COALESCE(mp.ieps, 0::numeric), 2) AS monto,
        'wincaja_'::text || mp.source_branch AS source_branch,
        now() AS computed_at,
        NULL::text AS dup_of_sucursal,
        NULL::text AS dup_of_folio,
        ww.id AS warehouse_id,
        mp.fecha_vencimiento::date AS fecha_vence,
        NULL::text AS condicion_pago,
        mp.fecha_vencimiento::date - mp.fecha::date AS dias_credito,
        NULL::date AS fecha_recepcion,
        NULL::text AS fecha_recepcion_hora,
        NULL::text AS fecha_recepcion_usuario,
        NULL::text AS fecha_recepcion_fuente
       FROM wincaja.movimiento_proveedores mp
         JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code ~~ 'MD-%'::text
         LEFT JOIN ( SELECT proveedores.source_branch,
                proveedores.proveedor,
                max(proveedores.nombre) AS nombre,
                max(proveedores.rfc) AS rfc
               FROM wincaja.proveedores
              WHERE proveedores.tenant_id = '${M}'::uuid
              GROUP BY proveedores.source_branch, proveedores.proveedor) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
         LEFT JOIN commercial.warehouses ww ON ww.tenant_id = '${M}'::uuid AND ww.wincaja_source_branch = mp.source_branch AND ww.deleted_at IS NULL
      WHERE mp.tenant_id = '${M}'::uuid AND mp.source_dataset = 'actual'::text AND (mp.tipo = ANY (ARRAY['CR'::text, 'CC'::text]))
  `);
  await regrant(knex);
  await knex.raw(`COMMENT ON COLUMN analytics.erp_goods_receipts.receipt_date IS
    'OJO: es la FECHA DE FACTURA (kdm1.c9 de la aplicación X-A-20), no la de llegada. La de llegada es fecha_recepcion. [RE.31]'`);
  await knex.raw(`COMMENT ON COLUMN analytics.erp_goods_receipts.fecha_recepcion IS
    'Fecha de recepción = captura en Kepler (kdm1.c68) del vale de entrada X-A-37; si no hay vale, la de la aplicación. Wincaja: NULL (sin verificar). [RE.31]'`);
};

exports.down = async function down(knex) {
  if (!(await hasCol(knex, 'fecha_recepcion'))) return;
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  // Las columnas nuevas van al final y Postgres no deja QUITARLAS con CREATE OR REPLACE, así que
  // DROP + CREATE en la misma transacción (sin dependientes en pg_depend; las funciones que la leen
  // la resuelven en tiempo de ejecución). La definición es la VIVA en prod el 2026-09-29 (leída con
  // pg_get_viewdef), no la de otra migración: 20260902170000 recrea varias vistas a la vez.
  await knex.raw(`DROP VIEW analytics.erp_goods_receipts`);
  await knex.raw(`
    CREATE VIEW analytics.erp_goods_receipts AS
    SELECT '${M}'::uuid AS tenant_id,
        ap.sucursal,
        btrim(ap.c6) AS folio,
        'XA2001'::text AS doc_prefix,
        ap.c9::date AS receipt_date,
        NULLIF(btrim(ap.c10), ''::text) AS proveedor_code,
        NULLIF(btrim(ap.c32), ''::text) AS proveedor_nombre,
        NULLIF(btrim(ap.c22), ''::text) AS proveedor_rfc,
        oe.vale_folio,
        oe.oc_folio,
        NULLIF(btrim(ap.c24), ''::text) AS concepto,
        round(COALESCE(NULLIF(regexp_replace(ap.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS monto,
        'md_'::text || ap.sucursal AS source_branch,
        now() AS computed_at,
        dd.dup_of_sucursal,
        dd.dup_of_folio,
        wk.id AS warehouse_id,
        ap.c18::date AS fecha_vence,
        NULLIF(btrim(ap.c30), ''::text) AS condicion_pago,
        ap.c18::date - ap.c9::date AS dias_credito
       FROM kepler_ods.kdm1 ap
         LEFT JOIN LATERAL ( SELECT NULLIF(btrim(oe_1.c39), ''::text) AS vale_folio,
                ( SELECT NULLIF(btrim(v.c39), ''::text) AS "nullif"
                       FROM kepler_ods.kdm1 v
                      WHERE v.sucursal = oe_1.sucursal AND v.c2 = 'X'::text AND v.c3 = 'A'::text AND btrim(v.c4::text) = '37'::text AND btrim(v.c6) = btrim(oe_1.c39)
                      ORDER BY (btrim(v.c6))
                     LIMIT 1) AS oc_folio
               FROM kepler_ods.kdm1 oe_1
              WHERE oe_1.sucursal = ap.sucursal AND oe_1.c2 = 'X'::text AND oe_1.c3 = 'A'::text AND btrim(oe_1.c4::text) = '40'::text AND btrim(oe_1.c6) = btrim(ap.c39)
              ORDER BY (btrim(oe_1.c39))
             LIMIT 1) oe ON true
         LEFT JOIN commercial.warehouses wk ON wk.tenant_id = '${M}'::uuid AND wk.code::text = ap.sucursal AND wk.deleted_at IS NULL
         LEFT JOIN analytics.erp_goods_receipt_dedup dd ON dd.tenant_id = '${M}'::uuid AND ap.sucursal = '00'::text AND dd.cedis_folio = btrim(ap.c6) AND (dd.status = ANY (ARRAY['auto'::text, 'confirmado'::text]))
      WHERE ap.c2 = 'X'::text AND ap.c3 = 'A'::text AND btrim(ap.c4::text) = '20'::text AND btrim(ap.c1) = ap.sucursal AND btrim(COALESCE(ap.c43, ''::text)) <> 'C'::text
    UNION ALL
     SELECT '${M}'::uuid AS tenant_id,
        mp.source_branch AS sucursal,
        btrim(mp.documento) AS folio,
        'WCJ-'::text || btrim(mp.tipo) AS doc_prefix,
        mp.fecha::date AS receipt_date,
        NULLIF(btrim(mp.tercero), ''::text) AS proveedor_code,
        pr.nombre AS proveedor_nombre,
        pr.rfc AS proveedor_rfc,
        NULL::text AS vale_folio,
        NULL::text AS oc_folio,
        NULL::text AS concepto,
        round(COALESCE(mp.valor, 0::numeric) + COALESCE(mp.iva, 0::numeric) + COALESCE(mp.ieps, 0::numeric), 2) AS monto,
        'wincaja_'::text || mp.source_branch AS source_branch,
        now() AS computed_at,
        NULL::text AS dup_of_sucursal,
        NULL::text AS dup_of_folio,
        ww.id AS warehouse_id,
        mp.fecha_vencimiento::date AS fecha_vence,
        NULL::text AS condicion_pago,
        mp.fecha_vencimiento::date - mp.fecha::date AS dias_credito
       FROM wincaja.movimiento_proveedores mp
         JOIN wincaja.branches b ON b.tenant_id = mp.tenant_id AND b.source_branch = mp.source_branch AND b.kepler_code IS NULL AND b.warehouse_code ~~ 'MD-%'::text
         LEFT JOIN ( SELECT proveedores.source_branch,
                proveedores.proveedor,
                max(proveedores.nombre) AS nombre,
                max(proveedores.rfc) AS rfc
               FROM wincaja.proveedores
              WHERE proveedores.tenant_id = '${M}'::uuid
              GROUP BY proveedores.source_branch, proveedores.proveedor) pr ON pr.source_branch = mp.source_branch AND pr.proveedor = mp.tercero
         LEFT JOIN commercial.warehouses ww ON ww.tenant_id = '${M}'::uuid AND ww.wincaja_source_branch = mp.source_branch AND ww.deleted_at IS NULL
      WHERE mp.tenant_id = '${M}'::uuid AND mp.source_dataset = 'actual'::text AND (mp.tipo = ANY (ARRAY['CR'::text, 'CC'::text]))
  `);
  await regrant(knex);
};
