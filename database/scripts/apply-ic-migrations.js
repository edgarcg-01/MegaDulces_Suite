'use strict';
/**
 * [IC] Aplica a prod SÓLO las 4 migraciones de esta fase, UNA POR UNA.
 *
 * ⛔ NO usa knex.migrate.latest(): la rama la comparten ~10 sesiones y en cualquier momento
 *    hay migraciones AJENAS pendientes. `latest()` las aplicaría todas, sin importar cuál se
 *    autorizó. Patrón de reference_prod_knex_migrations_table.
 * ⛔ Registra en `public.knex_migrations` CALIFICADO: el search_path lleva a
 *    `identity.knex_migrations`, que está VACÍA — leer la equivocada hace creer que faltan
 *    cientos de migraciones.
 *
 * ⛔ EXIGE UN ROL CON DDL. Los schemas `analytics`, `commercial` e `identity` son propiedad
 *    de `postgres`. Medido el 2026-09-29: el rol `edgar` (el de las credenciales de
 *    diagnóstico) NO puede ninguna de las tres cosas que hacen falta —
 *      CREATE en analytics ........... permission denied for schema analytics
 *      UPDATE en role_permissions .... permission denied for table role_permissions
 *      ALTER en inventory_count_items. must be owner of table
 *    así que el script FALLA LIMPIO en la primera y no deja nada a medias.
 *
 * Uso:  node database/scripts/apply-ic-migrations.js                  → dry-run
 *       node database/scripts/apply-ic-migrations.js --apply          → aplica
 *       IC_DB_URL=postgresql://... node ... --apply                   → con otra credencial
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const MIGS = [
  '20260928260000_erp_physical_count_variance_view.js',   // IC.0  CREATE VIEW
  '20260928270000_inventory_counting_segregation.js',     // IC.2  UPDATE 4 filas
  '20260928280000_inventory_count_items_unit.js',         // IC.1  ADD COLUMN x3 (nullable)
  '20260928290000_sku_count_variance_history_view.js',    // IC.3  CREATE VIEW
  '20260929120000_count_priority_score_view.js',         // IC.4  CREATE VIEW
  '20260929130000_inventory_kepler_export_ack.js',       // IC.7  CREATE TABLE + RLS
];

(async () => {
  const URL = process.env.IC_DB_URL || process.env.DATABASE_URL_NEW;
  if (!URL) { console.error('falta IC_DB_URL o DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(URL) ? false : { rejectUnauthorized: false } });
  await c.connect();
  // El cinturón de sesión se apaga; lo que de verdad protege son los GRANT.
  await c.query('SET default_transaction_read_only = off');
  await c.query(`SET statement_timeout = '120s'`);

  for (const name of MIGS) {
    const ya = await c.query('SELECT 1 FROM public.knex_migrations WHERE name = $1', [name]);
    if (ya.rowCount) { console.log(`\n=== ${name}\n    YA APLICADA — se omite`); continue; }

    const mig = require(path.join(ROOT, 'database/migrations-newdb', name));
    console.log(`\n=== ${name}`);

    if (!APPLY) {
      // Captura el SQL SIN ejecutarlo, para poder leerlo antes de aplicar.
      const sqls = [];
      const fake = {
        raw: async (s) => { sqls.push(String(s)); return { rows: [{ ok: true }] }; },
        schema: { withSchema: () => ({ hasColumn: async () => false, alterTable: async () => { sqls.push('[alterTable ADD COLUMN]'); } }) },
      };
      try { await mig.up(fake); } catch (e) { console.log(`    (captura parcial: ${e.message.slice(0, 80)})`); }
      sqls.forEach((s, i) => console.log(`    [${i + 1}] ${s.trim().slice(0, 110).replace(/\s+/g, ' ')}…`));
      continue;
    }

    const knex = require('knex')({
      client: 'pg',
      connection: { connectionString: URL, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(URL) ? false : { rejectUnauthorized: false } },
      pool: { min: 0, max: 1, afterCreate: (conn, done) => conn.query('SET default_transaction_read_only = off', () => done(null, conn)) },
    });
    const t0 = Date.now();
    try {
      await knex.transaction(async (trx) => {
        // lock_timeout corto: es horario hábil. Si algo está bloqueando, se aborta rápido en
        // vez de hacer cola sobre una tabla que otros están usando.
        await trx.raw(`SET LOCAL lock_timeout = '5s'`);
        await mig.up(trx);
        const [{ b }] = (await trx.raw('SELECT coalesce(max(batch),0)+1 AS b FROM public.knex_migrations')).rows;
        await trx.raw('INSERT INTO public.knex_migrations (name, batch, migration_time) VALUES (?, ?, now())', [name, b]);
        console.log(`    ✔ aplicada en ${Date.now() - t0} ms (batch ${b})`);
      });
    } catch (e) {
      console.error(`    ✘ FALLÓ: ${e.message}`);
      if (/permission denied|must be owner/i.test(e.message)) {
        console.error('      → falta un rol con DDL sobre ese objeto. Ver la cabecera del script.');
      }
      await knex.destroy(); await c.end(); process.exit(1);
    }
    await knex.destroy();
  }
  await c.end();
  console.log(APPLY ? '\nlisto.' : '\n(dry-run — usar --apply)');
})().catch((e) => { console.error('ERR', e.message.slice(0, 250)); process.exit(1); });
