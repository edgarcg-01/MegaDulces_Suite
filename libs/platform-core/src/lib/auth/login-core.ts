import { UnauthorizedException } from '@nestjs/common';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { soloConcedidos } from '../ability/granted-permissions';
import { tokenSignOptions } from './token-ttl';

/**
 * `[ID.37]` — LA regla de login. Una sola, para las dos puertas.
 *
 * ── El problema, medido ──────────────────────────────────────────────────────
 * Había **dos** caminos de login y cada uno decidía por su cuenta qué es una
 * sesión válida:
 *
 *   · `/auth-mt/login` — pide `tenant_slug`, corta por `kind='servicio'`, corta
 *     por `expires_at`, arma la unión de roles (`identity.user_roles`), aplica
 *     los overrides de la persona (`identity.user_permissions`) y respeta el
 *     TTL propio de la cuenta (`token_ttl_days`).
 *   · `/auth/login` (legacy, `@Public`, montado SIEMPRE) — **ninguna de las
 *     cinco cosas.** Leía el rol de una sola columna y firmaba con el TTL global.
 *
 * O sea: una cuenta vencida o una credencial de servicio entraban por la puerta
 * de atrás, y el snapshot de permisos que se le daba a la UI era otro que el de
 * la puerta principal. El daño estaba acotado porque `RolesGuard` **relee** los
 * permisos de la DB en cada request (el token no autoriza), y porque hoy en prod
 * hay **0 usuarios con `expires_at`** y la única cuenta `kind='servicio'` no
 * tiene un hash bcrypt válido — pero eso es suerte de datos, no una compuerta.
 *
 * ── Por qué no se retiró la puerta legacy ────────────────────────────────────
 * Porque tiene clientes que no se actualizan solos: `apps/vendor` es una app
 * Capacitor **instalada en teléfonos**, y su `AuthService` todavía trae el
 * método que pega a `/auth/login` (hoy la pantalla usa `loginMt`, pero un APK
 * viejo en el campo no se entera). Retirar el endpoint deja a un vendedor
 * afuera en medio de una ruta. Unificar la regla no rompe a nadie y elimina la
 * divergencia igual.
 *
 * Este archivo vive en `libs/` por ADR-056: un primitivo copiado a mano en dos
 * servicios se desincroniza — que es literalmente lo que le pasó a estos dos.
 * `soloConcedidos` ya había salido de acá por la misma razón; esto termina la
 * mudanza en vez de dejarla a mitad.
 */

/** Lo mínimo que se le pide a quien quiere entrar. */
export interface CredencialesLogin {
  username: string;
  password: string;
}

/** Datos del request, para la bitácora de último acceso. No deciden nada. */
export interface MetaLogin {
  ip?: string | null;
  userAgent?: string | null;
}

/** El tenant ya resuelto (por slug en `auth-mt`, por deducción en el legacy). */
export interface TenantResuelto {
  id: string;
  slug?: string | null;
  nombre?: string | null;
}

/** Lo que viaja firmado. Mismo payload para las dos puertas. */
export interface JwtPayloadSesion {
  sub: string;
  tenant_id: string;
  username: string;
  role_name: string;
  zona_id?: string;
  zona?: string;
  warehouse_code?: string;
  /**
   * Snapshot para gatear la UI. **No es fuente de autorización**: `RolesGuard`
   * relee de DB en cada request. Sólo viajan las claves concedidas (`[ID.29]`).
   */
  permissions?: Record<string, boolean>;
}

export interface SesionFirmada {
  access_token: string;
  user: Record<string, unknown>;
}

/** Firma mínima de lo que se necesita para firmar, sin arrastrar `@nestjs/jwt`. */
export interface FirmadorJwt {
  signAsync(payload: object, options?: { expiresIn?: number }): Promise<string>;
}

/**
 * Mensaje ÚNICO para todo lo que sea "no entrás porque las credenciales no
 * cuadran". Distinguir «no existe» de «existe y está invitada» convierte al
 * login en un oráculo de enumeración — es lo que `[AUTHZ-HARD.5]` cerró y no se
 * vuelve a abrir acá.
 */
const CREDENCIALES_INVALIDAS = 'Credenciales inválidas';

/**
 * `[ID.37]` — Resuelve el tenant cuando el cliente NO lo manda (puerta legacy).
 *
 * Dos pasos, en este orden:
 *   1. **Por el username**, que es único POR tenant. Si aparece en exactamente
 *      un tenant activo, ése es. Si aparece en varios, es ambiguo y se rechaza
 *      — adivinar sería elegir a ciegas de quién es la cuenta.
 *   2. Si el paso 1 no devuelve nada, se cae al **único tenant activo**, si es
 *      que hay exactamente uno. Esto NO es un atajo de conveniencia: la consulta
 *      del paso 1 es cross-tenant y `identity.users` tiene RLS **forzado**, así
 *      que con una conexión que no bypassee RLS devolvería 0 filas siempre y la
 *      puerta legacy dejaría de abrir. Hoy en prod hay **1 tenant**
 *      (`mega_dulces`, 135 usuarios), así que el resultado es el mismo por los
 *      dos caminos; el día que haya dos, este fallback se apaga solo y queda el
 *      paso 1, que es el correcto.
 *
 * Devuelve `null` cuando no puede decidir. Quien llama contesta el mensaje
 * genérico: acá no se revela qué tenants existen.
 */
