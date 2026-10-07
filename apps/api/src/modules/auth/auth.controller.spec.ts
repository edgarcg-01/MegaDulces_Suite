import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * [NX.3] El controlador de login DELEGA, no decide.
 *
 * Lo que había era el esqueleto del generador: `controllers: [AuthController]` sin ningún
 * provider y un `expect(controller).toBeDefined()`. **No podía pasar nunca** — el controlador
 * inyecta `AuthService`. Nunca se notó porque este proyecto no tenía corredor de pruebas
 * (el detalle está en `auth.service.spec.ts`).
 *
 * Lo único que hay que vigilar acá es la frontera: que el cuerpo llegue INTACTO al service y
 * que la respuesta vuelva sin reempaquetar. Las credenciales se prueban en el service, y lo que
 * toca Postgres de verdad se prueba por HTTP (ADR-044).
 */
describe('AuthController', () => {
  let controller: AuthController;
  let recibido: unknown;

  beforeEach(async () => {
    recibido = undefined;
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: async (dto: unknown) => {
              recibido = dto;
              return { access_token: 'tok', user: { id: 1 } };
            },
          },
        },
        // ⚠️ `JwtService` NO lo pide el controlador: lo pide `RequireAuthGuard`, que cuelga de
        // `@UseGuards` en `getProfile`. Nest instancia los guards al COMPILAR el módulo, así
        // que sin este doble falla el `beforeEach` entero — incluida la prueba de `login`, que
        // no tiene guard. El mensaje culpa a `RootTestModule` y no menciona al guard.
        { provide: JwtService, useValue: { verifyAsync: async () => ({}) } },
      ],
    }).compile();
    controller = module.get(AuthController);
  });

  it('pasa el cuerpo TAL CUAL al service y devuelve su resultado sin reempaquetar', async () => {
    const dto = { username: '  ADMIN  ', password: 'secreto' };
    const r = await controller.login(dto as never);

    // El controlador NO normaliza: eso es del service, y allá tiene su propio candado. Si algún
    // día alguien agrega un `.trim()` acá, van a quedar dos lugares normalizando lo mismo.
    expect(recibido).toBe(dto);
    expect(r).toEqual({ access_token: 'tok', user: { id: 1 } });
  });

  it('el perfil devuelve el usuario que el guard ya resolvió, sin consultar nada', () => {
    const user = { sub: 9, username: 'ana' };
    expect(controller.getProfile(user)).toBe(user);
  });
});
