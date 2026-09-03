import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.module';
import { TenantContextService } from '../tenant/tenant-context.service';
import { isPlatformAdminRole } from '../ability/platform-admin';
import { parseScopeParam } from './scope-params';
import {
  ResolvedDimension,
  ScopeSource,
  ResolvedScope,
  ScopeDimension,
  ScopeMode,
  ScopeRuleRow,
  SCOPE_DIMENSIONS,
  branchKeySql,
  branchKeyFilterSql,
  esCodigoSucursal,
} from './scope.types';

/**
 * `[ID.2]` — El ÚNICO lugar donde se resuelve y se aplica el alcance de datos
 * (Fase ID / ADR-050).
 *
 * El problema que reemplaza: hoy cada controller lo hace a mano, y el patrón
 * dominante es fail-OPEN —
 *
 *     const effective = user?.warehouse_code || query.warehouse_code;  // ← 41 módulos
 *
 * o sea, quien no tiene sucursal asignada ve la red completa (83 de 117 usuarios
 * en prod). Acá la ausencia de configuración significa `none`, y `all` tiene que
 * estar escrito.
 *
 * Diseño, espejando `PermissionsCacheService`:
 *   - Cache por `(tenant, user)` con TTL 30s. Va por USUARIO, no por rol, porque
 *     `user_scopes` es un override por persona y `own` depende de su ficha.
 *   - `KNEX_CONNECTION` es superuser → **bypassa RLS**, así que toda query lleva
 *     `tenant_id` explícito. Sin eso sería un leak cross-tenant.
 *   - Los roles de plataforma (`superadmin`/`admin`) son `all` en todo: espeja
 *     `manage:all` de `buildAbility` y el escape de
 *     `commercial-map.service.getRequesterZonaId()`. Sin esto, un superadmin con
 *     `zona_id` heredado quedaba filtrado a esa zona (bug ya vivido).
 *
 * Primer consumidor (`[ID.4]`): `store-analytics.controller` — /tienda/análisis
 * semanal. El resto de los dominios migra de a uno; hasta que lo hagan siguen
 * con su filtro a mano, y este servicio simplemente no los toca.
 */

interface CacheEntry {
  scope: ResolvedScope;
  expiresAt: number;
}

const TTL_MS = 30_000;

/**
 * `own` = el valor de la propia ficha.
 *
 * `[ID.24.1]` `route` entró acá al existir `identity.users.route_id`. Antes la
 * dimensión `route` no podía ser `own` —no había columna— y por eso quedó en
 * `all` para **42 de 45 roles**: no fue una decisión, fue la única opción. Con
 * la columna, "el vendedor ve SU ruta" por fin se puede escribir.
 */
const COLUMNA_PROPIA: Partial<Record<ScopeDimension, string>> = {
  warehouse: 'warehouse_code',
  zone: 'zona_id',
  customer: 'customer_id',
  route: 'route_id',
};

/**
 * Universo de cada dimensión — lo que significa `all` cuando hay que ENUMERAR
 * (el picker del front, el panel de "Acceso efectivo"). En la ruta caliente de
 * queries `all` no enumera nada: simplemente no filtra.
 *
 * `warehouse` se identifica por **código de 2 dígitos**, no por `kind='central'`:
 * `commercial.warehouses` mezcla las sucursales con almacenes-ruta (`RUTA-*`) y
 * basura de tests. El código de 2 dígitos es exactamente lo que
 * `users.warehouse_code` puede contener (el DTO valida `^[0-9]{2}$`) y lo que
 * los feeds usan como sucursal.
 *
 * `[RE.23]` Ese código sale de `branchKeySql()`, **no** de `code` a secas: las
 * sucursales de Morelia lo guardan prefijado (`MD-30`) y filtrar por `code`
 * las dejaba fuera del modelo de alcance por completo. Ver `scope.types.ts`.
 */
