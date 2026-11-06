import 'reflect-metadata';
import { FinanceExpenseProofsModule, ExpenseProofsService } from '@megadulces/finance';

/**
 * ⛔ `[PGP.79]` Regla 30 del protocolo de PR: tocar una firma inyectada de Nest se prueba por
 * `design:paramtypes` —lo que Nest lee al arrancar—, no por un regex (#414 tiró la API con el CI
 * en verde). `ExpenseProofsService` gana una dependencia nueva (el adaptador que autoriza en
 * Kepler): tiene que llegar por su CLASE, al final, y el módulo tiene que registrarla.
 */
type Clase = { name: string };

describe('[PGP.79] FinanceExpenseProofsModule: el adaptador de autorización en Kepler arranca', () => {
  const providers = (Reflect.getMetadata('providers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const por = (nombre: string) => providers.find((c) => c?.name === nombre);

  it('el módulo registra el adaptador', () => {
    expect(por('KeplerAutorizacionGastoAdapter'), 'falta registrar KeplerAutorizacionGastoAdapter').toBeDefined();
  });

  it('el adaptador no pide nada en su constructor (las variables de entorno van en un getter)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por('KeplerAutorizacionGastoAdapter')!) as Clase[] | undefined;
    expect(tipos ?? []).toEqual([]);
  });

  it('el servicio lo recibe por su CLASE, como última dependencia', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ExpenseProofsService) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 8, `sin design:paramtypes esta prueba no mide nada (${tipos?.length})`).toBe(true);
    expect(tipos![7]).toBe(por('KeplerAutorizacionGastoAdapter'));
    expect(tipos!.slice(0, 5).every((t) => typeof t === 'function' && t !== Object), `paramtypes: ${tipos!.map((t) => t?.name).join(', ')}`).toBe(true);
  });
});
