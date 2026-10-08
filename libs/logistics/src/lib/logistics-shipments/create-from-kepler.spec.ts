import { BadRequestException, ConflictException } from '@nestjs/common';
import { LogisticsShipmentsService } from './logistics-shipments.service';
import { ParadaKepler, resumirViaje, tipoDeViaje } from '../logistics-erp-shipments/nuevo-embarque.logic';

/**
 * EMB.12 — `createFromKepler`: tomar un viaje de Kepler en vez de recapturarlo.
 *
 * Se prueba con un doble de knex que ANOTA lo que se consulta y lo que se inserta. Lo que
 * importa no es que "se llame a insert", sino QUÉ se guarda: la llave de la guía, lo que Kepler
 * no tiene, y que NO se frene la unidad por la agenda de embarques propios de la app.
 */

const PARADAS: ParadaKepler[] = [
  { serie: 1, folio: '0001052', cliente_code: 'C3098', destino_nombre: 'ABARROTES', ruta_clave: 'R0057', ruta_nombre: 'JIQUILPAN', orden_visita: 2, total: 54468.36, cajas: 67, sueltos: 0 },
  { serie: 1, folio: '0001051', cliente_code: 'C3051', destino_nombre: 'DULCERIA', ruta_clave: 'R0041', ruta_nombre: 'SANTAGIO TANGAMNADAPIO', orden_visita: 1, total: 12054.93, cajas: 10, sueltos: 6 },
];

function hoja(over: Record<string, any> = {}) {
  return {
    viaje: { fecha: '2026-10-03', sucursal_nombre: 'Sucursal Canindo', tipo: tipoDeViaje(PARADAS) },
    unidad: { vehicle_id: 'aaaaaaaa-0000-4000-8000-000000000017' },
    chofer: { driver_id: 'bbbbbbbb-0000-4000-8000-000000000017' },
    // La tarifa del viaje: la mayor de sus rutas (JIQUILPAN). Todas sus rutas tienen tarifa.
    comision: {
      driver: 98.04, helper: 57.76, sin_tarifa: [],
      ruta_usada: { clave: 'R0057', nombre: 'JIQUILPAN', route_id: 'cccccccc-0000-4000-8000-000000000041' },
    },
    resumen: resumirViaje(PARADAS),
    paradas: PARADAS,
    tomado: null,
    ...over,
  };
}

interface Llamada { tabla: string; op: string; arg?: any }

/** Las tarifas de viático de la beta (logistics_baseline.js), como las guarda config_finance. */
const VIATICOS = [
  { key: 'viatico_cafe', value: '50.00' }, { key: 'viatico_desayuno', value: '100.00' },
  { key: 'viatico_comida', value: '100.00' }, { key: 'viatico_cena', value: '100.00' },
];
/** Un día que no da comidas (sale 8:00, llega 14:00): viáticos = 0 real. */
const TOMA = { delivery_type: 'route', departure_time: '08:00', arrival_time: '14:00' };

function dobleDeKnex(opts: { falloUnico?: boolean } = {}) {
  const llamadas: Llamada[] = [];
  const inserts: Record<string, any[]> = {};
  let folio = 0;
  const trx: any = (tabla: string) => {
    const b: any = {
      where: (arg: any) => { llamadas.push({ tabla, op: 'where', arg }); return b; },
      whereNull: () => b,
      whereNot: () => b,
      select: async () => {
        llamadas.push({ tabla, op: 'select' });
        return tabla === 'logistics.config_finance' ? VIATICOS : [];
      },
      first: async () => {
        llamadas.push({ tabla, op: 'first' });
        if (tabla === 'logistics.drivers') return { id: 'x', active: true, full_name: 'César C.' };
        return undefined;
      },
      insert: (rows: any) => {
        llamadas.push({ tabla, op: 'insert' });
        return {
          returning: async () => {
            if (opts.falloUnico && tabla === 'logistics.shipments') {
              throw Object.assign(new Error('duplicate key value violates unique constraint "ux_logistics_shipments_kepler_guia"'),
                { code: '23505', constraint: 'ux_logistics_shipments_kepler_guia' });
            }
            (inserts[tabla] ??= []).push(rows);
            return [{ ...(Array.isArray(rows) ? rows[0] : rows), id: `${tabla}-id` }];
          },
          then: (ok: any) => { (inserts[tabla] ??= []).push(rows); return Promise.resolve(ok?.()); },
        };
      },
    };
    return b;
  };
  // `trx.raw` se usa de dos formas: como valor (`current_tenant_id()`) y esperado (el folio).
  trx.raw = (sql: string) => ({
    sql,
    then: (ok: any) => Promise.resolve(ok({ rows: [{ current_value: ++folio }] })),
  });
  return { trx, llamadas, inserts };
}

