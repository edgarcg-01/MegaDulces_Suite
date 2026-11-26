import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@megadulces/platform-core';
import { CitasError } from './supplier-meetings.domain';
import { SupplierMeetingsController } from './supplier-meetings.controller';
import { SupplierMeetingsModule } from './supplier-meetings.module';
import { SupplierMeetingsService, traducir } from './supplier-meetings.service';

/**
 * `[PQ.3.8]` C2 — que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el grafo se
 * lee de los decoradores y cada ruta se verifica por su metadata (método, camino y llave). El `design:paramtypes` real
 * lo lee `database/tests/test-newdb-pq3-8-citas-api.js` (ts-node con `emitDecoratorMetadata`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const clavesDe = (h: object): unknown[] => Reflect.getMetadataKeys(h).flatMap((k) => [Reflect.getMetadata(k, h)].flat());

describe('[PQ.3.8] el módulo de Citas arranca', () => {
  it('servicio con 2 dependencias (TenantKnex, TenantContext) y controlador con 1', () => {
    expect(SupplierMeetingsService.length).toBe(2);
    expect(SupplierMeetingsController.length).toBe(1);
  });

  it('controlador y servicio registrados en su módulo', () => {
    expect(meta('controllers', SupplierMeetingsModule)).toContain(SupplierMeetingsController);
    expect(meta('providers', SupplierMeetingsModule)).toContain(SupplierMeetingsService);
  });

  it('todo cuelga de compras/proveedores/citas', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SupplierMeetingsController)).toBe('compras/proveedores/citas');
  });
});

describe('[PQ.3.8] cada ruta con su método, su camino y su llave (DC41)', () => {
  const P = SupplierMeetingsController.prototype as unknown as Record<string, object>;
  const LEER: [string, RequestMethod, string][] = [
    ['agenda', RequestMethod.GET, '/'],
    ['detalle', RequestMethod.GET, ':id'],
  ];
  const AGENDAR: [string, RequestMethod, string][] = [
    ['opciones', RequestMethod.GET, 'opciones'],
    ['proveedores', RequestMethod.GET, 'proveedores'],
    ['agendar', RequestMethod.POST, '/'],
    ['editar', RequestMethod.POST, ':id/editar'],
    ['confirmar', RequestMethod.POST, ':id/confirmar'],
    ['minuta', RequestMethod.POST, ':id/minuta'],
    ['cancelar', RequestMethod.POST, ':id/cancelar'],
  ];

  it.each(LEER)('%s: %s %s, con ver o agendar', (h, metodo, camino) => {
    expect(Reflect.getMetadata(METHOD_METADATA, P[h])).toBe(metodo);
    expect(Reflect.getMetadata(PATH_METADATA, P[h])).toBe(camino);
    const v = clavesDe(P[h]);
    expect(v).toContain(Permission.COMPRAS_CITAS_VER);
    expect(v).toContain(Permission.COMPRAS_CITAS_AGENDAR);
  });

  it.each(AGENDAR)('%s: %s %s, SÓLO con agendar (Dirección consulta y no escribe)', (h, metodo, camino) => {
    expect(Reflect.getMetadata(METHOD_METADATA, P[h])).toBe(metodo);
    expect(Reflect.getMetadata(PATH_METADATA, P[h])).toBe(camino);
    const v = clavesDe(P[h]);
    expect(v).toContain(Permission.COMPRAS_CITAS_AGENDAR);
    expect(v).not.toContain(Permission.COMPRAS_CITAS_VER);
  });

  it('las nueve rutas, ni una más (una ruta nueva entra a esta lista con su llave)', () => {
    const conRuta = Object.getOwnPropertyNames(SupplierMeetingsController.prototype)
      .filter((k) => k !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, P[k]) !== undefined);
    expect(conRuta.sort()).toEqual([...LEER, ...AGENDAR].map(([h]) => h).sort());
  });

  it('PRUEBA NEGATIVA: un método sin decorador no lleva ninguna llave de Citas', () => {
    class Desnudo { agendar(): void { /* nada */ } }
    const v = clavesDe(Desnudo.prototype.agendar);
    expect(v).not.toContain(Permission.COMPRAS_CITAS_AGENDAR);
    expect(v).not.toContain(Permission.COMPRAS_CITAS_VER);
  });

  it('las llaves existen en el enum (una llave mal escrita pasaría la prueba contra undefined)', () => {
    expect(Permission.COMPRAS_CITAS_VER).toBe('COMPRAS_CITAS_VER');
    expect(Permission.COMPRAS_CITAS_AGENDAR).toBe('COMPRAS_CITAS_AGENDAR');
  });
});

describe('[PQ.3.8] los errores llegan a la pantalla con su código y su mensaje', () => {
  const status = (e: unknown) => { try { traducir(e); } catch (x) { return (x as { getStatus?: () => number }).getStatus?.() ?? 'crudo'; } return 'nada'; };
  it('no encontrada → 404 · conflicto → 409 · inválida → 400; lo demás pasa tal cual', () => {
    expect(status(new CitasError('no_encontrada', 'x'))).toBe(404);
    expect(status(new CitasError('conflicto', 'x'))).toBe(409);
    expect(status(new CitasError('invalida', 'x'))).toBe(400);
    expect(status(new Error('base caída'))).toBe('crudo');
  });

  it('sin usuario en la sesión, 400 y no llega al servicio (no se adivina quién escribe)', () => {
    const service = { agendar: vi.fn(), editar: vi.fn(), confirmar: vi.fn(), minuta: vi.fn(), cancelar: vi.fn() };
    const c = new SupplierMeetingsController(service as never);
    const id = '11111111-1111-4111-8111-111111111111';
    for (const f of [() => c.agendar({} as never, {}), () => c.editar(id, {} as never, { user: {} }), () => c.confirmar(id, {}),
      () => c.minuta(id, { minutes: 'x' }, {}), () => c.cancelar(id, { reason: 'x' }, { user: { sub: '' } })]) {
      expect(f).toThrow(/No sabemos quién eres/);
    }
    for (const m of Object.values(service)) expect(m).not.toHaveBeenCalled();
  });

  it('con usuario, el servicio recibe quién escribe', async () => {
    const service = { confirmar: vi.fn(async () => ({ id: 'x' })) };
    const c = new SupplierMeetingsController(service as never);
    await c.confirmar('11111111-1111-4111-8111-111111111111', { user: { sub: 'u-1', username: 'ana' } });
    expect(service.confirmar).toHaveBeenCalledWith({ userId: 'u-1', username: 'ana' }, '11111111-1111-4111-8111-111111111111');
  });
});
