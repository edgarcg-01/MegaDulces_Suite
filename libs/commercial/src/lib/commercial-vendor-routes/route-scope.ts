import { ForbiddenException } from '@nestjs/common';
import type { Knex } from 'knex';

/**
 * `[MCP.3.9]` Alcance por TIPO DE RUTA de quien consulta — UNA sola función para todo el módulo
 * (tablero del supervisor, monitoreo de visitas y las pestañas de asignación de «Cartera de ventas»).
 *
 * Lo decide el PUESTO de quien consulta (`identity.users.position_code → identity.positions
 * .department_code`), no el rol: `supervisor_ventas` es el rol de los dos supervisores, y lo que
 * los distingue es el puesto («Supervisor de Ventas Vecinal» / «… Ruta Directa»).
 *
 *  · `ruta_vecinal` → sólo rutas con `trade.catalogs.route_kind = 'vecinal'`.
 *  · `ruta_directa` → sólo rutas que NO son vecinales (`route_kind IS DISTINCT FROM 'vecinal'`):
 *    las que nadie declaró cuentan como directa (hay muchas sin `route_kind`; filtrar por
 *    `camion` las dejaría fuera).
 *  · superadmin/admin (god-mode) → todas, sea cual sea su puesto.
 *  · cualquier otro puesto, o sin puesto → sin recorte (como siempre).
 *
 * Una ruta que no está en el catálogo (p. ej. un `customers.sales_route` suelto) no tiene tipo
 * declarado: para el alcance vecinal NO entra (cierra, no abre); para el directo, sí.
 */

/** `identity.positions.department_code` de los puestos de Ruta Vecinal (`supervisor_rv`, …). */
export const DEPARTAMENTO_VECINAL = 'ruta_vecinal';
/** `identity.positions.department_code` de los puestos de Ruta Directa. */
export const DEPARTAMENTO_DIRECTA = 'ruta_directa';

/** Tipo de ruta que ve quien consulta. `null` = todas. */
export type RouteScope = 'vecinal' | 'directa' | null;

/** Etiqueta de pantalla del alcance. */
export const ROUTE_SCOPE_LABEL: Record<'vecinal' | 'directa', string> = {
  vecinal: 'Rutas vecinales',
  directa: 'Ruta directa',
};

/** Puro: el alcance que le toca a un departamento. God-mode nunca se recorta. */
export function routeScopeFor(department: string | null | undefined, seeAll: boolean): RouteScope {
  if (seeAll) return null;
  if (department === DEPARTAMENTO_VECINAL) return 'vecinal';
  if (department === DEPARTAMENTO_DIRECTA) return 'directa';
  return null;
}

/** Puro: ¿una ruta de este `route_kind` entra en el alcance? */
export function kindInScope(scope: RouteScope, kind: string | null | undefined): boolean {
  if (scope === 'vecinal') return kind === 'vecinal';
  if (scope === 'directa') return kind !== 'vecinal';
  return true;
}

/** Llave de comparación de un nombre de ruta: el catálogo y `customers.sales_route` difieren en mayúsculas. */
export function routeKey(v: string | null | undefined): string {
  return (v ?? '').trim().toUpperCase();
}

/** Código de ruta vecinal de Kepler (`kdm1.c12`): `1V003`, `2V001`, `3V001`… */
const KEPLER_ROUTE_CODE_RX = /^([0-9]V[0-9]{3})\b/i;

export interface RouteCatalogRow {
  id?: string;
  value: string;
  route_kind: string | null;
  erp_vendor_code?: string | null;
}

/** El catálogo de rutas (`trade.catalogs`, `catalog_id = 'rutas'`) indexado por nombre. */
export class RouteCatalog {
  private readonly byKey = new Map<string, RouteCatalogRow[]>();

  constructor(rows: readonly RouteCatalogRow[]) {
    for (const r of rows) {
      const k = routeKey(r.value);
      (this.byKey.get(k) ?? this.byKey.set(k, []).get(k)!).push(r);
    }
  }

