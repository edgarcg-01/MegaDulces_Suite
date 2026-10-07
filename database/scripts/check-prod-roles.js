"use strict";

/**
 * Inspección READ-ONLY de role_permissions en prod, para diagnosticar 403.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-roles.js
 * Opcional: $env:PROD_VENDOR_USER='<username>' para ver el rol de ese usuario.
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
const VENDOR_USER = process.env.PROD_VENDOR_USER;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

const PERMS = [
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_CUSTOMERS_GESTIONAR',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CREAR',
  'VISITAS_REGISTRAR',
  'USUARIOS_ASIGNAR_RUTA',
];

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='role_permissions' ORDER BY ordinal_position`,
  );
  const colNames = cols.rows.map((r) => r.column_name);
  console.log('role_permissions cols:', colNames.join(', '));
  const hasTenant = colNames.includes('tenant_id');

  const sel = PERMS.map((p) => `(permissions -> '${p}') as "${p}"`).join(', ');
  const roles = await c.query(
    `SELECT role_name${hasTenant ? ', tenant_id' : ''}, ${sel}
     FROM public.role_permissions ORDER BY role_name`,
  );
  console.log('\n=== ROLES x PERMISOS (valor JSONB; null = key AUSENTE) ===');
  for (const r of roles.rows) {
    console.log(`\n[${r.role_name}]${hasTenant ? ' tenant=' + r.tenant_id : ''}`);
    for (const p of PERMS) console.log(`   ${p} = ${JSON.stringify(r[p])}`);
  }

  console.log('\n=== USERS de campo (no customer_b2b) ===');
  const us = await c.query(
    `SELECT username, role_name FROM public.users
     WHERE deleted_at IS NULL AND role_name <> 'customer_b2b'
     ORDER BY role_name, username LIMIT 60`,
  );
  for (const u of us.rows) console.log(`   ${u.username}  ->  ${u.role_name}`);

  if (VENDOR_USER) {
    const u = await c.query(
      `SELECT username, role_name FROM public.users WHERE username = $1`,
      [VENDOR_USER],
    );
    console.log('\n=== USER buscado ===');
    console.log(u.rows);
  }

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
