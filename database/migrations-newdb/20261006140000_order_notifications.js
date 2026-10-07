'use strict';
/**
 * `[VEC.4]` — `commercial.order_notifications`: el aviso a la sucursal que SOBREVIVE.
 *
 * ── Qué estaba roto ─────────────────────────────────────────────────────────────────────
 * Al agendar un pedido, `place()` emite `emitOrderConfirmed` → `AlertsGateway.emitToTenant` →
 * room `tenant:<id>`. Eso tiene **dos defectos**, los dos medidos en prod:
 *
 *   1. **Es efímero.** No hay tabla: en `commercial.*` no existe ninguna de avisos (sólo
 *      `analytics.db_health_alerts` y `logistics.fleet_alerts`, de otros dominios). Si en ese
 *      segundo nadie tiene la pantalla abierta, el aviso **se evapora sin dejar rastro**. Es
 *      el patrón del incidente que fundó la Fase OBS: la señal existía y no salió del edificio.
 *   2. **Es tenant-wide.** A Morelia le llega el pedido de La Piedad. Un aviso que no es para
 *      vos enseña a ignorar el tablero, y entonces tampoco se mira el que sí lo era.
 *
 * El primitivo para dirigirlo **ya existía y nadie lo usaba para esto**: `AlertsService.emitTo`
 * (room `u:<tenant>:<username>`). Esto no inventa el canal — le pone memoria y destinatario.
 *
 * ── Por qué la tabla guarda tan poco ────────────────────────────────────────────────────
 * Guarda **el hecho** (a esta sucursal le toca armar este pedido) y **el acuse** (alguien lo
 * vio). Nada más. Cliente, total, ruta y tipo de ruta se DERIVAN al leer, con el mismo
 * primitivo del pool (`route-kind.sql.ts`).
 *
 * ⭐ Es deliberado: copiar el nombre del cliente o el tipo de ruta acá crearía una **segunda
 * verdad** que envejece — y la primera vez que alguien reclasifique una ruta, el aviso diría
 * una cosa y el pool otra, sin que nada lo detecte. Un snapshot sólo se justifica cuando el
 * original puede desaparecer; acá no desaparece.
 *
 * ── A quién le llega ────────────────────────────────────────────────────────────────────
 * La fila apunta a `warehouse_id` (la sucursal que surte, que el pedido ya trae resuelto por
 * la ruta del vendedor). Quién la ve se resuelve con `ScopeService.warehouseIds()`, no con
 * `identity.users.warehouse_id` a secas.
 *
 * ⚠️ **Y eso importa, medido:** de los 6 `almacenista` activos, **sólo 1 tiene
 * `warehouse_id`**. Si la bandeja filtrara por esa columna, 5 de 6 de las personas que arman
 * no verían nada y la función se vería "entregada" sirviendo cero. Con `ScopeService`, quien
 * no tiene alcance declarado ve todo (`null` = sin recorte) en vez de ver nada — se prefiere
 * un aviso de más, que se nota, a uno de menos, que no.
 * **Asignarle sucursal a esos 5 es trabajo humano pendiente, y queda declarado.**
 *
 * ── Idempotencia ────────────────────────────────────────────────────────────────────────
 * `UNIQUE (tenant_id, order_id)`: un pedido genera UN aviso. `place()` es idempotente (si ya
 * está `confirmed` devuelve sin hacer nada) y el device reintenta sin señal — sin esta llave,
 * un reintento inflaría la bandeja con el mismo pedido tres veces.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('commercial').hasTable('order_notifications');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('order_notifications', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('order_id').notNullable();
      // La sucursal que tiene que armar. Es el `warehouse_id` del pedido, que ya salió de la
      // ruta del vendedor — no se recalcula acá para que aviso y pedido no puedan discrepar.
      t.uuid('warehouse_id').notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      // El acuse. NULL = nadie lo ha visto todavía; es la columna que hace que el aviso
      // sobreviva a que nadie estuviera mirando.
      t.timestamp('seen_at', { useTz: true });
      t.uuid('seen_by');
      t.primary(['tenant_id', 'id']);
    });

    await knex.raw(`
      ALTER TABLE commercial.order_notifications
        ADD CONSTRAINT order_notifications_order_fk
        FOREIGN KEY (tenant_id, order_id) REFERENCES commercial.orders(tenant_id, id)
        ON DELETE CASCADE`);
    await knex.raw(`
      ALTER TABLE commercial.order_notifications
        ADD CONSTRAINT order_notifications_wh_fk
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id)
        ON DELETE CASCADE`);
    // Un pedido = un aviso. Ver "Idempotencia" arriba.
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_order_notifications_order
        ON commercial.order_notifications (tenant_id, order_id)`);
    // La consulta de la bandeja: por sucursal, lo no visto primero, lo más nuevo arriba.
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_order_notifications_bandeja
        ON commercial.order_notifications (tenant_id, warehouse_id, seen_at, created_at DESC)`);

    // ⚠️ El acuse es coherente o no es: `seen_at` y `seen_by` se ponen JUNTOS. Un aviso
    // "visto por nadie" o "visto sin fecha" no se puede auditar, y la bandeja lo contaría mal.
    await knex.raw(`
      ALTER TABLE commercial.order_notifications
        ADD CONSTRAINT order_notifications_acuse_ck
        CHECK ((seen_at IS NULL) = (seen_by IS NULL))`);
  }

  // RLS forzado + grant, igual que el resto de `commercial.*`.
  await knex.raw('ALTER TABLE commercial.order_notifications ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.order_notifications FORCE ROW LEVEL SECURITY');
  await knex.raw(`DROP POLICY IF EXISTS order_notifications_tenant ON commercial.order_notifications`);
  await knex.raw(`
    CREATE POLICY order_notifications_tenant ON commercial.order_notifications
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`
    GRANT SELECT, INSERT, UPDATE ON commercial.order_notifications TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.order_notifications IS
    'VEC.4 — aviso a la sucursal de que tiene un pedido que armar. Guarda SOLO el hecho y el acuse: cliente/total/ruta/tipo se DERIVAN al leer (route-kind.sql.ts). Copiarlos acá crearía una segunda verdad que envejece.'`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  // [1] RLS de verdad, no declarado. Una tabla sin RLS forzado en commercial.* filtra entre
  //     tenants, y el síntoma sería que una sucursal ve los pedidos de otro cliente nuestro.
  const { rows: rls } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='commercial' AND c.relname='order_notifications'`);
  if (!rls[0]?.on || !rls[0]?.forced) {
    throw new Error('[VEC.4] RLS no quedó habilitado+forzado en order_notifications.');
  }

  // [2] PRUEBA NEGATIVA del CHECK del acuse: se intenta un `seen_at` sin `seen_by`.
  //
  // ⚠️ Dentro de un SAVEPOINT: knex corre la migración en UNA transacción, así que un error
  // provocado la aborta (25P02) y un try/catch NO la rescata.
  //
  // ⚠️ Necesita un pedido SIN aviso. Dos razones, las dos aprendidas escribiendo esto:
  //   · con `commercial.orders` vacía el INSERT afecta 0 filas, **no falla**, y el candado
  //     daría rojo por falta de sujeto en vez de por un defecto real;
  //   · al re-correr la migración el pedido elegido ya podría tener aviso, y entonces lo que
  //     rebota es el UNIQUE y no el CHECK — pasaría por "verde" midiendo otra cosa.
  // Sin sujeto se DECLARA (ADR-056), no se da por buena.
  const { rows: sujeto } = await knex.raw(`
    SELECT o.tenant_id, o.id, o.warehouse_id
      FROM commercial.orders o
     WHERE o.warehouse_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM commercial.order_notifications n
                        WHERE n.tenant_id = o.tenant_id AND n.order_id = o.id)
     LIMIT 1`);
  if (!sujeto.length) {
    console.log('  [VEC.4] ◻ NO MEDIDO: no hay un pedido sin aviso con el que probar el CHECK del acuse.');
  } else {
    await knex.raw('SAVEPOINT vec4_neg');
    let rebotó = false;
    try {
      await knex.raw(
        `INSERT INTO commercial.order_notifications (tenant_id, order_id, warehouse_id, seen_at)
         VALUES (?, ?, ?, now())`,
        [sujeto[0].tenant_id, sujeto[0].id, sujeto[0].warehouse_id],
      );
    } catch (e) {
      rebotó = /order_notifications_acuse_ck|violates check/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT vec4_neg');
    await knex.raw('RELEASE SAVEPOINT vec4_neg');
    if (!rebotó) {
      throw new Error('[VEC.4] el CHECK del acuse NO rechazó un seen_at sin seen_by: es decorativo.');
    }
    console.log('  [VEC.4] prueba negativa del acuse OK.');
  }
  console.log('  [VEC.4] tabla lista · RLS forzado.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.order_notifications');
};