export async function resolverTenantDeUsuario(
  knex: Knex,
  username: string,
): Promise<TenantResuelto | null> {
  const u = String(username ?? '').toLowerCase().trim();
  if (!u) return null;

  const porUsuario = await knex('tenants as t')
    .join('users as us', 'us.tenant_id', 't.id')
    .where('t.activo', true)
    .whereNull('t.deleted_at')
    .where('us.username', u)
    .where('us.activo', true)
    .distinct('t.id', 't.slug', 't.nombre')
    .select();
  if (porUsuario.length === 1) return porUsuario[0] as TenantResuelto;
  if (porUsuario.length > 1) return null; // ambiguo → fail-closed

  const activos = await knex('tenants')
    .where({ activo: true })
    .whereNull('deleted_at')
    .select('id', 'slug', 'nombre')
    .limit(2);
  return activos.length === 1 ? (activos[0] as TenantResuelto) : null;
}

/**
 * `[ID.37]` — Verifica credenciales, aplica los frenos de la cuenta, arma los
 * permisos efectivos y firma. **Las dos puertas pasan por acá.**
 *
 * Orden deliberado (no reordenar sin leer esto):
 *   1. bcrypt PRIMERO (`[AUTHZ-HARD.5]`): el estado de la cuenta sólo se le
 *      revela a quien probó ser su dueño.
 *   2. Sin hash → credencial inválida, no 500 (`[ID.31]`: `bcrypt.compare(x,
 *      null)` **lanza**, y desde `[ID.8]` una cuenta `invited` sin contraseña es
 *      un estado legítimo del padrón).
 *   3. Cuenta de servicio → no tiene acceso interactivo (`[ID.17]`).
 *   4. Cuenta vencida → dejó de existir para efectos de acceso (`[ID.13]`).
 */
