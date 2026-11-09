'use strict';
/**
 * `[DN.6]` — **Un renglón pedido sin existencia queda registrado aunque nadie lo decida.**
 *
 * Plan: docs/IMPLEMENTACION/FASES/FASE_DN_ANEXO_AVISO_AL_AGENDAR.md (§8 C0) · ADR-115.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-07) ──
 *  · Renglones de preventa que entraron sin existencia en su sucursal de surtido (misma base,
 *    foto de cierre del día anterior): antes del bloqueo de [MCP.3.16] 31 de 218 (14.2 %); con el
 *    bloqueo, desde el 30-oct, 2 de 857 (0.23 %). La diferencia no quedó en ningún lado: el
 *    bloqueo vive en el teléfono y no deja rastro.
 *  · El «agotado» de Kepler no es testigo fiable de «no hay»: el 29.4 % de los saldos ≤ 0 son
 *    negativos, y entre el 5.9 % y el 7.6 % de lo que estaba en 0 al cierre se vendió al otro día.
 *
 * ── Qué es esta tabla ────────────────────────────────────────────────────────────────────────
 * Dato PROPIO capturado en la Suite (no es copia de nada): por cada renglón de un pedido de
 * preventa de la app del vendedor, la COPIA del original (producto, cantidad en base y en su
 * presentación, precio de referencia) y lo que se sabía de su existencia en la sucursal de
 * surtido al agendar. El renglón puede borrarse o moverse después (`removeLine`, `replaceLines`,
 * `separarPorSucursal`): la fila no, porque es la demanda que el cliente expresó.
 *
 *  · `stock_state = 'pendiente'` es la marca que `place()` escribe DENTRO de su transacción (en un
 *    SAVEPOINT, sin leer existencia); después del commit otra transacción la completa. Un barrido
 *    pasa a `sin_dato` la que se quede en `pendiente`: el hueco se declara, nunca se cuenta como 0.
 *  · `con_existencia` también se guarda: es el denominador de la métrica por versión de la app
 *    (`client_build`). La demanda negada son `agotado` y `no_se_maneja`; `sin_dato` se declara.
 *  · Columnas del frente 2 (`candidates`, `decision` distinta de `sin_aviso`, sustituto, sucursal
 *    alterna) ya viven aquí para no alterar una tabla viva después; en el frente 1 nadie las llena.
 *
 * ── La llave ─────────────────────────────────────────────────────────────────────────────────
 * Una fila VIGENTE (`superseded_at IS NULL`) por (`order_id`, `product_id`, `source_warehouse_id`):
 * el pedido en el que queda el renglón DESPUÉS de separar por sucursal (ADR-105) y la sucursal de
 * surtido efectiva (`COALESCE(renglón.source_warehouse_id, pedido.warehouse_id)`). Reagendar marca
 * `superseded_at` en la vigente de la misma llave, y también en la de un renglón que se MOVIÓ (mismo
 * `order_line_id`, otra sucursal): no se cuenta doble. Un renglón que se QUITÓ conserva su fila.
 *
 * ⚠️ La llave NO es la raíz del grupo (así decía el plan): una revisión adversarial lo encontró
 * contando doble y perdiendo cantidad. Reabrir una PARTE y reagendarla le cambia `group_id`
 * (`separarPorSucursal`), y dos partes del grupo pueden pedir lo mismo de la misma sucursal.
 * `root_order_id` se queda como DATO para agrupar (Compras, DN.3): `COALESCE(group_id, id)` la
 * primera vez, y la misma de sus filas anteriores cuando un pedido se vuelve a agendar.
 *
 * Sin DELETE para la app: una fila no se borra, se reemplaza. Por eso no lleva `deleted_at`: el
 * papel del borrado lógico lo hace `superseded_at` (auditoría: `created_*` y `updated_*`).
 *
 * Sin FK a `order_lines`: los renglones se borran físicamente (`replaceLines`, `removeLine`) y
 * `order_line_id` es un dato auxiliar. Sin FK a `catalog.products` (no aporta: la llave usa el id
 * del renglón tal cual, legado incluido) para no tomar un candado más sobre una tabla caliente.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'commercial.order_stock_notices';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${TABLA} (
      id                       uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id                uuid          NOT NULL,
      context                  text          NOT NULL DEFAULT 'vendedor',
      root_order_id            uuid          NOT NULL,
      order_id                 uuid          NOT NULL,
      order_line_id            uuid,
      customer_id              uuid,
      seller_user_id           uuid,
      order_warehouse_id       uuid,
      source_warehouse_id      uuid          NOT NULL,
      requested_delivery_date  date,
      product_id               uuid          NOT NULL,
      quantity                 numeric(14,3) NOT NULL,
      qty_unit                 text,
      qty_factor               numeric(14,4),
      unit_quantity            numeric(14,4),
      unit_price               numeric(14,4),
      line_total               numeric(14,2),
      stock_state              text          NOT NULL DEFAULT 'pendiente',
      stock_qty                numeric(14,4),
      stock_checked_at         timestamptz,
      stock_reason             text,
      twin_product_id          uuid,
      candidates               jsonb,
      decision                 text          NOT NULL DEFAULT 'sin_aviso',
      substitute_product_id    uuid,
      substitute_quantity      numeric(14,3),
      substitute_qty_unit      text,
      substitute_line_id       uuid,
      alt_warehouse_id         uuid,
      decided_by               uuid,
      decided_at               timestamptz,
      client_build             text,
      superseded_at            timestamptz,
      created_at               timestamptz   NOT NULL DEFAULT now(),
      created_by               uuid,
      updated_at               timestamptz   NOT NULL DEFAULT now(),
      updated_by               uuid,
      CONSTRAINT order_stock_notices_pkey PRIMARY KEY (id),
      -- ⚠️ identity.tenants, NO public.tenants: ésa es una VISTA y una FK a una vista aborta la migración.
      CONSTRAINT order_stock_notices_tenant_fk FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT,
      CONSTRAINT order_stock_notices_root_fk FOREIGN KEY (tenant_id, root_order_id)
        REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT order_stock_notices_order_fk FOREIGN KEY (tenant_id, order_id)
        REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT order_stock_notices_context_ck CHECK (context IN ('vendedor', 'surtidor')),
      CONSTRAINT order_stock_notices_state_ck
        CHECK (stock_state IN ('pendiente', 'con_existencia', 'agotado', 'no_se_maneja', 'sin_dato')),
      CONSTRAINT order_stock_notices_decision_ck
        CHECK (decision IN ('dejar', 'condicional', 'cambiar_ya', 'otra_sucursal', 'quitar', 'sin_aviso', 'condicional_no_aplicable')),
      CONSTRAINT order_stock_notices_qty_ck CHECK (quantity >= 0 AND (qty_factor IS NULL OR qty_factor > 0)),
      CONSTRAINT order_stock_notices_build_ck CHECK (client_build IS NULL OR length(client_build) <= 60)
    )`);

  // La llave: una fila vigente por (pedido, producto, sucursal de surtido efectiva).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_order_stock_notices_vigente
    ON ${TABLA} (tenant_id, order_id, product_id, source_warehouse_id)
    WHERE superseded_at IS NULL`);
  // El reemplazo de un renglón que cambió de sucursal (mismo renglón, otra llave).
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_order_stock_notices_renglon
    ON ${TABLA} (tenant_id, order_line_id) WHERE superseded_at IS NULL`);
  // Compras agrupa por la raíz del grupo (DN.3) y el paso 2 completa por raíz.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_order_stock_notices_raiz
    ON ${TABLA} (tenant_id, root_order_id) WHERE superseded_at IS NULL`);
  // El barrido: sólo las marcas que siguen pendientes.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_order_stock_notices_pendiente
    ON ${TABLA} (tenant_id, created_at) WHERE stock_state = 'pendiente'`);
  // Compras (DN.3): por producto y fecha.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_order_stock_notices_producto
    ON ${TABLA} (tenant_id, product_id, created_at DESC) WHERE superseded_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_order_stock_notices_pedido
    ON ${TABLA} (tenant_id, order_id)`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON ${TABLA}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);

  // Sin DELETE: una fila se reemplaza (`superseded_at`), nunca se borra. ⚠️ El GRANT solo no alcanza:
  // el privilegio por omisión del esquema `commercial` le da a `app_runtime` arwd en toda tabla nueva
  // (medido en Docker, `[AB.18]` 20261012215125): sin el REVOKE la app podría borrar lo registrado.
  const { rows: [app] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS hay`);
  if (app.hay) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${TABLA} TO app_runtime`);
    await knex.raw(`REVOKE DELETE, TRUNCATE ON ${TABLA} FROM app_runtime`);
  }

  await knex.raw(`COMMENT ON TABLE ${TABLA} IS
    'DN.6 (ADR-115) — por renglón de preventa de la app del vendedor: la copia del original y su existencia en la sucursal de surtido al agendar. Dato propio, no copia. Demanda negada = agotado + no_se_maneja de filas vigentes; sin_dato y pendiente se declaran, nunca cuentan como 0.'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.root_order_id IS
    'Raíz del grupo para agrupar (Compras): COALESCE(group_id, id) del pedido la primera vez; al reagendar se conserva la de sus filas anteriores (reabrir una parte le cambia group_id). NO es parte de la llave.'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.order_id IS
    'El pedido en el que quedó el renglón DESPUÉS de separar por sucursal (ADR-105). Llave vigente: (order_id, product_id, source_warehouse_id).'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.source_warehouse_id IS
    'Sucursal de surtido efectiva del renglón al registrarlo: COALESCE(order_lines.source_warehouse_id, orders.warehouse_id).'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.quantity IS
    'Cantidad del renglón en unidad BASE. En su presentación: unit_quantity + qty_unit (NULL = sin presentación, p. ej. sincronizado sin conexión): nunca se rellena con la base.'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.stock_state IS
    'pendiente = marca de place() sin completar · con_existencia · agotado · no_se_maneja · sin_dato (lectura vieja, caída o barrido). Ver stock_reason.'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.decision IS
    'sin_aviso = lo registró el servidor sin que nadie viera un aviso (frente 1). Las demás vienen de la hoja del vendedor o del surtidor (frente 2).'`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.client_build IS
    'Versión de la app que agendó (cuerpo de place). NULL = una app sin la marca: la PWA vieja que bloqueaba en el teléfono.'`);

  // ── COMPUERTAS ─────────────────────────────────────────────────────────────────────────
  // Un GRANT que no se aplica no falla (Postgres da WARNING y node-postgres lo calla, GOTCHAS §43):
  // se lee lo que quedó y se aborta si no es lo que se escribió.
  const { rows: [rls] } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'order_stock_notices'`);
  if (!rls?.on || !rls?.forced) throw new Error('[DN.6] RLS no quedó habilitado y forzado en order_stock_notices.');
  if (app.hay) {
    const { rows: [p] } = await knex.raw(`
      SELECT has_table_privilege('app_runtime', '${TABLA}', 'INSERT') AS ins,
             has_table_privilege('app_runtime', '${TABLA}', 'UPDATE') AS upd,
             has_table_privilege('app_runtime', '${TABLA}', 'DELETE') AS del`);
    if (!p.ins || !p.upd) throw new Error('[DN.6] app_runtime no quedó con INSERT y UPDATE en order_stock_notices.');
    if (p.del) throw new Error('[DN.6] app_runtime quedó con DELETE en order_stock_notices: lo registrado no se borra.');
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: con filas se NIEGA (la demanda que el
 * cliente expresó no se reconstruye de ningún otro lado).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('commercial').hasTable('order_stock_notices'))) return;
  const { rows: [r] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM ${TABLA}) AS con_filas`);
  if (r.con_filas) {
    throw new Error('[DN.6] down rechazado: order_stock_notices tiene filas (la demanda registrada no se reconstruye).');
  }
  await knex.raw(`DROP TABLE IF EXISTS ${TABLA}`);
};
