'use strict';
/**
 * `[VK.1.1]` — Las rutas vecinales de La Piedad quedaron DUPLICADAS: se consolidan en las `RV*`.
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * ── Lo que se midió en prod (2026-09-29, solo lectura) ───────────────────────────────────────
 * La seed `20260928210200` creó 4 rutas nuevas ("Ruta Vecinal Padre Hidalgo 1"...) y las ligó a
 * Kepler, pero las rutas de verdad YA EXISTÍAN desde julio con código corto (`RVPH01`, `RVPH02`,
 * `RVLPA01`, mismo formato que `RVDAM01`) y son las que tienen a los vendedores colgados
 * (`identity.users.route_id`). Resultado: los clientes de Kepler en una ruta y los vendedores en
 * otra — "Mi ruta" vacía para los 4 vendedores de Mauricio.
 *
 *   ruta que se queda   duplicada (baja lógica)            usuarios  agenda  clientes
 *   RVPH01              Ruta Vecinal Padre Hidalgo 1       0         0       0
 *   RVPH02              Ruta Vecinal Padre Hidalgo 2       0         0       0
 *   RVLPA01             Ruta Vecinal La Piedad Abastos     0         0       0
 *   RVYUR01 (renombre)  Ruta Vecinal Yurécuaro             —  no existía RV*: se RENOMBRA la nueva
 *
 * Decisión (Francisco, 2026-09-29): se quedan las `RV*`. La duplicada se da de BAJA LÓGICA
 * (`deleted_at`), nunca se borra — y SOLO si no tiene nada colgado (usuarios, agenda, elección
 * del supervisor, clientes, tiendas, capturas); si tiene algo, se declara en el log y no se toca.
 *
 * ── Agenda (decisión: lunes a sábado) ────────────────────────────────────────────────────────
 * Sin `daily_assignments` "Mi ruta" sale vacía y el supervisor no ve opciones en
 * `/vendor/route-pick`. Se da de alta L–S para cada vendedor en su ruta. UNIQUE es
 * (tenant, user, day_of_week): si ese día ya tiene OTRA ruta NO se pisa — se declara en el log
 * (medido: `candelaria_salgado` trae "RUTA 21" los martes, dada de alta a mano el 29-sep).
 *
 * Idempotente: re-correrla no duplica ni cambia nada.
 *
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

// [ruta que se queda, duplicada de la seed, sucursal, vendedor Kepler]
const ROUTES = [
  ['RVPH01', 'Ruta Vecinal Padre Hidalgo 1', '01', '1V001'],
  ['RVPH02', 'Ruta Vecinal Padre Hidalgo 2', '01', '1V002'],
  ['RVLPA01', 'Ruta Vecinal La Piedad Abastos', '02', '1V003'],
  ['RVYUR01', 'Ruta Vecinal Yurécuaro', '04', '1V004'],
];

// [vendedor, ruta] — equipo de mauricio_ramirez (supervisor vecinal).
const AGENDA = [
  ['candelaria_salgado', 'RVPH01'],
  ['rafael.villalobos', 'RVPH02'],
  ['42pmpb', 'RVLPA01'],
  ['jlh_lopez', 'RVYUR01'],
];
const DAYS = [1, 2, 3, 4, 5, 6]; // ISODOW: lunes..sábado

const routeQ = (knex, value) =>
  knex('trade.catalogs')
    .where({ tenant_id: T, catalog_id: 'rutas', value })
    .whereNull('deleted_at')
    .first('id', 'value', 'erp_vendor_code');

/** ¿La ruta tiene algo colgado? Si sí, NO se da de baja. */
async function dependents(knex, route) {
  const count = async (tbl, where) => Number((await knex(tbl).where(where).count('* as n').first()).n);
  return {
    usuarios: await count('identity.users', { route_id: route.id }),
    agenda: await count('trade.daily_assignments', { route_id: route.id }),
    eleccion: await count('commercial.vendor_route_day_picks', { route_id: route.id }),
    tiendas: await count('trade.stores', { ruta_id: route.id }),
    // Legacy mixto (medido): stores usa `ruta_id`, daily_captures `route_id`.
    capturas: await count('trade.daily_captures', { route_id: route.id }),
    clientes: Number(
      (
        await knex('commercial.customers')
          .whereRaw('upper(sales_route) = upper(?)', [route.value])
          .whereNull('deleted_at')
          .count('* as n')
          .first()
      ).n,
    ),
  };
}

