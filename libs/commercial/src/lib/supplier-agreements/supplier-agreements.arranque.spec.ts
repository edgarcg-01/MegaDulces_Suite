import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@megadulces/platform-core';
import { AcuerdosError } from './supplier-agreements.domain';
import { SupplierAgreementsController } from './supplier-agreements.controller';
import { SupplierAgreementsModule } from './supplier-agreements.module';
import { SupplierAgreementsService, traducir } from './supplier-agreements.service';

/**
 * `[PQ.3.10]` C2 — que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el grafo se
 * lee de los decoradores y cada ruta se verifica por su metadata (método, camino y llave). El `design:paramtypes` real
 * lo lee `database/tests/test-newdb-pq3-10-acuerdos-api.js` (ts-node con `emitDecoratorMetadata`).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const clavesDe = (h: object): unknown[] => Reflect.getMetadataKeys(h).flatMap((k) => [Reflect.getMetadata(k, h)].flat());

describe('[PQ.3.10] el módulo de Acuerdos arranca', () => {
  it('servicio con 2 dependencias (TenantKnex, TenantContext) y controlador con 1', () => {
    expect(SupplierAgreementsService.length).toBe(2);
    expect(SupplierAgreementsController.length).toBe(1);
  });

  it('controlador y servicio registrados en su módulo', () => {
    expect(meta('controllers', SupplierAgreementsModule)).toContain(SupplierAgreementsController);
    expect(meta('providers', SupplierAgreementsModule)).toContain(SupplierAgreementsService);
  });

  it('todo cuelga de compras/proveedores/acuerdos', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SupplierAgreementsController)).toBe('compras/proveedores/acuerdos');
  });
});

describe('[PQ.3.10] cada ruta con su método, su camino y su llave (DC44: las de Citas, sin llaves nuevas)', () => {
  const P = SupplierAgreementsController.prototype as unknown as Record<string, object>;
  const LEER: [string, RequestMethod, string][] = [
    ['lista', RequestMethod.GET, '/'],
    ['deReunion', RequestMethod.GET, 'reunion/:meetingId'],
  ];
  const AGENDAR: [string, RequestMethod, string][] = [
    ['capturar', RequestMethod.POST, 'reunion/:meetingId'],
    ['editar', RequestMethod.POST, ':id/editar'],
    ['iniciar', RequestMethod.POST, ':id/iniciar'],
    ['cumplir', RequestMethod.POST, ':id/cumplir'],
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

  it('las siete rutas, ni una más (una ruta nueva entra a esta lista con su llave)', () => {
    const conRuta = Object.getOwnPropertyNames(SupplierAgreementsController.prototype)
      .filter((k) => k !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, P[k]) !== undefined);
    expect(conRuta.sort()).toEqual([...LEER, ...AGENDAR].map(([h]) => h).sort());
  });

  it('PRUEBA NEGATIVA: un método sin decorador no lleva ninguna llave de Citas', () => {
    class Desnudo { capturar(): void { /* nada */ } }
    const v = clavesDe(Desnudo.prototype.capturar);
    expect(v).not.toContain(Permission.COMPRAS_CITAS_AGENDAR);
    expect(v).not.toContain(Permission.COMPRAS_CITAS_VER);
  });
});

describe('[PQ.3.10] los errores llegan a la pantalla con su código y su mensaje', () => {
  const status = (e: unknown) => { try { traducir(e); } catch (x) { return (x as { getStatus?: () => number }).getStatus?.() ?? 'crudo'; } return 'nada'; };
  it('no encontrado → 404 · conflicto → 409 · inválido → 400; lo demás pasa tal cual', () => {
    expect(status(new AcuerdosError('no_encontrado', 'x'))).toBe(404);
    expect(status(new AcuerdosError('conflicto', 'x'))).toBe(409);
    expect(status(new AcuerdosError('invalido', 'x'))).toBe(400);
    expect(status(new Error('base caída'))).toBe('crudo');
  });

  it('sin usuario en la sesión, 400 y no llega al servicio (no se adivina quién escribe)', () => {
    const service = { capturar: vi.fn(), editar: vi.fn(), iniciar: vi.fn(), cumplir: vi.fn(), cancelar: vi.fn() };
    const c = new SupplierAgreementsController(service as never);
    const id = '11111111-1111-4111-8111-111111111111';
    for (const f of [() => c.capturar(id, {} as never, {}), () => c.editar(id, {} as never, { user: {} }), () => c.iniciar(id, {}),
      () => c.cumplir(id, { note: 'x' }, {}), () => c.cancelar(id, { note: 'x' }, { user: { sub: '' } })]) {
      expect(f).toThrow(/No sabemos quién eres/);
    }
    for (const m of Object.values(service)) expect(m).not.toHaveBeenCalled();
  });

  it('con usuario, el servicio recibe quién escribe y la nota', async () => {
    const service = { cumplir: vi.fn(async () => ({ id: 'x' })) };
    const c = new SupplierAgreementsController(service as never);
    await c.cumplir('11111111-1111-4111-8111-111111111111', { note: 'Llegó la lista' }, { user: { sub: 'u-1', username: 'ana' } });
    expect(service.cumplir).toHaveBeenCalledWith({ userId: 'u-1', username: 'ana' }, '11111111-1111-4111-8111-111111111111', { note: 'Llegó la lista' });
  });
});
