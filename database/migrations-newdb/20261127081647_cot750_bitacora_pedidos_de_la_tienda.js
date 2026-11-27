'use strict';
/**
 * `[COT.7.50]` — **`commercial.store_orders`: un renglón por cada pedido que la tienda nos entrega,
 * haya entrado o no.**
 *
 * ⛔⛔ **Por qué tiene que existir ANTES de encender el disparo en Wix.** Hoy el webhook decide y
 * contesta 200; un pedido que **no se puede armar** —SKU que no está en el mostrador, unidad que no
 * se resuelve— vuelve a Wix como recibido y **no deja rastro en ningún lado**: ni fila, ni
 * cotización, ni nada que una persona pueda encontrar después. El cliente ya pagó. Sin esta tabla,
 * el primer rechazo se pierde para siempre y la pantalla que lo mire va a ver **cero rechazos**,
 * que es indistinguible de «todo entró bien».
 *
 * Una fila por `(tenant_id, origen, numero)`, con el pedido **ya mapeado** guardado en `carga` para
 * que se pueda rescatar a mano sin volver a Wix, y `entregas` contando cuántas veces llegó el mismo
 * aviso (un webhook se reintenta).
 *
 * ── Lo que la tabla NO puede decir, por restricción ──────────────────────────────────────────
 *  · un rechazo **sin motivo** → `store_orders_motivo_ck`
 *  · un «creado» **sin cotización** → `store_orders_creado_ck`
 *
 * ── Lo que esta tabla NO es ──────────────────────────────────────────────────────────────────
 *  · ⛔ **No es el candado contra duplicados.** Eso lo sigue haciendo `yaEntro()` contra
 *    `commercial.quotes`, que es lo que de verdad no puede duplicarse. Esta tabla es el **libro**.
 *  · ⛔ No guarda el cuerpo crudo de Wix: guarda el `PedidoTienda` ya normalizado (sin ids ni
 *    internals de la tienda). El crudo sigue estando en Wix.
 *
 * ⚠️ **NO MEDIDO:** una entrega que muere **antes** de decidir (proceso caído, error inesperado) no
 * deja fila — ese caso contesta 5xx y Wix reintenta, así que el rastro queda en el reintento, no acá.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'store_orders';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable(TABLA))) {
    await knex.schema.withSchema('commercial').createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      /** De qué tienda vino. Hoy sólo `wix`; la columna existe para no tener que migrar al segundo. */
      t.text('origen').notNullable().defaultTo('wix');
      /** El número del pedido EN LA TIENDA (`11229`), que es lo que una persona puede buscar allá. */
      t.text('numero').notNullable();
      /** `creado` = hay cotización · `rechazado` = no se pudo armar y nadie lo sabría sin esta fila. */
      t.text('estado').notNullable();
      /** Por qué se rechazó, o qué falló de Kepler con la cotización ya creada. */
      t.text('motivo');
      t.uuid('quote_id');
      t.text('quote_code');
      t.text('kepler_sucursal');
      t.text('kepler_folio');
      /** Tal como llegaron de la tienda, para poder declarar después por qué se tomó o no. */
      t.text('pago');
      t.text('estatus_tienda');
      t.text('comprador');
      /** ⛔ NO hay columna de total: el mapeo no trae un total medido y sumar precio × cantidad
       *  lo inventaría (ignora envío y descuentos). Cada `precio_tienda` vive en `carga`. */
      t.integer('renglones');
      /** El `PedidoTienda` ya mapeado: con esto se rescata a mano sin volver a Wix. */
      t.jsonb('carga').notNullable().defaultTo(knex.raw(`'{}'::jsonb`));
      /** Cuántas veces llegó el MISMO aviso. Un webhook se reintenta; eso no es un pedido más. */
      t.integer('entregas').notNullable().defaultTo(1);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('deleted_at', { useTz: true });
    });
  }

  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_estado_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_estado_ck
                    CHECK (estado IN ('creado','rechazado'))`);
  // Un rechazo SIN motivo sería justo el hueco que esta tabla existe para tapar.
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_motivo_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_motivo_ck
                    CHECK (estado <> 'rechazado' OR motivo IS NOT NULL)`);
  // Y un «creado» sin cotización sería una fila que afirma lo que no pasó.
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_creado_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_creado_ck
                    CHECK (estado <> 'creado' OR quote_id IS NOT NULL)`);

  // La llave del libro: un pedido de la tienda es UNO, por más veces que lo entreguen.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_numero
                    ON commercial.${TABLA} (tenant_id, origen, numero)`);
  // Lo que va a preguntar la pantalla: los últimos, y los rechazados primero.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_recientes
                    ON commercial.${TABLA} (tenant_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_rechazados
                    ON commercial.${TABLA} (tenant_id, created_at DESC) WHERE estado = 'rechazado'`);

  await knex.raw(`ALTER TABLE commercial.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON commercial.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON commercial.${TABLA}
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  // UPDATE hace falta: el upsert sube `entregas` cuando el mismo aviso vuelve a llegar.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.${TABLA} TO app_runtime`);

  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.${TABLA}`);
  console.log(`[cot750_bitacora_tienda] commercial.${TABLA} lista · ${rows[0].n} filas`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.${TABLA}`);
};
