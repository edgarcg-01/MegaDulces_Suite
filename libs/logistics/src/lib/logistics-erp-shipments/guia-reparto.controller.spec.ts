import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { GuiaRepartoController, quienPide } from './guia-reparto.controller';
import { LogisticsErpShipmentsModule } from './logistics-erp-shipments.module';

/**
 * `[EMB.56]` La guía de reparto: quién entra y qué alcanza. El chofer sólo tiene esta clave, así
 * que si el permiso, el recorte por sucursal o el filtro por chofer fallan, ve viajes ajenos.
 *
 * ⛔ No se lee `design:paramtypes`: vitest transpila sin `emitDecoratorMetadata` (ver
 * `commercial-route-profit.controller.spec.ts`). El arranque se verificó aparte con
 * `ts.transpileModule` y metadata encendida.
 */

const meta = (fn: (...a: any[]) => any) => ({
  ruta: Reflect.getMetadata(PATH_METADATA, fn),
  verbo: Reflect.getMetadata(METHOD_METADATA, fn),
  permisos: Reflect.getMetadata(PERMISSIONS_KEY, fn),
});

const CHOFER = { user: { sub: 'u-chofer', role_name: 'chofer', permissions: { [Permission.LOGISTICS_GUIA_REPARTO_VER]: true } } };
const COORDINA = { user: { sub: 'u-coord', role_name: 'coordinador_embarques', permissions: { [Permission.LOGISTICS_SHIPMENTS_VER]: true, [Permission.LOGISTICS_GUIA_REPARTO_VER]: true } } };

const armar = (alcance: string[] | null) => {
  const service: any = {
    viajesGuiaReparto: vi.fn().mockResolvedValue({ fecha: 'x', rows: [] }),
    guiaReparto: vi.fn().mockResolvedValue({ ok: true }),
  };
  const scope: any = { readParam: vi.fn().mockResolvedValue(alcance) };
  return { c: new GuiaRepartoController(service, scope), service, scope };
};

describe('[EMB.56] GuiaRepartoController · rutas y permiso', () => {
  it('vive en logistics/guia-reparto, registrado en el módulo', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GuiaRepartoController)).toBe('logistics/guia-reparto');
    expect(Reflect.getMetadata('controllers', LogisticsErpShipmentsModule)).toContain(GuiaRepartoController);
    expect(GuiaRepartoController.length).toBe(2);
  });

  it('buscar por número: GET con la misma clave, y pasa alcance y chofer igual que la lista', async () => {
    expect(meta(GuiaRepartoController.prototype.buscar)).toEqual({
      ruta: 'buscar', verbo: RequestMethod.GET, permisos: [Permission.LOGISTICS_GUIA_REPARTO_VER],
    });
    const service: any = { buscarGuiaReparto: vi.fn().mockResolvedValue({ guia: null, rows: [] }) };
    const c = new GuiaRepartoController(service, { readParam: vi.fn().mockResolvedValue(['01']) } as any);
    await c.buscar({ guia: '969' }, CHOFER);
    expect(service.buscarGuiaReparto).toHaveBeenCalledWith('969', ['01'], { todos: false, user_id: 'u-chofer' });
  });

  it('los dos GET piden SÓLO la clave del chofer', () => {
    expect(meta(GuiaRepartoController.prototype.viajes)).toEqual({
      ruta: 'viajes', verbo: RequestMethod.GET, permisos: [Permission.LOGISTICS_GUIA_REPARTO_VER],
    });
    expect(meta(GuiaRepartoController.prototype.guia)).toEqual({
      ruta: ':sucursal/:guia', verbo: RequestMethod.GET, permisos: [Permission.LOGISTICS_GUIA_REPARTO_VER],
    });
  });
});

describe('[EMB.56] quienPide · cada chofer, sólo sus viajes', () => {
  it('el chofer (sólo la clave de la guía) se filtra por SU usuario', () => {
    expect(quienPide(CHOFER)).toEqual({ todos: false, user_id: 'u-chofer' });
  });

  it('quien ya ve embarques ve todos los de su alcance (para reimprimirle al chofer)', () => {
    expect(quienPide(COORDINA)).toEqual({ todos: true });
  });

  it('⛔ sin sesión no se abre todo: se filtra por un usuario que no existe', () => {
    expect(quienPide(undefined)).toEqual({ todos: false, user_id: null });
  });

  it('una clave presente pero en false NO cuenta como «ve embarques»', () => {
    const u = { user: { sub: 'u', role_name: 'chofer', permissions: { [Permission.LOGISTICS_SHIPMENTS_VER]: false } } };
    expect(quienPide(u)).toEqual({ todos: false, user_id: 'u' });
  });
});

describe('[EMB.56] GuiaRepartoController · alcance de sucursal', () => {
  it('la lista pasa al servicio la sucursal recortada, la fecha y QUIÉN pide', async () => {
    const { c, service } = armar(['01']);
    await c.viajes({ fecha: '2026-07-23' }, CHOFER);
    expect(service.viajesGuiaReparto).toHaveBeenCalledWith('2026-07-23', ['01'], { todos: false, user_id: 'u-chofer' });
  });

  it('una fecha mal escrita cae en hoy, no en un error ni en «todas»', async () => {
    const { c, service } = armar(null);
    await c.viajes({ fecha: '23/07/2026' }, COORDINA);
    expect(service.viajesGuiaReparto.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('su sucursal: entrega la guía, con quién la pide', async () => {
    const { c, service } = armar(['01']);
    await expect(c.guia('01', '0000969', CHOFER)).resolves.toEqual({ ok: true });
    expect(service.guiaReparto).toHaveBeenCalledWith('01', '0000969', { todos: false, user_id: 'u-chofer' });
  });

  it('⛔ otra sucursal: 404, y el servicio ni se consulta', async () => {
    const { c, service } = armar([]);
    await expect(c.guia('06', '0001419', CHOFER)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.guiaReparto).not.toHaveBeenCalled();
  });

  it('alcance «todas» (null) no recorta', async () => {
    const { c, service } = armar(null);
    await c.guia('06', '0001419', COORDINA);
    expect(service.guiaReparto).toHaveBeenCalledWith('06', '0001419', { todos: true });
  });
});
