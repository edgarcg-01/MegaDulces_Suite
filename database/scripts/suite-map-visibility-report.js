'use strict';
/* eslint-disable no-console */
/**
 * `[SN.1]` — Medición de VISIBILIDAD por rol: tarjetas legacy vs entradas del mapa de la suite.
 *
 * READ-ONLY. Lee `identity.role_permissions` (el JSONB que viaja en el JWT) y, para cada rol,
 * calcula qué tarjetas veía en la landing vieja (los 11 `anyOf` congelados al 2026-09-10) y qué
 * entradas ve en la nueva (`visibleSuiteMap` del `.ts` REAL, cargado con ts-node — no una
 * reimplementación). Reporta por rol: perdidas, ganadas y cross-links.
 *
 * Regla (criterio de salida Etapa 2, §24 de la spec): **nunca menos**. Una puerta perdida es
 * exit 1. Las ganadas no son error —derivar del árbol es más completo que las listas a mano, y
 * ésa era la causa de `[AUTHZ.6]` e `[IDG.9.6]`— pero se listan para revisarlas a mano antes de
 * mergear, porque una puerta nueva que rebota en el guard es peor que ninguna.
 *
 * Uso:  node database/scripts/suite-map-visibility-report.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) {
  console.error('Falta DATABASE_URL_NEW en .env');
  process.exit(1);
}

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir de Nx) y falla
// con TS5011 antes de compilar. Mismo patrón que test-newdb-scope-params.
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const AUTHZ = path.resolve(__dirname, '../../libs/contracts/src/authz');
const { Permission } = require(path.join(AUTHZ, 'permissions.ts'));
const { visibleSuiteMap, primaryDestinations, SUITE_SPACES } = require(path.join(AUTHZ, 'suite-map.ts'));

/** Copia congelada de `projects.component.ts` (2026-09-10). La misma que `suite-map.parity.spec.ts`. */
const LEGACY = [
  { card: 'Auditoría en Ruta', destino: 'rutas-auditoria', anyOf: [Permission.VISITAS_REGISTRAR, Permission.REPORTES_VER_PROPIO, Permission.REPORTES_VER_EQUIPO, Permission.REPORTES_VER_GLOBAL, Permission.TIENDAS_VER, Permission.VER_SEGUIMIENTO, Permission.PLANOGRAMAS_GESTIONAR, Permission.CATALOGO_GESTIONAR, Permission.USUARIOS_ASIGNAR_RUTA] },
  { card: 'Ventas', destino: 'ventas-backoffice', hideForRoles: ['vendedor'], anyOf: [Permission.COMMERCIAL_ORDERS_VER, Permission.COMMERCIAL_ORDERS_CREAR, Permission.COMMERCIAL_CUSTOMERS_VER, Permission.COMMERCIAL_CUSTOMERS_GESTIONAR, Permission.COMMERCIAL_PRICING_VER, Permission.COMMERCIAL_ANALYTICS_VER, Permission.COMMERCIAL_SELLOUT_VER, Permission.COMMERCIAL_SALIDAS_VER, Permission.COMMERCIAL_ROUTE_SALES_VER, Permission.COMMERCIAL_SALES_DOCS_VER, Permission.COMMERCIAL_CUSTOMERS360_VER, Permission.COMMERCIAL_HISTORICAL_VER, Permission.COMMERCIAL_ERP_PROMOS_VER, Permission.COMMERCIAL_VENDOR_SALES_VER] },
  { card: 'Almacén', destino: 'almacenes', anyOf: [Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_WAREHOUSES_VER, Permission.COMMERCIAL_DEADSTOCK_VER, Permission.COMMERCIAL_INVHEALTH_VER, Permission.RECONCILIATION_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR, Permission.COMMERCIAL_INVENTORY_CONTAR, Permission.COMMERCIAL_INVENTORY_ASIGNAR, Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR, Permission.COMMERCIAL_MOVEMENTS_VER, Permission.COMMERCIAL_PREVENTION_VER] },
  { card: 'Compras', destino: 'compras', anyOf: [Permission.COMPRAS_PEDIDO_VER, Permission.COMPRAS_RED_VER, Permission.COMPRAS_REQUISICIONES_VER, Permission.COMPRAS_ORDENES_VER, Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_360_VER, Permission.COMPRAS_COSTO_NETO_VER, Permission.COMPRAS_DESCUENTOS_VER, Permission.COMPRAS_HALLAZGOS_VER, Permission.COMPRAS_PROVEEDORES_VER, Permission.COMPRAS_CATEGORIAS_VER] },
  { card: 'Telemarketing', destino: 'mayoreo-telemarketing', anyOf: [Permission.COMMERCIAL_TELEVENTA_OPERATE, Permission.COMMERCIAL_TELEVENTA_VER] },
  { card: 'Logística', destino: 'transporte-y-embarques', anyOf: [Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_FLEET_VER, Permission.LOGISTICS_PAYROLL_VER, Permission.LOGISTICS_EXPENSES_VER, Permission.LOGISTICS_TRANSFERS_VER] },
  { card: 'Tienda', destino: 'pisos-de-venta', anyOf: [Permission.STORE_LIVE_VER, Permission.STORE_LABELS_VER, Permission.STORE_ARQUEO_VER, Permission.STORE_ARQUEO_CAPTURAR, Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR] },
  { card: 'Reparto', destino: 'entregas-reparto', anyOf: [Permission.REPARTO_DESPACHAR] },
  { card: 'Finanzas', destino: 'finanzas', anyOf: [Permission.FINANCE_EXPENSES_VER] },
  { card: 'Contabilidad', destino: 'contabilidad', anyOf: [Permission.FISCAL_LISTAS_VER, Permission.FISCAL_CFDI_VER, Permission.FISCAL_CONCILIACION_VER, Permission.FISCAL_DIOT_VER, Permission.FISCAL_CONTAB_VER, Permission.FISCAL_DESCARGA_VER, Permission.FISCAL_CREDENCIALES_GESTIONAR] },
  { card: 'Administración', destino: 'configuracion-suite', anyOf: [Permission.USUARIOS_GESTIONAR, Permission.ROLES_CONFIGURAR] },
];

