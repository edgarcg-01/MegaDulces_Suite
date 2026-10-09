import { BadRequestException, NotFoundException } from '@nestjs/common';
import { reconstruirViaje } from './gps-viaje.logic';
import { ShipmentGpsReviewService } from './shipment-gps-review.service';

/**
 * `[EMB.21]` El viaje reconstruido con el GPS y la revisión de la guía. Un viaje sintético en línea
 * recta al norte de una sucursal: sale, va a ~20 km, regresa. ~0.0018° de latitud ≈ 200 m.
 */

const ORIGEN = { lat: 20, lng: -102 };
const at = (hhmm: string, dia = '2026-10-07') => new Date(`${dia}T${hhmm}:00-06:00`);
const p = (hhmm: string, kmAlNorte: number, odometro: number | null, dia?: string) =>
  ({ en: at(hhmm, dia), lat: ORIGEN.lat + kmAlNorte / 111.2, lng: ORIGEN.lng, odometro });
const DESDE = at('07:30');
const DESPUES = new Date('2026-10-20T00:00:00-06:00');

const VIAJE = [
  p('07:00', 0, 1000), p('08:00', 0.1, 1000), p('08:30', 2, 1002),
  p('12:00', 20, 1021), p('17:00', 2, 1040), p('17:30', 0.2, 1042),
];

describe('reconstruirViaje', () => {
  it('salida, regreso y km del odómetro cuando es creíble frente al trazo', () => {
    const r = reconstruirViaje(VIAJE, ORIGEN, DESDE, DESPUES);
    expect(r).toEqual({ ok: true, viaje: {
      salida: '08:30', llegada: '17:30', duerme_fuera: false, km: 40, km_metodo: 'odometro', puntos: 4,
    } });
  });

  it('un odómetro roto (negativo) no se publica: se usa el trazo y se declara', () => {
    const roto = VIAJE.map((x, i) => ({ ...x, odometro: i === 5 ? 3 : x.odometro }));
    const r = reconstruirViaje(roto, ORIGEN, DESDE, DESPUES);
    expect(r.ok && r.viaje.km_metodo).toBe('trazo');
    expect(r.ok && r.viaje.km).toBe(38); // 18 + 18 + 1.8 km de trazo
  });

  it('un odómetro que salta (medido: de 37 a 133 veces el trazo) tampoco se cree', () => {
    const salto = VIAJE.map((x, i) => ({ ...x, odometro: i === 5 ? 1002 + 4412 : x.odometro }));
    const r = reconstruirViaje(salto, ORIGEN, DESDE, DESPUES);
    expect(r.ok && r.viaje).toMatchObject({ km: 38, km_metodo: 'trazo' });
  });

  it('regresar al día siguiente es dormir fuera', () => {
    const r = reconstruirViaje([...VIAJE.slice(0, 4), p('07:10', 0.1, 1042, '2026-10-08')], ORIGEN, DESDE, DESPUES);
    expect(r.ok && r.viaje).toMatchObject({ llegada: '07:10', duerme_fuera: true });
  });

  it('lo que no se puede medir se dice, con su motivo', () => {
    expect(reconstruirViaje([], ORIGEN, DESDE, DESPUES)).toEqual({ ok: false, motivo: 'sin_puntos' });
    expect(reconstruirViaje([p('09:00', 30, 1), p('10:00', 31, 2)], ORIGEN, DESDE, DESPUES)).toEqual({ ok: false, motivo: 'nunca_en_origen' });
    expect(reconstruirViaje([p('08:00', 0, 1), p('09:00', 0.1, 1)], ORIGEN, DESDE, DESPUES)).toEqual({ ok: false, motivo: 'no_sale' });
  });

  it('sin regreso: «en curso» dentro de las 48 h, «no regresa» después', () => {
    const ida = VIAJE.slice(0, 4);
    expect(reconstruirViaje(ida, ORIGEN, DESDE, at('20:00'))).toEqual({ ok: false, motivo: 'en_curso' });
    expect(reconstruirViaje(ida, ORIGEN, DESDE, DESPUES)).toEqual({ ok: false, motivo: 'no_regresa' });
  });

  it('salir ANTES de cargar no cuenta: la salida es la primera después de la captura', () => {
    const conVueltaPrevia = [p('06:00', 0, 990), p('06:10', 3, 993), p('06:40', 0.1, 996), ...VIAJE];
    const r = reconstruirViaje(conVueltaPrevia, ORIGEN, DESDE, DESPUES);
    expect(r.ok && r.viaje.salida).toBe('08:30');
  });
});

