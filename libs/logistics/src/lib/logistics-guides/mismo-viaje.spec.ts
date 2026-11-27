import { BadRequestException, ConflictException } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { erroresMismoViaje } from './guia-calculada.logic';

// [CML.J] Confirmar que dos guías son el mismo viaje: sólo de la MISMA unidad, con quién y cuándo.

const GID = 'a1aaaaaa-0000-4000-8000-000000000009';
const USUARIO = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('[CML.J] erroresMismoViaje', () => {
  it('misma unidad: se puede', () => {
    expect(erroresMismoViaje('06|0001695', '06|0001696', 'v1', 'v1')).toEqual([]);
  });
  it('NEGATIVA: formato, ella misma, no existe, sin unidad, otra unidad', () => {
    expect(erroresMismoViaje('06|0001695', '0001696', 'v1', 'v1')[0]).toMatch(/no es válida/);
    expect(erroresMismoViaje('06|0001695', '06|0001695', 'v1', 'v1')[0]).toMatch(/ella misma/);
    expect(erroresMismoViaje('06|0001695', '06|0001696', 'v1', undefined)[0]).toMatch(/no existe en Kepler/);
    expect(erroresMismoViaje('06|0001695', '06|0001696', null, 'v1')[0]).toMatch(/no tiene unidad/);
    expect(erroresMismoViaje('06|0001695', '06|0001696', 'v1', 'v2')[0]).toMatch(/otra unidad/);
  });
  it('fechas: hasta 2 días se puede (lo cargado en la tarde sale al día siguiente); más, no', () => {
    expect(erroresMismoViaje('06|0001249', '06|0001276', 'v1', 'v1', { propia: '2026-09-10', otra: '2026-09-12' })).toEqual([]);
    expect(erroresMismoViaje('06|0001249', '06|0001300', 'v1', 'v1', { propia: '2026-09-10', otra: '2026-09-13' })[0])
      .toMatch(/más de 2 días no es el mismo viaje/);
  });
});

describe('[CML.J] LogisticsGuidesService.confirmarMismoViaje', () => {
  function servicio(o: { unidades?: Record<string, string | null>; guia?: Record<string, unknown>; embarque?: Record<string, unknown> } = {}) {
    const updates: any[] = [];
    const unidades = o.unidades ?? { '06|0001695': 'v1', '06|0001696': 'v1' };
    const trx: any = (tabla: string) => {
      let filtro: Record<string, string> = {};
      const b: any = {
        where: (x: any) => { if (x && typeof x === 'object') filtro = { ...filtro, ...x }; return b; },
        whereNull: () => b,
        whereRaw: () => b,
        first: async () => {
          if (tabla === 'logistics.delivery_guides') return { id: GID, number: 'G-1', status: 'pendiente', shipment_id: 'e1', ...o.guia };
          if (tabla === 'logistics.shipments') return { id: 'e1', status: 'programado', kepler_sucursal: '06', kepler_guia: '0001695', ...o.embarque };
          if (tabla === 'analytics.erp_shipment_trips') {
            const k = `${filtro['sucursal']}|${filtro['guia_embarque']}`;
            return k in unidades ? { vehicle_id: unidades[k] } : undefined;
          }
          return undefined;
        },
        update: (row: any) => ({ returning: async () => { updates.push(row); return [{ id: GID, same_trip_as: row.same_trip_as }]; } }),
      };
      return b;
    };
    trx.fn = { now: () => 'now()' };
    trx.raw = (x: string) => x;
    const tk: any = { run: async (fn: any) => fn(trx) };
    const ctx: any = { get: () => ({ tenantId: 't', userId: USUARIO }) };
    return { svc: new LogisticsGuidesService(tk, ctx, {} as any), updates };
  }

  it('liga la guía con otra de la misma unidad y deja quién y cuándo', async () => {
    const { svc, updates } = servicio();
    const r = await svc.confirmarMismoViaje(GID, { same_trip_as: '06|0001696' });
    expect(r).toEqual({ id: GID, same_trip_as: '06|0001696' });
    expect(updates[0]).toMatchObject({ same_trip_as: '06|0001696', same_trip_by: USUARIO, same_trip_at: 'now()' });
    // No toca montos ni tripulación.
    for (const k of ['driver_commission', 'per_diem_total', 'helper1_id', 'departure_time']) expect(updates[0]).not.toHaveProperty(k);
  });

  it('deshacer (null) limpia la liga', async () => {
    const { svc, updates } = servicio();
    await svc.confirmarMismoViaje(GID, { same_trip_as: null });
    expect(updates[0]).toMatchObject({ same_trip_as: null, same_trip_by: null, same_trip_at: null });
  });

  it('NEGATIVA: otra unidad, guía inexistente, guía cancelada o embarque que no es de Kepler: no escribe', async () => {
    const a = servicio({ unidades: { '06|0001695': 'v1', '06|0001696': 'v2' } });
    await expect(a.svc.confirmarMismoViaje(GID, { same_trip_as: '06|0001696' })).rejects.toThrow(BadRequestException);
    const b = servicio();
    await expect(b.svc.confirmarMismoViaje(GID, { same_trip_as: '06|0009999' })).rejects.toThrow(/no existe en Kepler/);
    const c = servicio({ guia: { status: 'cancelada' } });
    await expect(c.svc.confirmarMismoViaje(GID, { same_trip_as: '06|0001696' })).rejects.toThrow(ConflictException);
    const d = servicio({ embarque: { kepler_guia: null } });
    await expect(d.svc.confirmarMismoViaje(GID, { same_trip_as: '06|0001696' })).rejects.toThrow(/viaje de Kepler/);
    for (const x of [a, b, c, d]) expect(x.updates).toHaveLength(0);
  });
});
