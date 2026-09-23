import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.module';

/**
 * Cache en memoria de permisos por rol. Razones del diseño:
 *
 * - **Por `(tenant_id, role_name)`, no por `user_id`**: muchos usuarios comparten
 *   el mismo rol (50 capturistas → 1 sola entrada). El `tenant_id` es OBLIGATORIO
 *   en la key y en la query: el mismo `role_name` (p.ej. `superadmin`) existe en
 *   cada tenant con permisos distintos, y `role_permissions` tiene UNIQUE
 *   (tenant_id, role_name). Sin el tenant, `.first()` sobre duplicados es
 *   no-determinista → un tenant podía leer los permisos de otro (incidente
 *   2026-06-16: superoot 403 al leer un superadmin de otro tenant).
 * - **TTL corto (30s)**: en el peor caso un revoke tarda ~30s en propagarse
 *   sin necesidad de invalidación explícita. El logout/login no es necesario.
 * - **Invalidación explícita en update**: al cambiar permisos desde
 *   `/admin/catalogs/roles`, el service llama `invalidate(roleName)` y el
 *   próximo request rebuildea desde DB → 0 latencia para el admin que edita.
 * - **Sin Redis**: la app corre como instancia única en Railway; un Map en
 *   memoria es suficiente. Si en el futuro hay multi-instancia, migrar a
 *   Redis con pub/sub para coordinar invalidaciones.
 */

interface CacheEntry {
  permissions: Record<string, boolean>;
  expiresAt: number;
}

/**
 * `[ID.38]` — Lo que el guard necesita saber de la CUENTA en cada request.
 *
 * Son dos preguntas distintas que se responden con la misma fila, así que van
 * juntas: pedirlas por separado eran dos consultas a `identity.users` por
 * request (la tabla más leída de la app).
 */
export interface EstadoCuenta {
  /** `activo = true` y sin `deleted_at`. */
  activo: boolean;
  /**
   * Corte de sesión en **segundos epoch**, o `null` si la cuenta no tiene
   * ninguno. Es `GREATEST(password_changed_at, sessions_revoked_at)`: todo token
   * cuyo `iat` sea ANTERIOR dejó de valer.
   *
   * En segundos y truncado hacia abajo a propósito: el `iat` del JWT también
   * viene en segundos truncados, así que comparar en milisegundos rechazaría un
   * token recién emitido cuando el corte cae en la misma fracción de segundo.
   */
  corteSesionSeg: number | null;
  /**
   * ¿Esto se pudo MEDIR contra la DB? `false` = la consulta falló y se está
   * contestando con lo último que se supo (o con el default permisivo si nunca
   * se supo nada). ADR-056: el veredicto es ternario, y "no sé" no se disfraza
   * de "sí". Quien decide cortar accesos tiene derecho a saber que está
   * decidiendo a ciegas.
   */
  medido: boolean;
}

const TTL_MS = 30_000;

@Injectable()
export class PermissionsCacheService {
  private readonly logger = new Logger(PermissionsCacheService.name);
  private cache = new Map<string, CacheEntry>();
  /** `[ID.13]` Lista de roles por usuario (perfil base + complementos). */
  private rolesCache = new Map<string, { roles: string[]; expiresAt: number }>();
  /** `[ID.21]` Diferencia de permisos de cada persona contra su puesto. */
  private overridesCache = new Map<string, { overrides: Record<string, boolean>; expiresAt: number }>();
  /**
   * `[AUTHZ-HARD.2]` ¿La cuenta sigue activa? (desactivar = revocar en ≤TTL).
   * `[ID.38]` + desde cuándo dejaron de valer sus tokens.
   *
   * ⚠️ La entrada NO se borra al vencer: se conserva para poder contestar con el
   * último valor conocido si la DB falla (ver `getEstadoCuenta`).
   */
  private estadoCache = new Map<string, { estado: EstadoCuenta; expiresAt: number }>();

