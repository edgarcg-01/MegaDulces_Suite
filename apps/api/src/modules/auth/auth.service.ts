import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { Knex } from 'knex';
import * as bcrypt from 'bcryptjs';
import { LoginDto } from './dto/login.dto';
import { buildAbility } from '../../shared/ability/ability.factory';

/**
 * El JWT carga:
 *   - Identidad estable (sub, username, role_name, zona) — usada por el
 *     backend para identificar al usuario.
 *   - `permissions` y `rules` — usadas SOLO por el frontend para gating de UI
 *     (esconder/mostrar menús). El backend las IGNORA: el `RolesGuard` lee
 *     permisos frescos de `role_permissions` en cada request (via cache TTL
 *     30s + invalidación en update). Así los cambios de permisos se aplican
 *     al instante para autorización aunque la UI tarde hasta el próximo
 *     login en reflejarlos.
 *
 * Por qué siguen en el JWT (y no solo en el response): cuando el usuario
 * recarga la página, el frontend restaura sesión desde la cookie. Sin
 * `rules` en el JWT, la UI se quedaría sin permisos hasta hacer una request
 * adicional a /auth/me. Mantenerlas en el JWT es un hint de UI cómodo,
 * no una source-of-truth de seguridad.
 */
interface JwtPayload {
  sub: string;
  username: string;
  zona: string;
  role_name: string;
  permissions?: Record<string, boolean>;
  rules?: any[];
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;

    const user = await this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where({ 'u.username': username, 'u.activo': true })
      .select('u.*', 'z.name as zona')
      .first();

    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Obtener los permisos del rol del usuario
    const rolePermissions = await this.knex('role_permissions')
        .where({ role_name: user.role_name })
        .first();

    const permissions = rolePermissions ? rolePermissions.permissions : {};

    const ability = buildAbility(permissions);

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      zona: user.zona,
      role_name: user.role_name,
      // Snapshot para UI gating (no para autorización backend).
      permissions: permissions,
      rules: ability.rules,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        username: user.username,
        nombre: user.nombre,
        zona: user.zona,
        role_name: user.role_name,
        permissions: permissions,
        rules: ability.rules,
      },
    };
  }
}
