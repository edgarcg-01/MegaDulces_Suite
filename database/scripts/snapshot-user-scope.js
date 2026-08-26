'use strict';
/**
 * `[ID.0]` — Arnés de no-regresión del ALCANCE (Fase ID / ADR-050).
 *
 * Hermano de `snapshot-user-privileges.js`. Ese prueba QUÉ ACCIONES puede hacer
 * cada usuario; este prueba SOBRE QUÉ FILAS. Son los dos ejes del ADR-050 y se
 * verifican por separado.
 *
 * Cómo funciona y por qué así: en vez de comparar la CONFIGURACIÓN (columnas hoy
 * vs tablas `user_scopes` después — incomparables), calcula para cada usuario el
 * **conjunto efectivo de valores visibles** por dimensión. Eso sí es comparable:
 * si la Fase ID está bien hecha, el conjunto no cambia ni un elemento.
 *
 *   MODO `legacy`  → resuelve con las reglas de HOY (columnas dispersas).
 *   MODO `scopes`  → resuelve con `identity.user_scopes` / `role_scopes`.
 *   El diff entre los dos DEBE SER VACÍO tras la migración de materialización.
 *
 * Clave = UUID del usuario, igual que en el snapshot de privilegios: un rename
 * legítimo no debe leerse como cambio de alcance.
 *
 * Uso:
 *   node database/scripts/snapshot-user-scope.js --write   .tmp-scope.json
 *   node database/scripts/snapshot-user-scope.js --compare .tmp-scope.json
 *   node database/scripts/snapshot-user-scope.js --compare <f> --mode scopes
 *   DATABASE_URL_NEW=<prod> node ... (default: el .env local)
 *
 * Exit 1 si hay diferencias (sirve como test en la suite de regresión).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const WRITE = process.argv.indexOf('--write');
const COMPARE = process.argv.indexOf('--compare');
const MODE_I = process.argv.indexOf('--mode');
const MODE = MODE_I > -1 ? process.argv[MODE_I + 1] : 'legacy';
const FILE = WRITE > -1 ? process.argv[WRITE + 1] : COMPARE > -1 ? process.argv[COMPARE + 1] : null;

if (!FILE) {
  console.error('Falta la ruta del archivo de snapshot. Ver el encabezado del script.');
  process.exit(1);
}
if (!['legacy', 'scopes'].includes(MODE)) {
  console.error(`--mode inválido: ${MODE} (legacy | scopes)`);
  process.exit(1);
}

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

// Espeja `PLATFORM_ADMIN_ROLES` de libs/platform-core/.../ability.factory.ts.
// Si allá cambia, acá también: es god-mode y anula cualquier restricción.
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']);

/** Las 6 dimensiones del ADR-050, en el orden del catálogo. */
const DIMENSIONS = ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'];

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST)
    ? DST
    : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

/**
 * Universo de valores de cada dimensión (lo que significa `all`).
 *
 * A propósito SIN `.catch(() => [])`: un universo vacío por un typo o una columna
 * que no existe haría que `all` valga lo mismo que `none`, y el diff pasaría en
 * verde tapando una regresión real. Si una query falla, el arnés truena.
 *
 * Cada tabla filtra su vida con la columna que REALMENTE tiene: `warehouses` y
 * `brands` usan `deleted_at`, pero `finance.expense_areas` usa `active`.
 */
const UNIVERSO_SQL = {
  // Sucursales REALES: `commercial.warehouses` mezcla las sucursales con
  // almacenes-ruta (RUTA-*, MD-30/32) y basura de tests, así que el universo son
  // los códigos de 2 dígitos vivos — lo mismo que valida el DTO (`^[0-9]{2}$`).
  warehouse: `SELECT code AS v FROM commercial.warehouses
               WHERE deleted_at IS NULL AND code ~ '^[0-9]{2}$' ORDER BY code`,
  zone: `SELECT id AS v FROM trade.zones WHERE deleted_at IS NULL ORDER BY orden`,
  route: `SELECT id AS v FROM trade.catalogs WHERE catalog_id = 'rutas' AND deleted_at IS NULL`,
  brand: `SELECT id AS v FROM catalog.brands WHERE deleted_at IS NULL`,
  expense_area: `SELECT id AS v FROM finance.expense_areas WHERE active IS TRUE`,
  customer: `SELECT id AS v FROM commercial.customers WHERE deleted_at IS NULL`,
};

