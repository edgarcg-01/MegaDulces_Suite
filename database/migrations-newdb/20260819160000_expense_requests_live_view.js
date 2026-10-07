/**
 * `analytics.expense_requests` (solicitudes de gasto XA1501): TABLA copiada por importer batch
 * → **VISTA derive-no-copy EN VIVO** sobre `kepler_ods.kdm1` (mismo patrón que erp_goods_receipts).
 *
 * Motivo: el importer `import-expense-requests.js` leía las 6 ramas remotas directo y se caía por
 * timeout en el nightly (bajo carga a las 09:00) → la tabla quedó **23 días vieja** (último refresh
 * Jul-27), faltándole ~1,161 solicitudes que YA viven en el ODS. Como vista, se muestran al instante
 * y `estado`/`aplicada` reflejan el estado vivo (la tabla los tenía congelados).
 *
 * Fuente: `kepler_ods.kdm1` XA1501 (X-A-15). Anti-réplica `c1=sucursal`.
 *   c6=folio, c9=fecha, c16=importe, c48=solicitante (upper+collapse ws), c32=beneficiario,
 *   c24=concepto, c43=estado (F/A/C/N), c67=usuario.
 *   aplicada = EXISTS(XA1001 con c39=folio en la misma sucursal) — el gasto que la aplica.
 * Normalizado: expone `warehouse_id` (FK-equivalente) resolviendo `commercial.warehouses.code`.
 *
 * El vínculo `expense_documents.solicitud_folio` (usado por el detalle) lo sigue mantiendo el
 * importer repuntado al ODS (ya no escribe expense_requests; solo linkage + hallazgos). Backup:
 * `*_snapshot_bak`. 0 FK apuntan a la tabla, único writer era el importer → drop-in.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const rk = await knex.raw(`SELECT relkind FROM pg_class WHERE oid=to_regclass('analytics.expense_requests')`);
  if (rk.rows[0] && rk.rows[0].relkind === 'v') return; // ya es vista

  await knex.raw(`ALTER TABLE analytics.expense_requests RENAME TO expense_requests_snapshot_bak`);

  await knex.raw(`
    CREATE VIEW analytics.expense_requests AS
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
      AND btrim(r.c1::text)=r.sucursal::text AND btrim(r.c6::text) <> ''
  `);

  await knex.raw('GRANT SELECT ON analytics.expense_requests TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.expense_requests IS
    'Vista derive-no-copy: solicitudes de gasto EN VIVO desde kepler_ods.kdm1 (XA1501, anti-réplica c1=sucursal). '
    'aplicada=EXISTS(XA1001 c39=folio). warehouse_id via commercial.warehouses.code. Reemplaza el importer que '
    'se caía por timeout. Vínculo solicitud↔gasto lo mantiene el importer repuntado al ODS. Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.expense_requests');
  await knex.raw('ALTER TABLE analytics.expense_requests_snapshot_bak RENAME TO expense_requests');
};