// ── El servicio, con un doble de knex ───────────────────────────────────────────────────────

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const VEH = 'bbbbbbbb-0000-4000-8000-000000000001';

function servicio(o: { embarque?: Record<string, unknown>; guia?: Record<string, unknown> | null; rastreador?: boolean; origen?: boolean } = {}) {
  const filas: Record<string, unknown> = {
    'logistics.shipments': { id: ID, shipment_date: '2026-10-07', vehicle_id: VEH, kepler_sucursal: '06', kepler_guia: '0009999', actual_km: 40, ...o.embarque },
    'logistics.delivery_guides': o.guia === null ? undefined : {
      driver_id: 'd1', helper1_id: null, helper2_id: null, departure_time: '08:30:00', arrival_time: '17:30:00',
      overnight: false, per_diem_total: '100.00', ...o.guia,
    },
    'logistics.trackers': o.rastreador === false ? undefined : { id: 't1' },
    'commercial.warehouses': o.origen === false ? undefined : { latitude: String(ORIGEN.lat), longitude: String(ORIGEN.lng) },
    'analytics.erp_shipment_stops': { hora: '07:30' },
  };
  const trx: any = (tabla: string) => {
    const b: any = {
      where: () => b, whereNull: () => b, whereNot: () => b, whereNotNull: () => b, orderBy: () => b, min: () => b,
      first: async () => filas[tabla],
      select: async () => tabla === 'logistics.vehicle_positions'
        ? VIAJE.map((x) => ({ captured_at: x.en, lat: x.lat, lng: x.lng, odometer: x.odometro }))
        : tabla === 'logistics.config_finance'
          ? [{ key: 'viatico_cafe', value: 50 }, { key: 'viatico_desayuno', value: 100 }, { key: 'viatico_comida', value: 100 }, { key: 'viatico_cena', value: 100 }]
          : [],
    };
    return b;
  };
  trx.raw = (sql: string) => sql;
  const tk: any = { run: async (fn: any) => fn(trx) };
  const ctx: any = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  return new ShipmentGpsReviewService(tk, ctx);
}

describe('ShipmentGpsReviewService.review', () => {
  it('lo capturado coincide con el GPS', async () => {
    const r = await servicio().review(ID, DESPUES);
    expect(r).toMatchObject({ estado: 'coincide', motivo: null, diferencias: [] });
    expect(r.gps).toMatchObject({ salida: '08:30', llegada: '17:30', km: 40, km_metodo: 'odometro', viaticos: 100 });
    expect(r.capturado).toMatchObject({ salida: '08:30', llegada: '17:30', km: 40 });
  });

  it('una salida capturada antes de las 7:00 que el GPS no confirma, difiere en viáticos', async () => {
    const r = await servicio({ guia: { departure_time: '06:30:00', per_diem_total: '200.00' } }).review(ID, DESPUES);
    expect(r.estado).toBe('difiere');
    expect(r.diferencias.some((d) => d.startsWith('Viáticos:'))).toBe(true);
  });

  it('lo que no se puede revisar se declara con su motivo, nunca como «coincide»', async () => {
    expect((await servicio({ embarque: { kepler_sucursal: null, kepler_guia: null } }).review(ID, DESPUES)))
      .toMatchObject({ estado: 'no_medible', motivo: expect.stringContaining('no viene de Kepler'), gps: null });
    expect((await servicio({ rastreador: false }).review(ID, DESPUES)).motivo).toBe('La unidad no tiene rastreador GPS.');
    expect((await servicio({ origen: false }).review(ID, DESPUES)).motivo).toContain('no tiene coordenadas');
    expect((await servicio({ guia: null }).review(ID, DESPUES)).motivo).toBe('El embarque no tiene guía.');
  });

  it('una guía sin horario capturado muestra el GPS y lo declara', async () => {
    const r = await servicio({ guia: { departure_time: null, arrival_time: null } }).review(ID, DESPUES);
    expect(r.estado).toBe('no_medible');
    expect(r.gps).toMatchObject({ salida: '08:30', viaticos: null });
  });

  it('valida el id y que el embarque exista', async () => {
    await expect(servicio().review('x', DESPUES)).rejects.toThrow(BadRequestException);
    const s = servicio({ embarque: undefined });
    (s as any).tk = { run: async (fn: any) => fn(Object.assign(() => ({ where: function () { return this; }, whereNull: function () { return this; }, first: async () => undefined }), { raw: (x: string) => x })) };
    await expect(s.review(ID, DESPUES)).rejects.toThrow(NotFoundException);
  });
});