async function universo() {
  const u = {};
  for (const dim of DIMENSIONS) {
    const r = await knex.raw(UNIVERSO_SQL[dim]);
    u[dim] = r.rows.map((x) => x.v);
    if (!u[dim].length) {
      console.warn(`  ⚠ universo de ${dim} VACÍO — 'all' y 'none' se vuelven indistinguibles en esta dimensión`);
    }
  }
  return u;
}

/**
 * Reglas VIGENTES (pre-Fase ID), leídas del código real:
 *   warehouse    — `users.warehouse_code` si está; si no, TODAS.
 *                  (store-analytics.controller: `user?.warehouse_code || query`)
 *   zone         — `users.zona_id` si está; si no, TODAS. Los roles de plataforma
 *                  ignoran su zona_id (commercial-map.service.getRequesterZonaId).
 *   brand        — filas en `commercial.promoter_brands`; sin filas, TODAS
 *                  (promoter-brands.service: "si tiene marcas es promotor").
 *   expense_area — `users.finance_expense_area_ids`; vacío = NINGUNA (única
 *                  dimensión que hoy ya es fail-closed) salvo FINANCE_EXPENSES_VER_ALL.
 *   customer     — rol de portal (PORTAL_B2B_ACCESS): su `customer_id` y nada más
 *                  — si no lo tiene linkeado, NADA (commercial-orders.service
 *                  `resolveCustomerIdFromCtx` → null → página vacía; no "todos").
 *                  Rol interno: TODOS los clientes.
 *   route        — `trade.vendor_sales_routes` (tabla vacía) → TODAS.
 * Los roles de plataforma (superadmin/admin) son `all` en todo: `manage:all`.
 */
async function resolverLegacy(u) {
  const users = (
    await knex.raw(`
      SELECT u.id, u.tenant_id, u.username, u.role_name, u.warehouse_code, u.zona_id,
             u.customer_id, u.finance_expense_area_ids,
             COALESCE((rp.permissions->>'FINANCE_EXPENSES_VER_ALL')::boolean, false) AS expenses_all,
             COALESCE((rp.permissions->>'PORTAL_B2B_ACCESS')::boolean, false) AS portal
        FROM identity.users u
        LEFT JOIN identity.role_permissions rp
               ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(u.role_name)
       WHERE u.deleted_at IS NULL
       ORDER BY u.username`)
  ).rows;

  const brands = {};
  for (const r of (await knex.raw(`SELECT user_id, brand_id FROM commercial.promoter_brands`).catch(() => ({ rows: [] }))).rows) {
    (brands[r.user_id] = brands[r.user_id] || []).push(r.brand_id);
  }
  const routes = {};
  for (const r of (await knex.raw(`SELECT user_id, route_id FROM trade.vendor_sales_routes`).catch(() => ({ rows: [] }))).rows) {
    (routes[r.user_id] = routes[r.user_id] || []).push(r.route_id);
  }

  const out = {};
  for (const usr of users) {
    const god = PLATFORM_ADMIN_ROLES.has(String(usr.role_name || '').toLowerCase());
    const s = {};
    s.warehouse = god ? u.warehouse : usr.warehouse_code ? [usr.warehouse_code] : u.warehouse;
    s.zone = god ? u.zone : usr.zona_id ? [usr.zona_id] : u.zone;
    s.route = god ? u.route : routes[usr.id]?.length ? routes[usr.id] : u.route;
    s.brand = god ? u.brand : brands[usr.id]?.length ? brands[usr.id] : u.brand;
    s.expense_area = god || usr.expenses_all ? u.expense_area : usr.finance_expense_area_ids || [];
    s.customer = god
      ? u.customer
      : usr.portal
        ? usr.customer_id ? [usr.customer_id] : []
        : usr.customer_id ? [usr.customer_id] : u.customer;
    out[`${usr.tenant_id}::${usr.id}`] = { username: usr.username, role_name: usr.role_name, scope: norm(s) };
  }
  return out;
}

/** Reglas NUEVAS: user_scopes → role_scopes → none. */
async function resolverScopes(u) {
  const users = (
    await knex.raw(`
      SELECT id, tenant_id, username, role_name, warehouse_code, zona_id, customer_id
        FROM identity.users WHERE deleted_at IS NULL ORDER BY username`)
  ).rows;

  const byUser = {};
  const byRole = {};
  for (const r of (await knex.raw(`SELECT user_id, dimension, mode, values FROM identity.user_scopes`)).rows) {
    (byUser[r.user_id] = byUser[r.user_id] || {})[r.dimension] = r;
  }
  for (const r of (await knex.raw(`SELECT role_name, dimension, mode, values FROM identity.role_scopes`)).rows) {
    (byRole[String(r.role_name).toLowerCase()] = byRole[String(r.role_name).toLowerCase()] || {})[r.dimension] = r;
  }

  const out = {};
  for (const usr of users) {
    const god = PLATFORM_ADMIN_ROLES.has(String(usr.role_name || '').toLowerCase());
    const s = {};
    for (const dim of DIMENSIONS) {
      if (god) { s[dim] = u[dim]; continue; }
      const rule = byUser[usr.id]?.[dim] || byRole[String(usr.role_name || '').toLowerCase()]?.[dim] || { mode: 'none' };
      s[dim] = aplicar(rule, dim, usr, u);
    }
    out[`${usr.tenant_id}::${usr.id}`] = { username: usr.username, role_name: usr.role_name, scope: norm(s) };
  }
  return out;
}

