import 'reflect-metadata';
import { BusinessDefinitionsModule, Permission } from '@megadulces/platform-core';

/**
 * ⛔ `[DP.2.1]` Regla 30 del protocolo de PR: módulo, controlador y servicio NUEVOS. Se prueba por
 * `design:paramtypes` —lo que Nest lee al arrancar—, no por un regex sobre el texto (#414 tiró la
 * API con el CI en verde). Vive en `apps/api` porque aquí se compila con `decoratorMetadata`.
 */
type Clase = { name: string };
const PERMISSIONS_KEY = 'permissions';

describe('[DP.2.1] BusinessDefinitionsModule arranca', () => {
  const controllers = (Reflect.getMetadata('controllers', BusinessDefinitionsModule) ?? []) as Clase[];
  const providers = (Reflect.getMetadata('providers', BusinessDefinitionsModule) ?? []) as Clase[];
  const por = (lista: Clase[], nombre: string) => lista.find((c) => c?.name === nombre);
  const ctrl = () => por(controllers, 'BusinessDefinitionsController') as unknown as { prototype: Record<string, unknown> };

  it('registra su controlador y su servicio', () => {
    expect(por(controllers, 'BusinessDefinitionsController'), 'falta el controlador').toBeDefined();
    expect(por(providers, 'BusinessDefinitionsService'), 'falta el servicio').toBeDefined();
  });

  it('el controlador recibe el servicio por su CLASE', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', ctrl()) as Clase[] | undefined;
    expect(Array.isArray(tipos) && tipos.length === 1, 'sin design:paramtypes esta prueba no mide nada').toBe(true);
    expect(tipos![0]).toBe(por(providers, 'BusinessDefinitionsService'));
  });

  it('el servicio pide TenantKnexService y TenantContextService por clase (los dan módulos @Global)', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', por(providers, 'BusinessDefinitionsService')!) as Clase[] | undefined;
    expect(tipos?.map((t) => t?.name)).toEqual(['TenantKnexService', 'TenantContextService']);
  });

  it('las llaves: VER lee, GESTIONAR reparte; contestar y la bandeja propia NO llevan llave', () => {
    const llave = (m: string) => Reflect.getMetadata(PERMISSIONS_KEY, ctrl().prototype[m] as object) as string[] | undefined;
    expect(llave('listar')).toEqual([Permission.DEFINICIONES_VER]);
    expect(llave('actualizar')).toEqual([Permission.DEFINICIONES_GESTIONAR]);
    // La contesta su DUEÑO: lo decide el servicio por `assigned_to`, no una clave del rol.
    expect(llave('contestar')).toBeUndefined();
    expect(llave('mias')).toBeUndefined();
  });
});
