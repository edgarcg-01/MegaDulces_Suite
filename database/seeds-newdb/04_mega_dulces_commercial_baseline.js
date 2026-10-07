/**
 * Seed: baseline comercial mínimo para Mega Dulces (Fase B.0).
 *
 * Crea solo lo necesario para tomar el primer pedido de prueba:
 *   - 1 warehouse "default" (almacén principal)
 *   - 1 price_list "default" (lista base MXN)
 *   - 1 customer demo "Cliente Demo" para validar flujo end-to-end
 *
 * NO carga catálogo de productos ni precios — eso lo hace el importer
 * cuando el usuario tenga los archivos reales.
 *
 * Idempotente: onConflict por (tenant_id, code).
 *
 * @param { import("knex").Knex } knex
 */
exports.seed = async function (knex) {
  const TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
  const WAREHOUSE_DEFAULT_ID = '00000000-0000-0000-0000-0000c0ffee01';
  const PRICE_LIST_DEFAULT_ID = '00000000-0000-0000-0000-0000c0ffee02';
  const CUSTOMER_DEMO_ID = '00000000-0000-0000-0000-0000c0ffee03';

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);

    // 1. Warehouse default
    await trx('commercial.warehouses')
      .insert({
        id: WAREHOUSE_DEFAULT_ID,
        tenant_id: TENANT_ID,
        code: 'MD-CENTRAL',
        name: 'Almacén Central Mega Dulces',
        address: 'Por definir',
        is_default: true,
        active: true,
      })
      .onConflict(['tenant_id', 'code'])
      .merge(['name', 'is_default', 'active', 'updated_at']);
    console.log(`[04_commercial_baseline] warehouse 'MD-CENTRAL' upserted.`);

    // 2. Price list default
    await trx('commercial.price_lists')
      .insert({
        id: PRICE_LIST_DEFAULT_ID,
        tenant_id: TENANT_ID,
        code: 'BASE-MXN',
        name: 'Lista base (MXN)',
        currency: 'MXN',
        is_default: true,
        active: true,
        notes: 'Lista base. Productos sin precio aquí no se pueden vender.',
      })
      .onConflict(['tenant_id', 'code'])
      .merge(['name', 'is_default', 'active', 'updated_at']);
    console.log(`[04_commercial_baseline] price_list 'BASE-MXN' upserted.`);

    // 3. Customer demo
    await trx('commercial.customers')
      .insert({
        id: CUSTOMER_DEMO_ID,
        tenant_id: TENANT_ID,
        code: 'DEMO-001',
        name: 'Cliente Demo',
        legal_name: 'Cliente Demo S.A. de C.V.',
        rfc: null,
        email: null,
        phone: null,
        default_price_list_id: PRICE_LIST_DEFAULT_ID,
        credit_limit: 0,
        payment_terms_days: 0,
        active: true,
        notes: 'Cliente de prueba creado por seed baseline.',
      })
      .onConflict(['tenant_id', 'code'])
      .merge(['name', 'legal_name', 'default_price_list_id', 'active', 'updated_at']);
    console.log(`[04_commercial_baseline] customer 'DEMO-001' upserted.`);
  });
};