const UNIVERSO_SQL: Record<ScopeDimension, { sql: string; label: string }> = {
  warehouse: {
    sql: `SELECT ${branchKeySql('w')} AS v, w.name AS label FROM commercial.warehouses w
           WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND ${branchKeyFilterSql('w')}
           ORDER BY 1`,
    label: 'Sucursal',
  },
  zone: {
    sql: `SELECT id::text AS v, name AS label FROM trade.zones
           WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY orden`,
    label: 'Zona',
  },
  route: {
    sql: `SELECT id::text AS v, value AS label FROM trade.catalogs
           WHERE tenant_id = ? AND catalog_id = 'rutas' AND deleted_at IS NULL ORDER BY orden`,
    label: 'Ruta',
  },
  brand: {
    sql: `SELECT id::text AS v, nombre AS label FROM catalog.brands
           WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY nombre`,
    label: 'Marca',
  },
  expense_area: {
    sql: `SELECT id::text AS v, name AS label FROM finance.expense_areas
           WHERE tenant_id = ? AND active IS TRUE ORDER BY name`,
    label: 'Área de gasto',
  },
  customer: {
    sql: `SELECT id::text AS v, name AS label FROM commercial.customers
           WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name`,
    label: 'Cliente',
  },
};

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cómo llevar un valor cualquiera (uuid o etiqueta legible) a la **llave
 * canónica** de la dimensión. `esCanonico` es el que decide qué NO hay que
 * traducir.
 *
 * `[RE.23]` En `warehouse` la llave canónica NO es `code`: es el código de 2
 * dígitos de `branchKeySql()`. Antes el test era "no es un uuid", así que
 * `MD-30` se colaba como si ya fuera canónico y terminaba en un
 * `IN ('MD-30')` que no matchea ninguna fila de los feeds (que emiten `'30'`).
 */
const TRADUCCION: Record<
  ScopeDimension,
  { tabla: string; etiqueta: string; canon: string; esCanonico: (v: string) => boolean }
> = {
  warehouse: {
    tabla: 'commercial.warehouses t',
    etiqueta: 't.code',
    canon: branchKeySql('t'),
    esCanonico: esCodigoSucursal,
  },
  zone: { tabla: 'trade.zones t', etiqueta: 't.name', canon: 't.id::text', esCanonico: (v) => UUID_RX.test(v) },
  route: { tabla: 'trade.catalogs t', etiqueta: 't.value', canon: 't.id::text', esCanonico: (v) => UUID_RX.test(v) },
  brand: { tabla: 'catalog.brands t', etiqueta: 't.nombre', canon: 't.id::text', esCanonico: (v) => UUID_RX.test(v) },
  expense_area: { tabla: 'finance.expense_areas t', etiqueta: 't.name', canon: 't.id::text', esCanonico: (v) => UUID_RX.test(v) },
  customer: { tabla: 'commercial.customers t', etiqueta: 't.name', canon: 't.id::text', esCanonico: (v) => UUID_RX.test(v) },
};

@Injectable()
export class ScopeService {
  private readonly logger = new Logger(ScopeService.name);
  private cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ───────────────────────── resolución ─────────────────────────

  /** Alcance del usuario del request en curso (lee el CLS). */
  async current(): Promise<ResolvedScope> {
    const ctx = this.tenantCtx.get();
    if (!ctx?.tenantId || !ctx.userId) {
      throw new ForbiddenException('Sin contexto de usuario: no se puede resolver el alcance');
    }
    return this.forUser(ctx.tenantId, ctx.userId, ctx.roleName ?? '');
  }