exports.up = async function up(knex) {
  const tenant = await knex('identity.tenants').where({ id: T }).first('id');
  if (!tenant) {
    console.log('  ~ tenant mega_dulces no existe en esta base: nada que consolidar.');
    return;
  }

  for (const [code, dupValue, branch, vendor] of ROUTES) {
    let keep = await routeQ(knex, code);
    let dup = await routeQ(knex, dupValue);

    // Sin RV* (Yurécuaro): la nueva se RENOMBRA al código corto, no se crea otra.
    if (!keep && dup) {
      await knex('trade.catalogs').where({ id: dup.id }).update({ value: code, updated_at: knex.fn.now() });
      console.log(`  ✓ ${dupValue} → renombrada a ${code}`);
      keep = { ...dup, value: code };
      dup = null;
    }
    if (!keep) {
      console.log(`  ! ${code}: no existe ni ella ni su duplicada — nada que ligar.`);
      continue;
    }

    if (dup) {
      const d = await dependents(knex, dup);
      const busy = Object.entries(d).filter(([, n]) => n > 0);
      if (busy.length) {
        console.log(`  ! ${dupValue}: NO se da de baja, tiene ${busy.map(([k, n]) => `${n} ${k}`).join(', ')}. Revisar a mano.`);
        continue;
      }
      // Primero se suelta la liga (UNIQUE parcial por sucursal+vendedor), luego la baja lógica.
      await knex('trade.catalogs')
        .where({ id: dup.id })
        .update({ erp_source_branch: null, erp_vendor_code: null, deleted_at: knex.fn.now(), updated_at: knex.fn.now() });
      console.log(`  ✓ ${dupValue}: duplicada de ${code}, baja lógica`);
    }

    await knex('trade.catalogs')
      .where({ id: keep.id })
      .update({ erp_source_branch: branch, erp_vendor_code: vendor, updated_at: knex.fn.now() });
    console.log(`  ✓ ${code}: ligada a Kepler ${branch}:${vendor}`);

    // Sucursal de surtido: la central de esa sucursal, solo si la ruta no tiene una ya.
    const hasWh = await knex('commercial.route_warehouses').where({ tenant_id: T, route_id: keep.id }).first('route_id');
    if (!hasWh) {
      const wh = await knex('commercial.warehouses')
        .where({ tenant_id: T, kepler_code: branch, kind: 'central', active: true })
        .whereNull('deleted_at')
        .first('id', 'name');
      if (wh) {
        await knex('commercial.route_warehouses').insert({ tenant_id: T, route_id: keep.id, warehouse_id: wh.id });
        console.log(`    surte de: ${wh.name}`);
      } else {
        console.log(`    ! sin almacén central kepler_code=${branch}: ${code} queda sin sucursal de surtido.`);
      }
    }
  }

  // ── Vendedores: ruta base + agenda L–S ──
  for (const [username, code] of AGENDA) {
    const user = await knex('identity.users').where({ tenant_id: T, username }).whereNull('deleted_at').first('id', 'route_id', 'supervisor_id');
    const route = await routeQ(knex, code);
    if (!user || !route) {
      console.log(`  ! agenda ${username} → ${code}: ${!user ? 'usuario' : 'ruta'} no existe.`);
      continue;
    }
    if (!user.route_id) {
      await knex('identity.users').where({ id: user.id }).update({ route_id: route.id });
      console.log(`  ✓ ${username}: ruta base = ${code}`);
    }

    const existing = await knex('trade.daily_assignments as d')
      .join('trade.catalogs as r', 'r.id', 'd.route_id')
      .where({ 'd.tenant_id': T, 'd.user_id': user.id })
      // SIN filtrar deleted_at: el UNIQUE (tenant, user, dow) incluye las bajas lógicas, y una
      // baja en ese día haría que el INSERT se ignore en silencio.
      .select('d.day_of_week', 'd.route_id', 'd.deleted_at', 'r.value');
    const byDay = new Map(existing.map((e) => [Number(e.day_of_week), e]));

    const toInsert = [];
    for (const dow of DAYS) {
      const e = byDay.get(dow);
      if (!e) toInsert.push(dow);
      else if (e.deleted_at) console.log(`  ! ${username} día ${dow}: hay una asignación dada de baja ("${e.value}") — NO se pisa.`);
      else if (e.route_id !== route.id) console.log(`  ! ${username} día ${dow}: ya tiene "${e.value}" — NO se pisa.`);
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
      console.log(`  ✓ ${username}: agenda ${code} días ${toInsert.join(',')}`);
    }
  }
};

exports.down = async function down(knex) {
  // Solo se suelta la liga de las RV*; la agenda y la baja lógica se revierten a mano (pueden
  // tener ya visitas o pedidos colgando).
  for (const [code] of ROUTES) {
    await knex('trade.catalogs')
      .where({ tenant_id: T, catalog_id: 'rutas', value: code })
      .update({ erp_source_branch: null, erp_vendor_code: null });
  }
};
