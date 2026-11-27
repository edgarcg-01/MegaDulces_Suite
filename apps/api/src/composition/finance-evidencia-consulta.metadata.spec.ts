import 'reflect-metadata';
import { FinancePaymentCalendarModule } from '@megadulces/finance';
import { Permission } from '@megadulces/platform-core';

/**
 * ⛔ `[PGP.231]` Regla 30 del protocolo de PR: se agregó un método decorado al controlador del Calendario
 * (`POST evidencia/consulta`, las llaves en el cuerpo porque en la URL —con el token de un superadmin— daban 431). Se
 * prueba por la metadata que Nest lee al arrancar, no por un regex sobre el texto (#414 tiró la API con el CI en verde).
 * Vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string; prototype: object };

describe('[PGP.231] FinancePaymentCalendarModule: la consulta de evidencia por cuerpo arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinancePaymentCalendarModule) ?? []) as Clase[];
  const ctrl = controllers.find((c) => c?.name === 'PaymentCalendarController');
  const metodo = (nombre: string) => (ctrl!.prototype as Record<string, unknown>)[nombre] as object;

  it('el módulo declara el controlador del Calendario, con el método nuevo y el viejo', () => {
    expect(ctrl, 'el módulo no declara PaymentCalendarController').toBeDefined();
    expect(typeof metodo('consultarEvidencia')).toBe('function');
    expect(typeof metodo('listEvidenceByRefs')).toBe('function'); // el GET sigue: pestañas abiertas antes del cambio
  });

  it('la ruta es POST evidencia/consulta, contesta 200 (sólo lee) y pide el permiso de VER', () => {
    expect(Reflect.getMetadata('path', metodo('consultarEvidencia'))).toBe('evidencia/consulta');
    expect(Reflect.getMetadata('method', metodo('consultarEvidencia'))).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata('__httpCode__', metodo('consultarEvidencia'))).toBe(200);
    expect(Reflect.getMetadata('permissions', metodo('consultarEvidencia'))).toEqual([Permission.FINANCE_PAYMENTS_VER]);
    // El GET viejo no cambió de ruta ni de método.
    expect(Reflect.getMetadata('path', metodo('listEvidenceByRefs'))).toBe('evidencia');
    expect(Reflect.getMetadata('method', metodo('listEvidenceByRefs'))).toBe(0); // RequestMethod.GET
  });

  it('el único parámetro es el cuerpo, un tipo que Nest resuelve sin inyectar nada', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl!.prototype, 'consultarEvidencia') as unknown[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin metadata del método esta prueba no mide nada').toBe(true);
    expect(tipos![0]).toBe(Object); // `PayableEvidenceQuery` es una interfaz: Nest y Swagger leen Object
  });

  it('pasa al servicio sólo las llaves de texto; sin cuerpo o con basura, una lista vacía (nunca revienta)', async () => {
    const llamadas: unknown[] = [];
    const yo = { svc: { listEvidenceByRefs: async (r: unknown) => { llamadas.push(r); return []; } } };
    const fn = metodo('consultarEvidencia') as (this: unknown, body?: unknown) => Promise<unknown>;
    await fn.call(yo, { refs: ['oblig:08|20|1|0000396', 7, null, 'oblig:00|20|1|0010381'] });
    await fn.call(yo, undefined);
    await fn.call(yo, { refs: 'oblig:08|20|1|0000396' });
    expect(llamadas).toEqual([['oblig:08|20|1|0000396', 'oblig:00|20|1|0010381'], [], []]);
  });
});
