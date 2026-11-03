import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { SucursalPendientesService } from './sucursal-pendientes.service';
import * as Q from './sucursal-pendientes.sql';

/**
 * `[AB.45]` La LÓGICA del servicio: qué colas viajan a quién, el alcance y lo no medido.
 * ⚠️ Con dobles: el SQL NO se ejerce aquí (un doble de knex no ejecuta SQL). El SQL se ejerció contra
 * prod, en sólo lectura y con la consulta envuelta del servicio: `database/scripts/ab45-pendientes-sucursal.js`.
 */
const WH = '8eb1a11d-5953-47e4-9d6c-a884c9baf0c5';

function armar(opts: { falla?: string } = {}) {
  const corridas: string[] = [];
  const trx = Object.assign(
    (_t: string) => ({ where: () => ({ first: async () => ({ code: '01', kepler_code: '01' }) }) }),
    {
      raw: async (sql: string) => {
        if (/SAVEPOINT|RELEASE/.test(sql)) return { rows: [] };
        corridas.push(sql);
        if (opts.falla && sql.includes(opts.falla)) throw new Error('boom');
        return { rows: [{ folio: 'F1', detalle: 'd', monto: '10.5', total: 3, dias: 4 }] };
      },
    },
  );
  const tk = { run: async <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const tenantCtx = { requireTenantId: () => 't1' };
  const motor = { almacenes: async () => [{ id: WH, code: '01', name: 'Padre Hidalgo' }] };
  const pedidos = {
    conLlaveDeSucursal: async (ws: Array<{ id: string; name: string }>) => ws.map((w) => ({ id: w.id, name: w.name, sucursal: '01' })),
    viene: async () => ({ almacen: { id: WH, code: '01', name: 'Padre Hidalgo' }, pedidos_medidos: true, ventana_en_camino_dias: 7,
      documentos: [{ tipo: 'embarque', origen: '00', serie: 2, folio: 'E1', estado: 'EMBARCADO', fecha: '2026-11-01', dias: 2, renglones: 3, monto: 5, se_resta: true }] }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new SucursalPendientesService(motor as any, pedidos as any, tk as any, tenantCtx as any);
  return { svc, corridas };
}

describe('[AB.45] SucursalPendientesService', () => {
  it('un almacén fuera del alcance se rechaza (no se confía en el query)', async () => {
    const { svc } = armar();
    await expect(svc.pendientes('otro-id', { permissions: {} })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sólo viajan las colas cuya llave tiene la persona', async () => {
    const { svc, corridas } = armar();
    const r = await svc.pendientes(WH, { permissions: { STORE_ARQUEO_CAPTURAR: true } });
    expect(r.colas.map((c) => c.id)).toEqual(['turnos-sin-arqueo']);
    expect(corridas).toHaveLength(1);
    expect(r.colas[0]).toMatchObject({ estado: 'ok', total: 3, mas_viejo_dias: 4 });
    expect(r.colas[0].filas[0]).toEqual({ folio: 'F1', detalle: 'd', dias: 4, monto: 10.5 });
  });

  it('cotizaciones exige las DOS llaves de su ruta; con una sola no viaja', async () => {
    const { svc } = armar();
    const una = await svc.pendientes(WH, { permissions: { COMMERCIAL_QUOTES_VER: true } });
    expect(una.colas.map((c) => c.id)).not.toContain('cotizaciones');
    const dos = await svc.pendientes(WH, { permissions: { COMMERCIAL_QUOTES_VER: true, COMMERCIAL_TELEVENTA_OPERATE: true } });
    expect(dos.colas.map((c) => c.id)).toContain('cotizaciones');
  });

  it('una consulta que falla se declara no_medido (total 0 que no suma), las demás siguen', async () => {
    const { svc } = armar({ falla: 'kdpv_folio_caja' });
    const r = await svc.pendientes(WH, { permissions: { STORE_ARQUEO_CAPTURAR: true, RECONCILIATION_VER: true } });
    const turnos = r.colas.find((c) => c.id === 'turnos-sin-arqueo')!;
    expect(turnos.estado).toBe('no_medido');
    expect(r.colas.find((c) => c.id === 'arqueos-por-validar')!.estado).toBe('ok');
  });

  it('con AUTOABASTO_VER llega «lo que te va a llegar», repartido', async () => {
    const { svc } = armar();
    const r = await svc.pendientes(WH, { permissions: { AUTOABASTO_VER: true } });
    expect(r.colas.find((c) => c.id === 'traspasos-sin-recibir')!.total).toBe(1);
  });

  it('el administrador de plataforma ve todas las colas', async () => {
    const { svc, corridas } = armar();
    const r = await svc.pendientes(WH, { role_name: 'superadmin', permissions: {} });
    expect(corridas.filter((s) => s.includes('FROM (')).length).toBe(Object.keys(Q).filter((k) => k.startsWith('SQL_')).length);
    expect(r.fuera.length).toBeGreaterThan(5);
  });
});
