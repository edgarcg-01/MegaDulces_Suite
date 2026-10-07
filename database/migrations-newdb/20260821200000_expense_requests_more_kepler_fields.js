/**
 * `analytics.expense_requests` — de 8 a 18 columnas de Kepler (derive-no-copy, sigue siendo VISTA).
 *
 * Descubrimiento 2026-08-21 sobre 8,831 solicitudes X-A-15 en prod: `kdm1` trae **72 columnas
 * con dato** y la vista exponía 8. Peor: la vista hermana `analytics.expense_documents` (el gasto
 * X-A-10, misma tabla origen) ya publicaba `rfc`, `iva`, `clase` y `area`. La solicitud —el
 * documento con el que se AUTORIZA el dinero— era la mitad pobre del par.
 *
 * Lo que se agrega, medido en prod (% = documentos con dato):
 *   c10 100% → `cuenta_clave` + `cuenta_grupo`. Clave del catálogo de acreedores. Resuelve en
 *              `kepler_ods.kdxd` en el 100% de los casos (8,814/8,831). Hoy se agrupa por el
 *              nombre libre c32 (367 variantes para 337 claves). El prefijo clasifica el gasto:
 *              GN nómina $22.5M · GS $11.8M · GG caja chica $4.2M · GF combustible $4.0M ·
 *              GB bancos $2.3M · C* proveedor de compra · A* / T*.
 *   c22  36% → `rfc` del beneficiario (misma expresión que expense_documents).
 *   c14  99% → `iva` (cuadra al 16% de c16 en 2,447 de 3,521 con impuesto).
 *   c90  47% → `forma_pago`, catálogo SAT c_FormaPago (01 efectivo · 02 cheque · 03 transferencia
 *              · 04 tarjeta · 06 dinero electrónico · 99 por definir).
 *   c30  94% → `autoriza`. Sucio a propósito: FINANZAS / DPTO FINANZAS / DEPARTAMENTO DE FINANSAS
 *              conviven. Se expone crudo; normalizarlo es otro trabajo, no de esta vista.
 *   c11  80% → `referencia` (texto libre: unidad, placa, iniciales).
 *   c68+c69   → `capturado_at`: fecha y hora reales de captura (rastro de auditoría).
 *   kdxd      → `acreedor` (nombre canónico) y `acreedor_rfc`.
 *
 * NO se agrega c18 como "vence": en X-A-15 es igual a c9 en 7,456 de 8,831 (promedio +0.3 días).
 * Ahí no es fecha de vencimiento, aunque sí lo sea en recepción de mercancía.
 *
 * `CREATE OR REPLACE VIEW` exige conservar las columnas previas en el mismo orden y sólo
 * AGREGAR al final; por eso `computed_at` queda en medio.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const BODY = `
    SELECT
      '${M}'::uuid                                        AS tenant_id,
      r.sucursal::text                                   AS sucursal,
      btrim(r.c6::text)                                  AS folio,
      r.c9::date                                         AS fecha,
      round(coalesce(nullif(regexp_replace(r.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      NULLIF(upper(regexp_replace(btrim(r.c48::text),'\\s+',' ','g')),'') AS solicitante,
      NULLIF(btrim(r.c32::text),'')                      AS beneficiario,
      NULLIF(btrim(r.c24::text),'')                      AS concepto,
      NULLIF(btrim(r.c43::text),'')                      AS estado,
      NULLIF(btrim(r.c67::text),'')                      AS usuario,
      EXISTS (SELECT 1 FROM kepler_ods.kdm1 g
         WHERE g.sucursal=r.sucursal AND g.c2='X' AND g.c3='A' AND btrim(g.c4::text)='10' AND btrim(g.c5::text)='1'
           AND btrim(g.c39::text)=btrim(r.c6::text))    AS aplicada,
      w.id                                               AS warehouse_id,
      now()                                              AS computed_at,
      -- ── nuevas (2026-08-21) ────────────────────────────────────────────
      NULLIF(btrim(r.c10::text),'')                      AS cuenta_clave,
      NULLIF(left(btrim(r.c10::text),2),'')              AS cuenta_grupo,
      NULLIF(btrim(x.nombre),'')                         AS acreedor,
      NULLIF(upper(btrim(x.rfc)),'')                     AS acreedor_rfc,
      NULLIF(upper(btrim(r.c22::text)),'')               AS rfc,
      round(coalesce(nullif(regexp_replace(r.c14::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS iva,
      NULLIF(btrim(r.c90::text),'')                      AS forma_pago,
      NULLIF(upper(regexp_replace(btrim(r.c30::text),'\\s+',' ','g')),'') AS autoriza,
      NULLIF(btrim(r.c11::text),'')                      AS referencia,
      CASE WHEN r.c68 IS NOT NULL
        THEN (r.c68::date + coalesce(nullif(btrim(r.c69::text),'')::time, '00:00'::time)) END AS capturado_at
    FROM kepler_ods.kdm1 r
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=r.sucursal::text AND w.deleted_at IS NULL
    -- Catálogo de acreedores: 748 claves, ~6 filas por clave (una por sucursal) → se agrega.
    LEFT JOIN LATERAL (
      SELECT max(btrim(d.c3::text)) AS nombre, max(btrim(d.c10::text)) AS rfc
        FROM kepler_ods.kdxd d WHERE btrim(d.c2::text) = btrim(r.c10::text)
    ) x ON true
    WHERE r.c2='X' AND r.c3='A' AND btrim(r.c4::text)='15' AND btrim(r.c5::text)='1'
      AND btrim(r.c1::text)=r.sucursal::text AND btrim(r.c6::text) <> ''`;

const BODY_PREV = `
    SELECT
      '${M}'::uuid                                        AS tenant_id,
      r.sucursal::text                                   AS sucursal,
      btrim(r.c6::text)                                  AS folio,
      r.c9::date                                         AS fecha,
      round(coalesce(nullif(regexp_replace(r.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      NULLIF(upper(regexp_replace(btrim(r.c48::text),'\\s+',' ','g')),'') AS solicitante,
      NULLIF(btrim(r.c32::text),'')                      AS beneficiario,
      NULLIF(btrim(r.c24::text),'')                      AS concepto,
      NULLIF(btrim(r.c43::text),'')                      AS estado,
      NULLIF(btrim(r.c67::text),'')                      AS usuario,
      EXISTS (SELECT 1 FROM kepler_ods.kdm1 g
         WHERE g.sucursal=r.sucursal AND g.c2='X' AND g.c3='A' AND btrim(g.c4::text)='10' AND btrim(g.c5::text)='1'
           AND btrim(g.c39::text)=btrim(r.c6::text))    AS aplicada,
      w.id                                               AS warehouse_id,
      now()                                              AS computed_at
    FROM kepler_ods.kdm1 r
    LEFT JOIN commercial.warehouses w
      ON w.tenant_id='${M}'::uuid AND w.code=r.sucursal::text AND w.deleted_at IS NULL
    WHERE r.c2='X' AND r.c3='A' AND btrim(r.c4::text)='15' AND btrim(r.c5::text)='1'
      AND btrim(r.c1::text)=r.sucursal::text AND btrim(r.c6::text) <> ''`;

/** No-op donde no hay ODS (local sin réplica): la vista ni siquiera existe ahí. */
async function esVista(knex) {
  const r = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.expense_requests')`);
  return !!(r.rows[0] && r.rows[0].relkind === 'v');
}

