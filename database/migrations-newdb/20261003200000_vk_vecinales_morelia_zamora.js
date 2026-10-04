'use strict';
/**
 * `[VK.8]` — Las vecinales de Morelia y Zamora pasan a "Kepler gobierna la cartera".
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * ── Lo que se midió en prod (2026-10-03, solo lectura) ───────────────────────────────────────
 * Las tres plazas ya operan en Kepler y su ficha de clientes (`kdud.c12`) dice quién es el
 * vendedor; se contrastó contra quién les VENDIÓ de verdad (`kdm1.c12`):
 *
 *   plaza            Kepler     ficha  compraron  ficha correcta   vendedor        Suite hoy
 *   Morelia Madero   07:2V003     334        280      280 (100%)   Guillermo       50  "Ruta Vecinal #1"
 *   Morelia Madero   07:2V001     200        153      152  (99%)   Joseph          51  "Ruta Vecinal #2"
 *   Morelia Abastos  08:20005      77         40       38  (95%)   Gloria          11  "Ruta vecinal 1"
 *   Morelia Abastos  08:2V005     110         21       19  (90%)   Humberto        —   (no tenía ruta)
 *   Zamora Centro    05:3V001     117         78       77  (99%)   Diana            6  "RVDAM01"
 *
 * Decisiones de Francisco (2026-10-03): Gloria Ortega (Suite) = Gloria Calderón (Kepler);
 * Diana Rocío Cortés Molina es la vecinal de Zamora (supervisa francisco_martinez); Morelia
 * la supervisa jose_herrera; los teléfonos de ruta se quedan.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────────────────────
 * 1. RENOMBRA las 9 vecinales (incluidas las 4 de La Piedad) a "<código Kepler> <EJECUTIVO>":
 *    el código es fijo y el nombre cambia cuando cambia el ejecutivo. ⚠️ El cliente se liga a su ruta POR
 *    TEXTO (`customers.sales_route`), así que el renombre mueve catálogo + clientes JUNTOS —
 *    renombrar sólo el catálogo deja a los clientes sin ruta, sin error. Medido: la única tabla
 *    con el nombre como texto es `commercial.customers.sales_route` (118 filas).
 * 2. CREA `RVMAB02` (Humberto) en la zona MORELIA ABASTOS.
 * 3. LIGA cada ruta a su vendedor Kepler (sucursal, código).
 * 4. CONCILIA los clientes dados de alta a mano: si su nombre normalizado coincide con UN solo
 *    cliente de la ficha Kepler de esa ruta (y ese cliente Kepler con UNO solo de la Suite), se le
 *    pone la liga Kepler a la fila EXISTENTE — conserva su id, GPS, visitas y pedidos, y la
 *    sincronización ya no crea un duplicado. Los que no casan se quedan como manuales y se
 *    DECLARAN en el log.
 * 5. AGENDA lunes–sábado del vendedor titular. Si un día ya tiene OTRA ruta, NO se pisa: se
 *    declara (p. ej. Humberto trae "Ruta mayoreo 01").
 *
 * NO toca personas (puesto, jefe, bajas): eso se administra en /admin/users.
 * NO cambia la sucursal de surtido de una ruta que ya tiene una (Madero surte hoy de
 * "Almacén Morelia Madero (32)"): se declara para revisarlo aparte.
 *
 * Idempotente: re-correrla no duplica ni cambia nada.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

// Nombre de la ruta = "<código de vendedor Kepler> <EJECUTIVO>" (decisión de Francisco,
// 2026-10-03; mismo formato que "10001 CINTHIA YARET DEL VALLE RUEDA"). El CÓDIGO no cambia
// nunca —es la liga con Kepler y también vive en `erp_vendor_code`—; cuando cambia el ejecutivo
// sólo se edita el nombre en el catálogo, y el catálogo arrastra a los clientes ([VK.8]).
//
// [nombre actual (o null si es nueva), nombre final, zona, sucursal Kepler, vendedor Kepler, vendedor titular]
const ROUTES = [
  // La Piedad (ya ligadas en [VK.1.1]): sólo cambia el nombre.
  ['RVPH01', '1V001 CANDELARIA SALGADO MORALES', 'LA PIEDAD VECINAL', '01', '1V001', 'candelaria_salgado'],
  ['RVPH02', '1V002 RAFAEL VILLALOBOS CAMPOS', 'LA PIEDAD VECINAL', '01', '1V002', 'rafael.villalobos'],
  ['RVLPA01', '1V003 PAULINA MICHELLE PLACENCIA BRAVO', 'LA PIEDAD VECINAL', '02', '1V003', '42pmpb'],
  ['RVYUR01', '1V004 JUAN ANGEL LOPEZ', 'LA PIEDAD VECINAL', '04', '1V004', 'jlh_lopez'],
  // Morelia y Zamora: se nombran y se ligan.
  ['Ruta Vecinal #1', '2V003 GUILLERMO HERNANDEZ ALMANZA', 'MORELIA MADERO', '07', '2V003', 'guillermo_hernandez'],
  ['Ruta Vecinal #2', '2V001 JOSEPH AGUSTIN GUERRERO PEREZ', 'MORELIA MADERO', '07', '2V001', 'joseph_guerrero'],
  ['Ruta vecinal 1', '20005 GLORIA ORTEGA', 'MORELIA ABASTOS', '08', '20005', 'gloria_ortega'],
  [null, '2V005 HUMBERTO PLACENCIA', 'MORELIA ABASTOS', '08', '2V005', 'humberto_placencia'],
  ['RVDAM01', '3V001 DIANA ROCIO CORTES MOLINA', 'ZAMORA VECINAL', '05', '3V001', 'diana_molina'],
];
const DAYS = [1, 2, 3, 4, 5, 6]; // ISODOW: lunes..sábado

/** Nombre normalizado: mayúsculas, sin acentos, sólo letras y números. */
const NORM = (col) =>
  `trim(regexp_replace(upper(translate(${col},'ÁÉÍÓÚÜÑáéíóúüñ','AEIOUUNaeiouun')),'[^A-Z0-9]+',' ','g'))`;

