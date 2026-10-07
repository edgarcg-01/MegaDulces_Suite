/**
 * Migración J.6.3 — UNIQUE constraint en (tenant_id, customer_id) para public.users
 * donde customer_id IS NOT NULL.
 *
 * Por qué: el endpoint `createPortalAccess(customerId)` crea un user con
 * `customer_id = X` para que el cliente entre al Portal B2B. Si admin clickea
 * 2 veces el botón, no debe crear 2 users — debe fallar con conflict.
 *
 * El índice partial idx_users_tenant_customer existe (migración 20260526100007)
 * pero NO es UNIQUE. Esta migración lo reemplaza por un UNIQUE índice partial.
 *
 * Idempotente: si ya existe el unique índex, no hace nada.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. Verificar si ya hay duplicados pre-existentes que romperían la creación del unique
  const dups = await knex.raw(`
    SELECT tenant_id, customer_id, COUNT(*) AS c
      FROM public.users
     WHERE customer_id IS NOT NULL
     GROUP BY tenant_id, customer_id
    HAVING COUNT(*) > 1
  `);
  if (dups.rows && dups.rows.length > 0) {
    throw new Error(
      `No se puede crear UNIQUE constraint: hay ${dups.rows.length} pares (tenant_id, customer_id) duplicados en public.users. Resolver manualmente antes de re-correr.`,
    );
  }

  // 2. Drop el índex previo si existe (era non-unique)
  await knex.raw(`DROP INDEX IF EXISTS public.idx_users_tenant_customer`);

  // 3. Crear UNIQUE índex partial
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_customer_unique
      ON public.users (tenant_id, customer_id)
      WHERE customer_id IS NOT NULL
  `);

  await knex.raw(`
    COMMENT ON INDEX public.idx_users_tenant_customer_unique IS
      'J.6.3: garantiza que un commercial.customers tiene a lo sumo 1 user Portal B2B. Partial: NULL customer_id (internal users) no participan.'
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS public.idx_users_tenant_customer_unique`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_tenant_customer
      ON public.users (tenant_id, customer_id)
      WHERE customer_id IS NOT NULL
  `);
};
