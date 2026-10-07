/* eslint-disable no-console */
/**
 * Agrega un día de visita (ISO 1=lun..7=dom) al array commercial.customers.visit_days
 * de los clientes de la ruta 27 de ese día (de las capturas del ERP, vendedor 27).
 *
 * ADITIVO e idempotente: hace append del día sin pisar los otros (un cliente en
 * lunes y martes queda {1,2}). Re-correr no cambia nada.
 * REQUIERE la columna visit_days (migración 20260616120000, aplicada en el deploy).
 *
 * Uso:
 *   DRY:     TARGET_DB_URL="postgres://..." node database/scripts/set-visit-days.js --day=1
 *   APLICAR: TARGET_DB_URL="postgres://..." node database/scripts/set-visit-days.js --day=1 --apply
 *   (--day=2 para martes)
 */
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const dayArg = process.argv.find((a) => a.startsWith('--day='));
const DAY = dayArg ? Number(dayArg.split('=')[1]) : null;
if (!DAY || DAY < 1 || DAY > 7) { console.error('Falta --day=N (1=lun..7=dom)'); process.exit(1); }

// Códigos por día (match por nombre contra prod, code LIKE '27%'). Falta "0" (sin identificar).
const BY_DAY = {
  1: [ // LUNES (21)
    '27002', '27005', '27ABARR19', '27abarr23', '27abarr14', '27ABARR20', '27abarr9',
    '27ABARR10', '27ABARR6', '27ANABE1', '27068', '27070', '27blanc1', '27084',
    '27irmah1', '27128', '27miria1', '27150', '27168', '27SECUN2', '27172',
  ],
  2: [ // MARTES (24)
    '27002', '27023', '27026', '27038', '27047', '27ANGEL1', '27083', '27085', '27090',
    '27096', '27099', '27102', '27LATIE1', '27120', '27maria2', '27132', '27MARIA1',
    '27papel1', '27152', '27156', '27163', '27167', '27SECUN2', '27174',
  ],
  3: [ // MIÉRCOLES (25)
    '27001', '27006', '27ABARR7', '27014', '27015', '27017', '27abarr23', '27024',
    '27033', '27035', '27040', '27048', '27055', '27064', '27072', '27080', '27claud1',
    '27096', '27100', '27115', '27127', '27136', '27147', '27170', '27175',
  ],
  4: [ // JUEVES (23)
    '27007', '27020', '27021', '27abarr14', '27031', '27046', '27052', '27067', '27069',
    '27078', '27086', '27091', '27095', '27juana1', '27111', '27115', '27121', '27124',
    '27maria2', '27marth2', '27169', '27torta1', '27176',
  ],
  5: [ // VIERNES (22)
    '27001', '27004', '27abarr12', '27abarr23', '27042', '27045', '27057', '27059',
    '27ANABE1', '27ANALA1', '27062', '27115', '27117', '27123', '27130', '27133',
    '27137', '27145', '27146', '27papel1', '27153', '27175',
  ],
  6: [ // SÁBADO (17)
    '27001', '27011', '27ABARR3', '27057', '27072', '27091', '27107', '27114', '27115',
    '27miria1', '27149', '27151', '27156', '27161', '27162', '27167', '27vinos1',
  ],
};
const CODES = BY_DAY[DAY] || [];
if (!CODES.length) { console.error(`No hay lista para day=${DAY}`); process.exit(1); }

const conn = process.env.TARGET_DB_URL
  ? { client: 'pg', connection: { connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } } }
  : require('../knexfile-newdb.js').development;
const knex = require('knex')(conn);

(async () => {
  const target = process.env.TARGET_DB_URL ? 'PROD' : 'local';
  const found = await knex('commercial.customers')
    .where({ tenant_id: T }).whereNull('deleted_at').whereIn('code', CODES)
    .select('code', 'name', 'visit_days');

  console.log(`target=${target} day=${DAY}${APPLY ? '' : ' [DRY — usar --apply]'}`);
  console.log(`códigos en lista: ${CODES.length} | encontrados: ${found.length}`);
  const missing = CODES.filter((c) => !found.some((r) => r.code === c));
  if (missing.length) console.log('NO encontrados (revisar):', missing.join(', '));
  for (const r of found) {
    const cur = r.visit_days || [];
    const next = [...new Set([...cur, DAY])].sort((a, b) => a - b);
    console.log(`  ${r.code.padEnd(12)} {${cur.join(',')}} → {${next.join(',')}} | ${r.name}`);
  }

  if (!APPLY) { await knex.destroy(); return; }

  const res = await knex.raw(
    `UPDATE commercial.customers
       SET visit_days = (
         SELECT array_agg(DISTINCT e ORDER BY e)
         FROM unnest(COALESCE(visit_days, ARRAY[]::smallint[]) || ARRAY[?]::smallint[]) AS e
       ), updated_at = now()
     WHERE tenant_id = ? AND deleted_at IS NULL AND code = ANY(?)
       AND NOT (COALESCE(visit_days, ARRAY[]::smallint[]) @> ARRAY[?]::smallint[])`,
    [DAY, T, CODES, DAY],
  );
  console.log(`\nfilas actualizadas: ${res.rowCount}`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
