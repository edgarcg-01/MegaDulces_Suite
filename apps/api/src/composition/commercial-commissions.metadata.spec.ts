import 'reflect-metadata';
import { CommercialCommissionsModule } from '@megadulces/commercial';
import { Permission } from '@megadulces/platform-core';

/**
 * ⛔ `[RD.100]` Regla 30 del protocolo de PR: se agregó `CommissionBeneficiariosService` al
 * constructor del controlador de comisiones y dos rutas nuevas (`/supervisors`). Se prueba por
 * `design:paramtypes` —lo que Nest lee al arrancar—, no por un regex sobre el texto (#414 tiró la
 * API con el CI en verde). Vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string };

describe('[RD.100] CommercialCommissionsModule: la nómina del supervisor arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', CommercialCommissionsModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', CommercialCommissionsModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);
  const exportados = ((Reflect.getMetadata('imports', CommercialCommissionsModule) ?? []) as object[])
    .flatMap((m) => (Reflect.getMetadata('exports', m) ?? []) as Clase[]);

  it('el módulo registra el servicio de la nómina del supervisor', () => {
    expect(por(controllers, 'CommercialCommissionsController'), 'falta el controlador').toBeDefined();
    expect(por(providers, 'CommissionBeneficiariosService'), 'falta registrar CommissionBeneficiariosService').toBeDefined();
  });

  it('el controlador recibe cada servicio por su CLASE, el nuevo incluido', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(controllers, 'CommercialCommissionsController')!) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length > 0, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos!.every((t) => typeof t === 'function' && t !== Object), `paramtypes: ${tipos!.map((t) => t?.name).join(', ')}`).toBe(true);
    expect(tipos).toContain(por(providers, 'CommissionBeneficiariosService'));
    // Todo lo que el constructor pide está registrado en el módulo o lo exporta un módulo que
    // éste importa: si no, Nest no arranca.
    for (const t of tipos!) expect(por(providers, t.name) ?? por(exportados, t.name), `${t.name} no está en providers ni lo exporta un import`).toBeDefined();
  });

  it('[DP.3.2] las definiciones llegan por el módulo que las exporta, con la llave de comisiones', () => {
    const ctrl = por(controllers, 'CommercialCommissionsController')!;
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl) as Clase[];
    expect(tipos.map((t) => t?.name)).toContain('BusinessDefinitionsService');
    expect(por(exportados, 'BusinessDefinitionsService'), 'falta importar BusinessDefinitionsModule').toBeDefined();
    const metodo = (ctrl as unknown as { prototype: Record<string, unknown> }).prototype['definiciones'];
    expect(typeof metodo, 'falta GET /definitions').toBe('function');
    expect(Reflect.getMetadata('permissions', metodo as object)).toEqual([Permission.COMMERCIAL_COMMISSIONS_VER]);
  });

  it('el body de POST /supervisors es un tipo, no un valor: Swagger lee Object', () => {
    const ctrl = por(controllers, 'CommercialCommissionsController') as unknown as { prototype: object };
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl.prototype, 'fijarNominaSupervisor') as unknown[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin metadata del método esta prueba no mide nada').toBe(true);
    expect(tipos![0]).toBe(Object);
  });
});
