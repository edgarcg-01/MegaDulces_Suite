import 'reflect-metadata';
import { FinanceExpenseProofsModule } from '@megadulces/finance';

/**
 * ⛔ `[GX.88]` Regla 30 del protocolo de PR: se agregó un método decorado al controlador de
 * vales (`GET buscar`). Se prueba por la metadata que Nest lee al arrancar —no por un regex
 * sobre el texto (#414 tiró la API con el CI en verde)—. Vive en `apps/api` porque aquí se
 * compila con `decoratorMetadata`.
 */
type Clase = { name: string; prototype: object };

describe('[GX.88] FinanceExpenseProofsModule: el buscador de gastos arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const ctrl = controllers.find((c) => c?.name === 'ExpenseProofsController');
  const proto = () => ctrl?.prototype as Record<string, unknown>;

  it('la ruta es GET buscar', () => {
    const m = proto()['buscar'] as object;
    expect(typeof m).toBe('function');
    expect(Reflect.getMetadata('path', m)).toBe('buscar');
    expect(Reflect.getMetadata('method', m)).toBe(0); // RequestMethod.GET
  });

  /** ⛔ Sólo quien aprueba: deja ver el gasto de toda la empresa. */
  it('⛔ exige FINANCE_EXPENSES_COMPROBAR', () => {
    expect(Reflect.getMetadata('permissions', proto()['buscar'] as object)).toEqual(['FINANCE_EXPENSES_COMPROBAR']);
  });

  /**
   * ⛔ Va ANTES de `GET :id`: Nest registra las rutas en el orden en que se declaran, y si
   * `:id` va primero, `/buscar` se lee como el vale con id «buscar» (y responde 404 o 500).
   */
  it('⛔ se declara antes de GET :id', () => {
    const nombres = Object.getOwnPropertyNames(ctrl?.prototype ?? {});
    const getId = nombres.find((n) => n !== 'constructor' && Reflect.getMetadata('path', proto()[n] as object) === ':id'
      && Reflect.getMetadata('method', proto()[n] as object) === 0);
    expect(getId).toBeDefined();
    expect(nombres.indexOf('buscar')).toBeLessThan(nombres.indexOf(getId as string));
  });

  it('los parámetros son dos textos de la query (q y limit)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl?.prototype ?? {}, 'buscar') as unknown[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 2, 'sin metadata del método esta prueba no mide nada').toBe(true);
    expect(tipos).toEqual([String, String]);
  });
});
