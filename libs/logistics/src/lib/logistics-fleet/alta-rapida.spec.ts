import 'reflect-metadata';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission } from '@megadulces/platform-core';
import { LogisticsFleetController } from './logistics-fleet.controller';
import { LogisticsFleetService } from './logistics-fleet.service';

/**
 * `[EMB.32]` Alta rápida de ayudante o cargador desde la guía. Lo que se prueba: que crea sólo
 * cuando no existe, que reutiliza o reactiva sin duplicar, y quién puede llamarla (el repartidor
 * completa guías pero no tiene el permiso de flota). Base de mentira; nombres inventados.
 */

function baseFalsa(padron: any[]) {
  const inserts: any[] = [];
  const updates: Array<{ where: any; patch: any }> = [];
  const trx: any = (tabla: string) => {
    let filtro: any = null;
    const b: any = {
      select: () => Promise.resolve(padron),
      where: (w: any) => { filtro = w; return b; },
      first: async () => padron.find((x) => x.id === filtro?.id),
      update: (patch: any) => {
        updates.push({ where: filtro, patch });
        const actual = padron.find((x) => x.id === filtro?.id);
        return { returning: async () => [{ ...actual, ...patch }] };
      },
      insert: (fila: any) => {
        inserts.push({ tabla, fila });
        return { returning: async () => [{ id: 'nuevo', ...fila }] };
      },
    };
    return b;
  };
  trx.fn = { now: () => 'NOW()' };
  trx.raw = (sql: string) => ({ sql });
  const tk: any = { run: async (fn: (t: any) => any) => fn(trx) };
  return { svc: new LogisticsFleetService(tk), inserts, updates };
}

const persona = (o: any) => ({ id: 'p1', full_name: 'JUAN PRUEBA', roles: ['chofer'], active: true, status: 'activo', deleted_at: null, updated_at: null, ...o });

describe('LogisticsFleetService.altaRapida', () => {
  it('sin nadie con ese nombre: crea en mayúsculas, con el papel pedido y activa', async () => {
    const { svc, inserts, updates } = baseFalsa([persona({ full_name: 'OTRA PERSONA' })]);
    const r = await svc.altaRapida({ full_name: '  juan   prueba ', rol: 'ayudante' });
    expect(r.accion).toBe('creada');
    expect(updates).toHaveLength(0);
    expect(inserts[0].fila).toMatchObject({ full_name: 'JUAN PRUEBA', roles: ['ayudante'], status: 'activo', active: true, employee_type: 'interno' });
  });

  it('PRUEBA NEGATIVA: con el mismo nombre activo y el mismo papel NO crea otro', async () => {
    const { svc, inserts, updates } = baseFalsa([persona({ roles: ['ayudante'] })]);
    const r = await svc.altaRapida({ full_name: 'Juan Prueba', rol: 'ayudante' });
    expect(r.accion).toBe('ya_existia');
    expect(r.driver.id).toBe('p1');
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('un chofer que también es ayudante: se le agrega el papel, sin duplicar', async () => {
    const { svc, inserts, updates } = baseFalsa([persona({ roles: ['chofer'] })]);
    const r = await svc.altaRapida({ full_name: 'JUAN PRUEBA', rol: 'ayudante' });
    expect(r.accion).toBe('papel_agregado');
    expect(inserts).toHaveLength(0);
    expect(updates[0].patch.roles).toEqual(['chofer', 'ayudante']);
  });

  it('dado de baja: se reactiva (deleted_at a null, activo) con el papel', async () => {
    const { svc, inserts, updates } = baseFalsa([persona({ roles: ['chofer', 'ayudante'], active: false, status: 'inactivo', deleted_at: '2026-06-02' })]);
    const r = await svc.altaRapida({ full_name: 'Juan Prueba', rol: 'cargador' });
    expect(r.accion).toBe('reactivada');
    expect(inserts).toHaveLength(0);
    expect(updates[0].patch).toMatchObject({ active: true, status: 'activo', deleted_at: null, roles: ['chofer', 'ayudante', 'cargador'] });
  });

  it('nombre incompleto o papel inválido: 400 y no escribe', async () => {
    const { svc, inserts, updates } = baseFalsa([]);
    await expect(svc.altaRapida({ full_name: 'Juan', rol: 'ayudante' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.altaRapida({ full_name: 'Juan Prueba', rol: 'chofer' as never })).rejects.toBeInstanceOf(BadRequestException);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

describe('POST logistics/fleet/drivers/alta-rapida', () => {
  it('la abre quien gestiona flota, quien completa guías o quien registra cargadores', () => {
    const fn = LogisticsFleetController.prototype.altaRapida;
    expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe('drivers/alta-rapida');
    expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn)).toEqual([
      Permission.LOGISTICS_FLEET_GESTIONAR, Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR,
    ]);
  });
});
