/**
 * `[ID.2]` — Tipos del ALCANCE de datos (Fase ID / ADR-050).
 *
 * El permiso dice QUÉ ACCIÓN (`Permission` + `RolesGuard`); el alcance dice
 * SOBRE QUÉ FILAS. Son dos ejes distintos y se invalidan distinto: el permiso
 * viaja en el JWT (cambiarlo exige re-login), el alcance se lee de DB con TTL
 * (cambiarlo NO exige re-login).
 *
 * No confundir con `getDataScope()` de `ability/data-scope.ts`, que resuelve la
 * jerarquía de REPORTES (propio / equipo / global vía `supervisor_id`). Eso es
 * otro eje y sigue viviendo aparte.
 */

/** Las 6 dimensiones de `identity.scope_dimensions`. */
export type ScopeDimension =
  | 'warehouse'
  | 'zone'
  | 'route'
  | 'brand'
  | 'expense_area'
  | 'customer';

export const SCOPE_DIMENSIONS: ScopeDimension[] = [
  'warehouse',
  'zone',
  'route',
  'brand',
  'expense_area',
  'customer',
];

/**
 * `none`   — no ve nada de esta dimensión. **Default si no hay fila** (fail-closed).
 * `own`    — el valor de su propia ficha (`users.warehouse_code` / `zona_id` /
 *            `customer_id`). Evita repetir el valor en cada renglón de config.
 * `listed` — exactamente `values[]`. Permite "la suya + la 03".
 * `all`    — toda la dimensión. Tiene que ser EXPLÍCITO.
 */
export type ScopeMode = 'none' | 'own' | 'listed' | 'all';

/** De dónde salió la regla — es lo que hace explicable el "Acceso efectivo". */
export type ScopeSource = 'user' | 'role' | 'default' | 'platform_admin';

export interface ResolvedDimension {
  mode: ScopeMode;
  /** Valores concretos para lectura. Vacío cuando `mode` es `all` o `none`. */
  values: string[];
  modeWrite: ScopeMode;
  valuesWrite: string[];
  source: ScopeSource;
  /** Texto de por qué se le dio de más, capturado al otorgar el override. */
  nota?: string | null;
}

export interface ResolvedScope {
  tenantId: string;
  userId: string;
  roleName: string;
  dims: Record<ScopeDimension, ResolvedDimension>;
}

/**
 * `[RE.23]` — **La llave canónica de la dimensión `warehouse` es el código de
 * sucursal de 2 dígitos**, y `commercial.warehouses.code` no siempre lo trae.
 *
 * Las 7 sucursales Kepler lo guardan tal cual (`'00'`..`'06'`); las de Morelia
 * —que corren Wincaja y no tienen código Kepler— lo guardan prefijado
 * (`'MD-30'`, `'MD-32'`) y el de 2 dígitos vive en `wincaja_source_branch`.
 *
 * Filtrar por `code ~ '^[0-9]{2}$'`, que es lo que se hacía **en tres lugares
 * distintos**, dejaba a Morelia fuera del modelo de alcance: no se podía
 * asignar a nadie, no salía en ningún selector, y de todos modos no habría
 * filtrado nada porque los feeds emiten `'30'`, no `'MD-30'`. Medido en prod:
 * `sucursal = '30'` → 2,405 recepciones · `sucursal = 'MD-30'` → **0**.
 *
 * Los almacenes-ruta (`RUTA-*`) y la basura de tests no tienen
 * `wincaja_source_branch`, así que siguen quedando fuera — que es lo correcto:
 * no son sucursales de la red.
 *
 * @param alias alias de `commercial.warehouses` en la query que la usa.
 */
export const branchKeySql = (alias = 'w'): string =>
  `CASE WHEN ${alias}.code ~ '^[0-9]{2}$' THEN ${alias}.code ELSE ${alias}.wincaja_source_branch END`;

/** Filas de `commercial.warehouses` que SON una sucursal de la red. */
export const branchKeyFilterSql = (alias = 'w'): string =>
  `(${branchKeySql(alias)}) ~ '^[0-9]{2}$'`;

/** ¿Este valor ya viene en la llave canónica de `warehouse`? */
export const esCodigoSucursal = (v: string): boolean => /^[0-9]{2}$/.test(v);

/** Fila cruda de `identity.role_scopes` / `identity.user_scopes`. */
export interface ScopeRuleRow {
  dimension: ScopeDimension;
  mode: ScopeMode;
  values: string[] | null;
  mode_write: ScopeMode | null;
  nota?: string | null;
}