  /**
   * `[ID.38]` — ¿Este entorno todavía NO tiene `identity.users.sessions_revoked_at`?
   *
   * No es paranoia: en Railway el **código se despliega antes** de que corra la
   * migración, y en esa ventana la consulta completa falla con `42703`. Sin este
   * interruptor, ese error caería en el `catch` genérico y el guard pasaría a
   * contestar con el default permisivo para **todas** las cuentas — o sea que
   * agregar un candado de revocación habría apagado el de `activo = false`.
   *
   * Se detecta una sola vez, se degrada a `password_changed_at` (que ya existe
   * desde `[ID.8]` y es la mitad útil del candado) y se sigue.
   */
  private sinColumnaCorte = false;

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Devuelve el JSONB de permisos del rol. Hit del cache si vigente,
   * miss → query a `role_permissions` + set en cache.
   */
  async getPermissionsForRole(
    roleName: string,
    tenantId?: string,
  ): Promise<Record<string, boolean>> {
    if (!roleName) return {};
    const now = Date.now();
    // Normalizamos el role_name a minúscula para la KEY y el lookup: los
    // usuarios pueden tener role_name en distinto case que role_permissions
    // (data legacy). Sin esto, un mismatch de mayúsculas = 0 permisos = usuario
    // rebotado a captures. La comparación en DB es LOWER()=LOWER().
    const normRole = roleName.toLowerCase();
    const key = `${tenantId ?? 'global'}:${normRole}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.permissions;
    }
    // tenant_id OBLIGATORIO para aislar: sin él, `.first()` sobre el mismo
    // role_name en varios tenants es no-determinista (cross-tenant leak).
    //
    // `[W3.2]` El comentario de arriba decía OBLIGATORIO y el código lo aplicaba con un `if`, o sea
    // opcional. Ese camino existe de verdad: `roles.guard.ts` pasa `user.tenant_id` CRUDO del JWT,
    // sin fallback — un token sin tenant llegaba acá y la query corría sin filtro. Y no es teórico:
    // medido en prod, `recursos_humanos` existe en **2 tenants**, así que para ese rol `.first()`
    // sin filtro devuelve el mapa de permisos de cualquiera de los dos.
    //
    // NO se resuelve con un throw: reventaría el login de un token legacy en cada request, y esta
    // ruta no se puede probar de punta a punta desde acá. Se resuelve haciéndolo DETERMINISTA y
    // fail-CLOSED: sin tenant se exige `tenant_id IS NULL`, que en `identity.role_permissions`
    // —columna **NOT NULL**, 0 filas en NULL— no puede casar con nada. Resultado: cero permisos en
    // vez de los de un tenant ajeno, y el camino sano queda idéntico.
    const q = this.knex('role_permissions').whereRaw('LOWER(role_name) = ?', [normRole]);
    if (tenantId) q.where({ tenant_id: tenantId });
    else q.whereNull('tenant_id');
    const row = await q.first();
    const permissions: Record<string, boolean> = row?.permissions ?? {};
    this.cache.set(key, { permissions, expiresAt: now + TTL_MS });
    return permissions;
  }

  /**
   * `[ID.13]` Roles de un usuario: el perfil base + los complementos.
   *
   * Se cachea la LISTA (no los permisos) para no duplicar el cache de roles:
   * un complemento nuevo se refleja en ≤30s, y los permisos de cada rol siguen
   * viniendo de `getPermissionsForRole` con su propia invalidación.
   *
   * Fallback deliberado: si `user_roles` no tiene filas para ese usuario
   * (token viejo, usuario recién creado por un camino que no pasó por el
   * trigger, o la migración `[ID.13]` sin correr) se devuelve `[primaryRole]`.
   * Así el peor caso es el comportamiento anterior, nunca "cero permisos".
   */
  async getRolesForUser(
    userId: string | undefined,
    tenantId: string | undefined,
    primaryRole?: string,
  ): Promise<string[]> {
    const base = primaryRole ? [primaryRole] : [];
    if (!userId || !tenantId) return base;
    const now = Date.now();
    const key = `roles:${tenantId}:${userId}`;
    const cached = this.rolesCache.get(key);
    if (cached && cached.expiresAt > now) return cached.roles;

    let roles: string[] = base;
    try {
      // tenant_id explícito: `KNEX_CONNECTION` es superusuario y NO aplica RLS.
      const rows = await this.knex('identity.user_roles')
        .where({ tenant_id: tenantId, user_id: userId })
        .orderBy('is_primary', 'desc')
        .select('role_name');
      if (rows.length) {
        roles = rows.map((r: { role_name: string }) => r.role_name);
      }
    } catch (e: any) {
      // La tabla puede no existir todavía en un entorno sin la migración.
      this.logger.warn(`user_roles no disponible (${e?.message}); se usa solo el perfil base`);
    }
    this.rolesCache.set(key, { roles, expiresAt: now + TTL_MS });
    return roles;
  }

  /**
   * `[ID.21]` Overrides de permisos de UNA persona contra el estándar de su
   * puesto (`identity.user_permissions`). Devuelve sólo la diferencia.
   *
   * Mismo fallback que `getRolesForUser`: si la tabla no existe todavía se
   * devuelve `{}` y el usuario queda con lo que le da su rol. El peor caso es el
   * comportamiento anterior, nunca "cero permisos".
   */
  async getOverridesForUser(
    userId: string | undefined,
    tenantId: string | undefined,
  ): Promise<Record<string, boolean>> {
    if (!userId || !tenantId) return {};
    const now = Date.now();
    const key = `ovr:${tenantId}:${userId}`;
    const cached = this.overridesCache.get(key);
    if (cached && cached.expiresAt > now) return cached.overrides;

    let overrides: Record<string, boolean> = {};
    try {
      // tenant_id explícito: `KNEX_CONNECTION` es superusuario y NO aplica RLS.
      const rows = await this.knex('identity.user_permissions')
        .where({ tenant_id: tenantId, user_id: userId })
        .select('permission_key', 'allow');
      overrides = Object.fromEntries(
        rows.map((r: { permission_key: string; allow: boolean }) => [r.permission_key, r.allow]),
      );
    } catch (e: any) {
      this.logger.warn(
        `user_permissions no disponible (${e?.message}); se usan solo los permisos del rol`,
      );
    }
    this.overridesCache.set(key, { overrides, expiresAt: now + TTL_MS });
    return overrides;
  }

  /**
   * `[ID.13]` + `[ID.21]` Permisos EFECTIVOS del usuario:
   *
   *     unión(perfil base + complementos)  ±  overrides de la persona
   *
   * La unión de roles es por `true` gana: un complemento sólo puede sumar. Poner
   * un permiso en `false` en un rol no le quita lo que otro rol le concede — para
   * quitar hay que quitar el rol. Es la semántica menos sorpresiva y la que hace
   * que `captura_gastos` (1 permiso) funcione como complemento.
   *
   * `[ID.21]` El override de la PERSONA sí gana sobre el rol, en los dos
   * sentidos. Es lo que permite que dos personas con el mismo puesto no tengan
   * forzosamente el mismo acceso, sin clonar el rol para una sola.
   */
  async getPermissionsForUser(
    userId: string | undefined,
    tenantId: string | undefined,
    primaryRole?: string,
  ): Promise<Record<string, boolean>> {
    const roles = await this.getRolesForUser(userId, tenantId, primaryRole);
    let efectivos: Record<string, boolean>;
    if (roles.length <= 1) {
      // Copia: lo que devuelve `getPermissionsForRole` es el objeto CACHEADO del
      // rol. Aplicarle el override encima sin copiar se lo aplicaría a todos los
      // usuarios de ese rol hasta que expire el TTL.
      efectivos = { ...(await this.getPermissionsForRole(roles[0] ?? primaryRole ?? '', tenantId)) };
    } else {
      efectivos = {};
      for (const rol of roles) {
        const perms = await this.getPermissionsForRole(rol, tenantId);
        for (const [k, v] of Object.entries(perms)) {
          if (v === true) efectivos[k] = true;
          else if (!(k in efectivos)) efectivos[k] = v;
        }
      }
    }
    const overrides = await this.getOverridesForUser(userId, tenantId);
    for (const [k, allow] of Object.entries(overrides)) {
      efectivos[k] = allow;
    }
    return efectivos;
  }

  /**
   * `[AUTHZ-HARD.2]` ¿La cuenta sigue activa y no borrada? Cacheado con el mismo TTL corto.
   *
   * Desactivar a alguien (o degradarlo) no surtía efecto hasta que expiraba su token (12h):
   * ni `JwtAuthGuard` ni este cache releían `identity.users`. Ahora `JwtAuthGuard` consulta esto
   * en cada request y expulsa al desactivado en ≤30s — incluido un superadmin (el god-mode se
   * decide con el rol del token, así que sin este chequeo un admin degradado seguía siendo dios).
   *
   * Fail-open deliberado ante error de DB: si la query falla, se asume activo (no romper toda la
   * app por un hipo de la DB). El caso normal —cuenta desactivada— sí se detecta.
   */
  async isUserActive(userId: string | undefined, tenantId: string | undefined): Promise<boolean> {
    return (await this.getEstadoCuenta(userId, tenantId)).activo;
  }

  /**
   * `[AUTHZ-HARD.2]` + `[ID.38]` — Estado de la cuenta para el guard, en UNA
   * consulta: si sigue activa, y desde cuándo dejaron de valer sus tokens.
   *
   * ── El corte de sesión ──────────────────────────────────────────────────────
   * `GREATEST(password_changed_at, sessions_revoked_at)`. Son dos hechos
   * distintos con la misma consecuencia: «lo que firmé antes de esto ya no
   * vale». `password_changed_at` ya se escribía en el alta y en cada reset
   * (`[AU.28]`) y **nadie la leía** — el candado que el encabezado de
   * `users_token_ttl_days` dejó anotado y quedó sin hacer.
   *
   * ── Por qué stale-if-error y no fail-open a secas ──────────────────────────
   * Lo anterior era `catch → se asume activo`, lo que significa que **un hipo de
   * la DB le devolvía el acceso a alguien recién desactivado**. Ahora, ante
   * error, se contesta con **lo último que se supo de esa cuenta** (aunque haya
   * vencido el TTL): si ya se sabía que estaba desactivada, sigue afuera.
   *
   * Sólo cuando NUNCA se supo nada de esa cuenta se cae al default permisivo, y
   * eso sigue siendo deliberado: un error de DB no puede dejar afuera a toda la
   * empresa. La diferencia es que ahora el fail-open es el ÚLTIMO recurso y no
   * el primero, y va marcado con `medido: false` para que quien lo consuma sepa
   * que está decidiendo a ciegas.
   */
  async getEstadoCuenta(
    userId: string | undefined,
    tenantId: string | undefined,
  ): Promise<EstadoCuenta> {
    // Sin identidad clara no es acá donde se corta (lo hace JwtAuthGuard).
    if (!userId || !tenantId) return { activo: true, corteSesionSeg: null, medido: false };

    const now = Date.now();
    const key = `estado:${tenantId}:${userId}`;
    const cached = this.estadoCache.get(key);
    if (cached && cached.expiresAt > now) return cached.estado;

    let estado: EstadoCuenta;
    try {
      const row = await this.knex('identity.users')
        .where({ id: userId, tenant_id: tenantId })
        .first(
          'activo',
          'deleted_at',
          this.knex.raw(
            this.sinColumnaCorte
              ? `password_changed_at AS corte`
              : `GREATEST(password_changed_at, sessions_revoked_at) AS corte`,
          ),
        );
      estado = {
        // Si el usuario ya no existe para ese tenant, tampoco pasa.
        activo: !!row && row.activo === true && row.deleted_at == null,
        corteSesionSeg: row?.corte ? Math.floor(new Date(row.corte).getTime() / 1000) : null,
        medido: true,
      };
    } catch (e: any) {
      // Ventana de despliegue: el código llegó antes que la migración `[ID.38]`.
      // Se degrada a `password_changed_at` y se reintenta UNA vez (el flag ya
      // quedó en `true`, así que no hay recursión infinita). Lo que NO se hace
      // es dejar que esto caiga en el fail-open de abajo, que apagaría también
      // el chequeo de cuenta desactivada.
      if (!this.sinColumnaCorte && /sessions_revoked_at/i.test(String(e?.message ?? ''))) {
        this.sinColumnaCorte = true;
        this.logger.warn(
          'identity.users.sessions_revoked_at no existe todavía (migración [ID.38] sin correr): ' +
            'el corte de sesión usa sólo password_changed_at hasta que se aplique.',
        );
        return this.getEstadoCuenta(userId, tenantId);
      }
      const previo = cached?.estado;
      this.logger.warn(
        `getEstadoCuenta: no se pudo verificar (${e?.message}); ` +
          (previo
            ? 'se contesta con el último estado conocido de la cuenta'
            : 'sin estado previo, se asume activa y sin corte'),
      );
      estado = previo
        ? { ...previo, medido: false }
        : { activo: true, corteSesionSeg: null, medido: false };
    }

    this.estadoCache.set(key, { estado, expiresAt: now + TTL_MS });
    return estado;
  }

  /** `[ID.13]` + `[ID.21]` Llamar al cambiar complementos o permisos de un usuario. */
  invalidateUser(userId: string, tenantId?: string): void {
    if (tenantId) {
      this.rolesCache.delete(`roles:${tenantId}:${userId}`);
      this.overridesCache.delete(`ovr:${tenantId}:${userId}`);
      this.estadoCache.delete(`estado:${tenantId}:${userId}`);
      return;
    }
    for (const k of Array.from(this.rolesCache.keys())) {
      if (k.endsWith(`:${userId}`)) this.rolesCache.delete(k);
    }
    for (const k of Array.from(this.overridesCache.keys())) {
      if (k.endsWith(`:${userId}`)) this.overridesCache.delete(k);
    }
    for (const k of Array.from(this.estadoCache.keys())) {
      if (k.endsWith(`:${userId}`)) this.estadoCache.delete(k);
    }
  }

  /**
   * Llamar tras `updateRolePermissions` para propagar el cambio inmediatamente
   * a TODOS los usuarios con ese rol en su próximo request.
   */
  invalidate(roleName: string, tenantId?: string): void {
    // Mismo normalizado que en la KEY (ver getPermissionsForRole).
    const normRole = (roleName ?? '').toLowerCase();
    if (tenantId) {
      if (this.cache.delete(`${tenantId}:${normRole}`)) {
        this.logger.log(`Cache invalidated for "${tenantId}:${normRole}"`);
      }
      return;
    }
    // Sin tenant: invalidar la entrada de ese rol en TODOS los tenants cacheados.
    let n = 0;
    for (const k of Array.from(this.cache.keys())) {
      const parts = k.split(':');
      const kRole = parts.length > 1 ? parts.slice(1).join(':') : k;
      if (kRole === normRole) {
        this.cache.delete(k);
        n++;
      }
    }
    if (n) this.logger.log(`Cache invalidated for role "${normRole}" (${n} entradas)`);
  }

  /** Util de debug — no usar en runtime normal. */
  invalidateAll(): void {
    this.cache.clear();
    this.rolesCache.clear();
    this.overridesCache.clear();
    this.estadoCache.clear();
  }
}
