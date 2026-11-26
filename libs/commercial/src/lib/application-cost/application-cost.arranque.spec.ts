import 'reflect-metadata';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission } from '@megadulces/platform-core';
import type { GuardarDecisionCostoDto } from '@megadulces/contracts/http/application-cost';
import { ApplicationCostController } from './application-cost.controller';
import { ApplicationCostModule } from './application-cost.module';
import { ApplicationCostService, traducir } from './application-cost.service';
import { CostoAplicadoError } from './application-cost.repo';

/**
 * `[PQ.157]` C2 — que compile no es que arranque (`#414`): vitest no emite `design:paramtypes`, así que el grafo se
 * lee de los decoradores y cada ruta se verifica por su metadata (método, camino y permiso).
 */
const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
const clavesDe = (h: object): unknown[] => Reflect.getMetadataKeys(h).flatMap((k) => [Reflect.getMetadata(k, h)].flat());

describe('[PQ.157] el módulo de la decisión de costo arranca', () => {
  it('servicio con 3 dependencias (TenantKnex, TenantContext, Scope) y controlador con 1', () => {
    expect(ApplicationCostService.length).toBe(3);
    expect(ApplicationCostController.length).toBe(1);
  });

  it('controlador y servicio registrados en su módulo', () => {
    expect(meta('controllers', ApplicationCostModule)).toContain(ApplicationCostController);
    expect(meta('providers', ApplicationCostModule)).toContain(ApplicationCostService);
  });

  it('todo cuelga de compras/costo-aplicado', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ApplicationCostController)).toBe('compras/costo-aplicado');
  });

  const P = ApplicationCostController.prototype;
  it('leer: GET aplicaciones/:sucursal/:folio, con ver entradas o decidir', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, P.aplicacion)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, P.aplicacion)).toBe('aplicaciones/:sucursal/:folio');
    const v = clavesDe(P.aplicacion);
    expect(v).toContain(Permission.COMPRAS_ENTRADAS_VER);
    expect(v).toContain(Permission.COMPRAS_COSTO_DECIDIR);
  });

  it('decidir: POST decisiones, SÓLO con COMPRAS_COSTO_DECIDIR (validar entradas no basta: la tienen tiendas, Finanzas y Tesorería)', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, P.decidir)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, P.decidir)).toBe('decisiones');
    const v = clavesDe(P.decidir);
    expect(v).toContain(Permission.COMPRAS_COSTO_DECIDIR);
    expect(v).not.toContain(Permission.COMPRAS_ENTRADAS_VALIDAR);
    expect(v).not.toContain(Permission.COMPRAS_ENTRADAS_VER);
  });

  it('PRUEBA NEGATIVA: un método sin decorador no lleva la clave de decidir', () => {
    class Desnudo { decidir(): void { /* nada */ } }
    expect(clavesDe(Desnudo.prototype.decidir)).not.toContain(Permission.COMPRAS_COSTO_DECIDIR);
  });
});

describe('[PQ.157] los errores llegan a la pantalla con su código y su mensaje', () => {
  const status = (e: unknown) => { try { traducir(e); } catch (x) { return (x as { getStatus?: () => number }).getStatus?.() ?? 'crudo'; } return 'nada'; };
  it('no encontrado → 404 · conflicto → 409 · inválida → 400; lo demás pasa tal cual', () => {
    expect(status(new CostoAplicadoError('no_encontrado', 'x'))).toBe(404);
    expect(status(new CostoAplicadoError('conflicto', 'x'))).toBe(409);
    expect(status(new CostoAplicadoError('invalida', 'x'))).toBe(400);
    expect(status(new Error('base caída'))).toBe('crudo');
  });
});

describe('[PQ.157] la llave y el alcance se revisan ANTES de tocar la base', () => {
  const dto = (o: Partial<GuardarDecisionCostoDto> = {}): GuardarDecisionCostoDto => ({
    sucursal: '03', subtipo: '1', folio: '0001139', renglon: 1, decision: 'accept', reason: 'El proveedor subió su lista', ...o,
  });
  const nuevo = (scope: object) => {
    const run = vi.fn(async () => 'ok');
    return { run, s: new ApplicationCostService({ run } as never, { requireTenantId: () => 't1' } as never, scope as never) };
  };
  const abierto = { assertCanRead: vi.fn(async () => undefined), assertCanWrite: vi.fn(async () => undefined) };

  it('una llave basura es 400 y no llega a la base (un ::numeric con basura sería un 500)', async () => {
    for (const malo of [dto({ subtipo: 'abc' }), dto({ renglon: 0 }), dto({ renglon: 1.5 }), dto({ folio: "1'; drop" }), dto({ sucursal: '' }), dto({ reason: 5 as never })]) {
      const { run, s } = nuevo(abierto);
      await expect(s.decidir({ userId: 'u', username: 'x' }, malo)).rejects.toMatchObject({ status: 400 });
      expect(run).not.toHaveBeenCalled();
    }
    const { run, s } = nuevo(abierto);
    await expect(s.aplicacion('03', '../x')).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
  });

  it('decidir pregunta si puede ESCRIBIR en la sucursal; leer, si puede VERLA', async () => {
    const sc = { assertCanRead: vi.fn(async () => undefined), assertCanWrite: vi.fn(async () => undefined) };
    const { s } = nuevo(sc);
    await s.decidir({ userId: 'u', username: 'x' }, dto());
    expect(sc.assertCanWrite).toHaveBeenCalledWith('warehouse', '03');
    await s.aplicacion(' 03 ', '0001139');
    expect(sc.assertCanRead).toHaveBeenCalledWith('warehouse', '03');
  });

  it('PRUEBA NEGATIVA: fuera de alcance no llega a la base', async () => {
    const fuera = { assertCanRead: async () => { throw new ForbiddenException('fuera'); }, assertCanWrite: async () => { throw new ForbiddenException('fuera'); } };
    const { run, s } = nuevo(fuera);
    await expect(s.decidir({ userId: 'u', username: 'x' }, dto())).rejects.toMatchObject({ status: 403 });
    await expect(s.aplicacion('03', '0001139')).rejects.toMatchObject({ status: 403 });
    expect(run).not.toHaveBeenCalled();
  });
});
