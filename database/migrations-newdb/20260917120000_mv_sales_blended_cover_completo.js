/**
 * [DB-MEM.13] Al índice cubridor del tablero le faltaban DOS columnas, y por esas dos no servía.
 *
 * `ix_mv_sales_blended_cover` (mig 20260903140000) se creó exactamente para que las consultas del
 * Command Center leyeran sin tocar el heap:
 *
 *     (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)
 *
 * Pero las tres consultas que lo necesitan piden una columna que no está ahí, así que ninguna
 * logra el `Index Only Scan` y las tres terminan barriendo la matvista entera (1,459 MB):
 *
 *   #5  overview por canal ...... pide `MAX(updated_at)`  -> falta `updated_at`
 *   #6  ventas por marca ........ hace join por product_id -> falta `product_id`
 *   #7  top de productos ........ hace join por product_id -> falta `product_id`
 *
 * Medido en prod (2026-09-17), con la MISMA consulta, quitándole el campo que falta:
 *
 *   #5 tal como está hoy ................ 199,641 páginas (1,560 MB) · toca el heap
 *   #5 sin MAX(updated_at) .............   22,218 páginas (  174 MB) · INDEX-ONLY
 *
 *   agregado por canal (todo en el índice)  21,837 páginas (  171 MB) · INDEX-ONLY
 *   agregado por product_id (falta) ....   199,599 páginas (1,559 MB) · toca el heap
 *
 * O sea que el índice de 355 MB que ya se paga hoy **no se está usando para lo que se creó**
 * (16 usos acumulados). Con las dos columnas agregadas, las tres consultas pasan de leer
 * 1,559 MB a 171 MB: **9× menos páginas**. En prod promedian 55 s cada una porque la caché está
 * fría (87.78% de aciertos sobre 31 GB), así que las páginas son la medida honesta, no los ms.
 *
 * COSTO: +24 bytes por fila (uuid 16 + timestamp 8) × 4,530,276 filas = **+104 MB**
 * (el índice pasa de 355 MB a ~459 MB). Se paga una vez por noche: `mv_sales_blended` se
 * refresca NIGHTLY (`analytics_refresh_blended`), no en el cron de 15 min — verificado en
 * `analytics-refresh.service.ts:121`. Si alguna vez se moviera al array de 15 minutos, este
 * índice habría que re-evaluarlo.
 *
 * ⚠️ POR QUÉ SE CREA CON OTRO NOMBRE Y LUEGO SE BORRA EL VIEJO. No se puede reemplazar un índice
 * "en el lugar": entre el DROP y el CREATE las consultas quedarían sin cubridor. Se crea el nuevo
 * CONCURRENTLY, se verifica que existe, y recién entonces se borra el viejo. El nombre nuevo se
 * queda (renombrar no aporta y agrega un paso que puede fallar a medias).
 *
 * ⚠️ `CONCURRENTLY` NO PUEDE CORRER DENTRO DE UNA TRANSACCIÓN, y knex envuelve cada migración en
 * una. Por eso esta migración se aplica con `disableTransactions` (ver abajo) y se corre SOLA,
 * nunca dentro de un `migrate:latest` de lote.
 *
 * ⚠️ VENTANA: construir ~459 MB de índice es escritura pesada. Correr de madrugada, y NO entre
 * las 03:00 y las 04:39 MX, que es cuando corre `feed_nightly` (mide 69–99 min desde las 03:00)
 * y justamente ahí se refresca esta matvista.
 */

const NUEVO = 'ix_mv_sales_blended_cover2';
const VIEJO = 'ix_mv_sales_blended_cover';

exports.config = { transaction: false };

exports.up = async function up(knex) {
  const ya = await knex.raw(`SELECT to_regclass(?) AS x`, [`analytics.${NUEVO}`]);
  if (!ya.rows[0].x) {
    // Sin statement_timeout: construir el índice tarda minutos y CONCURRENTLY no bloquea lecturas.
    await knex.raw(`SET statement_timeout = 0`);
    await knex.raw(`CREATE INDEX CONCURRENTLY ${NUEVO}
      ON analytics.mv_sales_blended (tenant_id, sale_date)
      INCLUDE (channel, revenue, cost, units, product_id, updated_at)`);
  }

  // El viejo se borra SOLO si el nuevo quedó válido. Un CONCURRENTLY que falla a mitad deja el
  // índice marcado `indisvalid = false`: existe, pesa, y no lo usa nadie. Borrar el cubridor
  // viejo confiando en uno inválido dejaría a las tres consultas peor que antes.
  const ok = await knex.raw(
    `SELECT i.indisvalid AS valido FROM pg_index i WHERE i.indexrelid = to_regclass(?)`,
    [`analytics.${NUEVO}`],
  );
  if (!ok.rows[0] || ok.rows[0].valido !== true) {
    throw new Error(
      `${NUEVO} no quedó válido (CONCURRENTLY interrumpido). Borralo con ` +
      `DROP INDEX CONCURRENTLY analytics.${NUEVO} y volvé a correr esta migración. ` +
      `NO se tocó ${VIEJO}.`,
    );
  }

  if ((await knex.raw(`SELECT to_regclass(?) AS x`, [`analytics.${VIEJO}`])).rows[0].x) {
    await knex.raw(`SET statement_timeout = 0`);
    await knex.raw(`DROP INDEX CONCURRENTLY analytics.${VIEJO}`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`SET statement_timeout = 0`);
  const hayViejo = await knex.raw(`SELECT to_regclass(?) AS x`, [`analytics.${VIEJO}`]);
  if (!hayViejo.rows[0].x) {
    await knex.raw(`CREATE INDEX CONCURRENTLY ${VIEJO}
      ON analytics.mv_sales_blended (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`);
  }
  if ((await knex.raw(`SELECT to_regclass(?) AS x`, [`analytics.${NUEVO}`])).rows[0].x) {
    await knex.raw(`DROP INDEX CONCURRENTLY analytics.${NUEVO}`);
  }
};
