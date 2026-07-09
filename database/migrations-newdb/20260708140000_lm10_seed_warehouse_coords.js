/**
 * Fase LM.10 — coordenadas de las 3 sucursales piloto de entrega a domicilio.
 *
 * Origen de la ruta del repartidor cuando no hay GPS fresco. Geocodificadas con
 * Mapbox (nivel calle) a partir de las direcciones reales:
 *   01 Padre Hidalgo    — Av. Padre Hidalgo 322, Santa Ana Pacueco, Gto.
 *   02 La Piedad Abastos — Av. Mariano Jiménez 1582, Peña, La Piedad, Mich.
 *   03 8 Esquinas        — Pino Suárez 259, Centro, La Piedad, Mich.
 *
 * Idempotente: UPDATE por (tenant, warehouse_code). Re-run fija los mismos valores.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
  const coords = [
    { warehouse_code: '01', lat: 20.346343, lng: -102.018453 },
    { warehouse_code: '02', lat: 20.345901, lng: -102.040417 },
    { warehouse_code: '03', lat: 20.343141, lng: -102.025576 },
  ];

  if (!(await knex.schema.withSchema('logistics').hasColumn('home_delivery_warehouses', 'lat'))) return;

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);
    for (const c of coords) {
      await trx('logistics.home_delivery_warehouses')
        .where({ tenant_id: MEGA_DULCES_TENANT_ID, warehouse_code: c.warehouse_code })
        .update({ lat: c.lat, lng: c.lng, updated_at: trx.fn.now() });
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
  if (!(await knex.schema.withSchema('logistics').hasColumn('home_delivery_warehouses', 'lat'))) return;
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);
    await trx('logistics.home_delivery_warehouses')
      .where({ tenant_id: MEGA_DULCES_TENANT_ID })
      .whereIn('warehouse_code', ['01', '02', '03'])
      .update({ lat: null, lng: null });
  });
};