exports.up = async function (knex) {
  if (!(await esVista(knex))) return;
  if (!(await knex.raw(`SELECT to_regclass('kepler_ods.kdxd') t`)).rows[0].t) return;
  await knex.raw(`CREATE OR REPLACE VIEW analytics.expense_requests AS ${BODY}`);
  await knex.raw('GRANT SELECT ON analytics.expense_requests TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.expense_requests IS
    'Vista derive-no-copy: solicitudes de gasto EN VIVO desde kepler_ods.kdm1 (XA1501, anti-replica c1=sucursal). '
    'aplicada=EXISTS(XA1001 c39=folio). 2026-08-21: + cuenta_clave/cuenta_grupo (c10, catalogo kdxd), acreedor, '
    'acreedor_rfc, rfc (c22), iva (c14), forma_pago (c90, catalogo SAT), autoriza (c30), referencia (c11), '
    'capturado_at (c68+c69).'`);
};

exports.down = async function (knex) {
  if (!(await esVista(knex))) return;
  // CREATE OR REPLACE no puede QUITAR columnas: hay que soltar y rehacer.
  await knex.raw('DROP VIEW IF EXISTS analytics.expense_requests');
  await knex.raw(`CREATE VIEW analytics.expense_requests AS ${BODY_PREV}`);
  await knex.raw('GRANT SELECT ON analytics.expense_requests TO app_runtime');
};
