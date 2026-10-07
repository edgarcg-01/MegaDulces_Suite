/**
 * Backfill ruta-hogar de tiendas desde sus capturas (ruta-hogar, última gana).
 *
 * Aplica retroactivamente la misma regla que el hook `maybeAssignStoreRoute`:
 * cada tienda hereda la ruta de su captura MÁS RECIENTE que declaró `route_id`.
 * Sin esto, el apartado Rutas solo refleja la nueva regla sobre capturas
 * futuras; este script alinea la data histórica de inmediato.
 *
 * Regla (por tienda):
 *   ruta-hogar = route_id de la captura más reciente con store_id = tienda
 *   y route_id NOT NULL, ordenando por hora_inicio DESC, luego created_at DESC.
 *
 * Notas:
 *   - Solo capturas posteriores a la migración 20260603190000 tienen route_id;
 *     tiendas capturadas solo antes de eso no se tocan (no hay de dónde inferir).
 *   - Scoped por tenant_id (join store↔capture mismo tenant). La conexión por
 *     DATABASE_URL es owner y bypassa RLS, así que el filtro es explícito.
 *   - Idempotente: solo escribe donde stores.ruta_id difiere del inferido
 *     (IS DISTINCT FROM, igual que el hook en runtime).
 *   - Dry-run por DEFAULT. Para escribir: --apply.
 *
 * Uso:
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-store-route-from-captures.js          # dry-run
 *   DATABASE_URL='postgres://...' node database/scripts/backfill-store-route-from-captures.js --apply  # escribe
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
    // Guard: si daily_captures.route_id no existe (DB previa a 20260603190000),
    // no hay nada que inferir.
    // daily_captures puede ser una VISTA passthrough (schema field_ops); hasColumn
    // contra public da falso negativo. Probamos con un SELECT real (respeta search_path).
    let hasRouteId = true;
    try { await db.raw('SELECT route_id FROM daily_captures LIMIT 1'); }
    catch { hasRouteId = false; }
    if (!hasRouteId) {
      console.log('daily_captures.route_id no existe — nada que backfillear.');
      return;
    }
    const hasUpdatedAt = await db.schema.hasColumn('stores', 'updated_at');

    // Ruta más reciente declarada por tienda (mismo tenant). DISTINCT ON toma
    // la primera fila por store_id según el ORDER BY → la captura más reciente.
    const latest = await db
      .select('dc.store_id', 'dc.route_id', 's.tenant_id', 's.ruta_id as current_ruta_id', 's.nombre')
      .from('daily_captures as dc')
      .join('stores as s', function () {
        this.on('s.id', '=', 'dc.store_id').andOn('s.tenant_id', '=', 'dc.tenant_id');
      })
      .whereNotNull('dc.store_id')
      .whereNotNull('dc.route_id')
      .whereNull('s.deleted_at')
      .distinctOn('dc.store_id')
      .orderBy([
        { column: 'dc.store_id' },
        { column: 'dc.hora_inicio', order: 'desc', nulls: 'last' },
        { column: 'dc.created_at', order: 'desc' },
      ]);

    console.log(`Modo: ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe)'}`);
    console.log(`Tiendas con capturas que declararon ruta: ${latest.length}\n`);

    const toFix = latest.filter((r) => r.current_ruta_id !== r.route_id);
    let fixed = 0;

    await db
      .transaction(async (trx) => {
        for (const r of toFix) {
          console.log(
            `  ${APPLY ? 'FIX' : 'WOULD-FIX'} ${r.nombre || r.store_id}: ` +
              `${r.current_ruta_id || 'NULL'} → ${r.route_id}`,
          );
          if (APPLY) {
            const update = { ruta_id: r.route_id };
            if (hasUpdatedAt) update.updated_at = trx.fn.now();
            await trx('stores')
              .where({ id: r.store_id, tenant_id: r.tenant_id })
              .whereRaw('ruta_id IS DISTINCT FROM ?', [r.route_id])
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

    console.log(
      `\n${APPLY ? 'Reasignadas' : 'A reasignar'}: ${toFix.length}. ` +
        `Sin cambio: ${latest.length - toFix.length}.`,
    );
    if (!APPLY && toFix.length > 0) {
      console.log('Re-ejecutá con --apply para persistir.');
    }
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
