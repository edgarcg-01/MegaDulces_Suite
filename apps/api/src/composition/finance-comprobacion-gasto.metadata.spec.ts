import 'reflect-metadata';
import { FinanceExpenseProofsModule, ExpenseProofsService } from '@megadulces/finance';

/**
 * ⛔ `[PGP.123]` G.8 — Regla 30 del protocolo de PR: lo que se rompe al agregar un provider o tocar un constructor de
 * Nest es el ARRANQUE, y eso no lo ven ni `nx build`, ni vitest, ni el CI (#414 tiró la API con el CI en verde). Se
 * prueba por `design:paramtypes`, que es lo que Nest lee al arrancar: la comprobación del gasto trae un servicio y el
 * escritor del X-A-10, y `ExpenseProofsService` gana su 10ª dependencia.
 */
type Clase = { name: string };

describe('[PGP.123] FinanceExpenseProofsModule: la comprobación del gasto (X-A-10) arranca', () => {
  const providers = (Reflect.getMetadata('providers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const por = (nombre: string) => providers.find((c) => c?.name === nombre);

  it('el módulo registra el servicio y el escritor', () => {
    expect(por('ComprobacionGastoService'), 'falta registrar ComprobacionGastoService').toBeDefined();
    expect(por('KeplerGastoSinkAdapter'), 'falta registrar KeplerGastoSinkAdapter').toBeDefined();
  });

  it('el escritor no pide nada en su constructor (las variables de entorno van en un getter, #414)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por('KeplerGastoSinkAdapter')!) as Clase[] | undefined;
    expect(tipos ?? []).toEqual([]);
  });

  it('el servicio recibe cada dependencia por su CLASE (el knex, por su token)', () => {
    const ts = Reflect.getMetadata('design:paramtypes', por('ComprobacionGastoService')!) as Clase[] | undefined;
    expect(ts?.map((t) => t?.name)).toEqual(['TenantKnexService', 'Object', 'KeplerGastoSinkAdapter']);
  });

  it('ExpenseProofsService recibe la comprobación por CLASE, como su última dependencia', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ExpenseProofsService) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 10, `sin design:paramtypes esta prueba no mide nada (${tipos?.length})`).toBe(true);
    expect(tipos![9]).toBe(por('ComprobacionGastoService'));
  });
});
