import 'reflect-metadata';
import { FinanceCaosModule, CaosService } from '@megadulces/finance';

/**
 * ⛔ `[CGS.22]` Regla 30 del protocolo de PR: al tocar una firma inyectada de Nest se prueba
 * `design:paramtypes` —lo que Nest lee al arrancar—, no un regex sobre el texto (#414 tiró la API
 * con el CI en verde).
 *
 * Vive en `apps/api` y no en `libs/finance` a propósito: la configuración de pruebas de la API
 * compila con swc y `decoratorMetadata`; la de la librería no emite metadata y esta prueba no
 * mediría nada allá. Las clases se leen de la metadata del MÓDULO, que es lo que se exporta.
 */
type Clase = { name: string };

describe('[CGS.22] FinanceCaosModule: lo que Nest inyecta al arrancar', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceCaosModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', FinanceCaosModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);

  it('el módulo registra el controlador y el servicio del conteo físico', () => {
    expect(por(controllers, 'CaosController'), 'el módulo no declara CaosController').toBeDefined();
    expect(por(providers, 'CaosConteoFisicoService'), 'falta registrar CaosConteoFisicoService').toBeDefined();
  });

  it('el constructor de CaosController declara cada dependencia por su CLASE', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(controllers, 'CaosController')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length > 0, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos!.every((t) => typeof t === 'function' && t !== Object), `paramtypes: ${tipos!.map((t) => t?.name).join(', ')}`).toBe(true);
    expect(tipos).toContain(por(providers, 'CaosConteoFisicoService'));
  });

  it('CaosConteoFisicoService recibe CaosService por su clase', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(providers, 'CaosConteoFisicoService')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 3, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos).toContain(CaosService);
  });
});
