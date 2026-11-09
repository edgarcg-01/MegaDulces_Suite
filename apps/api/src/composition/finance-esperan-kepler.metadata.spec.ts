import 'reflect-metadata';
import { FinanceExpenseProofsModule } from '@megadulces/finance';

/**
 * ⛔ `[GX.96]` Regla 30 del protocolo de PR: se agregó un método decorado al controlador de
 * vales (`GET esperan-kepler`). Se prueba por la metadata que Nest lee al arrancar —no por un
 * regex sobre el texto (#414 tiró la API con el CI en verde)—. Vive en `apps/api` porque aquí se
 * compila con `decoratorMetadata`. Misma forma que `finance-buscar-gastos.metadata.spec.ts`.
 */
type Clase = { name: string; prototype: object };

describe('[GX.96] FinanceExpenseProofsModule: la cola «Esperan a Kepler» arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const ctrl = controllers.find((c) => c?.name === 'ExpenseProofsController');
  const proto = () => ctrl?.prototype as Record<string, unknown>;

  it('la ruta es GET esperan-kepler', () => {
    const m = proto()['esperanKepler'] as object;
    expect(typeof m).toBe('function');
    expect(Reflect.getMetadata('path', m)).toBe('esperan-kepler');
    expect(Reflect.getMetadata('method', m)).toBe(0); // RequestMethod.GET
  });

  /** ⛔ Sólo quien aprueba: es el gasto revisado de toda la empresa. */
  it('⛔ exige FINANCE_EXPENSES_COMPROBAR', () => {
    expect(Reflect.getMetadata('permissions', proto()['esperanKepler'] as object)).toEqual(['FINANCE_EXPENSES_COMPROBAR']);
  });

  /** ⛔ Va ANTES de `GET :id`: si no, `/esperan-kepler` se lee como el vale con ese id. */
  it('⛔ se declara antes de GET :id', () => {
    const nombres = Object.getOwnPropertyNames(ctrl?.prototype ?? {});
    const getId = nombres.find((n) => n !== 'constructor' && Reflect.getMetadata('path', proto()[n] as object) === ':id'
      && Reflect.getMetadata('method', proto()[n] as object) === 0);
    expect(getId).toBeDefined();
    expect(nombres.indexOf('esperanKepler')).toBeLessThan(nombres.indexOf(getId as string));
  });

  it('el único parámetro es un texto de la query (limit)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl?.prototype ?? {}, 'esperanKepler') as unknown[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin metadata del método esta prueba no mide nada').toBe(true);
    expect(tipos).toEqual([String]);
  });
});
