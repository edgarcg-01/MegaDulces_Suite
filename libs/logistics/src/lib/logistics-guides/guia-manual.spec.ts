import { BadRequestException, ConflictException } from '@nestjs/common';
import { LogisticsGuidesService } from './logistics-guides.service';
import { cambiosACamposCalculados, GUIA_NO_SE_EDITA, validarGuiaManual } from './guia-calculada.logic';

/**
 * EMB.19 — «Nueva guía» de un embarque MANUAL: se elige la tripulación y el horario; comisión y
 * viáticos se CALCULAN (tarifa de la ruta del embarque + regla de horario de la beta) y no se
 * editan después. La guía de un embarque de Kepler no se agrega a mano: sale de su hoja.
 *
 * Nombres y montos de prueba, inventados.
 */

const RUTA_ID = 'cccccccc-0000-4000-8000-000000000001';
const CHOFER = 'aaaaaaaa-0000-4000-8000-000000000001';
const AYUDANTE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TARIFAS = { cafe: 50, desayuno: 100, comida: 100, cena: 100 };
const RUTA = { route_id: RUTA_ID, nombre: 'RUTA PRUEBA', driver: 120, helper: 80 };
const VIAJE = { driver_id: CHOFER, departure_time: '08:00', arrival_time: '14:00' };

describe('validarGuiaManual', () => {
  it('con chofer, ruta tarifada y horario, se crea', () => {
    expect(validarGuiaManual(VIAJE, { ruta: RUTA, tarifas: TARIFAS })).toEqual([]);
  });
  it('junta todo lo que falta, en lenguaje del usuario', () => {
    expect(validarGuiaManual({}, { ruta: null, tarifas: TARIFAS })).toEqual([
      'Elige al chofer.',
      'El embarque no tiene ruta: sin ruta no se calcula la comisión.',
      'Indica la hora de salida.',
      'Indica la hora de llegada.',
    ]);
  });
  it('un monto tecleado sólo se compara cuando el cálculo se pudo hacer', () => {
    expect(validarGuiaManual({ ...VIAJE, driver_commission: 1 }, { ruta: null, tarifas: TARIFAS }))
      .not.toContain('La comisión se calcula de la tarifa de la ruta; no se captura.');
    expect(validarGuiaManual({ ...VIAJE, driver_commission: 1 }, { ruta: RUTA, tarifas: TARIFAS }))
      .toEqual(['La comisión se calcula de la tarifa de la ruta; no se captura.']);
  });
});

describe('cambiosACamposCalculados — una guía creada no se re-teclea', () => {
  const guardada = {
    driver_id: CHOFER, helper1_id: null, helper2_id: null, departure_time: '08:00:00', arrival_time: '14:00:00',
    overnight: false, driver_commission: '120.00', helper1_commission: '0.00', helper2_commission: '0.00', per_diem_total: '0.00',
  };
  it('cambiar comisión, viáticos, tripulación u horario se detecta', () => {
    expect(cambiosACamposCalculados(guardada, { driver_commission: 150 })).toEqual(['driver_commission']);
    expect(cambiosACamposCalculados(guardada, { per_diem_total: 100, overnight: true })).toEqual(['overnight', 'per_diem_total']);
    expect(cambiosACamposCalculados(guardada, { helper1_id: AYUDANTE, departure_time: '05:00' })).toEqual(['helper1_id', 'departure_time']);
  });
  it('reenviar el MISMO valor no es cambiarlo (la hora en otro formato tampoco)', () => {
    expect(cambiosACamposCalculados(guardada, {
      driver_id: CHOFER, helper1_id: '', departure_time: '8:00', driver_commission: 120, per_diem_total: 0, overnight: false,
    })).toEqual([]);
  });
  it('el desglose de viáticos no se acepta de fuera', () => {
    expect(cambiosACamposCalculados(guardada, { per_diem_breakdown: {} })).toEqual(['per_diem_breakdown']);
    expect(cambiosACamposCalculados(guardada, { auto_per_diem: true })).toEqual(['auto_per_diem']);
  });
});

// ── El servicio, con un doble de knex que anota lo que se inserta y se actualiza ─────────────

interface Opciones {
  embarque?: Record<string, unknown>;
  ruta?: Record<string, unknown> | null;
  guia?: Record<string, unknown>;
}

