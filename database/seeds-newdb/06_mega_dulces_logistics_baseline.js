/**
 * Seed: baseline logística mínimo para Mega Dulces (Fase J.0).
 *
 * Crea solo lo necesario para arrancar el módulo de logística:
 *   - 1 vehicle demo (placa, capacidad, rendimiento)
 *   - 1 driver demo (chofer)
 *   - 1 route demo (catálogo destino)
 *   - 1 payroll_period demo (catorcena actual)
 *   - 3 config_finance baseline (costo_km, factor_default, tarifa_maniobra)
 *
 * NO carga datos reales — solo placeholders para validar end-to-end y
 * para que la app no muestre vacío en primer arranque. Reemplazar con
 * datos reales via importer/UI cuando se opere.
 *
 * Idempotente: onConflict por keys naturales.
 *
 * @param { import("knex").Knex } knex
 */
exports.seed = async function (knex) {
  const TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
  const VEHICLE_ID = '00000000-0000-0000-0000-0000109157e1';
  const DRIVER_ID = '00000000-0000-0000-0000-0000109157e2';
  const ROUTE_ID = '00000000-0000-0000-0000-0000109157e3';
  const PERIOD_ID = '00000000-0000-0000-0000-0000109157e4';

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);

    // 1. Vehicle demo
    await trx('logistics.vehicles')
      .insert({
        id: VEHICLE_ID,
        tenant_id: TENANT_ID,
        plate: 'DEMO-001',
        model: 'NPR Genérico',
        brand: 'Isuzu',
        year: 2020,
        fuel_efficiency_km_l: 8.5,
        capacity_boxes: 500,
        capacity_kg: 3500,
        status: 'disponible',
        active: true,
        notes: 'Unidad demo creada por seed baseline. Reemplazar con flotilla real.',
      })
      .onConflict(['tenant_id', 'plate'])
      .merge(['model', 'brand', 'year', 'fuel_efficiency_km_l', 'capacity_boxes', 'capacity_kg', 'status', 'updated_at']);
    console.log(`[06_logistics_baseline] vehicle 'DEMO-001' upserted.`);

    // 2. Driver demo
    await trx('logistics.drivers')
      .insert({
        id: DRIVER_ID,
        tenant_id: TENANT_ID,
        full_name: 'Chofer Demo',
        roles: ['chofer'],
        employee_type: 'interno',
        status: 'activo',
        nss: null,
        phone: null,
        active: true,
        notes: 'Driver demo creado por seed baseline.',
      })
      // No hay unique en driver name → checkear primero
      .onConflict('id')
      .merge(['full_name', 'roles', 'status', 'updated_at']);
    console.log(`[06_logistics_baseline] driver 'Chofer Demo' upserted.`);

    // 3. Route demo
    await trx('logistics.routes')
      .insert({
        id: ROUTE_ID,
        tenant_id: TENANT_ID,
        name: 'Ruta Local Demo',
        origin: 'CEDIS Mega Dulces',
        destination: 'Zona Metropolitana',
        estimated_km: 50,
        driver_commission: 150,
        helper_commission: 100,
        active: true,
        notes: 'Ruta demo. Reemplazar con catálogo real de rutas operativas.',
      })
      .onConflict(['tenant_id', 'name'])
      .merge(['origin', 'destination', 'estimated_km', 'driver_commission', 'helper_commission', 'updated_at']);
    console.log(`[06_logistics_baseline] route 'Ruta Local Demo' upserted.`);

    // 4. Payroll period demo (catorcena actual - junio 2026)
    await trx('logistics.payroll_periods')
      .insert({
        id: PERIOD_ID,
        tenant_id: TENANT_ID,
        number: 11, // catorcena 11 del año
        year: 2026,
        start_date: '2026-05-26',
        end_date: '2026-06-08',
        payment_date: '2026-06-09',
        status: 'abierto',
        notes: 'Catorcena demo. Generar automáticamente las siguientes via cron o admin UI.',
      })
      .onConflict(['tenant_id', 'year', 'number'])
      .merge(['start_date', 'end_date', 'payment_date', 'status', 'updated_at']);
    console.log(`[06_logistics_baseline] payroll_period '2026-11' upserted.`);

    // 5. Config finance baseline (3 valores)
    const configs = [
      { key: 'costo_km_estandar', category: 'costo_km', value: 8.5, unit: 'mxn/km', description: 'Costo fijo por km (incluye depreciación, llantas, aceite).' },
      { key: 'factor_jalisco', category: 'factor', value: 1.0, unit: 'pct', description: 'Factor multiplicador para rutas en Jalisco.' },
      { key: 'tarifa_maniobra_caja', category: 'tarifa_maniobra', value: 5.0, unit: 'mxn', description: 'Tarifa por caja en maniobra de carga/descarga.' },
    ];
    for (const cfg of configs) {
      await trx('logistics.config_finance')
        .insert({ tenant_id: TENANT_ID, ...cfg, active: true })
        .onConflict(['tenant_id', 'key'])
        .merge(['category', 'value', 'unit', 'description', 'updated_at']);
      console.log(`[06_logistics_baseline] config_finance '${cfg.key}' upserted.`);
    }
  });
};
