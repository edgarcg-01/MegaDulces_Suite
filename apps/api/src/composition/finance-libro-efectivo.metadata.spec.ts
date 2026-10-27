import 'reflect-metadata';
import { FinanceCajaGeneralModule, CashbookService, CashbookCaosCarril } from '@megadulces/finance';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[LE.4]` — Que la API ARRANQUE con el libro de efectivo: el módulo registra su controlador y su
 * servicio, y Nest sabe qué inyectarles (`design:paramtypes`). Un regex sobre el texto no prueba
 * esto: el incidente de #414 tiró la API en prod con el CI en verde (ONBOARDING §8.0b, punto 30).
 */
type Clase = { name: string };

describe('[LE.4] FinanceCajaGeneralModule: el libro de efectivo', () => {
  const controllers = (Reflect.getMetadata('controllers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', FinanceCajaGeneralModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);

  it('el módulo registra el controlador y el servicio del libro', () => {
    expect(por(controllers, 'CashbookController'), 'el módulo no declara CashbookController').toBeDefined();
    expect(por(providers, 'CashbookService'), 'falta registrar CashbookService').toBeDefined();
  });

  it('CashbookController recibe CashbookService por su clase', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(controllers, 'CashbookController')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos).toEqual([CashbookService]);
  });

  it('CashbookService recibe el acceso a la base y el tenant por su clase', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', CashbookService) as Clase[] | undefined;
    expect(tipos).toEqual([TenantKnexService, TenantContextService]);
  });

  it('[LE.4.4] el carril de la máquina está registrado y recibe tenant y base por su clase (la knex por token)', () => {
    expect(por(providers, 'CashbookCaosCarril'), 'falta registrar CashbookCaosCarril').toBeDefined();
    const tipos = Reflect.getMetadata('design:paramtypes', CashbookCaosCarril) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 3, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos?.slice(1)).toEqual([TenantContextService, TenantKnexService]);
  });
});
