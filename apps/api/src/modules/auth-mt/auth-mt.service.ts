import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  KNEX_NEW_DB,
  autenticarYFirmar,
  JwtPayloadSesion,
  MetaLogin,
} from '@megadulces/platform-core';
import { Knex } from 'knex';

/**
 * Auth multi-tenant para la nueva DB. **La puerta principal**: es la que usan
 * las pantallas de login de las tres apps (`view`, `vendor`, `portal`).
 *
 * Diferencias vs la puerta legacy (`/auth/login`):
 *   - El cliente declara el tenant (`tenant_slug`). Acá no se deduce nada.
 *   - Username NO es único global — es único POR tenant. Dos tenants pueden
 *     tener cada uno su "admin".
 *
 * `[ID.37]` Lo que ya NO vive acá: la regla de qué es una sesión válida (frenos
 * de la cuenta, unión de roles, overrides de la persona, TTL propio, snapshot
 * del token). Eso se mudó entero a `autenticarYFirmar` en
 * `libs/platform-core/.../login-core.ts`, porque estaba **duplicado y
 * divergido** contra el legacy. Este servicio hace lo único que es suyo:
 * resolver `tenant_slug` → `tenant_id`.
 */

export interface LoginDto {
  tenant_slug: string;
  username: string;
  password: string;
}

/**
 * Forma del JWT. Se conserva el nombre por compatibilidad con quien lo importe;
 * la definición es la compartida del núcleo, para que no haya dos.
 */
export type JwtPayloadMt = JwtPayloadSesion;

@Injectable()
export class AuthMtService {
  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto, meta?: MetaLogin) {
    if (!dto?.tenant_slug || !dto?.username || !dto?.password) {
      throw new UnauthorizedException('Faltan credenciales o tenant');
    }

    // Resolver tenant_slug → tenant (global, sin RLS).
    const tenant = await this.knex('tenants')
      .where({ slug: dto.tenant_slug, activo: true })
      .whereNull('deleted_at')
      .first('id', 'slug', 'nombre');

    if (!tenant) {
      // Mensaje genérico para no filtrar qué tenants existen.
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return autenticarYFirmar(
      { knex: this.knex, jwt: this.jwtService },
      tenant,
      { username: dto.username, password: dto.password },
      meta,
    );
  }
}
