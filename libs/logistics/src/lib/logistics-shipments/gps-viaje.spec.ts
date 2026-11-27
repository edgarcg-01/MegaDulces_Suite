import { BadRequestException, NotFoundException } from '@nestjs/common';
import { capturadaMientrasFuera, desvioPorLaHoja, MAX_DESVIOS_POR_HOJA, mismoViajeFisico, reconstruirViaje, ventanaDeLaHoja } from './gps-viaje.logic';
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
      salida: '08:30', llegada: '17:30', duerme_fuera: false, km: 40, km_metodo: 'odometro', puntos: 4, dia_salida: '2026-10-07',
    } });
  });

  it('[CML.H] el día de la salida es el del GPS, no el de la guía: cargó un día y salió al siguiente', () => {
    const otroDia = VIAJE.map((x) => ({ ...x, en: new Date(x.en.getTime() + 24 * 3600_000) }));
    const r = reconstruirViaje(otroDia, ORIGEN, DESDE, DESPUES);
    expect(r.ok && r.viaje).toMatchObject({ salida: '08:30', dia_salida: '2026-10-08', duerme_fuera: false });
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

describe('[CML.J] mismo viaje físico (D17)', () => {
  // El par real de prod: 06/0001695 y 06/0001696, salida 12:16 del 12-nov, 259 km.
  const a = { salida: '12:16', dia_salida: '2026-11-12' };
  it('misma unidad, mismo día y misma hora de salida = el mismo viaje', () => {
    expect(mismoViajeFisico(a, { salida: '12:16', dia_salida: '2026-11-12' })).toBe(true);
  });
  it('NEGATIVA: otra hora, otro día, o sin día de salida, no se afirma', () => {
    expect(mismoViajeFisico(a, { salida: '12:17', dia_salida: '2026-11-12' })).toBe(false);
    expect(mismoViajeFisico(a, { salida: '12:16', dia_salida: '2026-11-13' })).toBe(false);
    expect(mismoViajeFisico({ salida: '12:16' }, { salida: '12:16' })).toBe(false);
  });
});

// [CML.J] D17 caso 3 — sin GPS: otra guía de la misma unidad capturada mientras el camión estaba fuera
// según la hoja de viaje es, posiblemente, el desvío. Sólo sugiere; confirma una persona.
describe('[CML.J] mismo viaje por la hoja (sin GPS)', () => {
  const guia = { fecha: '2026-09-29', hora_captura: '06:00' };
  const hoja = { salida: '07:00', llegada: '16:30', duerme_fuera: false };
  const v = ventanaDeLaHoja(guia, hoja);

  it('capturada a las 11:20 del mismo día, con el camión fuera: se sugiere', () => {
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-29', hora_captura: '11:20' })).toBe(true);
  });
  it('NEGATIVA: antes de salir, justo a la salida, después de regresar u otro día: no', () => {
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-29', hora_captura: '06:59' })).toBe(false);
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-29', hora_captura: '07:00' })).toBe(false);
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-29', hora_captura: '16:31' })).toBe(false);
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-30', hora_captura: '11:20' })).toBe(false);
    expect(capturadaMientrasFuera(v, { fecha: '2026-09-29', hora_captura: null })).toBe(false);
  });
  it('cargada en la tarde: la guía se capturó después de la hora de salida, salió al día siguiente', () => {
    const tarde = ventanaDeLaHoja({ fecha: '2026-09-29', hora_captura: '18:00' }, hoja);
    expect(capturadaMientrasFuera(tarde, { fecha: '2026-09-30', hora_captura: '10:00' })).toBe(true);
    expect(capturadaMientrasFuera(tarde, { fecha: '2026-09-29', hora_captura: '10:00' })).toBe(false);
  });
  it('durmió fuera: la ventana cruza la medianoche', () => {
    const noche = ventanaDeLaHoja(guia, { salida: '20:00', llegada: '05:00', duerme_fuera: true });
    expect(capturadaMientrasFuera(noche, { fecha: '2026-09-30', hora_captura: '02:00' })).toBe(true);
  });
  it('NEGATIVA: sin horario o con una ventana imposible (4:30 AM por 4:30 PM) no sugiere nada', () => {
    expect(ventanaDeLaHoja(guia, { salida: null, llegada: '16:30', duerme_fuera: false })).toBeNull();
    // 07:00 → 04:30 del día siguiente son 21.5 h: es un error de captura, no un viaje.
    const mal = ventanaDeLaHoja(guia, { salida: '07:00', llegada: '04:30', duerme_fuera: false });
    expect(mal).toBeNull();
    expect(capturadaMientrasFuera(mal, { fecha: '2026-09-29', hora_captura: '11:20' })).toBe(false);
  });
});


describe('[CML.J2] la hoja sólo sugiere UN desvío', () => {
  it('una sola guía capturada mientras estaba fuera: se sugiere', () => {
    expect(desvioPorLaHoja(['0001383'])).toEqual({ sugeridas: ['0001383'], omitidas: 0 });
  });
  it('ninguna: nada que sugerir ni que declarar', () => {
    expect(desvioPorLaHoja([])).toEqual({ sugeridas: [], omitidas: 0 });
  });
  it('NEGATIVA: dos o más = unidad compartida, no se sugiere ninguna y se dice cuántas', () => {
    expect(MAX_DESVIOS_POR_HOJA).toBe(1);
    expect(desvioPorLaHoja(['0001383', '0001384', '0001385'])).toEqual({ sugeridas: [], omitidas: 3 });
    expect(desvioPorLaHoja(['a', 'b'])).toEqual({ sugeridas: [], omitidas: 2 });
  });
});
