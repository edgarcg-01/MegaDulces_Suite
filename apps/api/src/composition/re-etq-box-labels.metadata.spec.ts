import 'reflect-metadata';
import { CommercialReceivingModule } from '@megadulces/commercial';
import { Permission } from '@megadulces/platform-core';

/**
 * ⛔ `[RE.ETQ.2.1–2.3]` Regla 30 del protocolo de PR: controlador y servicio NUEVOS dentro de un módulo que ya
 * existía. Se prueba por `design:paramtypes` —lo que Nest lee al arrancar—, no por un regex sobre el texto (#414
 * tiró la API con el CI en verde). Vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string };
const PERMISSIONS_KEY = 'permissions';

describe('[RE.ETQ] CommercialReceivingModule arranca con las etiquetas de caja', () => {
  const controllers = (Reflect.getMetadata('controllers', CommercialReceivingModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', CommercialReceivingModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);
  const ctrl = () => por(controllers, 'BoxLabelsController') as unknown as { prototype: Record<string, unknown> };

  it('registra su controlador y su servicio, sin perder los que ya estaban', () => {
    expect(por(controllers, 'BoxLabelsController'), 'falta el controlador').toBeDefined();
    expect(por(providers, 'BoxLabelsService'), 'falta el servicio').toBeDefined();
    for (const c of ['ReceivingAuditorController', 'ReceivingSessionController', 'ReceivingClaimsController']) {
      expect(por(controllers, c), `se perdió ${c}`).toBeDefined();
    }
  });

  it('el controlador recibe el servicio por su CLASE', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl()) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos![0]).toBe(por(providers, 'BoxLabelsService'));
  });

  it('el servicio pide TenantKnexService, TenantContextService y ScopeService por clase (módulos @Global)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(providers, 'BoxLabelsService')!) as Clase[] | undefined;
    expect(tipos?.map((t) => t?.name)).toEqual(['TenantKnexService', 'TenantContextService', 'ScopeService']);
  });

  it('las tres rutas piden la misma clave: la pantalla existe para imprimir', () => {
    const llave = (m: string) => Reflect.getMetadata(PERMISSIONS_KEY, ctrl().prototype[m] as object) as string[] | undefined;
    expect(llave('orders')).toEqual([Permission.ALMACEN_ETIQUETAS_CAJA]);
    expect(llave('catalogDefects')).toEqual([Permission.ALMACEN_ETIQUETAS_CAJA]);
    expect(llave('print')).toEqual([Permission.ALMACEN_ETIQUETAS_CAJA]);
  });
});
