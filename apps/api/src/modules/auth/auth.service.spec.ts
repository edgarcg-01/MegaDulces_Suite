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
 * [NX.3] Candados del login clásico · `[ID.37]` los cinco que la puerta legacy NO tenía.
 *
 * ── Qué sujeto se prueba acá ────────────────────────────────────────────────────────────────
 * `AuthService` (la puerta `/auth/login`), que desde `[ID.37]` **delega en
 * `autenticarYFirmar`** — la regla única de login, compartida con `/auth-mt/login`. O sea que
 * cada caso de abajo vale por las DOS puertas: es exactamente el punto del cambio.
 *
 * ⚠️ Deuda declarada: el núcleo vive en `libs/platform-core`, que **no tiene corredor de
 * pruebas** (no hay `vitest.config.ts` ni un solo `.spec.ts` ahí). Los candados se quedan en
 * `apps/api`, que sí tiene runner y es quien consume las dos puertas. Cuando `platform-core`
 * estrene runner, este archivo se parte en dos y el del núcleo se muda con él.
 *
 * ── Qué se vigila ───────────────────────────────────────────────────────────────────────────
 *  1. usuario inexistente → 401, y NO se firma token (un 200 con token vacío sería peor);
 *  2. ⭐ [ID.31] cuenta sin `password_hash` (invitada) → 401, NO 500. `bcrypt.compare(x, null)`
 *     **lanza**, así que sin la guarda esto es un error de servidor disfrazado de fallo de login;
 *  3. el username se normaliza (minúsculas, sin espacios) ANTES de ir a la DB;
 *  4. ⭐ [ID.29] en el token viajan SÓLO las claves concedidas;
 *  5. ⭐ [ID.37] cuenta `kind='servicio'` → 401 **por esta puerta** (antes entraba);
 *  6. ⭐ [ID.37] cuenta con `expires_at` vencido → 401 **por esta puerta** (antes entraba);
 *  7. ⭐ [ID.37] la vida del token la decide la cuenta (`token_ttl_days`), no la constante global;
 *  8. ⭐ [ID.37] el snapshot lleva la unión con los roles complementarios y los overrides de la
 *     persona — que es lo que esta puerta no miraba, y por eso daba un menú distinto al de la otra;
 *  9. ⭐ [ID.37] sin tenant resoluble → 401 fail-closed, sin tocar la tabla de usuarios.
 *
 * Los casos 5 y 6 llevan **control positivo**: la misma cuenta sin la marca SÍ entra. Sin eso,
 * un 401 por cualquier otro motivo pintaría el candado de verde.
 *
 * Límite declarado: acá Knex es un doble. La consulta real (los JOIN, el `LOWER()` del rol) se
 * prueba por HTTP contra la API corriendo — ADR-044, porque un test que reimplementa la
 * consulta se pone verde con la ruta caída.
 */

const TENANT = { id: 't1', slug: 'mega_dulces', nombre: 'Mega Dulces' };

interface Espia {
  where?: unknown;
  raw?: unknown[];
  tablas: string[];
}

/**
 * Doble encadenable de Knex. Resuelve por NOMBRE BASE de tabla:
 *   · `first()`  → `tablas[base]`            (una fila)
 *   · `select()` / `limit()` / `pluck()` → `tablas[base + ':lista']` (varias, por default `[]`)
 * Distinguir los dos es necesario porque `role_permissions` se consulta de las dos formas: la
 * fila del perfil base y la lista de los complementos.
 */
