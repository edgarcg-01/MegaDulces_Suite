import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { CostoUnidadController, veSalarios } from './costo-unidad.controller';

/**
 * `[FCU.3.9]` Costo por unidad tiene permiso PROPIO: leer con `LOGISTICS_COSTO_UNIDAD_VER`, escribir
 * con `_GESTIONAR`. La nómina administrativa y los salarios son dato sensible: sólo GESTIONAR.
 */
type Fn = (...a: unknown[]) => unknown;
const proto = CostoUnidadController.prototype as unknown as Record<string, Fn>;
const permisos = (n: string): Permission[] => [
  ...(Reflect.getMetadata(PERMISSIONS_KEY, proto[n]) ?? []), ...(Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[n]) ?? []),
];
const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);

describe('[FCU.3.9] permisos de Costo por unidad', () => {
  it('todo handler declara un permiso del módulo, y sólo del módulo', () => {
    expect(handlers.length).toBe(11);
    for (const n of handlers) {
      const p = permisos(n);
      expect(p.length).toBe(1);
      expect([Permission.LOGISTICS_COSTO_UNIDAD_VER, Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR]).toContain(p[0]);
    }
  });

  it('PRUEBA NEGATIVA: ninguna escritura se abre con VER', () => {
    for (const n of handlers.filter((x) => Reflect.getMetadata(METHOD_METADATA, proto[x]) !== RequestMethod.GET)) {
      expect(permisos(n)).toEqual([Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR]);
    }
  });

  it('PRUEBA NEGATIVA: la nómina administrativa no se lee con VER', () => {
    expect(permisos('nomina')).toEqual([Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR]);
  });

  it('los salarios se ven con GESTIONAR o siendo administrador de plataforma; con VER, no', () => {
    expect(veSalarios({ user: { permissions: { [Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR]: true } } })).toBe(true);
    expect(veSalarios({ user: { role_name: 'superadmin', permissions: {} } })).toBe(true);
    expect(veSalarios({ user: { permissions: { [Permission.LOGISTICS_COSTO_UNIDAD_VER]: true } } })).toBe(false);
    expect(veSalarios(undefined)).toBe(false);
  });
});
