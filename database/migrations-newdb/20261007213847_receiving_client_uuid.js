/**
 * `[WMS-REC.19]` — **Abrir un vale y fechar una caducidad cuentan UNA vez, aunque la red falle.**
 *
 * Pedido de quien recibe (2026-10-07): con poco internet el Andén tiene que seguir funcionando y
 * mandar lo terminado solo cuando vuelve la conexión. Eso significa reintentar, y reintentar sin
 * una llave es peligroso acá:
 *
 *  - `receiving_lot_captures` ESCRIBE EXISTENCIA (verde/amarillo). Si el equipo manda una captura,
 *    el servidor la guarda y la respuesta se pierde, el reintento metía la mercancía DOS veces —
 *    y eso no se ve hasta un conteo físico.
 *  - `receiving_sessions`: un reintento de abrir el vale chocaba con su propio guardia
 *    (`folio_ya_recibido`) o, con `force`, abría un segundo vale del mismo camión.
 *
 * `client_uuid` es el id que el EQUIPO le pone a la operación antes de mandarla. El servidor
 * deduplica por (tenant_id, client_uuid) y devuelve lo que ya existe. Mismo patrón que
 * `commercial.orders` (mig 20260827120000).
 *
 * Índice único PARCIAL (sólo filas con uuid): las filas viejas quedan en NULL y no chocan. Sin
 * `deleted_at` en ninguna de las dos tablas: el estado vive en `status`.
 *
 * Grants: las dos tablas ya tienen SELECT/INSERT/UPDATE/DELETE para `app_runtime` a nivel tabla, así
 * que la columna nueva los hereda. RLS no cambia.
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS. Las dos tablas son
 * chicas (un renglón por camión, una fila por caducidad) y la columna nace en NULL: el índice se
 * construye al instante. El `lock_timeout` evita quedarse esperando detrás de una captura larga.
 *
 * @param { import("knex").Knex } knex
 */
const TABLAS = [
  { tabla: 'receiving_sessions', indice: 'ux_recv_sessions_client_uuid', que: 'abrir el vale' },
  { tabla: 'receiving_lot_captures', indice: 'ux_recv_lot_captures_client_uuid', que: 'la captura de lote y caducidad' },
];

exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  for (const { tabla, indice, que } of TABLAS) {
    await knex.raw(`ALTER TABLE commercial.${tabla} ADD COLUMN IF NOT EXISTS client_uuid uuid`);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${indice}
        ON commercial.${tabla} (tenant_id, client_uuid)
        WHERE client_uuid IS NOT NULL
    `);
    await knex.raw(`
      COMMENT ON COLUMN commercial.${tabla}.client_uuid IS
        'Id que el equipo le pone a ${que} antes de mandarla: un reintento devuelve la fila existente en vez de duplicarla — WMS-REC.19'
    `);
  }
};

exports.down = async function (knex) {
  for (const { tabla, indice } of TABLAS) {
    await knex.raw(`DROP INDEX IF EXISTS commercial.${indice}`);
    await knex.raw(`ALTER TABLE commercial.${tabla} DROP COLUMN IF EXISTS client_uuid`);
  }
};