function servicio(o: Opciones = {}) {
  const inserts: Record<string, any[]> = {};
  const updates: Record<string, any[]> = {};
  const embarque = { id: 'e1', folio: 'EMB-2026-00001', status: 'programado', route_id: RUTA_ID, kepler_guia: null, ...o.embarque };
  const ruta = o.ruta === undefined ? { id: RUTA_ID, name: 'RUTA PRUEBA', driver_commission: '120.00', helper_commission: '80.00' } : o.ruta;
  const filas: Record<string, unknown> = {
    'logistics.shipments': embarque,
    'logistics.routes': ruta ?? undefined,
    'logistics.drivers': { id: 'x', full_name: 'PRUEBA UNO', active: true, status: 'activo' },
    'logistics.delivery_guides': { id: 'g1', number: 'GUIA-2026-00001', status: 'pendiente', ...o.guia },
  };
  const trx: any = (tabla: string) => {
    const b: any = {
      where: () => b,
      whereNull: () => b,
      first: async () => filas[tabla],
      select: async () => tabla === 'logistics.config_finance'
        ? [{ key: 'viatico_cafe', value: '50' }, { key: 'viatico_desayuno', value: '100' }, { key: 'viatico_comida', value: '100' }, { key: 'viatico_cena', value: '100' }]
        : [],
      insert: (row: any) => ({ returning: async () => { (inserts[tabla] ??= []).push(row); return [{ ...row, id: 'nueva' }]; } }),
      update: (row: any) => ({ returning: async () => { (updates[tabla] ??= []).push(row); return [{ ...row }]; } }),
    };
    return b;
  };
  trx.raw = () => ({ then: (ok: any) => Promise.resolve(ok({ rows: [{ current_value: 7 }] })) });
  trx.fn = { now: () => 'now()' };
  const tk: any = { run: async (fn: any) => fn(trx) };
  const ctx: any = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  return { svc: new LogisticsGuidesService(tk, ctx), inserts, updates };
}

describe('LogisticsGuidesService.create — guía manual', () => {
  it('guarda la comisión de la tarifa de la ruta y los viáticos del horario, con su desglose', async () => {
    const { svc, inserts } = servicio();
    // Sale 5:30 y duerme fuera: café + desayuno + cena = 250 por persona; chofer + 1 ayudante = 500.
    await svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', driver_id: CHOFER, helper1_id: AYUDANTE,
      departure_time: '05:30', arrival_time: '12:00', overnight: true });
    const [g] = inserts['logistics.delivery_guides'];
    expect(g).toMatchObject({
      driver_commission: 120, helper1_commission: 80, helper2_commission: 0,
      departure_time: '05:30', arrival_time: '12:00', overnight: true, per_diem_total: 500,
    });
    expect(JSON.parse(g.per_diem_breakdown).helper1).toMatchObject({ cafe: true, desayuno: true, comida: false, cena: true, subtotal: 250 });
  });

  it('la guía de un embarque de Kepler no se agrega a mano: sale de su hoja', async () => {
    const { svc, inserts } = servicio({ embarque: { kepler_sucursal: '06', kepler_guia: '0001419' } });
    await expect(svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE }))
      .rejects.toThrow(ConflictException);
    await expect(svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE }))
      .rejects.toThrow(/sale de la hoja, no se agrega a mano/);
    expect(inserts['logistics.delivery_guides']).toBeUndefined();
  });

  it('un embarque sin ruta, o con la ruta sin tarifa, no crea la guía (un 0 sería no pagar)', async () => {
    const sinRuta = servicio({ embarque: { route_id: null } });
    await expect(sinRuta.svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE }))
      .rejects.toThrow(/El embarque no tiene ruta/);
    const sinTarifa = servicio({ ruta: { id: RUTA_ID, name: 'RUTA PRUEBA', driver_commission: '0.00', helper_commission: '0.00' } });
    await expect(sinTarifa.svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE }))
      .rejects.toThrow(BadRequestException);
    expect(sinTarifa.inserts['logistics.delivery_guides']).toBeUndefined();
  });

  it('una comisión o un viático tecleado que no es el calculado se rechaza', async () => {
    const { svc, inserts } = servicio();
    await expect(svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE, driver_commission: 150 }))
      .rejects.toThrow(/La comisión se calcula/);
    await expect(svc.create({ shipment_id: 'e1aaaaaa-0000-4000-8000-000000000001', ...VIAJE, per_diem_total: 100 }))
      .rejects.toThrow(/Los viáticos se calculan/);
    expect(inserts['logistics.delivery_guides']).toBeUndefined();
  });
});

describe('LogisticsGuidesService.update — lo calculado no se edita', () => {
  const guia = { driver_id: CHOFER, driver_commission: '120.00', per_diem_total: '0.00', overnight: false };

  it('cambiar la comisión es conflicto y no toca la guía', async () => {
    const { svc, updates } = servicio({ guia });
    await expect(svc.update('a1aaaaaa-0000-4000-8000-000000000001', { driver_commission: 999 }))
      .rejects.toThrow(GUIA_NO_SE_EDITA);
    expect(updates['logistics.delivery_guides']).toBeUndefined();
  });

  it('cambiar el estado o las notas sí se puede, aunque se reenvíen los mismos montos', async () => {
    const { svc, updates } = servicio({ guia });
    await svc.update('a1aaaaaa-0000-4000-8000-000000000001', { status: 'en_ruta', notes: 'sale tarde', driver_commission: 120 });
    const [patch] = updates['logistics.delivery_guides'];
    expect(patch).toMatchObject({ status: 'en_ruta', notes: 'sale tarde' });
    expect(patch).not.toHaveProperty('driver_commission');
  });
});