  async forUser(tenantId: string, userId: string, roleName?: string): Promise<ResolvedScope> {
    const key = `${tenantId}:${userId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) return hit.scope;

    const scope = await this.build(tenantId, userId, roleName);
    this.cache.set(key, { scope, expiresAt: now + TTL_MS });
    return scope;
  }

  private async build(tenantId: string, userId: string, roleNameHint?: string): Promise<ResolvedScope> {
    const user = await this.knex('identity.users')
      .where({ tenant_id: tenantId, id: userId })
      // `route_id` (`[ID.24.1]`) es lo que hace resoluble `route: own`.
      .select('role_name', 'warehouse_code', 'zona_id', 'customer_id', 'route_id')
      .first();

    const roleName = user?.role_name ?? roleNameHint ?? '';
    const dims = {} as Record<ScopeDimension, ResolvedDimension>;

    // God-mode: espeja `manage:all`. Sale temprano — ni siquiera consulta reglas.
    if (isPlatformAdminRole(roleName)) {
      for (const dim of SCOPE_DIMENSIONS) {
        dims[dim] = { mode: 'all', values: [], modeWrite: 'all', valuesWrite: [], source: 'platform_admin' };
      }
      return { tenantId, userId, roleName, dims };
    }

    const [userRules, roleRules] = await Promise.all([
      this.knex('identity.user_scopes')
        .where({ tenant_id: tenantId, user_id: userId })
        .select('dimension', 'mode', 'values', 'mode_write', 'nota'),
      roleName
        ? this.knex('identity.role_scopes')
            .where({ tenant_id: tenantId })
            .whereRaw('lower(role_name) = ?', [roleName.toLowerCase()])
            .select('dimension', 'mode', 'values', 'mode_write', 'nota')
        : Promise.resolve([] as ScopeRuleRow[]),
    ]);

    // Tipado explícito del Map: sin la anotación de tupla, TS infiere
    // `(ScopeDimension | ScopeRuleRow)[][]` y el `.get()` devuelve `{}`.
    const indexar = (rows: ScopeRuleRow[]) =>
      new Map<ScopeDimension, ScopeRuleRow>(
        rows.map((r) => [r.dimension, r] as [ScopeDimension, ScopeRuleRow]),
      );
    const porUsuario = indexar(userRules as ScopeRuleRow[]);
    const porRol = indexar(roleRules as ScopeRuleRow[]);

    for (const dim of SCOPE_DIMENSIONS) {
      const regla = porUsuario.get(dim) ?? porRol.get(dim);
      const source: ScopeSource = porUsuario.has(dim) ? 'user' : porRol.has(dim) ? 'role' : 'default';
      if (!regla) {
        // Fail-closed: sin regla, no ve nada.
        dims[dim] = { mode: 'none', values: [], modeWrite: 'none', valuesWrite: [], source: 'default' };
        continue;
      }
      const modeWrite = (regla.mode_write ?? regla.mode) as ScopeMode;
      dims[dim] = {
        mode: regla.mode,
        values: this.valoresDe(regla.mode, regla.values, dim, user),
        modeWrite,
        valuesWrite: this.valoresDe(modeWrite, regla.values, dim, user),
        source,
        nota: regla.nota ?? null,
      };
    }

    return { tenantId, userId, roleName, dims };
  }

  private valoresDe(
    mode: ScopeMode,
    values: string[] | null,
    dim: ScopeDimension,
    user: any,
  ): string[] {
    if (mode === 'listed') return (values ?? []).map(String);
    if (mode === 'own') {
      const col = COLUMNA_PROPIA[dim];
      const v = col ? user?.[col] : null;
      return v ? [String(v)] : [];
    }
    return []; // `all` no enumera acá; `none` no tiene valores
  }

  // ───────────────────────── aplicación ─────────────────────────

  /**
   * Agrega el filtro de alcance a un query builder. Es el reemplazo del
   * `user?.warehouse_code || query.warehouse_code` disperso.
   *
   *   `all`    → no toca el query.
   *   `none`   → `WHERE false`. Devuelve vacío, NO lanza: un reporte sin filas es
   *              una respuesta legítima; un 403 en un dashboard con 8 widgets
   *              rompe la pantalla entera.
   *   `listed` / `own` → `WHERE col IN (...)`.
   *
   * @param columna columna calificada, p.ej. `'i.warehouse_code'`
   */
  applyTo<T extends Knex.QueryBuilder>(
    qb: T,
    scope: ResolvedScope,
    dim: ScopeDimension,
    columna: string,
    opts?: { write?: boolean; incluirNulos?: boolean },
  ): T {
    const d = scope.dims[dim];
    const mode = opts?.write ? d.modeWrite : d.mode;
    const values = opts?.write ? d.valuesWrite : d.values;

    if (mode === 'all') return qb;
    if (mode === 'none' || !values.length) return qb.whereRaw('false') as T;

    // `incluirNulos`: filas sin sucursal asignada (traspasos en tránsito,
    // movimientos de CEDIS viejos). Se pide explícito, no por default.
    if (opts?.incluirNulos) {
      return qb.where((b: Knex.QueryBuilder) =>
        b.whereIn(columna, values).orWhereNull(columna),
      ) as T;
    }
    return qb.whereIn(columna, values) as T;
  }

  /** Azúcar: resuelve el alcance del request y lo aplica de una. */
  async apply<T extends Knex.QueryBuilder>(
    qb: T,
    dim: ScopeDimension,
    columna: string,
    opts?: { write?: boolean; incluirNulos?: boolean },
  ): Promise<T> {
    return this.applyTo(qb, await this.current(), dim, columna, opts);
  }

  /** ¿Puede LEER este valor? Para validar un query param antes de usarlo. */
  canRead(scope: ResolvedScope, dim: ScopeDimension, valor: string): boolean {
    const d = scope.dims[dim];
    if (d.mode === 'all') return true;
    if (d.mode === 'none') return false;
    return d.values.includes(String(valor));
  }

  /** ¿Puede ESCRIBIR en este valor? Es lo que `mode_write` habilita. */
  canWrite(scope: ResolvedScope, dim: ScopeDimension, valor: string): boolean {
    const d = scope.dims[dim];
    if (d.modeWrite === 'all') return true;
    if (d.modeWrite === 'none') return false;
    return d.valuesWrite.includes(String(valor));
  }

  /** 403 explicando la dimensión y el valor — no un "Forbidden" mudo. */
  async assertCanWrite(dim: ScopeDimension, valor: string): Promise<void> {
    const scope = await this.current();
    if (!this.canWrite(scope, dim, valor)) {
      throw new ForbiddenException(
        `Tu alcance no incluye ${UNIVERSO_SQL[dim].label.toLowerCase()} "${valor}" para escritura.`,
      );
    }
  }

  /**
   * Reduce lo que pidió el usuario por query param a lo que puede ver. Es el
   * puente para migrar un endpoint sin romperlo: si no pidió nada, devuelve su
   * alcance; si pidió de más, se le recorta en silencio (no 403).
   * Devuelve `null` cuando no hay que filtrar (`all` sin pedido explícito).
   */
  intersect(scope: ResolvedScope, dim: ScopeDimension, pedido?: string[] | null): string[] | null {
    const d = scope.dims[dim];
    const limpio = (pedido ?? []).map(String).filter(Boolean);
    if (d.mode === 'all') return limpio.length ? limpio : null;
    if (d.mode === 'none') return [];
    if (!limpio.length) return d.values;
    return limpio.filter((v) => d.values.includes(v));
  }

  // ───────────────────────── params del request ─────────────────────────

  /**
   * `[ID.5]` — Lee la dimensión del query del request y devuelve la lista YA
   * recortada al alcance del usuario, en la **llave canónica** de la dimensión.
   *
   * Reemplaza el `const effective = user?.x || query.x` de cada controller y
   * resuelve de una las tres cosas que hoy están sueltas:
   *   1. **el nombre**: acepta el canónico (`warehouse_codes`) y los 16 alias
   *      viejos, avisando la deprecación una vez por alias;
   *   2. **el tipo de llave**: `?warehouse_id=<uuid>` y `?warehouses=03` llegan
   *      al mismo lugar — verificado que hoy conviven en el mismo dominio;
   *   3. **el alcance**: `intersect()` recorta lo pedido a lo permitido.
   *
   * Devuelve `null` cuando no hay que filtrar (alcance `all` y nada pedido).
   */
  async readParam(
    query: Record<string, unknown> | undefined,
    dim: ScopeDimension,
    ruta?: string,
  ): Promise<string[] | null> {
    const { values } = parseScopeParam(query, dim, ruta);
    const pedido = values ? await this.aLlaveCanonica(dim, values) : null;
    return this.intersect(await this.current(), dim, pedido);
  }

  /**
   * Lleva los valores a la llave canónica de la dimensión (`ref_key`).
   *
   * Existe porque el mismo dominio hoy recibe las dos formas: en
   * `commercial-analytics`, `warehouse_id` es UUID (`s.warehouse_id`) y
   * `warehouses` son códigos (`commercial.warehouses.code`). Traducir acá, una
   * vez, es lo que permite migrar los endpoints sin romper a quien ya manda una
   * u otra forma.
   *
   * Lo que no se puede resolver se **descarta y se loguea**: dejarlo pasar lo
   * volvería un `IN (...)` que no matchea nada y el filtro se leería como
   * "sin resultados" en vez de "escribiste mal el parámetro".
   */
  private async aLlaveCanonica(dim: ScopeDimension, values: string[]): Promise<string[]> {
    const { tabla, etiqueta, canon, esCanonico } = TRADUCCION[dim];

    // Ya vienen en la llave buena → nada que hacer.
    const canonicos = values.filter((v) => esCanonico(v));
    const aTraducir = values.filter((v) => !esCanonico(v));
    if (!aTraducir.length) return canonicos;

    const tenantId = this.tenantCtx.requireTenantId();
    // Dos caminos: uuid → llave canónica, o etiqueta legible → llave canónica.
    const { rows } = await this.knex.raw(
      `SELECT (${canon})::text AS canon, t.id::text AS id, ${etiqueta}::text AS label
         FROM ${tabla}
        WHERE t.tenant_id = ? AND (t.id::text = ANY(?) OR ${etiqueta}::text = ANY(?))`,
      [tenantId, aTraducir, aTraducir],
    );

    // `canon` puede venir NULL: un `RUTA-*` es una fila de `warehouses` pero no
    // es una sucursal, así que no tiene llave y se descarta como "perdido".
    const traducidos = rows.map((r: any) => r.canon).filter(Boolean);
    const perdidos = aTraducir.filter(
      (v) => !rows.some((r: any) => r.id === v || r.label === v || r.canon === v),
    );
    if (perdidos.length) {
      this.logger.warn(`${dim}: ${perdidos.length} valor(es) no existen y se descartan: ${perdidos.slice(0, 5).join(', ')}`);
    }
    return canonicos.concat(traducidos).filter((v, i, a) => a.indexOf(v) === i);
  }

  // ───────────────────────── enumeración (UI) ─────────────────────────

  /**
   * Lo que el picker del front debe ofrecer: los valores que el usuario puede
   * ver, con etiqueta. Solo para UI (`GET /users/me/scope`) — nunca en la ruta
   * caliente de un reporte.
   */
  async optionsFor(
    scope: ResolvedScope,
    dim: ScopeDimension,
  ): Promise<{ value: string; label: string }[]> {
    const d = scope.dims[dim];
    if (d.mode === 'none') return [];
    const { rows } = await this.knex.raw(UNIVERSO_SQL[dim].sql, [scope.tenantId]);
    const todos = rows.map((r: any) => ({ value: String(r.v), label: r.label ?? String(r.v) }));
    if (d.mode === 'all') return todos;
    return todos.filter((o: { value: string }) => d.values.includes(o.value));
  }

  /** Vista completa para `/admin/usuarios` y para el picker. */
  async describe(scope: ResolvedScope): Promise<
    Record<
      ScopeDimension,
      { mode: ScopeMode; modeWrite: ScopeMode; source: string; nota?: string | null; options: { value: string; label: string }[] }
    >
  > {
    const out: any = {};
    for (const dim of SCOPE_DIMENSIONS) {
      const d = scope.dims[dim];
      out[dim] = {
        mode: d.mode,
        modeWrite: d.modeWrite,
        source: d.source,
        nota: d.nota ?? null,
        options: await this.optionsFor(scope, dim),
      };
    }
    return out;
  }

  // ───────────────────────── invalidación ─────────────────────────

  /** Llamar tras editar `user_scopes` de alguien: cambio inmediato, sin re-login. */
  invalidateUser(tenantId: string, userId: string): void {
    if (this.cache.delete(`${tenantId}:${userId}`)) {
      this.logger.log(`Alcance invalidado para ${tenantId}:${userId}`);
    }
  }

  /**
   * Tras editar `role_scopes`: no sabemos qué usuarios tienen ese rol sin ir a
   * DB, y son ~50 en el peor caso. Se limpia todo el cache: es un Map en memoria
   * y el rebuild son 2 queries por usuario activo.
   */
  invalidateRole(roleName: string): void {
    const n = this.cache.size;
    this.cache.clear();
    this.logger.log(`Alcance del rol "${roleName}" cambió → cache limpiado (${n} entradas)`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