const routeQ = (knex, value) =>
  knex('trade.catalogs')
    .where({ tenant_id: T, catalog_id: 'rutas', value })
    .whereNull('deleted_at')
    .first('id', 'value', 'erp_vendor_code', 'erp_source_branch');

exports.up = async function up(knex) {
  const tenant = await knex('identity.tenants').where({ id: T }).first('id');
  if (!tenant) {
    console.log('  ~ tenant mega_dulces no existe en esta base: nada que hacer.');
    return;
  }

  for (const [current, code, zoneName, branch, vendor, username] of ROUTES) {
    // ── 1/2. Renombre o alta ──
    let route = await routeQ(knex, code);
    if (!route && current) {
      const old = await routeQ(knex, current);
      if (old) {
        await knex('trade.catalogs').where({ id: old.id }).update({ value: code, updated_at: knex.fn.now() });
        const moved = await knex('commercial.customers')
          .where({ tenant_id: T, sales_route: current })
          .update({ sales_route: code, updated_at: knex.fn.now() });
        console.log(`  ✓ "${current}" → ${code} (catálogo + ${moved} clientes)`);
        route = { ...old, value: code };
      }
    }
    if (!route) {
      const zone = await knex('trade.zones').where({ tenant_id: T, name: zoneName }).whereNull('deleted_at').first('id');
      if (!zone) console.log(`  ! zona "${zoneName}" no existe: ${code} queda sin zona.`);
      const [row] = await knex('trade.catalogs')
        .insert({ tenant_id: T, catalog_id: 'rutas', value: code, parent_id: zone?.id ?? null })
        .returning('id');
      route = { id: row.id ?? row, value: code };
      console.log(`  ✓ ${code}: creada`);
    }

    // ── 3. Liga a Kepler ──
    const taken = await knex('trade.catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', erp_source_branch: branch, erp_vendor_code: vendor })
      .whereNull('deleted_at')
      .whereNot('id', route.id)
      .first('value');
    if (taken) {
      console.log(`  ! ${code}: ${branch}:${vendor} ya está ligado a "${taken.value}" — NO se liga. Revisar a mano.`);
      continue;
    }
    await knex('trade.catalogs')
      .where({ id: route.id })
      .update({ erp_source_branch: branch, erp_vendor_code: vendor, updated_at: knex.fn.now() });
    console.log(`  ✓ ${code}: ligada a Kepler ${branch}:${vendor}`);

    // Sucursal de surtido: sólo si no tiene una.
    const hasWh = await knex('commercial.route_warehouses as rw')
      .join('commercial.warehouses as w', 'w.id', 'rw.warehouse_id')
      .where({ 'rw.tenant_id': T, 'rw.route_id': route.id })
      .first('w.name', 'w.kepler_code');
    if (hasWh) {
      if (hasWh.kepler_code !== branch) {
        console.log(`    ! surte de "${hasWh.name}", no de la sucursal Kepler ${branch} — se deja; revisar aparte.`);
      }
    } else {
      const wh = await knex('commercial.warehouses')
        .where({ tenant_id: T, kepler_code: branch, kind: 'central', active: true })
        .whereNull('deleted_at')
        .first('id', 'name');
      if (wh) {
        await knex('commercial.route_warehouses').insert({ tenant_id: T, route_id: route.id, warehouse_id: wh.id });
        console.log(`    surte de: ${wh.name}`);
      } else {
        console.log(`    ! sin almacén central kepler_code=${branch}: ${code} queda sin sucursal de surtido.`);
      }
    }

    // ── 4. Conciliación de los clientes manuales (par único por nombre, en los dos sentidos) ──
    const linked = await knex.raw(
      `WITH k AS (
         SELECT v.cliente_code, ${NORM('v.nombre')} AS n
           FROM analytics.v_customer_master v
          WHERE v.fuente_sucursal = ? AND v.vendedor_code = ? AND NOT v.es_interno AND v.nombre IS NOT NULL
       ), ku AS (SELECT n, min(cliente_code) AS cliente_code FROM k GROUP BY n HAVING count(*) = 1),
       s AS (
         SELECT c.id, ${NORM('c.name')} AS n
           FROM commercial.customers c
          WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.erp_customer_code IS NULL AND c.sales_route = ?
       ), su AS (SELECT n, min(id::text)::uuid AS id FROM s GROUP BY n HAVING count(*) = 1)
       UPDATE commercial.customers c
          SET erp_source_branch = ?, erp_customer_code = ku.cliente_code, updated_at = now()
         FROM su JOIN ku ON ku.n = su.n
        WHERE c.id = su.id
          AND NOT EXISTS (
            SELECT 1 FROM commercial.customers x
             WHERE x.tenant_id = ? AND x.deleted_at IS NULL
               AND x.erp_source_branch = ? AND x.erp_customer_code = ku.cliente_code)`,
      [branch, vendor, T, code, branch, T, branch],
    );
    const left = await knex('commercial.customers')
      .where({ tenant_id: T, sales_route: code })
      .whereNull('deleted_at')
      .whereNull('erp_customer_code')
      .count('* as n')
      .first();
    console.log(`    conciliados con Kepler: ${linked.rowCount ?? 0} · siguen manuales: ${left.n}`);

    // ── 5. Agenda L–S del titular ──
    const user = await knex('identity.users')
      .where({ tenant_id: T, username })
      .whereNull('deleted_at')
      .first('id', 'route_id', 'supervisor_id');
    if (!user) {
      console.log(`    ! usuario ${username} no existe: ${code} queda sin agenda.`);
      continue;
    }
    const existing = await knex('trade.daily_assignments as d')
      .join('trade.catalogs as r', 'r.id', 'd.route_id')
      .where({ 'd.tenant_id': T, 'd.user_id': user.id })
      // SIN filtrar deleted_at: el UNIQUE (tenant, user, dow) incluye las bajas lógicas.
      .select('d.day_of_week', 'd.route_id', 'd.deleted_at', 'r.value');
    const byDay = new Map(existing.map((e) => [Number(e.day_of_week), e]));
    const toInsert = [];
    const busy = [];
    for (const dow of DAYS) {
      const e = byDay.get(dow);
      if (!e) toInsert.push(dow);
      else if (e.deleted_at || e.route_id !== route.id) busy.push(`${dow}="${e.value}"${e.deleted_at ? ' (baja)' : ''}`);
    }
    if (toInsert.length) {
      await knex('trade.daily_assignments')
        .insert(
          toInsert.map((dow) => ({
            tenant_id: T,
            user_id: user.id,
            route_id: route.id,
            day_of_week: dow,
            status: 'pendiente',
            assigned_by: user.supervisor_id || null,
          })),
        )
        .onConflict(['tenant_id', 'user_id', 'day_of_week'])
        .ignore();
      console.log(`    ✓ ${username}: agenda ${code} días ${toInsert.join(',')}`);
    }
    if (busy.length) console.log(`    ! ${username}: días ocupados por otra ruta, NO se pisan: ${busy.join(', ')}`);
    if (!user.route_id) {
      await knex('identity.users').where({ id: user.id }).update({ route_id: route.id });
      console.log(`    ✓ ${username}: ruta base = ${code}`);
    }
  }
};

exports.down = async function down(knex) {
  // Sólo se suelta la liga a Kepler. El renombre, la conciliación y la agenda se revierten a mano:
  // para entonces pueden tener visitas o pedidos colgando.
  for (const [, code] of ROUTES) {
    await knex('trade.catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', value: code })
      .update({ erp_source_branch: null, erp_vendor_code: null });
  }
};
