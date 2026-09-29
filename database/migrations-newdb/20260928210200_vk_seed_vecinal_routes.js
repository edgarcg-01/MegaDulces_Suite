'use strict';
/**
 * `[VK.1]` — Las 4 rutas vecinales de La Piedad, dadas de alta y LIGADAS a su vendedor Kepler.
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * Hoy no existen en la Suite (medido 2026-09-28): "Mi ruta" de sus vendedores salía vacía aunque
 * en Kepler venden todos los días. Cada una se liga a (sucursal que la opera, vendedor Kepler):
 *
 *   ruta Suite                          sucursal  vendedor Kepler (kduv)        ficha  compran 60d
 *   Ruta Vecinal Padre Hidalgo 1        01        1V001 RUTA VECINAL PH 01          86     71
 *   Ruta Vecinal Padre Hidalgo 2        01        1V002 RUTA VECINAL PH 02         115     86
 *   Ruta Vecinal La Piedad Abastos      02        1V003 RUTA VECINAL ABASTOS LP    158    111
 *   Ruta Vecinal Yurécuaro              04        1V004 RUTA VECINAL YURECUARO.    143     83
 *
 * La sucursal que opera cada ruta se MIDIÓ (dónde están sus documentos kdm1 de 60 días), no se
 * supuso: el catálogo de vendedores kduv se replica en las 9 sucursales y no dice cuál es la suya.
 *
 * También les asigna su sucursal de surtido (`commercial.route_warehouses`) = el almacén central
 * de esa misma sucursal (`warehouses.kepler_code`), que es de donde sale su inventario.
 *
 * Idempotente: si la ruta ya existe (mismo nombre) solo actualiza la liga; nunca duplica.
 * Zona y almacén se resuelven por NOMBRE/CÓDIGO (los ids cambian entre bases). Si alguno no
 * existe, la ruta se crea igual y se DECLARA en el log.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

// [value, sucursal, vendedor Kepler, zona (public.zones.name)]
const ROUTES = [
  ['Ruta Vecinal Padre Hidalgo 1', '01', '1V001', 'LA PIEDAD VECINAL'],
  ['Ruta Vecinal Padre Hidalgo 2', '01', '1V002', 'LA PIEDAD VECINAL'],
  ['Ruta Vecinal La Piedad Abastos', '02', '1V003', 'LA PIEDAD VECINAL'],
  ['Ruta Vecinal Yurécuaro', '04', '1V004', 'LA PIEDAD VECINAL'], // opera la suc 04, pero reporta a la zona La Piedad Vecinal
];

exports.up = async function up(knex) {
  const tenant = await knex('identity.tenants').where({ id: T }).first('id');
  if (!tenant) {
    console.log('  ~ tenant mega_dulces no existe en esta base: nada que sembrar.');
    return;
  }

  for (const [value, branch, vendor, zoneName] of ROUTES) {
    const zone = await knex('public.zones').where({ tenant_id: T, name: zoneName }).first('id');
    if (!zone) console.log(`  ! zona "${zoneName}" no existe: ${value} queda sin zona.`);

    const existing = await knex('trade.catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', value })
      .first('id', 'deleted_at');

    let routeId;
    if (existing) {
      routeId = existing.id;
      await knex('trade.catalogs')
        .where({ id: routeId })
        .update({
          erp_source_branch: branch,
          erp_vendor_code: vendor,
          deleted_at: null,
          parent_id: zone?.id ?? null,
          updated_at: knex.fn.now(),
        });
      console.log(`  ✓ ${value}: ya existía, ligada a ${branch}:${vendor}`);
    } else {
      const [row] = await knex('trade.catalogs')
        .insert({
          tenant_id: T,
          catalog_id: 'rutas',
          value,
          parent_id: zone?.id ?? null,
          erp_source_branch: branch,
          erp_vendor_code: vendor,
        })
        .returning('id');
      routeId = row.id ?? row;
      console.log(`  ✓ ${value}: creada y ligada a ${branch}:${vendor}`);
    }

    const wh = await knex('commercial.warehouses')
      .where({ tenant_id: T, kepler_code: branch, kind: 'central', active: true })
      .whereNull('deleted_at')
      .first('id', 'name');
    if (!wh) {
      console.log(`    ! sin almacén central con kepler_code=${branch}: sin sucursal de surtido.`);
      continue;
    }
    await knex.raw(
      `INSERT INTO commercial.route_warehouses (tenant_id, route_id, warehouse_id)
       VALUES (?, ?, ?)
       ON CONFLICT (tenant_id, route_id) DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id, updated_at = now()`,
      [T, routeId, wh.id],
    );
    console.log(`    surte de: ${wh.name}`);
  }
};

exports.down = async function down(knex) {
  // Solo se quita la liga; la ruta se queda (puede tener agenda, visitas o pedidos colgando).
  for (const [value] of ROUTES) {
    await knex('trade.catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', value })
      .update({ erp_source_branch: null, erp_vendor_code: null });
  }
};