  /** Tipo declarado. Si el mismo nombre está dos veces y una es vecinal, manda la vecinal. */
  kindOf(value: string | null | undefined): string | null {
    const rs = this.byKey.get(routeKey(value));
    if (!rs?.length) return null;
    return rs.some((r) => r.route_kind === 'vecinal') ? 'vecinal' : rs.find((r) => r.route_kind)?.route_kind ?? null;
  }

  /**
   * Código de ruta en Kepler: el declarado (`erp_vendor_code`) o, si no hay, el que encabeza el
   * nombre (`1V003 PAULINA …`). `null` = la ruta no tiene identidad en Kepler.
   */
  keplerCode(value: string | null | undefined): string | null {
    const rs = this.byKey.get(routeKey(value)) ?? [];
    const declared = rs.map((r) => (r.erp_vendor_code ?? '').trim()).find((c) => c !== '');
    if (declared) return declared.toUpperCase();
    const m = KEPLER_ROUTE_CODE_RX.exec((value ?? '').trim());
    return m ? m[1].toUpperCase() : null;
  }

  inScope(scope: RouteScope, value: string | null | undefined): boolean {
    if (scope === null) return true;
    if (!value || !value.trim()) return scope === 'directa';
    return kindInScope(scope, this.kindOf(value));
  }
}

/** El catálogo de rutas del tenant. `public.catalogs` NO expone `route_kind` ni `erp_vendor_code`: se lee la tabla. */
export async function loadRouteCatalog(trx: Knex | Knex.Transaction): Promise<RouteCatalog> {
  const r = await trx.raw(
    `SELECT id, value, route_kind, erp_vendor_code FROM trade.catalogs
      WHERE tenant_id = public.current_tenant_id() AND catalog_id = 'rutas' AND deleted_at IS NULL`,
  );
  return new RouteCatalog(r.rows as RouteCatalogRow[]);
}

/** `department_code` del puesto de una persona (`null` sin puesto). */
export async function departmentOf(trx: Knex | Knex.Transaction, userId: string): Promise<string | null> {
  const r = await trx.raw(
    `SELECT p.department_code
       FROM identity.users u
       JOIN identity.positions p
         ON p.tenant_id = u.tenant_id AND p.code = u.position_code AND p.deleted_at IS NULL
      WHERE u.id = ?::uuid AND u.tenant_id = public.current_tenant_id()`,
    [userId],
  );
  return (r.rows?.[0]?.department_code as string | undefined) ?? null;
}

export interface ResolvedRouteScope {
  scope: RouteScope;
  label: string | null;
  /** Cargado sólo si hay recorte (o si se pidió con `withCatalog`). */
  catalog: RouteCatalog | null;
  /** ¿Esta ruta (nombre de catálogo / `sales_route`) entra en el alcance? */
  allows(route: string | null | undefined): boolean;
  /** 403 si la ruta no entra. Para las escrituras. */
  assert(route: string | null | undefined): void;
}

/**
 * Resuelve el alcance de quien consulta. Fail-closed: sin identidad y sin god-mode, 403.
 * `department` se puede pasar si ya se leyó (el monitoreo lo trae en su primera consulta).
 */
export async function resolveRouteScope(
  trx: Knex | Knex.Transaction,
  opts: { me: string | null; seeAll: boolean; department?: string | null; withCatalog?: boolean },
): Promise<ResolvedRouteScope> {
  if (!opts.seeAll && !opts.me) throw new ForbiddenException('Sin usuario en sesión');
  const department = opts.seeAll ? null : opts.department !== undefined ? opts.department : await departmentOf(trx, opts.me!);
  const scope = routeScopeFor(department, opts.seeAll);
  const catalog = scope !== null || opts.withCatalog ? await loadRouteCatalog(trx) : null;
  const allows = (route: string | null | undefined) => scope === null || catalog!.inScope(scope, route);
  return {
    scope,
    label: scope ? ROUTE_SCOPE_LABEL[scope] : null,
    catalog,
    allows,
    assert(route) {
      if (!allows(route)) {
        throw new ForbiddenException(`La ruta ${route ?? '(sin ruta)'} no es de tu alcance (${ROUTE_SCOPE_LABEL[scope!]})`);
      }
    },
  };
}
