import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { ErpShipmentsController } from './erp-shipments.controller';
import { LogisticsShipmentsController } from '../logistics-shipments/logistics-shipments.controller';

/**
 * EMB.12 — Los dos endpoints nuevos: LEER la hoja de un viaje y TOMARLO. Lo que se prueba es lo
 * que decide quién entra y a dónde: la ruta, el verbo, el permiso (ver no es lo mismo que crear)
 * y que el controlador pase sucursal y guía tal cual al servicio.
 */

const meta = (fn: (...a: any[]) => any) => ({
  ruta: Reflect.getMetadata(PATH_METADATA, fn),
  verbo: Reflect.getMetadata(METHOD_METADATA, fn),
  permisos: Reflect.getMetadata(PERMISSIONS_KEY, fn),
});

describe('GET logistics/erp-shipments/trips/:sucursal/:guia/nuevo-embarque', () => {
  it('es un GET bajo erp-shipments y pide sólo ver embarques', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ErpShipmentsController)).toBe('logistics/erp-shipments');
    expect(meta(ErpShipmentsController.prototype.nuevoEmbarque)).toEqual({
      ruta: 'trips/:sucursal/:guia/nuevo-embarque',
      verbo: RequestMethod.GET,
      permisos: [Permission.LOGISTICS_SHIPMENTS_VER],
    });
  });

  it('pasa sucursal y guía tal cual al servicio', async () => {
    const service: any = { nuevoEmbarque: vi.fn().mockResolvedValue({ ok: true }) };
    const c = new ErpShipmentsController(service, {} as any);
    await expect(c.nuevoEmbarque('06', '0001419')).resolves.toEqual({ ok: true });
    expect(service.nuevoEmbarque).toHaveBeenCalledWith('06', '0001419');
  });
});

describe('POST logistics/shipments/from-kepler/:sucursal/:guia', () => {
  it('es un POST y pide GESTIONAR (embarques o Pagos de viaje), no sólo ver', () => {
    expect(Reflect.getMetadata(PATH_METADATA, LogisticsShipmentsController)).toBe('logistics/shipments');
    const fn = LogisticsShipmentsController.prototype.createFromKepler;
    expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe('from-kepler/:sucursal/:guia');
    expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
    // [EMB.43] Logística › Pagos de viaje toma el viaje desde su bandeja con su permiso propio.
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn)).toEqual([
      Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR,
    ]);
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn)).not.toContain(Permission.LOGISTICS_PAGOS_VER);
  });

  it('pasa sucursal, guía y lo capturado al servicio', async () => {
    const service: any = { createFromKepler: vi.fn().mockResolvedValue({ destinatarios: 13 }) };
    const c = new LogisticsShipmentsController(service);
    const body = { delivery_type: 'route' as const, actual_km: 186 };
    await expect(c.createFromKepler('06', '0001419', body)).resolves.toEqual({ destinatarios: 13 });
    expect(service.createFromKepler).toHaveBeenCalledWith('06', '0001419', body);
  });
});
