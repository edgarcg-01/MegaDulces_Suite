import 'reflect-metadata';
import { FinanceCajaGeneralModule, CajaArqueoService } from '@megadulces/finance';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * ⛔ `[CGS.45]` Regla 30 del protocolo de PR: al agregar un controlador y un servicio inyectados se
 * prueba `design:paramtypes` —lo que Nest lee al arrancar—, no un regex sobre el texto (#414 tiró
 * la API con el CI en verde). Vive en `apps/api` porque aquí la configuración emite metadata.
 */
type Clase = { name: string };

describe('[CGS.45] FinanceCajaGeneralModule: el arqueo completo de la caja', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);

  it('el módulo registra el controlador y el servicio del arqueo', () => {
    expect(por(controllers, 'CajaArqueoController'), 'el módulo no declara CajaArqueoController').toBeDefined();
    expect(por(providers, 'CajaArqueoService'), 'falta registrar CajaArqueoService').toBeDefined();
  });

  it('CajaArqueoController recibe CajaArqueoService por su clase', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(controllers, 'CajaArqueoController')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos).toEqual([CajaArqueoService]);
  });

  it('CajaArqueoService recibe el acceso a la base y el tenant por su clase', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', CajaArqueoService) as Clase[] | undefined;
    expect(tipos).toEqual([TenantKnexService, TenantContextService]);
  });
});
