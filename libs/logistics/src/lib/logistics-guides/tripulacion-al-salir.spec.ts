import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { bloqueoDeTripulacion, CHOFER_DE_KEPLER, TRIPULACION_YA_CON_HORARIO, validarTripulacion } from './guia-calculada.logic';

// [CML.HV] La tripulación se guarda AL SALIR, sin horario; el horario (y con él comisión y
// viático) llega al regresar por `complete()`.

const GID = 'a1aaaaaa-0000-4000-8000-000000000009';
const CHOFER = 'aaaaaaaa-0000-4000-8000-000000000001';
const AYUDANTE = 'aaaaaaaa-0000-4000-8000-000000000002';
const AYUDANTE2 = 'aaaaaaaa-0000-4000-8000-000000000003';
const USUARIO = 'bbbbbbbb-0000-4000-8000-000000000001';

describe('[CML.HV] reglas de la tripulación al salir', () => {
  it('se puede guardar mientras falte el horario; con horario completo, no', () => {
    expect(bloqueoDeTripulacion({ departure_time: null, arrival_time: null })).toBeNull();
    expect(bloqueoDeTripulacion({ departure_time: '07:00:00', arrival_time: null })).toBeNull();
    expect(bloqueoDeTripulacion({ departure_time: '07:00:00', arrival_time: '15:00:00' })).toBe(TRIPULACION_YA_CON_HORARIO);
  });

  it('valida a las personas como al completar, pero NO pide horario', () => {
    expect(validarTripulacion({ helper1_id: AYUDANTE, helper2_id: null }, { chofer_guia: CHOFER })).toEqual([]);
    expect(validarTripulacion({ helper1_id: null, helper2_id: null }, { chofer_guia: CHOFER })).toEqual([]);
  });

  it('NEGATIVA: sin chofer, chofer repetido, chofer distinto al de Kepler o ayudante 2 sin el 1', () => {
    expect(validarTripulacion({ helper1_id: AYUDANTE, helper2_id: null }, { chofer_guia: null })).toEqual(['Elige al chofer.']);
    expect(validarTripulacion({ helper1_id: CHOFER, helper2_id: null }, { chofer_guia: CHOFER }))
      .toEqual(['El chofer no puede ir también como ayudante.']);
    expect(validarTripulacion({ driver_id: AYUDANTE2, helper1_id: null, helper2_id: null }, { chofer_guia: CHOFER }))
      .toEqual([CHOFER_DE_KEPLER]);
    expect(validarTripulacion({ helper1_id: null, helper2_id: AYUDANTE }, { chofer_guia: CHOFER }))
      .toEqual(['Captura primero al ayudante 1.']);
  });
});

describe('[CML.HV] LogisticsGuidesService.guardarTripulacion', () => {
  function servicio(o: { guia?: Record<string, unknown> | null; embarque?: Record<string, unknown>; chofer?: Record<string, unknown>; actualiza?: boolean } = {}) {
    const updates: any[] = [];
    const filas: Record<string, unknown> = {
      'logistics.delivery_guides': o.guia === null ? undefined
        : { id: GID, number: 'GUIA-2026-00045', status: 'pendiente', shipment_id: 'e1', driver_id: CHOFER, departure_time: null, arrival_time: null, ...o.guia },
      'logistics.shipments': { id: 'e1', status: 'programado', ...o.embarque },
      'logistics.drivers': { id: 'x', full_name: 'PRUEBA UNO', active: true, status: 'activo', ...o.chofer },
    };
    const trx: any = (tabla: string) => {
      const b: any = {
        where: (x: unknown) => { if (typeof x === 'function') x({ whereNull: () => ({ orWhereNull: () => b }) }); return b; },
        whereNull: () => b,
        first: async () => filas[tabla],
        update: (row: any) => ({
          returning: async () => {
            updates.push(row);
            return o.actualiza === false ? [] : [{ id: GID, number: 'GUIA-2026-00045', ...row, crew_saved_at: new Date('2026-11-24T14:05:00Z') }];
          },
        }),
      };
      return b;
    };
    trx.fn = { now: () => 'now()' };
    const tk: any = { run: async (fn: any) => fn(trx) };
    const ctx: any = { get: () => ({ tenantId: '00000000-0000-0000-0000-00000000d01c', userId: USUARIO }) };
    const erp: any = { nuevoEmbarque: async () => { throw new Error('no se usa al salir'); } };
    return { svc: new LogisticsGuidesService(tk, ctx, erp), updates };
  }

  it('guarda chofer y ayudantes con cuándo y quién, SIN horario ni montos', async () => {
    const { svc, updates } = servicio();
    const r = await svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: AYUDANTE2 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      driver_id: CHOFER, helper1_id: AYUDANTE, helper2_id: AYUDANTE2,
      crew_saved_at: 'now()', crew_saved_by: USUARIO, updated_at: 'now()',
    });
    // Ni horario ni comisión ni viático: el pago la sigue reteniendo.
    for (const k of ['departure_time', 'arrival_time', 'driver_commission', 'helper1_commission', 'per_diem_total']) {
      expect(updates[0]).not.toHaveProperty(k);
    }
    expect(r).toMatchObject({ id: GID, driver_id: CHOFER, helper1_id: AYUDANTE, helper2_id: AYUDANTE2, crew_saved_at: '2026-11-24T14:05:00.000Z' });
  });

  it('«salió sin ayudantes» también se guarda (queda la marca de cuándo)', async () => {
    const { svc, updates } = servicio();
    await svc.guardarTripulacion(GID, { helper1_id: null, helper2_id: null });
    expect(updates[0]).toMatchObject({ driver_id: CHOFER, helper1_id: null, helper2_id: null, crew_saved_at: 'now()' });
  });

  it('si Kepler no trajo chofer, se elige aquí', async () => {
    const { svc, updates } = servicio({ guia: { driver_id: null } });
    await svc.guardarTripulacion(GID, { driver_id: CHOFER, helper1_id: AYUDANTE, helper2_id: null });
    expect(updates[0]).toMatchObject({ driver_id: CHOFER, helper1_id: AYUDANTE });
  });

  it('NEGATIVA: con el horario ya capturado es conflicto y no toca la guía', async () => {
    const { svc, updates } = servicio({ guia: { departure_time: '07:00:00', arrival_time: '15:00:00' } });
    await expect(svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow(TRIPULACION_YA_CON_HORARIO);
    expect(updates).toHaveLength(0);
  });

  it('NEGATIVA: chofer distinto al de Kepler, embarque cerrado, guía cancelada o inexistente', async () => {
    const a = servicio();
    await expect(a.svc.guardarTripulacion(GID, { driver_id: AYUDANTE2, helper1_id: null, helper2_id: null })).rejects.toThrow(BadRequestException);
    const b = servicio({ embarque: { status: 'cerrado' } });
    await expect(b.svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow(ConflictException);
    const c = servicio({ guia: { status: 'cancelada' } });
    await expect(c.svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow(/cancelada/);
    const d = servicio({ guia: null });
    await expect(d.svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow(NotFoundException);
    for (const x of [a, b, c, d]) expect(x.updates).toHaveLength(0);
  });

  it('NEGATIVA: una persona inactiva no se guarda', async () => {
    const { svc, updates } = servicio({ chofer: { active: false, status: 'baja' } });
    await expect(svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  it('si otra persona capturó el horario en ese instante, gana el horario', async () => {
    const { svc } = servicio({ actualiza: false });
    await expect(svc.guardarTripulacion(GID, { helper1_id: AYUDANTE, helper2_id: null })).rejects.toThrow(/Otra persona acaba de capturar el horario/);
  });
});
