/**
 * Backfill zona-hogar de tiendas desde su ruta (zona-hogar = zona de la ruta).
 *
 * Una ruta pertenece a UNA zona (catalogs.parent_id → zones). El invariante es
 * `stores.zona_id == zona de su ruta`. Cuando una tienda queda con zona_id NULL
 * o de otra zona, el apartado Rutas la fragmenta: la misma ruta aparece en
 * varias filas (ej. "RUTA 23 / LA PIEDAD RD" y "RUTA 23 / —"). Este script
 * alinea la zona de cada tienda a la de su ruta.
 *
 * Complementa al hook `maybeAssignStoreRoute` (que ya alinea zona en capturas
 * futuras) aplicando la corrección a la data histórica de inmediato.
 *
 * Regla (por tienda con ruta_id no nulo):
 *   zona-hogar = catalogs.parent_id de su ruta (solo si parent_id NOT NULL).
 *   Se escribe únicamente donde stores.zona_id IS DISTINCT FROM esa zona.
 *   Nunca borra una zona existente cuando la ruta no declara zona (parent_id NULL).
 *
 * Notas:
 *   - Scoped por tenant_id (join store↔ruta mismo tenant). La conexión por
 *     DATABASE_URL es owner y bypassa RLS, así que el filtro es explícito.
 *   - Idempotente (IS DISTINCT FROM). Dry-run por DEFAULT. Para escribir: --apply.
 *
 * Uso:
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-store-zone-from-route.js          # dry-run
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-store-zone-from-route.js --apply  # escribe
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');

const db = knex({
  client: 'pg',
  connection: {
    connectionString: DATABASE_URL,
    ssl: /railway|rlwy|proxy|amazonaws/i.test(DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
  },
  pool: { min: 0, max: 4 },
});

(async () => {
  try {
    const hasUpdatedAt = await db.schema.hasColumn('stores', 'updated_at');

    // Tiendas vivas con ruta cuya zona (parent_id de la ruta) difiere de su zona_id.
    const rows = await db
      .select(
        's.id',
        's.nombre',
        's.tenant_id',
        's.zona_id as current_zona_id',
        'c.parent_id as route_zona_id',
        'zc.name as route_zona_name',
        'zs.name as current_zona_name',
        'c.value as route_name',
      )
      .from('stores as s')
      .join('catalogs as c', function () {
        this.on('c.id', '=', 's.ruta_id')
          .andOn('c.tenant_id', '=', 's.tenant_id')
          .andOnVal('c.catalog_id', '=', 'rutas');
      })
      .leftJoin('zones as zc', 'zc.id', 'c.parent_id')
      .leftJoin('zones as zs', 'zs.id', 's.zona_id')
      .whereNull('s.deleted_at')
      .whereNotNull('c.parent_id')
      .whereRaw('s.zona_id IS DISTINCT FROM c.parent_id');

    console.log(`Modo: ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'}`);
    console.log(`Tiendas a alinear: ${rows.length}\n`);

    let fixed = 0;
    await db
      .transaction(async (trx) => {
        for (const r of rows) {
          console.log(
            `  ${APPLY ? 'FIX' : 'WOULD-FIX'} ${r.nombre || r.id} [${r.route_name}]: ` +
              `zona "${r.current_zona_name || '—'}" → "${r.route_zona_name || r.route_zona_id}"`,
          );
          if (APPLY) {
            const update = { zona_id: r.route_zona_id };
            if (hasUpdatedAt) update.updated_at = trx.fn.now();
            await trx('stores')
              .where({ id: r.id, tenant_id: r.tenant_id })
              .whereRaw('zona_id IS DISTINCT FROM ?', [r.route_zona_id])
              .update(update);
            fixed++;
          }
        }
        if (!APPLY) await trx.rollback(new Error('__dry_run__'));
      })
      .catch((e) => {
        if (e && e.message === '__dry_run__') return;
        throw e;
      });

    console.log(`\n${APPLY ? `Alineadas: ${fixed}` : `A alinear: ${rows.length}`}.`);
    if (!APPLY && rows.length > 0) console.log('Re-ejecutá con --apply para persistir.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
