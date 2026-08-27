import { Inject, Injectable, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { buildAbility } from '@megadulces/platform-core';

/**
 * Auth multi-tenant para la nueva DB.
 *
 * Diferencias clave vs auth.service.ts legacy:
 *   - JWT carga `tenant_id` (además de sub/username/role_name).
 *   - Login requiere identificar el tenant: aceptamos `tenant_slug` en el body
 *     o subdomain en host (para futuro, ahora solo slug explícito).
 *   - Username NO es único global — es único POR tenant. Dos tenants pueden
 *     tener cada uno su "admin".
 *   - El password_hash se busca CON tenant context (RLS filtra).
 *
 * Sigue conviviendo con auth.service.ts legacy hasta el cutover.
 */

export interface LoginDto {
  tenant_slug: string;
  username: string;
  password: string;
}

export interface JwtPayloadMt {
  sub: string;
  tenant_id: string;
  username: string;
  role_name: string;
  zona_id?: string;
  /**
   * Sucursal Kepler asignada ('00'..'05'). Si está seteada, el usuario queda
   * scopeado a esa sucursal en el monitor Tienda (snapshot + WS). Vacío = ve
   * todas (rol global). Ver [[project_proyecto_tienda_live]].
   */
  warehouse_code?: string;
  /**
   * Nombre de la zona (denormalizado). Necesario porque varios componentes
   * del frontend (daily-assignments, captures, seguimiento) leen `user.zona`
   * para hacer match contra el catálogo de zonas. Sin este campo, el frontend
   * trata al user como "sin zona asignada" aunque tenga zona_id válida.
   */
  zona?: string;
  /**
   * Snapshot de permisos para gating de UI (no source-of-truth de autorización).
   * El backend ignora estos campos en autorización — vuelve a leer
   * `role_permissions` fresco en cada request. Mismo enfoque que auth.service
   * legacy (ver allí comentario detallado).
   */
  permissions?: Record<string, boolean>;
  rules?: any[];
}

@Injectable()
export class AuthMtService {
  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto, meta?: { ip?: string | null; userAgent?: string | null }) {
    if (!dto.tenant_slug || !dto.username || !dto.password) {
      throw new UnauthorizedException('Faltan credenciales o tenant');
    }

    // 1. Resolver tenant_slug → tenant_id (global, sin RLS)
    const tenant = await this.knex('tenants')
      .where({ slug: dto.tenant_slug, activo: true })
      .first();

    if (!tenant) {
      // Mensaje genérico para no leak qué tenants existen
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // 2. Buscar usuario + role_permissions + zona CON tenant context (RLS aplica).
    // role_permissions y zones son tenant-scoped en la nueva DB, así que se
    // leen en la misma trx para que RLS no oculte las filas.
    // Nota: NO se lanzan excepciones dentro del callback de la transacción —
    // el caso "usuario no encontrado" se resuelve devolviendo `user: null` y
    // se lanza la excepción DESPUÉS de que la transacción haya terminado
    // limpiamente. Esto evita dejar la conexión en estado abortado (25P02)
    // si el resto del flujo intentara reutilizar la trx tras un throw.
    let user: any;
    let rolePermissions: any;
    let zonaName: string | null;
    let extraPermissions: Array<Record<string, boolean>> = [];
    try {
      ({ user, rolePermissions, zonaName, extraPermissions } = await this.knex.transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${tenant.id}'`);
        const u = await trx('users')
          .where({ username: dto.username.toLowerCase().trim(), activo: true })
          .first();
        if (!u)
          return {
            user: null,
            rolePermissions: null,
            zonaName: null,
            extraPermissions: [] as Array<Record<string, boolean>>,
          };
        // Lookup case-insensitive: users.role_name puede diferir en mayúsculas de
        // role_permissions.role_name (data legacy, p.ej. user 'auxiliar_x' vs fila
        // 'Auxiliar_x'). Con match exacto el rol no se encontraba → JWT con 0
        // permisos → el usuario quedaba rebotado a /dashboard/captures.
        const rp = await trx('role_permissions')
          .whereRaw('LOWER(role_name) = ?', [String(u.role_name ?? '').toLowerCase()])
          .first();
        // `[ID.13]` Complementos: un usuario puede tener varios roles
        // (`identity.user_roles`). El JWT lleva la UNIÓN para que la UI gatee
        // igual que el backend. El perfil base sigue siendo `role_name`.
        // tenant_id explícito: la conexión de login es superusuario y no aplica RLS.
        let extras: Array<Record<string, boolean>> = [];
        try {
          const otros = await trx('identity.user_roles')
            .where({ tenant_id: tenant.id, user_id: u.id, is_primary: false })
            .pluck('role_name');
          if (otros.length) {
            const rows = await trx('role_permissions')
              .whereRaw(
                `LOWER(role_name) = ANY(?)`,
                [otros.map((r: string) => String(r).toLowerCase())],
              )
              .select('permissions');
            extras = rows.map((r: { permissions: Record<string, boolean> }) => r.permissions || {});
          }
        } catch {
          // Sin la migración `[ID.13]` aplicada: se sigue con el perfil base.
          extras = [];
        }
        let zn: string | null = null;
        if (u.zona_id) {
          const z = await trx('zones').where({ id: u.zona_id }).first();
          zn = z?.name ?? null;
        }
        return { user: u, rolePermissions: rp, zonaName: zn, extraPermissions: extras };
      }));
    } catch (error) {
      // Rollback ya ejecutado por Knex al propagarse el error. Re-lanzamos
      // tal cual para que no se asuma una trx activa más adelante.
      throw error;
    }

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // `[ID.17]` Una cuenta de SERVICIO no entra con contraseña. Existe para que
    // los feeds y las tareas programadas tengan identidad (`created_by`), no para
    // que alguien se loguee con ella. El hash guardado además no es un bcrypt
    // válido, así que esto es la segunda barrera, no la única.
    if (user.kind === 'servicio') {
      throw new UnauthorizedException('Esta es una cuenta de servicio: no tiene acceso interactivo.');
    }

    // `[ID.13]` Cuentas con vencimiento (contador/auditor externo). Se corta
    // ANTES de comparar el password: una cuenta vencida no es una credencial
    // inválida, es una cuenta que dejó de existir para efectos de acceso. Se
    // hace en el login y no con un cron para que no dependa de que un job corra.
    if (user.expires_at && new Date(user.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException('La cuenta venció. Pedí una extensión al administrador.');
    }

    // 3. Verificar password
    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // 3.5 Registrar último login (fire-and-forget — el éxito del login NO
    // depende de este UPDATE). RLS aplica via SET LOCAL.
    // IP truncada a 45 chars (col limit IPv6 + margen); UA a 1024 chars
    // para que un UA absurdo no infle la fila.
    const ip = meta?.ip ? String(meta.ip).slice(0, 45) : null;
    const ua = meta?.userAgent ? String(meta.userAgent).slice(0, 1024) : null;
    void this.knex
      .transaction(async (trx) => {
        await trx.raw(`SET LOCAL app.tenant_id = '${tenant.id}'`);
        await trx('users').where({ id: user.id }).update({
          last_login_at: trx.fn.now(),
          last_login_ip: ip,
          last_login_user_agent: ua,
        });
      })
      .catch((err) => {
        // Logueamos pero no fallamos el login.
        console.warn(`[auth-mt] No se pudo actualizar last_login para ${user.id}: ${err?.message}`);
      });

    // 4. Construir permissions + rules para gating de UI.
    // `[ID.13]` Unión perfil base + complementos. `true` gana: un complemento
    // sólo puede sumar, nunca quitar lo que el perfil base concede.
    const permissions: Record<string, boolean> = { ...(rolePermissions?.permissions || {}) };
    for (const extra of extraPermissions) {
      for (const [k, v] of Object.entries(extra)) {
        if (v === true) permissions[k] = true;
        else if (!(k in permissions)) permissions[k] = v;
      }
    }
    const ability = buildAbility(permissions, { roleName: user.role_name });

    // 5. Generar JWT con tenant_id + snapshot de permisos.
    const payload: JwtPayloadMt = {
      sub: user.id,
      tenant_id: tenant.id,
      username: user.username,
      role_name: user.role_name,
      zona_id: user.zona_id || undefined,
      zona: zonaName || undefined,
      warehouse_code: user.warehouse_code || undefined,
      permissions,
      rules: ability.rules,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        tenant_nombre: tenant.nombre,
        username: user.username,
        nombre: user.nombre,
        role_name: user.role_name,
        zona_id: user.zona_id,
        zona: zonaName ?? null,
        warehouse_code: user.warehouse_code ?? null,
        meta_puntos: user.meta_puntos,
        permissions,
        rules: ability.rules,
      },
    };
  }
}