function servicio(h: any, k = dobleDeKnex()) {
  const tk: any = { run: async (fn: any) => fn(k.trx) };
  const ctx: any = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  const erp: any = { nuevoEmbarque: async () => h };
  return { svc: new LogisticsShipmentsService(tk, ctx, {} as any, erp), k };
}

describe('LogisticsShipmentsService.create — embarque manual', () => {
  it('guarda el tipo de entrega (antes el formulario lo pedía y se tiraba)', async () => {
    const { svc, k } = servicio(hoja());
    await svc.create({ shipment_date: '2026-10-03', type: 'recoleccion', delivery_type: 'long_trip' });
    const fila = k.inserts['logistics.shipments'][0];
    expect(fila).toMatchObject({ type: 'recoleccion', delivery_type: 'long_trip' });
    expect(fila.kepler_guia).toBeUndefined(); // un embarque manual no lleva llave de Kepler
  });
  it('rechaza un tipo de entrega que no existe', async () => {
    const { svc } = servicio(hoja());
    await expect(svc.create({ shipment_date: '2026-10-03', delivery_type: 'avion' as any })).rejects.toThrow(BadRequestException);
  });
});

describe('LogisticsShipmentsService.createFromKepler', () => {
  it('guarda la llave de la guía y lo que Kepler no tiene, sin recapturar lo que sí', async () => {
    const { svc, k } = servicio(hoja());
    const r = await svc.createFromKepler('06', '0001419', {
      ...TOMA, helper1_id: 'dddddddd-0000-4000-8000-000000000001', freight_revenue: 0,
    });

    const [s] = k.inserts['logistics.shipments'];
    expect(s).toMatchObject({
      kepler_sucursal: '06', kepler_guia: '0001419',
      shipment_date: '2026-10-03',
      vehicle_id: 'aaaaaaaa-0000-4000-8000-000000000017',
      route_id: 'cccccccc-0000-4000-8000-000000000041',
      type: 'entrega', delivery_type: 'route', status: 'programado',
      boxes_count: 77, cargo_value: 66523.29, total_weight_kg: 0,
      origin: 'Sucursal Canindo',
    });
    expect(s.folio).toMatch(/^EMB-\d{4}-\d{5}$/);
    expect(r.destinatarios).toBe(2);
  });

  it('NO frena la unidad por la agenda de embarques propios: Kepler ya la asignó', async () => {
    const { svc, k } = servicio(hoja());
    await svc.createFromKepler('06', '0001419', TOMA);
    // La única lectura de logistics.shipments sería el freno de agenda; aquí no debe existir.
    expect(k.llamadas.filter((l) => l.tabla === 'logistics.shipments' && l.op === 'first')).toHaveLength(0);
    expect(k.llamadas.filter((l) => l.tabla === 'logistics.vehicles')).toHaveLength(0);
  });

  it('la guía lleva al chofer de Kepler y la comisión CALCULADA de la tarifa del viaje', async () => {
    const { svc, k } = servicio(hoja());
    await svc.createFromKepler('06', '0001419', TOMA);
    const [g] = k.inserts['logistics.delivery_guides'];
    expect(g).toMatchObject({
      driver_id: 'bbbbbbbb-0000-4000-8000-000000000017', driver_commission: 98.04,
      helper1_id: null, helper1_commission: 0, status: 'pendiente', type: 'entrega',
    });
    expect(g.number).toMatch(/^GUIA-\d{4}-\d{5}$/);
  });

  it('cada ayudante que va cobra la tarifa de ayudante; el que no va, 0', async () => {
    const { svc, k } = servicio(hoja());
    await svc.createFromKepler('06', '0001419', { ...TOMA, helper1_id: 'dddddddd-0000-4000-8000-000000000001' });
    expect(k.inserts['logistics.delivery_guides'][0]).toMatchObject({ helper1_commission: 57.76, helper2_commission: 0 });
  });

  it('si una ruta del viaje no tiene tarifa, no crea nada y dice cuál falta', async () => {
    const h = hoja({ comision: { driver: 98.04, helper: 57.76, ruta_usada: null, sin_tarifa: [{ clave: 'R0041', nombre: 'SANTAGIO TANGAMNADAPIO' }] } });
    const { svc, k } = servicio(h);
    await expect(svc.createFromKepler('06', '0001419', TOMA))
      .rejects.toThrow(/Falta la tarifa de SANTAGIO TANGAMNADAPIO/);
    expect(k.inserts['logistics.shipments']).toBeUndefined();
    expect(k.inserts['logistics.delivery_guides']).toBeUndefined();
  });

  it('una comisión tecleada que no es la calculada se rechaza (no se paga de más ni de menos)', async () => {
    const { svc, k } = servicio(hoja());
    await expect(svc.createFromKepler('06', '0001419', { ...TOMA, driver_commission: 150 }))
      .rejects.toThrow(/La comisión se calcula de la tarifa de la ruta/);
    expect(k.inserts['logistics.delivery_guides']).toBeUndefined();
  });

  // ── Viáticos: se CALCULAN del horario (EMB.19, regla de la beta) ─────────────────────────

  it('guarda el horario y los viáticos calculados, con su desglose', async () => {
    const { svc, k } = servicio(hoja());
    // Sale 5:30, llega 16:00: café + desayuno + comida = 250 por persona; chofer + 1 ayudante = 500.
    await svc.createFromKepler('06', '0001419', {
      ...TOMA, departure_time: '05:30', arrival_time: '16:00', helper1_id: 'dddddddd-0000-4000-8000-000000000001',
    });
    const [g] = k.inserts['logistics.delivery_guides'];
    expect(g).toMatchObject({ departure_time: '05:30', arrival_time: '16:00', overnight: false, per_diem_total: 500 });
    const d = JSON.parse(g.per_diem_breakdown);
    expect(d.driver).toMatchObject({ cafe: true, desayuno: true, comida: true, cena: false, subtotal: 250 });
    expect(d.helper2).toMatchObject({ va: false, subtotal: 0 });
  });

  it('sin horario no crea nada: los viáticos salen de él', async () => {
    const { svc, k } = servicio(hoja());
    await expect(svc.createFromKepler('06', '0001419', { delivery_type: 'route' }))
      .rejects.toThrow(/Indica la hora de salida/);
    expect(k.inserts['logistics.shipments']).toBeUndefined();
  });

  it('un viático tecleado que no es el calculado se rechaza', async () => {
    const { svc, k } = servicio(hoja());
    await expect(svc.createFromKepler('06', '0001419', { ...TOMA, per_diem_total: 320 }))
      .rejects.toThrow(/Los viáticos se calculan del horario/);
    expect(k.inserts['logistics.delivery_guides']).toBeUndefined();
  });

  it('un destinatario por parada, en orden de ruta y con la llave del documento de Kepler', async () => {
    const { svc, k } = servicio(hoja());
    await svc.createFromKepler('06', '0001419', TOMA);
    const [dest] = k.inserts['logistics.guide_recipients'];
    expect(dest.map((d: any) => d.kepler_folio)).toEqual(['0001052', '0001051']); // JIQUILPAN antes que SANTIAGO
    expect(dest[0]).toMatchObject({ kepler_serie: '1', kepler_warehouse_code: '06', boxes_count: 67, value: 54468.36, status: 'pendiente' });
  });

  it('si Kepler no trae chofer y no se eligió uno, no crea nada y dice por qué', async () => {
    const { svc, k } = servicio(hoja({ chofer: { driver_id: null } }));
    await expect(svc.createFromKepler('01', '0001626', TOMA))
      .rejects.toThrow(BadRequestException);
    await expect(svc.createFromKepler('01', '0001626', TOMA))
      .rejects.toThrow(/Falta el chofer/);
    expect(k.inserts['logistics.shipments']).toBeUndefined();
  });

  it('una guía ya tomada es conflicto (409), con el folio que la tiene', async () => {
    const { svc } = servicio(hoja({ tomado: { id: 'x', folio: 'EMB-2026-00012', status: 'programado' } }));
    await expect(svc.createFromKepler('06', '0001419', TOMA))
      .rejects.toThrow(ConflictException);
    await expect(svc.createFromKepler('06', '0001419', TOMA))
      .rejects.toThrow(/EMB-2026-00012/);
  });

  it('dos personas tomando la misma guía a la vez: la segunda recibe un 409 legible', async () => {
    const { svc } = servicio(hoja(), dobleDeKnex({ falloUnico: true }));
    await expect(svc.createFromKepler('06', '0001419', TOMA))
      .rejects.toThrow(/Otra persona acaba de tomar este viaje/);
  });

  it('rechaza sucursal o guía con forma inválida antes de tocar la base', async () => {
    const { svc, k } = servicio(hoja());
    await expect(svc.createFromKepler('06; drop', '0001419', TOMA)).rejects.toThrow(BadRequestException);
    await expect(svc.createFromKepler('06', 'G-1', TOMA)).rejects.toThrow(BadRequestException);
    expect(k.llamadas).toHaveLength(0);
  });
});
