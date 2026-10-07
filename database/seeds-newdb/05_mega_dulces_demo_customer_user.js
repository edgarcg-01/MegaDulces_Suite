/**
 * Seed: usuario customer_b2b demo para validar Portal B2B (Fase D).
 *
 * Crea:
 *   - Customer TST-PORTAL-001 si no existe (cliente demo del portal).
 *   - User `cliente_demo` linkeado al customer, rol customer_b2b, password 'cliente_demo'.
 *
 * Permite probar el flow: cliente_demo login → ver SUS pedidos → crear pedido →
 * cancelar. NO debe ver pedidos de otros customers.
 *
 * Idempotente: onConflict por (tenant_id, username) y (tenant_id, code).
 *
 * @param { import("knex").Knex } knex
 */
const bcrypt = require('bcryptjs');

exports.seed = async function (knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  const PORTAL_CUSTOMER_ID = '00000000-0000-0000-0000-0000c0ffeed1';
  const PORTAL_USER_ID = '00000000-0000-0000-0000-0000c0ffeed2';

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);

    // Resolver price_list default
    const pl = await trx('commercial.price_lists').where({ code: 'BASE-MXN' }).first();

    // 1. Customer del portal
    await trx('commercial.customers')
      .insert({
        id: PORTAL_CUSTOMER_ID,
        tenant_id: TENANT,
        code: 'TST-PORTAL-001',
        name: 'Cliente Portal Demo',
        legal_name: 'Cliente Portal Demo S.A. de C.V.',
        default_price_list_id: pl?.id || null,
        credit_limit: 20000,
        payment_terms_days: 15,
        active: true,
        notes: 'Customer demo para validar Portal B2B (D.1+).',
      })
      .onConflict(['tenant_id', 'code'])
      .merge(['name', 'legal_name', 'default_price_list_id', 'credit_limit', 'active', 'updated_at']);
    console.log(`[05_demo_customer_user] customer TST-PORTAL-001 upserted.`);

    // 2. User linkeado al customer
    const hash = await bcrypt.hash('cliente_demo', 10);
    await trx('public.users')
      .insert({
        id: PORTAL_USER_ID,
        tenant_id: TENANT,
        username: 'cliente_demo',
        password_hash: hash,
        nombre: 'Cliente Portal Demo',
        role_name: 'customer_b2b',
        customer_id: PORTAL_CUSTOMER_ID,
        activo: true,
      })
      .onConflict(['tenant_id', 'username'])
      .merge(['password_hash', 'role_name', 'customer_id', 'activo', 'updated_at']);
    console.log(`[05_demo_customer_user] user cliente_demo (role=customer_b2b, customer=TST-PORTAL-001) upserted.`);
  });
};
