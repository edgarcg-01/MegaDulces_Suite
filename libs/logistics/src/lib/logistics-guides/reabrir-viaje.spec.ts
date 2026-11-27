import { BadRequestException, ConflictException } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { erroresReabrir, MOTIVO_MINIMO } from './guia-calculada.logic';

// [CML.K] Reabrir un viaje cerrado: sólo con motivo; borra horario y montos, deja quién, cuándo y por qué.

const GID = 'a1aaaaaa-0000-4000-8000-00000000000b';
const USUARIO = 'bbbbbbbb-0000-4000-8000-000000000002';
const CERRADA = { status: 'pendiente', departure_time: '05:30:00', arrival_time: '16:00:00' };

describe('[CML.K] erroresReabrir', () => {
  it('un viaje cerrado con motivo suficiente: se puede', () => {
    expect(erroresReabrir(CERRADA, 'el ayudante era otro')).toEqual([]);
  });
  it('NEGATIVA: sin motivo, motivo corto, viaje sin cerrar o guía cancelada', () => {
    expect(erroresReabrir(CERRADA, undefined)[0]).toMatch(/por qué se reabre/);
    expect(erroresReabrir(CERRADA, '   error   ')[0]).toMatch(new RegExp(`al menos ${MOTIVO_MINIMO}`));
    expect(erroresReabrir({ ...CERRADA, arrival_time: null }, 'el ayudante era otro')[0]).toMatch(/todavía no se cierra/);
    expect(erroresReabrir({ ...CERRADA, status: 'cancelada' }, 'el ayudante era otro')[0]).toMatch(/cancelada/);
  });
});

describe('[CML.K] LogisticsGuidesService.reabrir', () => {
  function servicio(o: { guia?: Record<string, unknown>; embarque?: Record<string, unknown>; nadieActualiza?: boolean } = {}) {
    const updates: any[] = [];
    const trx: any = (tabla: string) => {
      const b: any = {
        where: () => b,
        whereNull: () => b,
        whereNotNull: () => b,
        first: async () => {
          if (tabla === 'logistics.delivery_guides') return { id: GID, number: 'G-9', shipment_id: 'e1', ...CERRADA, ...o.guia };
          if (tabla === 'logistics.shipments') return { id: 'e1', status: 'programado', ...o.embarque };
          return undefined;
        },
        update: (row: any) => ({
          returning: async () => {
            if (o.nadieActualiza) return [];
            updates.push(row);
            return [{ id: GID, number: 'G-9', reopened_at: '2026-11-24T20:00:00.000Z' }];
          },
        }),
      };
      return b;
    };
    trx.fn = { now: () => 'now()' };
    trx.raw = (x: string) => x;
    const tk: any = { run: async (fn: any) => fn(trx) };
    const ctx: any = { get: () => ({ tenantId: 't', userId: USUARIO }) };
    return { svc: new LogisticsGuidesService(tk, ctx, {} as any), updates };
  }

  it('borra horario y montos, conserva la tripulación y deja quién, cuándo y el motivo', async () => {
    const { svc, updates } = servicio();
    const r = await svc.reabrir(GID, { motivo: '  la hora de regreso estaba mal ' });
    expect(r).toEqual({ id: GID, number: 'G-9', reopened_at: '2026-11-24T20:00:00.000Z' });
    expect(updates[0]).toMatchObject({
      departure_time: null, arrival_time: null, driver_commission: 0, helper1_commission: 0, helper2_commission: 0,
      per_diem_total: 0, per_diem_breakdown: null, reopened_by: USUARIO, reopen_reason: 'la hora de regreso estaba mal',
    });
    // La tripulación NO se toca.
    for (const k of ['driver_id', 'helper1_id', 'helper2_id']) expect(updates[0]).not.toHaveProperty(k);
  });

  it('NEGATIVA: motivo corto, viaje sin cerrar, embarque cerrado o carrera con otra persona: no escribe', async () => {
    const a = servicio();
    await expect(a.svc.reabrir(GID, { motivo: 'error' })).rejects.toThrow(BadRequestException);
    const b = servicio({ guia: { arrival_time: null } });
    await expect(b.svc.reabrir(GID, { motivo: 'el ayudante era otro' })).rejects.toThrow(/todavía no se cierra/);
    const c = servicio({ embarque: { status: 'cerrado' } });
    await expect(c.svc.reabrir(GID, { motivo: 'el ayudante era otro' })).rejects.toThrow(ConflictException);
    const d = servicio({ nadieActualiza: true });
    await expect(d.svc.reabrir(GID, { motivo: 'el ayudante era otro' })).rejects.toThrow(/acaba de reabrir/);
    await expect(a.svc.reabrir('no-es-uuid', { motivo: 'el ayudante era otro' })).rejects.toThrow(/id inválido/);
    for (const x of [a, b, c]) expect(x.updates).toHaveLength(0);
  });
});
