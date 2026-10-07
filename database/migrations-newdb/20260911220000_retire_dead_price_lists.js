/**
 * `[NORM.1]` Retira las listas de precio MUERTAS: `P1`–`P4` y `MAYOREO`.
 *
 * ── Qué son y por qué estorban ───────────────────────────────────────────────────────────
 * `commercial.product_prices` tiene 44,982 filas y **35,490 (79 %) no las actualiza nadie**.
 * Son cinco listas cuyo importer (`import-prices-bulk.js`) se **retiró en CANON.0.2** por ser
 * dato muerto; las filas quedaron. Medido en prod el 2026-09-11:
 *
 *   BASE-MXN   9,566 filas · último cambio HOY          ← la única viva
 *   MAYOREO    7,098 filas · congelada hace 26 días
 *   P1 … P4    7,098 c/u   · congeladas hace 26 días
 *
 * ⛔ **Y la de nombre más peligroso es la peor.** El mayoreo REAL vive en
 * `commercial.product_label_prices.wholesale_*` y se recalcula cada 30 min desde el ODS. Pero
 * además existe una lista **llamada `MAYOREO`** con precios de hace 26 días: quien busque
 * "precios de mayoreo" va a unir por la que se llama así y va a publicar cifras viejas. Eso no
 * es una fila de sobra: es una trampa con nombre propio.
 *
 * La vista `analytics.v_product_volume_tiers` (mig 20260826140000) ya dice en su encabezado que
 * **"reemplaza las listas P1-P4/MAYOREO congeladas"** y sólo une `BASE-MXN`. O sea que el
 * reemplazo ya existe hace dos semanas y estas filas son puro residuo.
 *
 * ── Lo que se borra y lo que NO ──────────────────────────────────────────────────────────
 * Se borran **las filas de precio**. Las filas de `price_lists` se conservan y sólo se marcan
 * `active = false`, por dos motivos medidos:
 *   · `commercial.orders(tenant_id, price_list_id)` tiene FK `ON DELETE SET NULL` → borrar la
 *     lista le borraría a un pedido histórico con qué lista se cotizó.
 *   · `commercial.customers(tenant_id, default_price_list_id)`, lo mismo.
 * Conservar la definición cuesta 5 filas y preserva el significado de lo que ya pasó.
 *
 * ── La guarda, y por qué no es decorativa ────────────────────────────────────────────────
 * En PROD hoy: **0 clientes y 0 pedidos** citan una lista muerta (434 clientes y 35 pedidos
 * están en `BASE-MXN`). Pero esta migración corre también en dev y en cualquier entorno futuro,
 * donde alguien pudo dejar un cliente colgado de `P3`. Si aparece uno, **aborta**: borrarle los
 * precios a la lista de un cliente le cambia lo que paga, y eso no puede pasar en silencio.
 *
 * ⚠️ **Irreversible.** `import-prices-bulk.js` está retirado, así que estas filas **no se pueden
 * regenerar**. El `down` no las restaura y lo dice. Respaldo tomado antes de aplicar:
 * `c:/tmp/backup-product_prices-listas-muertas-20260911.json` (35,490 filas, 14.56 MB) — fuera
 * del repo a propósito: no se versiona data de prod.
 *
 * @param { import("knex").Knex } knex
 */

/** Las cinco, por código. Nombrarlas es el alcance: no se borra "todo lo que no es BASE-MXN". */
const MUERTAS = ['P1', 'P2', 'P3', 'P4', 'MAYOREO'];

exports.up = async function up(knex) {
  // ── Guarda 1: nadie las está usando ────────────────────────────────────────────────────
  const { rows: enUso } = await knex.raw(
    `SELECT pl.code,
            (SELECT count(*) FROM commercial.customers cu
              WHERE cu.tenant_id = pl.tenant_id AND cu.default_price_list_id = pl.id
                AND cu.deleted_at IS NULL) AS clientes,
            (SELECT count(*) FROM commercial.orders o
              WHERE o.tenant_id = pl.tenant_id AND o.price_list_id = pl.id) AS pedidos
       FROM commercial.price_lists pl
      WHERE pl.code = ANY(?)`,
    [MUERTAS],
  );
  const ocupadas = enUso.filter((r) => Number(r.clientes) > 0 || Number(r.pedidos) > 0);
  if (ocupadas.length) {
    throw new Error(
      '[NORM.1] ABORTA: hay listas muertas EN USO en este entorno — ' +
        ocupadas.map((r) => `${r.code}: ${r.clientes} cliente(s), ${r.pedidos} pedido(s)`).join(' · ') +
        '. Borrarles los precios cambiaría lo que paga alguien. Resolver a mano antes de correr esto.',
    );
  }

  // ── El borrado ─────────────────────────────────────────────────────────────────────────
  // Se acota por JOIN con la lista (que lleva `tenant_id`), así que es correcto multi-tenant
  // sin depender del GUC de RLS.
  const del = await knex.raw(
    `DELETE FROM commercial.product_prices pp
      USING commercial.price_lists pl
      WHERE pl.id = pp.price_list_id AND pl.tenant_id = pp.tenant_id
        AND pl.code = ANY(?)`,
    [MUERTAS],
  );

  // ── Y la lista queda marcada, no borrada ───────────────────────────────────────────────
  const upd = await knex.raw(
    `UPDATE commercial.price_lists
        SET active = false, updated_at = now(),
            notes = coalesce(nullif(btrim(notes), '') || ' · ', '')
                    || '[NORM.1 2026-09-11] Retirada: su importer (import-prices-bulk) se quito en '
                    || 'CANON.0.2 y las filas quedaron congeladas. El mayoreo real vive en '
                    || 'commercial.product_label_prices.wholesale_*; los tramos por volumen, en '
                    || 'analytics.v_product_volume_tiers.'
      WHERE code = ANY(?) AND active IS DISTINCT FROM false`,
    [MUERTAS],
  );

  console.log(
    `[NORM.1] precios borrados: ${del.rowCount} · listas marcadas inactivas: ${upd.rowCount}`,
  );
};

/**
 * No restaura los precios: son irreproducibles (su importer está retirado) y el respaldo vive
 * fuera del repo. Lo único reversible es la marca de la lista, y eso sí se deshace.
 */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE commercial.price_lists SET active = true, updated_at = now()
                   WHERE code = ANY(?)`, [MUERTAS]);
  console.log(
    '[NORM.1] listas reactivadas. ⚠️ Los 35,490 precios NO se restauran — el respaldo está en ' +
      'c:/tmp/backup-product_prices-listas-muertas-20260911.json, fuera del repo.',
  );
};
