import 'reflect-metadata';
import { ForbiddenException, BadRequestException, RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Permission, PERMISSIONS_KEY, ANY_PERMISSIONS_KEY } from '@megadulces/platform-core';
import { FinanceCortesSucursalesModule } from './finance-cortes-sucursales.module';
import { CortesSucursalesController } from './cortes-sucursales.controller';
import { CortesSucursalesService } from './cortes-sucursales.service';

/**
 * `[CSU.30]` La ruta nueva de facturas entra sin mover lo que ya está en prod. Que compile no es que arranque (`#414`):
 * vitest no emite `design:paramtypes`, así que el grafo se lee del módulo y de la aridad, y cada ruta por su metadata
 * —la llave que lee `RolesGuard`—. Y el alcance por sucursal (CSU.6): pedir una sucursal ajena es 403.
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const proto = CortesSucursalesController.prototype as unknown as Record<string, object>;
const metodos = Object.getOwnPropertyNames(CortesSucursalesController.prototype).filter((m) => m !== 'constructor' && typeof proto[m] === 'function');
const llaves = (m: string): string[] => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]) ?? [];

describe('[CSU.30] Cortes / Sucursales arranca igual, con una ruta más', () => {
  it('el mismo grafo: controlador con 1 dependencia, servicio con 3 (sin dependencias nuevas)', () => {
    expect(CortesSucursalesController.length).toBe(1);
    expect(CortesSucursalesService.length).toBe(3);
    expect(meta('controllers', FinanceCortesSucursalesModule)).toContain(CortesSucursalesController);
    expect(meta('providers', FinanceCortesSucursalesModule)).toContain(CortesSucursalesService);
  });
  it('dos rutas GET: la lista y «facturas»', () => {
    expect(metodos.sort()).toEqual(['facturas', 'list']);
    expect(Reflect.getMetadata(PATH_METADATA, proto.facturas)).toBe('facturas');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.facturas)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.list)).toBe(RequestMethod.GET);
  });
  it('las dos piden FINANCE_CORTES_VER, y nada más', () => {
    for (const m of metodos) {
      expect(llaves(m)).toEqual([Permission.FINANCE_CORTES_VER]);
      expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m])).toBeUndefined();
    }
  });
  it('❌ sin la llave no se entra a ninguna (lo que hace RolesGuard: todas las llaves de la ruta)', () => {
    const entra = (m: string, tiene: string[]) => llaves(m).every((k) => tiene.includes(k));
    expect(metodos.filter((m) => entra(m, []))).toEqual([]);
    expect(metodos.filter((m) => entra(m, [Permission.FINANCE_CORTES_VER])).sort()).toEqual(['facturas', 'list']);
  });
});

describe('[CSU.30] el alcance por sucursal en las facturas (CSU.6)', () => {
  // Una tienda: alcance «own» = Morelia Abastos. El servicio decide ANTES de leer nada.
  const tienda = () => {
    const leer = vi.fn();
    const svc = new CortesSucursalesService(
      { run: leer } as never,
      { requireTenantId: () => 'T' } as never,
      { current: async () => ({}), intersect: () => new Set(['08']) } as never,
    );
    return { svc, leer };
  };
  it('❌ una tienda que pide otra sucursal → 403, sin tocar la base', async () => {
    const { svc, leer } = tienda();
    await expect(svc.facturas({ month: '2026-11', sucursal: '01' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(leer).not.toHaveBeenCalled();
  });
  it('una sucursal que no es un código de dos dígitos → 400', async () => {
    const { svc } = tienda();
    await expect(svc.facturas({ month: '2026-11', sucursal: "08' OR 1=1" })).rejects.toBeInstanceOf(BadRequestException);
  });
});