/** `own` = el valor de la propia ficha del usuario. Evita repetirlo en cada fila. */
const PROPIO = {
  warehouse: (usr) => (usr.warehouse_code ? [usr.warehouse_code] : []),
  zone: (usr) => (usr.zona_id ? [usr.zona_id] : []),
  customer: (usr) => (usr.customer_id ? [usr.customer_id] : []),
};

function aplicar(rule, dim, usr, u) {
  switch (rule.mode) {
    case 'all': return u[dim];
    case 'listed': return rule.values || [];
    case 'own': return PROPIO[dim] ? PROPIO[dim](usr) : [];
    default: return [];
  }
}

/** Orden estable y sin duplicados: el diff no debe disparar por orden. */
function norm(s) {
  const o = {};
  for (const dim of DIMENSIONS) {
    const vals = (s[dim] || []).filter((v) => v != null).map(String);
    o[dim] = Array.from(new Set(vals)).sort();
  }
  return o;
}

(async () => {
  try {
    const u = await universo();
    const snap = MODE === 'legacy' ? await resolverLegacy(u) : await resolverScopes(u);
    const meta = { mode: MODE, universo: Object.fromEntries(DIMENSIONS.map((d) => [d, u[d].length])) };

    if (WRITE > -1) {
      fs.writeFileSync(FILE, JSON.stringify({ meta, users: snap }, null, 2));
      const total = Object.keys(snap).length;
      console.log(`baseline de alcance escrito (${MODE}): ${FILE}`);
      console.log(`  ${total} usuarios · universo: ${DIMENSIONS.map((d) => `${d}=${u[d].length}`).join(' ')}`);
      // Cuántos ven TODO en cada dimensión: es la métrica que la Fase ID debe bajar.
      for (const dim of DIMENSIONS) {
        const n = Object.values(snap).filter((x) => x.scope[dim].length === u[dim].length && u[dim].length > 0).length;
        console.log(`  ven TODAS las ${dim}: ${n}/${total}`);
      }
      return;
    }

    const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const base = prev.users || prev; // tolera un baseline viejo sin `meta`
    let fallas = 0;
    const claves = new Set([...Object.keys(base), ...Object.keys(snap)]);
    for (const k of claves) {
      const a = base[k];
      const b = snap[k];
      if (!a) { console.log(`+ NUEVO   ${b.username} (${b.role_name})`); fallas++; continue; }
      if (!b) { console.log(`- FALTA   ${a.username} (${a.role_name})`); fallas++; continue; }
      const difs = [];
      for (const dim of DIMENSIONS) {
        const x = a.scope[dim] || [];
        const y = b.scope[dim] || [];
        const gana = y.filter((v) => !x.includes(v));
        const pierde = x.filter((v) => !y.includes(v));
        if (gana.length || pierde.length) {
          difs.push(
            `${dim}: ${x.length}→${y.length}` +
              (gana.length ? ` GANA ${gana.slice(0, 4).join(',')}${gana.length > 4 ? `…+${gana.length - 4}` : ''}` : '') +
              (pierde.length ? ` PIERDE ${pierde.slice(0, 4).join(',')}${pierde.length > 4 ? `…+${pierde.length - 4}` : ''}` : ''),
          );
        }
      }
      if (difs.length) { console.log(`! ${b.username} (${b.role_name})`); difs.forEach((d) => console.log(`    ${d}`)); fallas++; }
    }

    if (fallas) {
      console.log(`\nFALLA — ${fallas} usuario(s) con alcance distinto al baseline (${prev.meta?.mode || '?'} → ${MODE}).`);
      process.exitCode = 1;
    } else {
      console.log(`OK — ${Object.keys(snap).length} usuarios, alcance efectivo IDÉNTICO al baseline (${prev.meta?.mode || '?'} → ${MODE}).`);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
