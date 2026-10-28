import 'reflect-metadata';
import { FinanceCajaGeneralModule, CashLedgerService } from '@megadulces/finance';

/**
 * ⛔ `[CGA-A.61]` Regla 30 del protocolo de PR: un controlador y un servicio NUEVOS con firmas
 * inyectadas se prueban por `design:paramtypes` —lo que Nest lee al arrancar—, no por un regex
 * sobre el texto (#414 tiró la API con el CI en verde). Mismo patrón que
 * `finance-caos.metadata.spec.ts`: vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string };

describe('[CGA-A.61] FinanceCajaGeneralModule: la reposición por sucursal arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);

  it('el módulo registra el controlador y el servicio de la reposición', () => {
    expect(por(controllers, 'CajaReposicionController'), 'el módulo no declara CajaReposicionController').toBeDefined();
    expect(por(providers, 'CajaReposicionService'), 'falta registrar CajaReposicionService').toBeDefined();
  });

  it('el controlador recibe el servicio por su CLASE', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(controllers, 'CajaReposicionController')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos).toContain(por(providers, 'CajaReposicionService'));
  });

  it('el servicio recibe sus tres dependencias por su clase, CashLedgerService incluido', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(providers, 'CajaReposicionService')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 3, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos!.every((t) => typeof t === 'function' && t !== Object), `paramtypes: ${tipos!.map((t) => t?.name).join(', ')}`).toBe(true);
    expect(tipos).toContain(CashLedgerService);
  });
});
