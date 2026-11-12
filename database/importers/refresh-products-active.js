/* eslint-disable no-console */
/**
 * `inventory.products_active` — ⛔ RETIRADO como cron 2026-11-12 `[CANON.6.13]`.
 *
 * Desde la migración `20261112135015_canon613_products_active_vista` es una VISTA sobre `catalog.products`
 * (+ subfamilia, categoría e imagen de `inventory.products`): la misma consulta que este script copiaba cada día
 * a las 05:20 con TRUNCATE + INSERT, ahora evaluada al leer. No hay nada que refrescar. Medido antes: la vista y
 * la tabla coincidían columna por columna salvo lo del día (4 nombres cambiados y 13 altas después de las 05:20),
 * y el cron fallaba el 20 % de las corridas. La tabla quedó como `inventory.products_active_congelada_20261112`.
 *
 * Queda como herramienta MANUAL sólo para lo que el cron nunca hizo (no pasaba `--reactivate`): el DRIFT de
 * activos — productos source=kepler, vivos en `kepler_ods.kdii`, con `activo=false`, no borrados ni
 * DESCONTINUADO.
 *
 *   node database/importers/refresh-products-active.js                      # sólo lectura: cuántos y la vista
 *   node database/importers/refresh-products-active.js --apply --reactivate # reactiva el drift
 */
const { Client } = require('pg');
const { declararActor } = require('./lib/declare-actor');

const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const APPLY = process.argv.includes('--apply');
const REACT = process.argv.includes('--reactivate');

const REACT_WHERE = `p.tenant_id=$1 AND p.source='kepler' AND p.deleted_at IS NULL AND p.activo=false
  AND p.nombre NOT ILIKE '%DESCONTINUADO%'
  AND EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.c1)=p.sku AND btrim(coalesce(k.c2,'')) <> '')`;

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 120000 });
  await c.connect();
  await declararActor(c, 'refresh-products-active');
  try {
    console.log(`\n=== inventory.products_active (${APPLY && REACT ? 'APPLY --reactivate' : 'SÓLO LECTURA'}) ===\n`);
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${M}'`);
    const tipo = (await c.query(`SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                                  WHERE n.nspname='inventory' AND c.relname='products_active'`)).rows[0];
    const filas = Number((await c.query(`SELECT count(*)::int n FROM inventory.products_active`)).rows[0].n);
    const reactN = Number((await c.query(`SELECT count(*)::int n FROM catalog.products p WHERE ${REACT_WHERE}`, [M])).rows[0].n);
    console.log(`  inventory.products_active: ${tipo && tipo.relkind === 'v' ? 'VISTA' : 'TABLA (falta aplicar la migración 20261112135015)'} · ${filas} filas`);
    console.log(`  drift a reactivar (kepler vivo, activo=false, no descontinuado): ${reactN}`);
    if (!(APPLY && REACT)) { await c.query('ROLLBACK'); console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const r = await c.query(`UPDATE catalog.products p SET activo=true, updated_at=now() WHERE ${REACT_WHERE}`, [M]);
    await c.query('COMMIT');
    console.log(`\n  ✓ reactivados: ${r.rowCount}${tipo && tipo.relkind === 'v' ? ' (la vista los ve ya)' : ''}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await c.end().catch(() => {}); }
})();
