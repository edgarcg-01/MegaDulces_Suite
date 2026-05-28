#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Pre-flight check para cutover Railway → nueva DB multi-tenant.
 *
 * Corre TODAS las validaciones del runbook antes de tocar prod.
 * Usar APUNTANDO A RAILWAY (env vars LEGACY_DATABASE_URL + DATABASE_URL_NEW),
 * NO contra local.
 *
 * Uso:
 *   LEGACY_DATABASE_URL=<railway_legacy> \
 *   DATABASE_URL_NEW=<railway_new_postgres_user> \
 *   DATABASE_URL_NEW_RUNTIME=<railway_new_app_runtime_user> \
 *   node database/cutover-preflight.js
 *
 * Exit 0 = todo OK, podés proceder con Fase 2.
 * Exit 1 = al menos un check rojo, NO proceder.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const knex = require('knex');

const TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
    fail++;
  }
}

async function main() {
  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  const newUrl = process.env.DATABASE_URL_NEW;
  const runtimeUrl = process.env.DATABASE_URL_NEW_RUNTIME;

  console.log('\n═══ CUTOVER PRE-FLIGHT CHECK ═══\n');

  console.log('── 0. Env vars ──');
  check('LEGACY_DATABASE_URL presente', !!legacyUrl);
  check('DATABASE_URL_NEW presente', !!newUrl);
  check('DATABASE_URL_NEW_RUNTIME presente', !!runtimeUrl);
  if (!legacyUrl || !newUrl || !runtimeUrl) {
    console.log('\n✗ Env vars incompletas. Abortando.');
    process.exit(1);
  }

  const legacy = knex({
    client: 'pg',
    connection: { connectionString: legacyUrl, ssl: { rejectUnauthorized: false } },
    pool: { min: 1, max: 2 },
  });
  const newdbAdmin = knex({
    client: 'pg',
    connection: { connectionString: newUrl, ssl: { rejectUnauthorized: false } },
    pool: { min: 1, max: 2 },
  });
  const newdbRuntime = knex({
    client: 'pg',
    connection: { connectionString: runtimeUrl, ssl: { rejectUnauthorized: false } },
    pool: { min: 1, max: 2 },
  });

  try {
    console.log('\n── 1. Conectividad ──');
    const legPing = await legacy.raw('SELECT 1 as ok');
    check('connect legacy', legPing.rows[0].ok === 1);

    const newPing = await newdbAdmin.raw('SELECT current_user as u, current_database() as db');
    check('connect new DB (postgres)', !!newPing.rows[0].db);
    check('user es postgres (admin)', newPing.rows[0].u === 'postgres', `actual=${newPing.rows[0].u}`);

    const runtPing = await newdbRuntime.raw('SELECT current_user as u');
    check('connect new DB (app_runtime)', runtPing.rows[0].u === 'app_runtime', `actual=${runtPing.rows[0].u}`);

    console.log('\n── 2. Schema nueva DB ──');
    const tables = await newdbAdmin('information_schema.tables')
      .where({ table_schema: 'public' })
      .select('table_name');
    const tableNames = tables.map((t) => t.table_name);
    const required = ['tenants', 'users', 'role_permissions', 'zones', 'catalogs', 'brands', 'products', 'stores', 'daily_captures', 'daily_assignments', 'scoring_config_versions', 'scoring_weights'];
    for (const t of required) {
      check(`tabla public.${t} existe`, tableNames.includes(t));
    }

    const commTables = await newdbAdmin('information_schema.tables')
      .where({ table_schema: 'commercial' })
      .select('table_name');
    const commNames = commTables.map((t) => t.table_name);
    const reqComm = ['customers', 'warehouses', 'price_lists', 'product_prices', 'stock', 'stock_movements', 'orders', 'order_lines', 'payments', 'order_sequences', 'order_status_history', 'recommended_baskets'];
    for (const t of reqComm) {
      check(`tabla commercial.${t} existe`, commNames.includes(t));
    }

    const anTables = await newdbAdmin('information_schema.tables')
      .where({ table_schema: 'analytics' })
      .select('table_name');
    const anNames = anTables.map((t) => t.table_name);
    check('MV mv_sales_overview_30d existe', anNames.includes('mv_sales_overview_30d'));
    check('MV mv_top_customers_30d existe', anNames.includes('mv_top_customers_30d'));
    check('MV mv_top_products_30d existe', anNames.includes('mv_top_products_30d'));

    console.log('\n── 3. RLS habilitado (defense-in-depth) ──');
    const rlsRows = await newdbAdmin.raw(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relkind='r'
      AND relnamespace IN ('public'::regnamespace, 'commercial'::regnamespace)
      AND relname IN ('users','stores','daily_captures','customers','orders','order_lines','stock')
    `);
    for (const r of rlsRows.rows) {
      check(`RLS forced en ${r.relname}`, r.relforcerowsecurity === true, `relrowsecurity=${r.relrowsecurity} forced=${r.relforcerowsecurity}`);
    }

    console.log('\n── 4. Tenant Mega Dulces seedeado ──');
    const tenant = await newdbAdmin('tenants').where({ id: TENANT_ID }).first();
    check('tenant mega_dulces existe', !!tenant, `buscado id=${TENANT_ID}`);
    check('tenant activo', tenant?.activo === true);

    console.log('\n── 5. RLS bloquea sin contexto (runtime user) ──');
    const usersNoCtx = await newdbRuntime('users').count('* as n');
    check('users SIN tenant_id = 0 rows', Number(usersNoCtx[0].n) === 0, `actual=${usersNoCtx[0].n}`);

    await newdbRuntime.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);
      const usersWithCtx = await trx('users').count('* as n');
      check('users CON tenant_id > 0 rows', Number(usersWithCtx[0].n) > 0, `actual=${usersWithCtx[0].n}`);
    });

    console.log('\n── 6. Conteos legacy → nueva DB (proporción esperada) ──');
    const compareTables = [
      ['users', 'users'],
      ['stores', 'stores'],
      ['brands', 'brands'],
      ['products', 'products'],
      ['daily_captures', 'daily_captures'],
    ];
    for (const [legTab, newTab] of compareTables) {
      try {
        const legCount = await legacy(legTab).count('* as n');
        const newRow = await newdbAdmin(newTab).count('* as n');
        const L = Number(legCount[0].n);
        const N = Number(newRow[0].n);
        const ratio = L === 0 ? 1 : (N / L);
        check(`${legTab}: legacy=${L} new=${N} (${(ratio * 100).toFixed(1)}%)`, ratio >= 0.95, 'esperado ≥95%');
      } catch (e) {
        check(`compare ${legTab}`, false, e.message);
      }
    }

    console.log('\n── 7. Migraciones aplicadas en nueva DB ──');
    const migs = await newdbAdmin('knex_migrations').orderBy('id', 'desc').limit(5);
    check('knex_migrations no vacío', migs.length > 0);
    console.log('    Últimas 5 migraciones:');
    migs.forEach((m) => console.log(`      - ${m.name} (batch ${m.batch})`));

    console.log('\n── 8. Sequences orders inicializadas ──');
    const seqOk = await newdbAdmin('commercial.order_sequences').count('* as n');
    console.log(`    order_sequences rows: ${seqOk[0].n} (puede ser 0 si todavía no se creó un pedido)`);
  } finally {
    await legacy.destroy();
    await newdbAdmin.destroy();
    await newdbRuntime.destroy();
  }

  console.log('\n═══ RESUMEN ═══');
  console.log(`  OK:   ${pass}`);
  console.log(`  FAIL: ${fail}`);
  if (fail > 0) {
    console.log('\n  Fallas:');
    failures.forEach((f) => console.log(`    ✗ ${f}`));
    console.log('\n✗ NO PROCEDER con cutover hasta resolver fallas.');
    process.exit(1);
  } else {
    console.log('\n✓ Pre-flight OK. Listo para Fase 2 (sync delta + switch).');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('\n✗ Excepción fatal:', e.message);
  console.error(e.stack);
  process.exit(2);
});
