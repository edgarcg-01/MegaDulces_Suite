"use strict";
/** READ-ONLY: grants de app_runtime en trade.stores + columnas, para diseñar la sync de ubicación. */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const g = await c.query(`SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee='app_runtime' AND table_schema='trade' AND table_name='stores' ORDER BY 1`);
  console.log('app_runtime grants en trade.stores:', g.rows.map((r) => r.privilege_type).join(', ') || '(NINGUNO)');
  const cols = await c.query(`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='trade' AND table_name='stores'
      AND column_name IN ('latitud','longitud','activo','updated_at','updated_by','tenant_id') ORDER BY 1`);
  console.log('columnas:', cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '));
  const rls = await c.query(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid='trade.stores'::regclass`);
  console.log('RLS:', rls.rows[0]);
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
