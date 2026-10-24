import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { LogisticsGuidesController } from '../logistics-guides/logistics-guides.controller';
import { LogisticsConfigController } from '../logistics-config/logistics-config.controller';

/**
 * `[EMB.43]` Logística › Pagos de viaje es autosuficiente: todo endpoint que usa la pantalla acepta
 * el permiso propio del módulo. Leer con `LOGISTICS_PAGOS_VER`; escribir con `_GESTIONAR`.
 * ⛔ Y al revés: las tarifas se LEEN desde el módulo, pero se cambian sólo con configurar o
 * autorizar (EMB.28.1). Un permiso del módulo nunca abre una escritura de tarifas.
 */
type Fn = (...a: unknown[]) => unknown;
const alguno = (fn: Fn): Permission[] => Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn) ?? [];
const todos = (fn: Fn): Permission[] => Reflect.getMetadata(PERMISSIONS_KEY, fn) ?? [];
const proto = LogisticsConfigController.prototype as unknown as Record<string, Fn>;

describe('[EMB.43] permisos que usa Pagos de viaje', () => {
  it('completar la guía (tripulación y horario) acepta GESTIONAR del módulo, no VER', () => {
    const fn = LogisticsGuidesController.prototype.complete as unknown as Fn;
    expect(alguno(fn)).toEqual([Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR]);
  });

  it('leer tarifas, rutas y su historial acepta VER del módulo', () => {
    for (const n of ['list', 'findOne', 'historialConfig', 'listRoutes', 'historialRuta']) {
      expect(Reflect.getMetadata(METHOD_METADATA, proto[n])).toBe(RequestMethod.GET);
      expect(alguno(proto[n])).toContain(Permission.LOGISTICS_PAGOS_VER);
    }
  });

  it('PRUEBA NEGATIVA: ninguna escritura de tarifas se abre al módulo', () => {
    const escrituras = Object.getOwnPropertyNames(proto).filter((n) => {
      if (n === 'constructor' || typeof proto[n] !== 'function') return false;
      const verbo = Reflect.getMetadata(METHOD_METADATA, proto[n]);
      return verbo !== undefined && verbo !== RequestMethod.GET;
    });
    expect(escrituras.sort()).toEqual(['create', 'createRoute', 'deleteRoute', 'remove', 'update', 'updateRoute']);
    for (const n of escrituras) {
      const p = [...alguno(proto[n]), ...todos(proto[n])];
      expect(p).not.toContain(Permission.LOGISTICS_PAGOS_VER);
      expect(p).not.toContain(Permission.LOGISTICS_PAGOS_GESTIONAR);
    }
  });
});
