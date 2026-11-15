import 'reflect-metadata';
import { FinanceExpenseProofsModule, ExpenseProofsService } from '@megadulces/finance';

/**
 * ⛔ `[PGP.122]` Regla 30 del protocolo de PR: lo que se rompe al tocar un controlador, un provider o un constructor
 * de Nest es el ARRANQUE, y eso no lo ven ni `nx build`, ni vitest, ni el CI (#414 tiró la API con el CI en verde).
 * Se prueba por `design:paramtypes`, que es lo que Nest lee al arrancar: la solicitud de gasto que nace en la Suite
 * trae un controlador, un servicio y el escritor a Kepler, y `ExpenseProofsService` gana una dependencia.
 */
type Clase = { name: string };

describe('[PGP.122] FinanceExpenseProofsModule: la solicitud de gasto que nace en la Suite arranca', () => {
  const providers = (Reflect.getMetadata('providers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const controllers = (Reflect.getMetadata('controllers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const por = (nombre: string) => providers.find((c) => c?.name === nombre);
  const ctrl = () => controllers.find((c) => c?.name === 'SolicitudGastoController');

  it('el módulo registra el controlador, el servicio y el escritor', () => {
    expect(ctrl(), 'falta registrar SolicitudGastoController').toBeDefined();
    expect(por('SolicitudGastoService'), 'falta registrar SolicitudGastoService').toBeDefined();
    expect(por('KeplerSolicitudGastoSinkAdapter'), 'falta registrar KeplerSolicitudGastoSinkAdapter').toBeDefined();
  });

  it('el escritor no pide nada en su constructor (las variables de entorno van en un getter, #414)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por('KeplerSolicitudGastoSinkAdapter')!) as Clase[] | undefined;
    expect(tipos ?? []).toEqual([]);
  });

  it('el controlador recibe su servicio por CLASE, en la ruta finance/expenses/solicitudes', () => {
    const tc = Reflect.getMetadata('design:paramtypes', ctrl()!) as Clase[] | undefined;
    expect(tc).toEqual([por('SolicitudGastoService')]);
    expect(Reflect.getMetadata('path', ctrl()!)).toBe('finance/expenses/solicitudes');
  });

  it('el servicio recibe cada dependencia por su CLASE (el knex, por su token)', () => {
    const ts = Reflect.getMetadata('design:paramtypes', por('SolicitudGastoService')!) as Clase[] | undefined;
    expect(ts?.map((t) => t?.name)).toEqual([
      'TenantKnexService', 'TenantContextService', 'Object', 'KeplerSolicitudGastoSinkAdapter', 'ExpenseProofsGateway',
      'LlmExtractorService', 'ObjectStorageService',
    ]);
  });

  it('ExpenseProofsService recibe el servicio de la solicitud por CLASE, como su última dependencia', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ExpenseProofsService) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 9, `sin design:paramtypes esta prueba no mide nada (${tipos?.length})`).toBe(true);
    expect(tipos![8]).toBe(por('SolicitudGastoService'));
  });

  it('⛔ ningún parámetro de los métodos del controlador es un esquema Zod (es lo que tiró #414 al arrancar)', () => {
    const proto = (ctrl() as unknown as { prototype: object }).prototype;
    const metodos = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');
    expect(metodos.length, 'el controlador sin métodos: la prueba no mide nada').toBeGreaterThan(5);
    for (const k of metodos) {
      const p = (Reflect.getMetadata('design:paramtypes', proto, k) ?? []) as unknown[];
      // Una clase o un tipo primitivo (String, Object…) es una función; un esquema Zod es un objeto con `parse`.
      for (const t of p) expect(typeof t === 'function', `${k}: un parámetro no es una clase (${String((t as { name?: string })?.name ?? t)})`).toBe(true);
    }
  });
});