export async function autenticarYFirmar(
  deps: { knex: Knex; jwt: FirmadorJwt },
  tenant: TenantResuelto,
  dto: CredencialesLogin,
  meta?: MetaLogin,
): Promise<SesionFirmada> {
  const { knex, jwt } = deps;
  const username = String(dto?.username ?? '').toLowerCase().trim();
  if (!username || !dto?.password) {
    throw new UnauthorizedException(CREDENCIALES_INVALIDAS);
  }

  // ── 1. Leer usuario + rol + zona + complementos + overrides ────────────────
  // Todo en UNA transacción con `SET LOCAL app.tenant_id`: `role_permissions` y
  // `zones` son tenant-scoped, así que sin el contexto RLS las oculta.
  //
  // ⚠️ No se lanza NADA dentro del callback: un throw deja la conexión en estado
  // abortado (25P02) si alguien reusara la trx. El "no existe" vuelve como
  // `user: null` y la excepción se lanza afuera, con la trx ya cerrada limpia.
  const { user, rolePermissions, zonaName, extraPermissions, overrides } = await knex.transaction(
    async (trx) => {
      await trx.raw('SET LOCAL app.tenant_id = ?', [tenant.id]);

      const u = await trx('users').where({ username, activo: true }).first();
      if (!u) {
        return {
          user: null,
          rolePermissions: null,
          zonaName: null,
          extraPermissions: [] as Array<Record<string, boolean>>,
          overrides: {} as Record<string, boolean>,
        };
      }

      // Lookup case-insensitive: `users.role_name` puede diferir en mayúsculas
      // de `role_permissions.role_name` (data legacy). Con match exacto el rol
      // no se encontraba → JWT con 0 permisos → usuario rebotado.
      const rp = await trx('role_permissions')
        .whereRaw('LOWER(role_name) = ?', [String(u.role_name ?? '').toLowerCase()])
        .first();

      // `[ID.13]` Complementos: el perfil base es `role_name`, y encima van los
      // roles no primarios. El JWT lleva la UNIÓN para que la UI gatee igual que
      // el backend. `tenant_id` explícito: esta conexión no aplica RLS.
      let extras: Array<Record<string, boolean>> = [];
      try {
        const otros = await trx('identity.user_roles')
          .where({ tenant_id: tenant.id, user_id: u.id, is_primary: false })
          .pluck('role_name');
        if (otros.length) {
          const filas = await trx('role_permissions')
            .whereRaw('LOWER(role_name) = ANY(?)', [otros.map((r: string) => String(r).toLowerCase())])
            .select('permissions');
          extras = filas.map((f: { permissions: Record<string, boolean> }) => f.permissions || {});
        }
      } catch {
        // Sin la migración `[ID.13]` aplicada: se sigue con el perfil base.
        extras = [];
      }

      // `[ID.21]` Overrides de la PERSONA contra el estándar de su puesto.
      let ovr: Record<string, boolean> = {};
      try {
        const filas = await trx('identity.user_permissions')
          .where({ tenant_id: tenant.id, user_id: u.id })
          .select('permission_key', 'allow');
        ovr = Object.fromEntries(
          filas.map((f: { permission_key: string; allow: boolean }) => [f.permission_key, f.allow]),
        );
      } catch {
        ovr = {};
      }

      let zn: string | null = null;
      if (u.zona_id) {
        const z = await trx('zones').where({ id: u.zona_id }).first();
        zn = z?.name ?? null;
      }

      return { user: u, rolePermissions: rp, zonaName: zn, extraPermissions: extras, overrides: ovr };
    },
  );

  if (!user) throw new UnauthorizedException(CREDENCIALES_INVALIDAS);

  // ── 2. Contraseña PRIMERO, después el estado de la cuenta ──────────────────
  const valid = !!user.password_hash && (await bcrypt.compare(dto.password, user.password_hash));
  if (!valid) throw new UnauthorizedException(CREDENCIALES_INVALIDAS);

  if (user.kind === 'servicio') {
    throw new UnauthorizedException('Esta es una cuenta de servicio: no tiene acceso interactivo.');
  }

  if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
    throw new UnauthorizedException('La cuenta venció. Pedí una extensión al administrador.');
  }

  // ── 3. Último acceso (fire-and-forget) ─────────────────────────────────────
  // El éxito del login NO depende de este UPDATE. IP a 45 chars (IPv6 + margen)
  // y UA a 1024 para que un user-agent absurdo no infle la fila.
  const ip = meta?.ip ? String(meta.ip).slice(0, 45) : null;
  const ua = meta?.userAgent ? String(meta.userAgent).slice(0, 1024) : null;
  void knex
    .transaction(async (trx) => {
      await trx.raw('SET LOCAL app.tenant_id = ?', [tenant.id]);
      await trx('users')
        .where({ id: user.id })
        .update({ last_login_at: trx.fn.now(), last_login_ip: ip, last_login_user_agent: ua });
    })
    .catch(() => {
      /* la bitácora de acceso no puede hacer fallar el acceso */
    });

  // ── 4. Permisos efectivos = unión(base + complementos) ± overrides ─────────
  // `true` gana entre roles: un complemento sólo suma. El override de la persona
  // gana sobre el rol en los DOS sentidos. Mismo orden que
  // `PermissionsCacheService.getPermissionsForUser`, que es quien manda de
  // verdad — esto es sólo el snapshot con el que arranca la UI.
  const permissions: Record<string, boolean> = { ...(rolePermissions?.permissions || {}) };
  for (const extra of extraPermissions) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === true) permissions[k] = true;
      else if (!(k in permissions)) permissions[k] = v;
    }
  }
  for (const [k, allow] of Object.entries(overrides)) {
    permissions[k] = allow;
  }

  // `[ID.29]` Al token sólo viajan las claves CONCEDIDAS.
  const concedidos = soloConcedidos(permissions);

  // `[CH.1.3]` La vida del token la decide la CUENTA (`token_ttl_days`), no una
  // constante global: un kiosco no puede pedirle la contraseña a nadie cada 12 h.
  const opcionesFirma = tokenSignOptions(user.token_ttl_days);

  const payload: JwtPayloadSesion = {
    sub: user.id,
    tenant_id: tenant.id,
    username: user.username,
    role_name: user.role_name,
    zona_id: user.zona_id || undefined,
    zona: zonaName || undefined,
    warehouse_code: user.warehouse_code || undefined,
    permissions: concedidos,
  };

  return {
    access_token: await jwt.signAsync(payload, opcionesFirma),
    user: {
      id: user.id,
      tenant_id: tenant.id,
      tenant_slug: tenant.slug ?? null,
      tenant_nombre: tenant.nombre ?? null,
      username: user.username,
      nombre: user.nombre,
      role_name: user.role_name,
      zona_id: user.zona_id ?? null,
      zona: zonaName ?? null,
      warehouse_code: user.warehouse_code ?? null,
      meta_puntos: user.meta_puntos,
      must_change_password: user.must_change_password ?? false,
      // Mismo mapa que el token, a propósito: dos formas distintas del mismo
      // snapshot en la misma respuesta es la clase de divergencia que después
      // nadie sabe cuál gana.
      permissions: concedidos,
    },
  };
}
