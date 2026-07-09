/**
 * Fase LM.10 — Mapa + Ruta de Reparto.
 *
 * Agrega lo mínimo para poder optimizar y persistir la ruta del repartidor de
 * entregas a domicilio (dominio Reparto, tabla commercial.home_deliveries):
 *
 *   commercial.home_deliveries.sequence_order  — orden de visita optimizado (1..n).
 *   commercial.home_deliveries.route_eta_min   — ETA acumulado a esa parada (min), si Mapbox lo da.
 *   commercial.home_deliveries.route_computed_at — cuándo se corrió el ruteo.
 *
 * Y coordenadas de la sucursal (origen de la ruta) en la allowlist de domicilio:
 *   logistics.home_delivery_warehouses.lat / .lng
 *
 * El origen de la ruta se resuelve en runtime con prioridad:
 *   GPS fresco del repartidor → coord de sucursal (estas columnas) → centroide.
 * Por eso lat/lng son NULLABLE (se llenan cuando se conozcan; el ruteo funciona
 * igual con el fallback).
 *
 * Idempotente (hasColumn). No borra nada.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasHd = await knex.schema.withSchema('commercial').hasTable('home_deliveries');
  if (hasHd) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('home_deliveries', 'sequence_order'))) {
      await knex.schema.withSchema('commercial').alterTable('home_deliveries', (t) => {
        t.integer('sequence_order'); // 1..n, orden de visita optimizado; NULL = sin rutear
      });
    }
    if (!(await knex.schema.withSchema('commercial').hasColumn('home_deliveries', 'route_eta_min'))) {
      await knex.schema.withSchema('commercial').alterTable('home_deliveries', (t) => {
        t.integer('route_eta_min'); // ETA acumulado a la parada (min), si aplica
      });
    }
    if (!(await knex.schema.withSchema('commercial').hasColumn('home_deliveries', 'route_computed_at'))) {
      await knex.schema.withSchema('commercial').alterTable('home_deliveries', (t) => {
        t.timestamp('route_computed_at');
      });
    }
  }

  const hasWh = await knex.schema.withSchema('logistics').hasTable('home_delivery_warehouses');
  if (hasWh) {
    if (!(await knex.schema.withSchema('logistics').hasColumn('home_delivery_warehouses', 'lat'))) {
      await knex.schema.withSchema('logistics').alterTable('home_delivery_warehouses', (t) => {
        t.decimal('lat', 10, 7); // origen de la ruta (opcional; fallback a centroide)
      });
    }
    if (!(await knex.schema.withSchema('logistics').hasColumn('home_delivery_warehouses', 'lng'))) {
      await knex.schema.withSchema('logistics').alterTable('home_delivery_warehouses', (t) => {
        t.decimal('lng', 10, 7);
      });
    }
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasHd = await knex.schema.withSchema('commercial').hasTable('home_deliveries');
  if (hasHd) {
    for (const col of ['sequence_order', 'route_eta_min', 'route_computed_at']) {
      if (await knex.schema.withSchema('commercial').hasColumn('home_deliveries', col)) {
        await knex.schema.withSchema('commercial').alterTable('home_deliveries', (t) => t.dropColumn(col));
      }
    }
  }
  const hasWh = await knex.schema.withSchema('logistics').hasTable('home_delivery_warehouses');
  if (hasWh) {
    for (const col of ['lat', 'lng']) {
      if (await knex.schema.withSchema('logistics').hasColumn('home_delivery_warehouses', col)) {
        await knex.schema.withSchema('logistics').alterTable('home_delivery_warehouses', (t) => t.dropColumn(col));
      }
    }
  }
};
