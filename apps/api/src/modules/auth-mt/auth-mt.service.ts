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
    const { user, rolePermissions, zonaName } = await this.knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${tenant.id}'`);
      const u = await trx('users')
        .where({ username: dto.username.toLowerCase().trim(), activo: true })
        .first();
      if (!u) return { user: null, rolePermissions: null, zonaName: null };
      // Lookup case-insensitive: users.role_name puede diferir en mayúsculas de
      // role_permissions.role_name (data legacy, p.ej. user 'auxiliar_x' vs fila
      // 'Auxiliar_x'). Con match exacto el rol no se encontraba → JWT con 0
      // permisos → el usuario quedaba rebotado a /dashboard/captures.
      const rp = await trx('role_permissions')
        .whereRaw('LOWER(role_name) = ?', [String(u.role_name ?? '').toLowerCase()])
        .first();
      let zn: string | null = null;
      if (u.zona_id) {
        const z = await trx('zones').where({ id: u.zona_id }).first();
        zn = z?.name ?? null;
      }
      return { user: u, rolePermissions: rp, zonaName: zn };
    });

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
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
    const permissions: Record<string, boolean> =
      rolePermissions?.permissions || {};
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
