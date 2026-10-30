import 'reflect-metadata';
import { FinanceExpenseProofsModule } from '@megadulces/finance';

/**
 * ⛔ `[GX.87]` Regla 30 del protocolo de PR: se agregó un método decorado al controlador de
 * vales (`POST :id/evidencia-adicional`). Se prueba por la metadata que Nest lee al arrancar
 * —no por un regex sobre el texto (#414 tiró la API con el CI en verde)—. Vive en `apps/api`
 * porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string; prototype: object };

describe('[GX.87] FinanceExpenseProofsModule: la evidencia adicional arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceExpenseProofsModule) ?? []) as Clase[];
  const ctrl = controllers.find((c) => c?.name === 'ExpenseProofsController');
  const metodo = () => (ctrl!.prototype as Record<string, unknown>)['agregarEvidenciaAdicional'];

  it('el módulo declara el controlador de vales, con el método nuevo', () => {
    expect(ctrl, 'el módulo no declara ExpenseProofsController').toBeDefined();
    expect(typeof metodo()).toBe('function');
  });

  it('la ruta es POST :id/evidencia-adicional', () => {
    expect(Reflect.getMetadata('path', metodo() as object)).toBe(':id/evidencia-adicional');
    expect(Reflect.getMetadata('method', metodo() as object)).toBe(1); // RequestMethod.POST
  });

  it('los parámetros son id, body y req: tipos que Nest resuelve sin inyectar nada', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl!.prototype, 'agregarEvidenciaAdicional') as unknown[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 3, 'sin metadata del método esta prueba no mide nada').toBe(true);
    expect(tipos![0]).toBe(String);
    // El body es un tipo literal, no una clase: Swagger y Nest leen Object.
    expect(tipos![1]).toBe(Object);
  });
});
