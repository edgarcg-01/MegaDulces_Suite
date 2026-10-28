'use strict';
/**
 * `[MCP.3.13]` — La clave de Kepler de un cliente EN OTRA sucursal.
 *
 * Las claves de cliente de Kepler son POR SUCURSAL (medido 2026-10-08: el cliente `10465` de la 01 no
 * es el `10465` de la 04). Con el pedido agrupado, la parte que surte Padre Hidalgo se cobra en el
 * Kepler de Padre Hidalgo (decisión de David, 2026-10-23), con la clave que ese cliente tenga AHÍ.
 * Decisión de David: si el cliente no existe en esa sucursal, se da de alta en ese Kepler y su clave se
 * liga aquí. `commercial.customers.erp_customer_code` / `erp_source_branch` sigue siendo la clave de su
 * sucursal de origen; esta tabla guarda las de las DEMÁS.
 *
 * Es un dato propio (HITL: alguien liga la clave), no una copia del ODS. Una clave viva por
 * (cliente, sucursal); ligar otra da de baja la anterior (`deleted_at`), no la pisa.
 *
 * El código nuevo lee esta tabla: aplicarla ANTES de desplegar. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('customer_branch_keys'))) {
    await knex.raw(`
      CREATE TABLE commercial.customer_branch_keys (
        id                uuid        NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid        NOT NULL DEFAULT public.current_tenant_id(),
        customer_id       uuid        NOT NULL,
        -- Sucursal KEPLER de dos dígitos (la misma llave que analytics.erp_sale_tickets.sucursal).
        branch            text        NOT NULL,
        erp_customer_code text        NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        created_by        uuid,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        uuid,
        deleted_at        timestamptz,
        deleted_by        uuid,
        CONSTRAINT customer_branch_keys_pkey PRIMARY KEY (id),
        CONSTRAINT customer_branch_keys_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        CONSTRAINT customer_branch_keys_customer_fk
          FOREIGN KEY (tenant_id, customer_id) REFERENCES commercial.customers (tenant_id, id),
        CONSTRAINT customer_branch_keys_branch_ck CHECK (branch ~ '^[0-9]{2}$'),
        CONSTRAINT customer_branch_keys_code_ck CHECK (btrim(erp_customer_code) <> '')
      )`);
    await knex.raw(`
      CREATE UNIQUE INDEX ux_customer_branch_keys_vivo
        ON commercial.customer_branch_keys (tenant_id, customer_id, branch)
        WHERE deleted_at IS NULL`);
  }

  await knex.raw('ALTER TABLE commercial.customer_branch_keys ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.customer_branch_keys FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS customer_branch_keys_tenant ON commercial.customer_branch_keys');
  await knex.raw(`
    CREATE POLICY customer_branch_keys_tenant ON commercial.customer_branch_keys
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.customer_branch_keys TO app_runtime');
  await knex.raw(`COMMENT ON TABLE commercial.customer_branch_keys IS
    'MCP.3.13 — clave de Kepler de un cliente en una sucursal que NO es la de origen (las claves de Kepler son por sucursal). Para cobrar en esa sucursal la parte de un pedido agrupado. Dato propio.'`);

  // ── COMPUERTA ────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'customer_branch_keys'`);
  if (!rows[0]?.on || !rows[0]?.forced) throw new Error('[MCP.3.13] RLS no quedó habilitado+forzado en customer_branch_keys.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.customer_branch_keys');
};