function knexDoble(porTabla: Record<string, unknown>, espia: Espia) {
  const consulta = (tabla: string) => {
    const base = tabla.split(' ')[0];
    espia.tablas.push(base);
    const lista = () => (porTabla[`${base}:lista`] as unknown[]) ?? [];
    const q: Record<string, unknown> = {};
    for (const m of ['leftJoin', 'join', 'orderBy', 'whereNull', 'distinct', 'returning', 'select', 'limit', 'pluck']) {
      q[m] = () => q;
    }
    // Thenable, como el query builder real: `await` sobre la consulta devuelve la LISTA.
    // Sin esto, un `select(...).limit(2)` revienta con un TypeError que el test leería como
    // "falló por otra razón" — pasó al escribirlo.
    q['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(lista()).then(res, rej);
    q['where'] = (w: unknown) => {
      if (base === 'users' && w && typeof w === 'object' && 'username' in (w as object)) {
        espia.where = w;
      }
      return q;
    };
    q['whereRaw'] = (...a: unknown[]) => {
      espia.raw = a;
      return q;
    };
    q['first'] = async () => porTabla[base] ?? undefined;
    q['update'] = async () => 1;
    return q;
  };

  const knex = ((tabla: string) => consulta(tabla)) as unknown as Record<string, unknown> &
    ((t: string) => unknown);
  knex['raw'] = async () => ({ rows: [] });
  knex['fn'] = { now: () => 'now()' };
  knex['transaction'] = async (cb: (trx: unknown) => Promise<unknown>) => {
    const trx = ((tabla: string) => consulta(tabla)) as unknown as Record<string, unknown> &
      ((t: string) => unknown);
    trx['raw'] = async () => ({ rows: [] });
    trx['fn'] = { now: () => 'now()' };
    return cb(trx);
  };
  return knex;
}

describe('AuthService · login (puerta legacy, regla compartida [ID.37])', () => {
  let service: AuthService;
  let firmado: unknown;
  let opcionesFirma: unknown;
  let espia: Espia;

  /** Monta el servicio con el tenant SIEMPRE resoluble, salvo que se indique lo contrario. */
  const montar = async (tablas: Record<string, unknown>, sinTenant = false) => {
    firmado = undefined;
    opcionesFirma = undefined;
    espia = { tablas: [] };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: KNEX_CONNECTION,
          useValue: knexDoble(
            { 'tenants:lista': sinTenant ? [] : [TENANT], ...tablas },
            espia,
          ),
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: async (p: unknown, o: unknown) => {
              firmado = p;
              opcionesFirma = o;
              return 'token-de-prueba';
            },
          },
        },
      ],
    }).compile();
    service = module.get(AuthService);
    return service;
  };

  /** Una cuenta que entra sin problemas — el control positivo de los frenos. */
  const cuentaSana = async (extra: Record<string, unknown> = {}) => ({
    users: {
      id: 7,
      username: 'ana',
      password_hash: await bcrypt.hash('secreto', 4),
      role_name: 'vendedor',
      tenant_id: 't1',
      nombre: 'Ana',
      ...extra,
    },
    role_permissions: { permissions: { PUEDE_VER: true } },
  });

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
    await montar({ users: undefined });
    await expect(service.login({ username: '  ADMIN  ', password: 'x' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(espia.where).toEqual({ username: 'admin', activo: true });
  });

  it('⭐ [ID.29] el token lleva SÓLO los permisos concedidos, no el mapa completo', async () => {
    const mapaCrudo = { PUEDE_VER: true, NO_PUEDE: false, TAMPOCO: false };
    const tablas = await cuentaSana();
    (tablas as Record<string, unknown>)['role_permissions'] = { permissions: mapaCrudo };
    await montar(tablas);

    const r = await service.login({ username: 'ana', password: 'secreto' } as never);

    expect(r.access_token).toBe('token-de-prueba');
    expect((firmado as { permissions: unknown }).permissions).toEqual({ PUEDE_VER: true });
    expect(r.user.permissions).toEqual({ PUEDE_VER: true });
    // NEGATIVA: el mapa de origen SÍ traía las claves en `false`, o sea que el caso no es
    // degenerado — hubo algo que filtrar.
    expect(Object.keys(mapaCrudo)).toHaveLength(3);
  });

  it('⭐ [ID.37] cuenta de servicio: 401 por la puerta legacy (antes entraba)', async () => {
    await montar(await cuentaSana({ kind: 'servicio' }));
    await expect(service.login({ username: 'ana', password: 'secreto' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(firmado).toBeUndefined();
  });

  it('⭐ [ID.37] cuenta vencida (expires_at en el pasado): 401 por la puerta legacy', async () => {
    await montar(await cuentaSana({ expires_at: new Date(Date.now() - 86_400_000) }));
    await expect(service.login({ username: 'ana', password: 'secreto' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(firmado).toBeUndefined();
  });

  it('CONTROL POSITIVO de los dos frenos: la misma cuenta, sin las marcas, SÍ entra', async () => {
    // Sin esto, los dos casos de arriba podrían estar dando 401 por cualquier otro motivo
    // (un doble mal armado, por ejemplo) y el candado se leería verde igual.
    await montar(await cuentaSana({ expires_at: new Date(Date.now() + 86_400_000) }));
    const r = await service.login({ username: 'ana', password: 'secreto' } as never);
    expect(r.access_token).toBe('token-de-prueba');
  });

  it('⭐ [ID.37] la vida del token la decide la CUENTA (token_ttl_days), no el default global', async () => {
    await montar(await cuentaSana({ token_ttl_days: 30 }));
    await service.login({ username: 'ana', password: 'secreto' } as never);
    expect(opcionesFirma).toEqual({ expiresIn: 30 * 24 * 60 * 60 });
  });

  it('⭐ [ID.37] sin token_ttl_days manda el default global (objeto VACÍO, no expiresIn undefined)', async () => {
    // NEGATIVA del anterior, y no es cosmética: `{ expiresIn: undefined }` BORRA la clave en el
    // merge de Nest y emitiría un token **sin expiración** para todo el mundo.
    await montar(await cuentaSana());
    await service.login({ username: 'ana', password: 'secreto' } as never);
    expect(opcionesFirma).toEqual({});
  });

  it('⭐ [ID.37] el snapshot suma el rol complementario y aplica el override de la persona', async () => {
    const tablas = await cuentaSana();
    Object.assign(tablas, {
      // un complemento que SUMA una clave que el perfil base no tiene
      'identity.user_roles:lista': ['captura_gastos'],
      'role_permissions:lista': [{ permissions: { GASTO_CAPTURAR: true } }],
      // y un override de la persona que QUITA una que el rol sí le daba
      'identity.user_permissions:lista': [{ permission_key: 'PUEDE_VER', allow: false }],
    });
    await montar(tablas);

    const r = await service.login({ username: 'ana', password: 'secreto' } as never);

    expect(r.user.permissions).toEqual({ GASTO_CAPTURAR: true });
    // `PUEDE_VER` venía del rol y el override lo quitó: no viaja ni en `false`
    // (`soloConcedidos` filtra), que es justo lo que el front lee como "no tiene".
    expect(Object.keys(r.user.permissions as object)).not.toContain('PUEDE_VER');
  });

  it('⭐ [ID.37] sin tenant resoluble: 401 fail-closed y NO se consulta la tabla de usuarios', async () => {
    await montar(await cuentaSana(), true);
    await expect(service.login({ username: 'ana', password: 'secreto' } as never))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(espia.tablas).not.toContain('users');
  });
});