const PLATFORM_ADMIN = new Set(['superadmin', 'admin']);
const host = (() => { try { return new URL(DST).host; } catch { return '(url ilegible)'; } })();

(async () => {
  const knex = require('knex')({ client: 'pg', connection: DST, pool: { min: 0, max: 2 } });
  try {
    const roles = await knex('identity.role_permissions as rp')
      .leftJoin('identity.tenants as t', 't.id', 'rp.tenant_id')
      .whereNull('rp.deleted_at')
      .select('t.slug as tenant', 'rp.role_name', 'rp.permissions')
      .orderBy(['t.slug', 'rp.role_name']);
    const usuarios = await knex('identity.users')
      .whereNull('deleted_at')
      .where('activo', true)
      .groupBy('tenant_id', 'role_name')
      .select('tenant_id', 'role_name', knex.raw('count(*)::int as n'));
    const nPorRol = new Map(usuarios.map((u) => [`${u.tenant_id}::${u.role_name}`, u.n]));
    const tenantIds = await knex('identity.tenants').select('id', 'slug');
    const idPorSlug = new Map(tenantIds.map((t) => [t.slug, t.id]));

    console.log(`\n═══ Visibilidad por rol · legacy (11 tarjetas) vs mapa (${SUITE_SPACES.length} espacios) · ${host} ═══`);
    console.log('(sólo lectura; usuarios = activos con ese rol)\n');

    let perdidasTotal = 0;
    const filas = [];
    for (const r of roles) {
      const perms = Object.fromEntries(Object.entries(r.permissions || {}).filter(([, v]) => v === true));
      const isAdmin = PLATFORM_ADMIN.has(String(r.role_name).toLowerCase());
      const legacy = LEGACY.filter((c) => !(c.hideForRoles && c.hideForRoles.includes(r.role_name)))
        .filter((c) => isAdmin || c.anyOf.some((p) => perms[p] === true))
        .map((c) => c.destino);
      const vis = visibleSuiteMap(perms, isAdmin, r.role_name);
      const primarias = vis.spaces.flatMap((s) => s.entries.filter((e) => e.entry.kind === 'project' && !e.entry.crossLink).map((e) => e.entry.id));
      const cross = vis.spaces.flatMap((s) => s.entries.filter((e) => e.entry.crossLink).map((e) => e.entry.id));
      const perdidas = legacy.filter((d) => !primarias.includes(d));
      const ganadas = primarias.filter((d) => !legacy.includes(d));
      perdidasTotal += perdidas.length;
      filas.push({
        tenant: r.tenant, rol: r.role_name, usuarios: nPorRol.get(`${idPorSlug.get(r.tenant)}::${r.role_name}`) ?? 0,
        legacy: legacy.length, nuevas: primarias.length, destinos: primaryDestinations(vis).length,
        perdidas, ganadas, cross,
      });
    }

    for (const f of filas) {
      const flag = f.perdidas.length ? '✗' : f.ganadas.length || f.cross.length ? '+' : ' ';
      console.log(`${flag} ${String(f.tenant).padEnd(14)} ${String(f.rol).padEnd(26)} usuarios=${String(f.usuarios).padStart(3)}  tarjetas=${String(f.legacy).padStart(2)} → entradas=${String(f.nuevas).padStart(2)} (destinos ${f.destinos})`);
      if (f.perdidas.length) console.log(`      PERDIDAS: ${f.perdidas.join(', ')}`);
      if (f.ganadas.length) console.log(`      ganadas : ${f.ganadas.join(', ')}`);
      if (f.cross.length) console.log(`      cross   : ${f.cross.join(', ')}`);
    }

    const conGanancia = filas.filter((f) => f.ganadas.length);
    const usuariosGanan = conGanancia.reduce((a, f) => a + f.usuarios, 0);
    console.log(`\nRoles: ${filas.length} · con puertas PERDIDAS: ${filas.filter((f) => f.perdidas.length).length} · con puertas ganadas: ${conGanancia.length} (${usuariosGanan} usuarios activos)`);
    if (perdidasTotal) {
      console.error(`\n✗ ${perdidasTotal} puerta(s) perdida(s). La Etapa 2 exige "sin pérdida de permisos".`);
      process.exit(1);
    }
    console.log('\n✓ Ninguna puerta perdida. Las ganadas se revisan a mano (ver arriba).');
  } finally {
    await knex.destroy();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
