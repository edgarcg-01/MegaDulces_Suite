import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  KNEX_CONNECTION,
  autenticarYFirmar,
  resolverTenantDeUsuario,
} from '@megadulces/platform-core';
import { Knex } from 'knex';
import { LoginDto } from './dto/login.dto';

/**
 * Puerta de login **legacy** (`POST /auth/login`): sin `tenant_slug`.
 *
 * ── `[ID.37]` Qué cambió acá y por qué ───────────────────────────────────────
 * Este servicio tenía su PROPIA versión de qué es una sesión válida, y estaba
 * atrasada respecto de `/auth-mt/login`. Medido, no le aplicaba **ninguno** de
 * estos cinco frenos/reglas que la puerta principal sí aplica:
 *
 *   1. `kind = 'servicio'` → sin acceso interactivo (`[ID.17]`).
 *   2. `expires_at` vencido → la cuenta dejó de existir para acceder (`[ID.13]`).
 *   3. `identity.user_roles` → la unión con los roles complementarios (`[ID.13]`).
 *   4. `identity.user_permissions` → los overrides de la persona (`[ID.21]`).
 *   5. `token_ttl_days` → la vida del token que declara la cuenta (`[CH.1.3]`).
 *
 * Los puntos 3 y 4 no eran un agujero de autorización —`RolesGuard` relee los
 * permisos de la DB en cada request, el token no autoriza— pero sí dejaban a la
 * UI con un menú distinto según por qué puerta hubieras entrado. Los puntos 1, 2
 * y 5 sí eran compuertas ausentes. Hoy no hay daño vivo (**0 usuarios con
 * `expires_at`** en prod y la única cuenta de servicio no tiene hash bcrypt
 * válido), pero eso es suerte de datos, no una compuerta.
 *
 * Ahora las dos puertas llaman a `autenticarYFirmar`, así que la regla es una
 * sola y se cambia en un solo lugar.
 *
 * ── Por qué esta puerta sigue abierta ────────────────────────────────────────
 * Porque `apps/vendor` es una app **Capacitor instalada en teléfonos** y su
 * `AuthService` todavía trae el método que pega acá: un APK viejo en el campo no
 * se entera de un cambio de endpoint. Las pantallas de login de las tres apps ya
 * usan `loginMt` — los únicos consumidores nuestros que quedan son dos importers
 * de finanzas y dos scripts de verificación. Se retira cuando el APK del campo
 * esté confirmado; hasta entonces se deja medida: cada uso queda logueado.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const { username, password } = loginDto;

    // El cliente legacy no manda tenant. Se deduce (ver `resolverTenantDeUsuario`:
    // por username único, y si no, el único tenant activo). Sin decisión posible
    // → el mismo mensaje genérico de siempre, sin revelar qué tenants existen.
    const tenant = await resolverTenantDeUsuario(this.knex, username);
    if (!tenant) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const sesion = await autenticarYFirmar(
      { knex: this.knex, jwt: this.jwtService },
      tenant,
      { username, password },
    );

    // Deprecación MEDIDA, no anunciada: sin esto, el día que haya que retirar la
    // puerta nadie va a poder decir quién la estaba usando (ADR-056 — lo que no
    // se mide se declara, no se supone).
    this.logger.warn(
      `[ID.37] Login por la puerta legacy /auth/login (usuario "${sesion.user['username']}"). ` +
        `La puerta vigente es /auth-mt/login con tenant_slug.`,
    );

    return sesion;
  }
}
