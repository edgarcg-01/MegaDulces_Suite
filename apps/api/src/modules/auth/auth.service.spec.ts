import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
// ⚠️ Este import dispara `@nx/enforce-module-boundaries` ("Static imports of lazy-loaded
// libraries are forbidden"), igual que la línea 3 de `auth.service.ts`, el archivo que este spec
// prueba. NO es deuda nueva: el origen es que `apps/api/src/main.ts` carga `platform-core` de
// forma diferida mientras todo el resto la importa estático. Traer el token de otro lado sería
// duplicarlo; se deja igual que el sujeto y el defecto queda donde está, a la vista.
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { AuthService } from './auth.service';

/**
 * [NX.3] Candados del login clásico.
 *
 * ── Por qué este archivo se reescribió ──────────────────────────────────────────────────────
 * Lo que había era el esqueleto del generador: `Test.createTestingModule({ providers:
 * [AuthService] })` y un `expect(service).toBeDefined()`. Ese spec **no podía pasar nunca** —
 * `AuthService` inyecta `KNEX_CONNECTION` y `JwtService`, y ninguno estaba provisto. Nadie lo
 * notó porque el target `test` de `apps/api` apuntaba a un `jest.config.ts` inexistente: los
 * tres specs de este proyecto jamás corrieron, ni una vez, desde que se generaron.
 *
 * O sea que el target no estaba rojo por un archivo faltante. Estaba rojo por DOS capas: el
 * corredor no arrancaba, y detrás había pruebas que tampoco eran viables.
 *
 * ── Qué se vigila ───────────────────────────────────────────────────────────────────────────
 * Lo que este método ya decidió y está escrito en sus propios comentarios, cada cosa con su
 * prueba negativa (ADR-056):
 *
 *  1. usuario inexistente → 401, y NO se firma token (un 200 con token vacío sería peor);
 *  2. ⭐ [ID.31] cuenta sin `password_hash` (invitada) → 401, NO 500. `bcrypt.compare(x, null)`
 *     **lanza**, así que sin la guarda esto es un error de servidor disfrazado de fallo de login;
 *  3. el username se normaliza (minúsculas, sin espacios) ANTES de ir a la DB;
 *  4. ⭐ [ID.29] en el token viajan SÓLO las claves concedidas. El mapa que guarda
 *     `/admin/roles` trae ~175 claves, la mayoría en `false`, y ese payload va en cada request.
 *
 * Límite declarado: acá Knex es un doble. La consulta real (los JOIN, el `LOWER()` del rol) se
 * prueba por HTTP contra la API corriendo — ADR-044, porque un test que reimplementa la
 * consulta se pone verde con la ruta caída.
 */

/** Doble encadenable de Knex: devuelve lo que se le indique para la tabla que se le pida. */
function knexDoble(
  porTabla: Record<string, unknown>,
  espia?: { where?: unknown; raw?: unknown[] },
) {
  return (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'join', 'select', 'orderBy', 'limit']) q[m] = () => q;
    q['where'] = (w: unknown) => { if (espia) espia.where = w; return q; };
    q['whereRaw'] = (...a: unknown[]) => { if (espia) espia.raw = a; return q; };
    q['first'] = async () => porTabla[tabla.split(' ')[0]] ?? undefined;
    return q;
  };
}

describe('AuthService · login', () => {
  let service: AuthService;
  let firmado: unknown;

  const montar = async (
    tablas: Record<string, unknown>,
    espia?: { where?: unknown; raw?: unknown[] },
  ) => {
    firmado = undefined;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: KNEX_CONNECTION, useValue: knexDoble(tablas, espia) },
        {
          provide: JwtService,
          useValue: {
            signAsync: async (p: unknown) => { firmado = p; return 'token-de-prueba'; },
          },
        },
      ],
    }).compile();
    service = module.get(AuthService);
    return service;
  };

  it('usuario inexistente: 401 y NO se firma ningún token', async () => {
    await montar({ users: undefined });
    await expect(service.login({ username: 'nadie', password: 'x' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(firmado).toBeUndefined();
  });

  it('⭐ [ID.31] cuenta invitada (password_hash null): 401, no un 500 de bcrypt', async () => {
    await montar({
      users: { id: 1, username: 'invitado', password_hash: null, role_name: 'vendedor' },
    });
    // La negativa de este candado está en el TIPO: si se quita la guarda `!!user.password_hash`,
    // bcrypt lanza un Error común y `toBeInstanceOf(UnauthorizedException)` falla. Esperar
    // "que reviente" a secas no distinguiría un 401 correcto de un 500.
    await expect(service.login({ username: 'invitado', password: 'x' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(firmado).toBeUndefined();
  });

  it('normaliza el username (minúsculas y sin espacios) antes de consultar', async () => {
    const espia: { where?: unknown; raw?: unknown[] } = {};
    await montar({ users: undefined }, espia);
    await expect(service.login({ username: '  ADMIN  ', password: 'x' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(espia.where).toEqual({ 'u.username': 'admin', 'u.activo': true });
  });

  it('⭐ [ID.29] el token lleva SÓLO los permisos concedidos, no el mapa completo', async () => {
    const mapaCrudo = { PUEDE_VER: true, NO_PUEDE: false, TAMPOCO: false };
    const hash = await bcrypt.hash('secreto', 4);
    await montar({
      users: {
        id: 7, username: 'ana', password_hash: hash, role_name: 'Vendedor',
        tenant_id: 't1', nombre: 'Ana', zona: 'Centro',
      },
      role_permissions: { permissions: mapaCrudo },
    });

    const r = await service.login({ username: 'ana', password: 'secreto' } as never);

    expect(r.access_token).toBe('token-de-prueba');
    expect((firmado as { permissions: unknown }).permissions).toEqual({ PUEDE_VER: true });
    expect(r.user.permissions).toEqual({ PUEDE_VER: true });
    // NEGATIVA: el mapa de origen SÍ traía las claves en `false`, o sea que el caso no es
    // degenerado — hubo algo que filtrar.
    expect(Object.keys(mapaCrudo)).toHaveLength(3);
  });
});
