/**
 * `analytics.kepler_bank_movements`: TABLA copiada por importer → **VISTA derive-no-copy EN VIVO**
 * sobre `kepler_ods.kdm1 ⋈ kdb1` (regla ⭐: cero importers, todo del ODS). Reemplaza
 * `import-kepler-bank-movements.js`, que se retira. Reproduce su lógica en SQL:
 *   · dirección entrada/salida por tipo de doc (+ fallback por c31 método),
 *   · traspaso N-A-26 = 2 piernas (−origen c45 / +destino c47),
 *   · crosswalk clave_banco → account_label (exacto · '0011'→'CG' · sufijo), resuelto por-clave (CTE xw),
 *   · CONCENTRADOR: todas las sucursales, anti-réplica c1=sucursal (kdm1 arrastra réplicas),
 *   · excluye cancelados c43='C'.
 *
 * Validada contra la tabla materializada del importer (2026-09-03): filas, entradas y account_label
 * EXACTOS; salidas ±$77 = drift vivo-vs-snapshot (la vista es más fresca). Perf ~400ms/cuenta.
 *
 * 0 writers salvo el importer (retirado). Consumidores (finance-bank, caja) sólo LEEN → drop-in.
 * Backup: `*_snapshot_bak`. Índice de apoyo sobre el filtro de tesorería (c45).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const VIEW_SQL = `
  WITH kb AS (
    SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre, btrim(c5) cta,
           CASE WHEN btrim(c5) NOT LIKE '102%' THEN 'puente'
                WHEN btrim(c1) IN ('0010','0011','0040') THEN 'caja' ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>''
     ORDER BY btrim(c1), sucursal
  ),
  xw AS (
    SELECT kb.clave,
      COALESCE(
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='${M}'::uuid AND ba.account_label=kb.clave LIMIT 1),
        CASE WHEN kb.clave='0011' THEN 'CG' END,
        (SELECT ba.account_label FROM finance.bank_accounts ba WHERE ba.tenant_id='${M}'::uuid AND length(ba.account_label)>=3
           AND kb.clave LIKE '%'||ba.account_label AND kb.clave<>ba.account_label ORDER BY length(ba.account_label) DESC LIMIT 1)
      ) AS account_label
    FROM kb
  ),
  flj AS (
    SELECT btrim(d.c1::text) suc,
           btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text) dt,
           btrim(d.c6::text) folio, d.c9::date fval, d.c68::date fcap,
           round(coalesce(NULLIF(regexp_replace(d.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) importe,
           NULLIF(btrim(d.c24::text),'') concepto, NULLIF(btrim(d.c31::text),'') metodo,
           NULLIF(btrim(d.c32::text),'') beneficiario, btrim(d.c45::text) c45, NULLIF(btrim(d.c47::text),'') c47,
           CASE btrim(d.c2::text)||'-'||btrim(d.c3::text)||'-'||btrim(d.c4::text)
             WHEN 'U-A-5' THEN 'entrada' WHEN 'U-A-25' THEN 'entrada' WHEN 'X-A-45' THEN 'entrada'
             WHEN 'X-D-26' THEN 'salida' WHEN 'X-D-25' THEN 'salida' WHEN 'X-D-60' THEN 'salida' WHEN 'X-D-10' THEN 'salida'
             WHEN 'N-A-26' THEN 'traspaso'
             ELSE CASE WHEN btrim(d.c31::text)='Cob' THEN 'entrada'
                       WHEN btrim(d.c31::text) IN ('Tra','Che','Ant') THEN 'salida' ELSE 'otro' END
           END flujo
      FROM kepler_ods.kdm1 d
     WHERE btrim(d.c1::text)=d.sucursal::text
       AND btrim(coalesce(d.c43::text,'')) <> 'C'
       AND btrim(d.c45::text) IN (SELECT clave FROM kb)
  ),
  legs AS (
    SELECT suc, dt, folio, fval, fcap, importe, concepto, metodo, beneficiario, c45 AS clave,
           CASE WHEN flujo='traspaso' THEN 'traspaso' ELSE flujo END AS flujo,
           CASE WHEN flujo='traspaso' THEN -1 WHEN flujo='entrada' THEN 1 WHEN flujo='salida' THEN -1 ELSE NULL END AS signo,
           (flujo='traspaso') AS es_traspaso,
           CASE WHEN flujo='traspaso' THEN c47 ELSE NULL END AS contra,
           CASE WHEN flujo='traspaso' THEN 'origen' ELSE 'mov' END AS pierna
      FROM flj
    UNION ALL
    SELECT suc, dt, folio, fval, fcap, importe, concepto, metodo, beneficiario, c47 AS clave,
           'traspaso' AS flujo, 1 AS signo, true AS es_traspaso, c45 AS contra, 'destino' AS pierna
      FROM flj WHERE flujo='traspaso' AND c47 IS NOT NULL AND c47 IN (SELECT clave FROM kb)
  )
  SELECT '${M}'::uuid AS tenant_id,
    legs.suc AS sucursal, legs.dt AS doc_tipo, legs.folio, legs.clave AS clave_banco,
    kb.cta AS cuenta_contable, kb.nombre AS banco_nombre, kb.tipo AS tipo_cuenta,
    legs.flujo, legs.importe, legs.signo::smallint AS signo,
    legs.fval AS fecha_valor, legs.fcap AS fecha_captura,
    legs.concepto, legs.metodo, legs.beneficiario,
    legs.es_traspaso, legs.contra AS contra_clave, legs.pierna,
    xw.account_label,
    now() AS computed_at
  FROM legs
  LEFT JOIN kb ON kb.clave = legs.clave
  LEFT JOIN xw ON xw.clave = legs.clave`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return; // entorno sin ODS: nada que derivar

  const rel = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.kepler_bank_movements')`);
  if (rel.rows[0]?.relkind === 'v') return; // ya es vista: idempotente

  // Índice de apoyo: el filtro clave del view es c45 (sólo docs que tocan banco).
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_kdm1_tesoreria_c45
    ON kepler_ods.kdm1 (btrim(c45::text)) WHERE btrim(coalesce(c45::text,'')) <> ''`);

  if (rel.rows[0]?.relkind === 'r') {
    await knex.raw(`ALTER TABLE analytics.kepler_bank_movements RENAME TO kepler_bank_movements_snapshot_bak`);
  }
  await knex.raw(`CREATE VIEW analytics.kepler_bank_movements AS ${VIEW_SQL}`);
  await knex.raw(`GRANT SELECT ON analytics.kepler_bank_movements TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.kepler_bank_movements IS
    'Vista derive-no-copy: tesorería EN VIVO desde kepler_ods.kdm1⋈kdb1 (concentrador 6 sucursales, '
    'anti-réplica c1=sucursal). Reemplaza import-kepler-bank-movements.js. Dirección por doctype, '
    'traspaso=2 piernas, crosswalk clave→account_label, excluye c43=C. Backup: *_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.kepler_bank_movements`);
  await knex.raw(`ALTER TABLE IF EXISTS analytics.kepler_bank_movements_snapshot_bak RENAME TO kepler_bank_movements`);
  await knex.raw(`DROP INDEX IF EXISTS kepler_ods.idx_kdm1_tesoreria_c45`);
};
