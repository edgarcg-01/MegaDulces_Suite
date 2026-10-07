/* eslint-disable no-console */
/**
 * Thot (ADR-018) — construye `intelligence.pdv_presence` desde las capturas de Trade.
 *
 * Proyecta `daily_captures.exhibiciones.productosMarcados` (qué exhibe físicamente
 * el PdV) al nivel cliente, uniendo `commercial.customers.store_id → daily_captures.store_id`.
 * Es un build app-DB → app-DB (las capturas viven en `postgres_platform`, NO en el ERP),
 * más simple que thot-build-features.js. DELETE+INSERT por tenant, idempotente.
 *
 * Solo conserva product_ids que existen en catalog.products (descarta UUIDs viejos).
 * Corre: node database/scripts/thot-build-pdv-presence.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const Knex = require('knex');

const T = '00000000-0000-0000-0000-00000000d01c';

(async () => {
  const app = Knex({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
  try {
    const rows = (
      await app.raw(
        `
        WITH marks AS (
          SELECT c.id AS customer_id, pid AS product_text,
                 COUNT(*)::int AS marks,
                 COUNT(DISTINCT dc.id)::int AS capture_count,
                 MAX(dc.created_at) AS last_seen
          FROM commercial.customers c
          JOIN public.daily_captures dc
            ON dc.store_id = c.store_id AND dc.tenant_id = c.tenant_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE jsonb_typeof(dc.exhibiciones) WHEN 'array' THEN dc.exhibiciones ELSE '[]'::jsonb END) ex
          CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ex->'productosMarcados','[]'::jsonb)) pid
          WHERE c.tenant_id = ? AND c.store_id IS NOT NULL AND c.deleted_at IS NULL
            AND pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          GROUP BY c.id, pid
        )
        SELECT m.customer_id, m.product_text::uuid AS product_id,
               m.marks, m.capture_count, m.last_seen
        FROM marks m
        JOIN catalog.products p
          ON p.id = m.product_text::uuid AND p.tenant_id = ? AND p.deleted_at IS NULL
        `,
        [T, T],
      )
    ).rows;

    const inserts = rows.map((r) => ({
      tenant_id: T,
      customer_id: r.customer_id,
      product_id: r.product_id,
      marks: Number(r.marks) || 0,
      capture_count: Number(r.capture_count) || 0,
      last_seen: r.last_seen || null,
    }));

    await app.transaction(async (trx) => {
      await trx('intelligence.pdv_presence').where({ tenant_id: T }).del();
      if (inserts.length) await trx.batchInsert('intelligence.pdv_presence', inserts, 1000);
    });

    const customers = new Set(inserts.map((r) => r.customer_id)).size;
    console.log(`pdv_presence: ${inserts.length} filas (${customers} clientes con presencia)`);
    console.log('OK.');
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await app.destroy();
  }
})();
