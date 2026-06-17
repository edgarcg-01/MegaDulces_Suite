/**
 * Vacía stores.ruta_id de las tiendas asignadas a rutas de la zona ZAMORA VECINAL
 * (asignación masiva errónea del 16-jun). Preserva las que SÍ tienen una captura
 * que declaró esa ruta (esas son reales — auto-llenado legítimo).
 * Las vaciadas se rellenan solas vía el hook maybeAssignStoreRoute al capturarlas.
 *
 * DRY-RUN por default. Para escribir: --apply.
 * Uso: DATABASE_URL='postgres://...' node database/scripts/fix-empty-zamora-vecinal.js --apply
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const ZONE = 'ZAMORA VECINAL';

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 4 },
});

(async () => {
  try {
    const rutas = await db.raw(
      `SELECT c.id, c.value FROM catalogs c
       JOIN zones z ON z.id = c.parent_id
       WHERE c.catalog_id='rutas' AND z.name = ? AND c.deleted_at IS NULL`,
      [ZONE],
    );
    const ids = rutas.rows.map((r) => r.id);
    if (!ids.length) { console.log(`No hay rutas en zona "${ZONE}".`); return; }
    console.log(`Rutas en "${ZONE}": ${rutas.rows.map((r) => r.value).join(', ')}`);

    const ph = ids.map(() => '?').join(',');
    const count = async (sql, params) => Number((await db.raw(sql, params)).rows[0].n);

    const toEmpty = await count(
      `SELECT count(*)::int n FROM stores
       WHERE deleted_at IS NULL AND ruta_id IN (${ph})
         AND id NOT IN (SELECT dc.store_id FROM daily_captures dc
                        WHERE dc.store_id IS NOT NULL AND dc.route_id IN (${ph}))`,
      [...ids, ...ids],
    );
    const preserved = await count(
      `SELECT count(*)::int n FROM stores
       WHERE deleted_at IS NULL AND ruta_id IN (${ph})
         AND id IN (SELECT dc.store_id FROM daily_captures dc
                    WHERE dc.store_id IS NOT NULL AND dc.route_id IN (${ph}))`,
      [...ids, ...ids],
    );
    console.log(`A vaciar: ${toEmpty}. Preservadas (captura real en la ruta): ${preserved}.`);

    if (APPLY) {
      const res = await db.raw(
        `UPDATE stores SET ruta_id = NULL
         WHERE deleted_at IS NULL AND ruta_id IN (${ph})
           AND id NOT IN (SELECT dc.store_id FROM daily_captures dc
                          WHERE dc.store_id IS NOT NULL AND dc.route_id IN (${ph}))`,
        [...ids, ...ids],
      );
      console.log(`✓ Vaciadas: ${res.rowCount}.`);
    } else {
      console.log('DRY-RUN — re-ejecutá con --apply para vaciar.');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
