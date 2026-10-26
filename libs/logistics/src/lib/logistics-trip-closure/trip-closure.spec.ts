import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { TripClosureController } from './trip-closure.controller';
import {
  cajasPorGuia, calculoDeCarga, calculoDeViatico, centroDeOperacion, centrosDePiso, documentosDelDesglose, pesos,
  renglonesDeLaOperacion, TripClosureService,
} from './trip-closure.service';

/**
 * `[EMB.24]` `[EMB.27]` — Cierre de parada y registro de cargadores (ADR-091).
 *
 * Las vistas que deciden si el viaje cerró ya tienen su candado contra Postgres
 * (`database/tests/test-newdb-emb-pago-por-viaje.js`). Aquí se prueba lo que hace el SERVICIO:
 * quién puede escribir, qué escribe y qué hace cuando dos personas cierran la misma parada.
 * Base de mentira que contesta por tabla; nombres inventados.
 */

const UUID_PARADA = '11111111-1111-4111-8111-111111111111';
const UUID_EMB = '22222222-2222-4222-8222-222222222222';
const UUID_USUARIO = '33333333-3333-4333-8333-333333333333';
const CARGADOR_A = '44444444-4444-4444-8444-444444444444';
const CARGADOR_B = '55555555-5555-4555-8555-555555555555';

interface Respuestas {
  primero?: Record<string, any>;
  lista?: Record<string, any[]>;
  actualizadas?: number;
  conteo?: number;
}

function baseFalsa(r: Respuestas) {
  const updates: Array<{ tabla: string; where: any; datos: any }> = [];
  const inserts: Array<{ tabla: string; filas: any }> = [];
  const borrados: string[] = [];
  const trx: any = (tabla: string) => {
    let filtro: any = null;
    const b: any = {
      where(a: any) { if (typeof a === 'object') filtro = { ...(filtro ?? {}), ...a }; return b; },
      whereNull: () => b, whereNot: () => b, whereIn: () => b, whereRaw: () => b, join: () => b, leftJoin: () => b,
      orderBy: () => b, orderByRaw: () => b, select: () => b, forUpdate: () => b, distinct: () => b, whereBetween: () => b,
      first: async () => r.primero?.[tabla],
      count: async () => [{ n: String(r.conteo ?? 0) }],
      update: async (datos: any) => { updates.push({ tabla, where: filtro, datos }); return r.actualizadas ?? 1; },
      insert: async (filas: any) => { inserts.push({ tabla, filas }); return []; },
      del: async () => { borrados.push(tabla); return 1; },
      then: (ok: any, ko: any) => Promise.resolve(r.lista?.[tabla] ?? []).then(ok, ko),
    };
    return b;
  };
  trx.fn = { now: () => 'NOW()' };
  // Un raw se usa como valor (el tenant) o se espera: la consulta de la Suite en el reporte contesta
  // `lista['__raw']`; la del tiempo aire sobre `kdm2`, `lista['__sin_carga']`.
  trx.raw = (sql: string) => ({
    sql,
    then: (ok: any, ko: any) => {
      const q = String(sql);
      const clave = q.includes('kepler_ods.kdm2') ? '__sin_carga'
        : q.includes('kepler_ods.pv_suc_ip') ? '__ti'
          : q.includes('kepler_ods.kdc3') ? '__centros'
            : q.includes('kepler_ods.kdii') || q.includes('kepler_ods.kdm1') ? '__kepler_otro'
              : '__raw';
      return Promise.resolve({ rows: r.lista?.[clave] ?? [] }).then(ok, ko);
    },
  });
  const tk: any = { run: async (fn: (t: any) => any) => fn(trx) };
  const ctx: any = {
    get: () => ({ username: 'prueba', userId: UUID_USUARIO }),
    requireTenantId: () => 'tenant-prueba',
  };
  const storage: any = {
    putFile: vi.fn().mockResolvedValue({ key: 'logistics/tenant-prueba/remisiones/r1.png' }),
    remove: vi.fn().mockResolvedValue(undefined),
    signedUrl: vi.fn().mockResolvedValue('https://firmada/r1.png'),
  };
  const svc = new TripClosureService(tk, ctx, storage);
  return { svc, storage, updates, inserts, borrados };
}

const PARADA_CLIENTE = {
  recipient_id: UUID_PARADA, shipment_id: UUID_EMB, tipo_parada: 'cliente',
  recipient_status: 'pendiente', estado_parada: 'pendiente',
};

describe('TripClosureService.cerrarParada', () => {
  const conCierre = (svc: TripClosureService) =>
    vi.spyOn(svc, 'cierre').mockResolvedValue({ paradas: [{ recipient_id: UUID_PARADA, estado_parada: 'cerrada' }] } as any);

  it('sin foto: cierra la parada y NO toca el almacenamiento (foto opcional desde 2026-10-12)', async () => {
    const { svc, storage, updates } = baseFalsa({ primero: { 'logistics.v_trip_stop_closure': PARADA_CLIENTE } });
    conCierre(svc);
    const p = await svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: '  Persona Prueba  ' });
    expect(p.estado_parada).toBe('cerrada');
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.tabla).toBe('logistics.guide_recipients');
    // Sólo se escribe sobre una parada que sigue pendiente: es lo que frena a la segunda persona.
    expect(u.where).toEqual({ id: UUID_PARADA, status: 'pendiente' });
    expect(u.datos.status).toBe('entregado');
    expect(u.datos.delivered_to).toBe('Persona Prueba');
    expect(u.datos.incident_type).toBeNull();
    expect('proof_photo_url' in u.datos).toBe(false);
    expect(u.datos.updated_by).toBe(UUID_USUARIO);
  });

  it('no entregado: guarda el motivo y la nota, sin quien recibió', async () => {
    const { svc, updates } = baseFalsa({ primero: { 'logistics.v_trip_stop_closure': PARADA_CLIENTE } });
    conCierre(svc);
    await svc.cerrarParada(UUID_PARADA, { resultado: 'no_entregado', motivo: 'not_located', nota: ' Cerrado ' });
    expect(updates[0].datos).toMatchObject({
      status: 'no_entregado', delivered_to: null, incident_type: 'not_located', incident_notes: 'Cerrado',
    });
  });

  it('con foto: la sube antes de escribir y guarda su llave', async () => {
    const { svc, storage, updates } = baseFalsa({ primero: { 'logistics.v_trip_stop_closure': PARADA_CLIENTE } });
    conCierre(svc);
    await svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: 'Ana', foto: 'data:image/png;base64,AAAA' });
    expect(storage.putFile).toHaveBeenCalledWith('data:image/png;base64,AAAA', 'logistics/tenant-prueba/remisiones');
    expect(updates[0].datos.proof_photo_url).toBe('logistics/tenant-prueba/remisiones/r1.png');
  });

  it('PRUEBA NEGATIVA: si otra persona la cerró primero, 409 y se borra la foto que se subió', async () => {
    const { svc, storage } = baseFalsa({ primero: { 'logistics.v_trip_stop_closure': PARADA_CLIENTE }, actualizadas: 0 });
    const cierre = conCierre(svc);
    await expect(svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: 'Ana', foto: 'data:image/png;base64,AAAA' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(storage.remove).toHaveBeenCalledWith('logistics/tenant-prueba/remisiones/r1.png');
    expect(cierre).not.toHaveBeenCalled();
  });

  it('una parada ya cerrada responde 409, no 400', async () => {
    const { svc, updates } = baseFalsa({
      primero: { 'logistics.v_trip_stop_closure': { ...PARADA_CLIENTE, recipient_status: 'entregado', estado_parada: 'cerrada' } },
    });
    await expect(svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: 'Ana' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(updates).toHaveLength(0);
  });

  it('un traspaso no se cierra a mano: lo cierra la recepción de Kepler', async () => {
    const { svc, updates } = baseFalsa({
      primero: { 'logistics.v_trip_stop_closure': { ...PARADA_CLIENTE, tipo_parada: 'traspaso' } },
    });
    await expect(svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: 'Ana' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('sin quien recibió no escribe nada', async () => {
    const { svc, updates } = baseFalsa({ primero: { 'logistics.v_trip_stop_closure': PARADA_CLIENTE } });
    await expect(svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: '' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it('id inválido → 400 y parada inexistente → 404', async () => {
    const { svc } = baseFalsa({});
    await expect(svc.cerrarParada('no-es-uuid', { resultado: 'entregado', recibio: 'Ana' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.cerrarParada(UUID_PARADA, { resultado: 'entregado', recibio: 'Ana' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripClosureService.setCargadores — [EMB.39] la carga se paga por caja', () => {
  // Embarque de Kepler con una parada de 531 cajas; tarifa de $0.20 por caja.
  const EMB = { id: UUID_EMB, status: 'programado', shipment_date: '2026-10-20', kepler_sucursal: '06', kepler_guia: '0001521', boxes_count: 0 };
  const TARIFA = { id: 'cfg-1', value: '0.2000', active: true };
  const PARADAS = [{ serie: 2, folio: '0001339' }];
  const CARGA = [{ serie: 2, folio: '0001339', cajas: '531' }];
  const kepler = (extra: Respuestas['lista'] = {}): Respuestas['lista'] => ({
    'analytics.erp_shipment_stops': PARADAS, 'analytics.erp_shipment_stop_load': CARGA, ...extra,
  });
  // Las pruebas negativas llevan al cargador EN el padrón: sin él, el 400 saldría de «no existe» y
  // la prueba pasaría por la razón equivocada (así lo cazó la mutación del 2026-10-24).
  const PADRON = { 'logistics.drivers': [{ id: CARGADOR_A }] };
  const conCierre = (svc: TripClosureService) => vi.spyOn(svc, 'cierre').mockResolvedValue({} as any);

  it('reparte cajas × tarifa en partes iguales y guarda con qué cajas y qué tarifa se calculó', async () => {
    const { svc, inserts, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({ 'logistics.drivers': [{ id: CARGADOR_A }, { id: CARGADOR_B }] }),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A, CARGADOR_B] });
    expect(borrados).toEqual(['logistics.load_details']);
    expect(inserts).toHaveLength(1);
    // 531 × $0.20 = $106.20 entre 2 = $53.10 cada quien.
    expect(inserts[0].filas).toEqual([
      expect.objectContaining({ shipment_id: UUID_EMB, driver_id: CARGADOR_A, rate: 53.1, boxes: 531, rate_per_box: 0.2, role_at_time: 'cargador', created_by: UUID_USUARIO }),
      expect.objectContaining({ shipment_id: UUID_EMB, driver_id: CARGADOR_B, rate: 53.1, boxes: 531, rate_per_box: 0.2, role_at_time: 'cargador' }),
    ]);
  });

  it('el centavo que no divide exacto va al primero: la suma es el total', async () => {
    const { svc, inserts } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({
        'analytics.erp_shipment_stop_load': [{ serie: 2, folio: '0001339', cajas: '25' }],
        'logistics.drivers': [{ id: CARGADOR_A }, { id: CARGADOR_B }, { id: UUID_PARADA }],
      }),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A, CARGADOR_B, UUID_PARADA] });
    expect(inserts[0].filas.map((f: any) => f.rate)).toEqual([1.67, 1.67, 1.66]);
  });

  it('cobra con la tarifa VIGENTE el día del embarque, no con la de hoy', async () => {
    const { svc, inserts } = baseFalsa({
      primero: { 'logistics.config_finance': { ...TARIFA, value: '0.3000' }, 'logistics.shipments': EMB },
      lista: kepler({
        'logistics.drivers': [{ id: CARGADOR_A }],
        'logistics.tariff_changes': [
          { field: 'value', old_value: null, new_value: '0.2', changed_at: '2026-10-01T16:00:00Z' },
          { field: 'value', old_value: '0.2', new_value: '0.3', changed_at: '2026-11-03T16:00:00Z' },
        ],
      }),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] });
    expect(inserts[0].filas[0]).toEqual(expect.objectContaining({ rate: 106.2, rate_per_box: 0.2 }));
  });

  it('un embarque de puras piezas sueltas tiene 0 cajas: se registra quién cargó y cobra $0', async () => {
    const { svc, inserts } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({ 'analytics.erp_shipment_stop_load': [{ serie: 2, folio: '0001339', cajas: '0' }], 'logistics.drivers': [{ id: CARGADOR_A }] }),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] });
    expect(inserts[0].filas[0]).toEqual(expect.objectContaining({ rate: 0, boxes: 0 }));
  });

  it('embarque manual: usa las cajas capturadas', async () => {
    const manual = { ...EMB, kepler_sucursal: null, kepler_guia: null, boxes_count: 40 };
    const { svc, inserts } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': manual },
      lista: { 'logistics.drivers': [{ id: CARGADOR_A }] },
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] });
    expect(inserts[0].filas[0]).toEqual(expect.objectContaining({ rate: 8, boxes: 40 }));
  });

  it('lista vacía: quita a todos y no inserta', async () => {
    const { svc, inserts, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB }, lista: kepler(),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [] });
    expect(borrados).toEqual(['logistics.load_details']);
    expect(inserts).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA: sin tarifa de carga por caja no se registra a nadie', async () => {
    const { svc, borrados } = baseFalsa({ primero: { 'logistics.shipments': EMB }, lista: kepler(PADRON) });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] })).rejects.toThrow(/tarifa de carga por caja/);
    expect(borrados).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA: la tarifa todavía no existía el día del embarque → no se registra', async () => {
    const { svc, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({ ...PADRON, 'logistics.tariff_changes': [{ field: 'value', old_value: null, new_value: '0.2', changed_at: '2026-10-27T16:00:00Z' }] }),
    });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] })).rejects.toThrow(/tarifa de carga por caja/);
    expect(borrados).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA: si Kepler sólo trae renglones de OTRA parada, las cajas no se saben', async () => {
    const { svc, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({ ...PADRON, 'analytics.erp_shipment_stop_load': [{ serie: 1, folio: '0001339', cajas: '999' }] }),
    });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] })).rejects.toThrow(/No se sabe cuántas cajas/);
    expect(borrados).toHaveLength(0);
  });

  it('[EMB.47] las cajas de una carga a camión de ruta en la misma guía NO se pagan', async () => {
    const { svc, inserts } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({
        'analytics.erp_shipment_stops': [{ serie: 2, folio: '0001339', cliente_code: 'TI006' }, { serie: 2, folio: '0001340', cliente_code: 'RUTA21' }],
        'analytics.erp_shipment_stop_load': [{ serie: 2, folio: '0001339', cajas: '531' }, { serie: 2, folio: '0001340', cajas: '400' }],
        'logistics.drivers': [{ id: CARGADOR_A }],
      }),
    });
    conCierre(svc);
    await svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] });
    expect(inserts[0].filas[0]).toEqual(expect.objectContaining({ boxes: 531, rate: 106.2 }));
  });

  it('PRUEBA NEGATIVA: embarque manual sin cajas capturadas no se registra', async () => {
    const manual = { ...EMB, kepler_sucursal: null, kepler_guia: null, boxes_count: 0 };
    const { svc, borrados } = baseFalsa({ primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': manual }, lista: PADRON });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] })).rejects.toThrow(/No se sabe cuántas cajas/);
    expect(borrados).toHaveLength(0);
  });

  it('PRUEBA NEGATIVA: si la carga ya está en un vale, no se cambia', async () => {
    const { svc, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB }, lista: kepler(), conteo: 1,
    });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A] })).rejects.toBeInstanceOf(ConflictException);
    expect(borrados).toHaveLength(0);
  });

  it('un cargador fuera del padrón activo frena todo', async () => {
    const { svc, borrados } = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': EMB },
      lista: kepler({ 'logistics.drivers': [{ id: CARGADOR_A }] }),
    });
    await expect(svc.setCargadores(UUID_EMB, { driver_ids: [CARGADOR_A, CARGADOR_B] })).rejects.toBeInstanceOf(BadRequestException);
    expect(borrados).toHaveLength(0);
  });

  it('embarque cancelado → 409; inexistente → 404', async () => {
    const cancelado = baseFalsa({
      primero: { 'logistics.config_finance': TARIFA, 'logistics.shipments': { ...EMB, status: 'cancelado' } },
    });
    await expect(cancelado.svc.setCargadores(UUID_EMB, { driver_ids: [] })).rejects.toBeInstanceOf(ConflictException);
    const falta = baseFalsa({ primero: { 'logistics.config_finance': TARIFA } });
    await expect(falta.svc.setCargadores(UUID_EMB, { driver_ids: [] })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripClosureController — rutas y permisos', () => {
  const meta = (fn: (...a: any[]) => any) => ({
    ruta: Reflect.getMetadata(PATH_METADATA, fn),
    verbo: Reflect.getMetadata(METHOD_METADATA, fn),
    permisos: Reflect.getMetadata(PERMISSIONS_KEY, fn),
    alguno: Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn),
  });

  it('[EMB.47] el reporte: VER del módulo, o las llaves con que Finanzas ya leía el corte', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TripClosureController)).toBe('logistics/trip-closure');
    expect(meta(TripClosureController.prototype.reporte)).toEqual({
      ruta: 'reporte', verbo: RequestMethod.GET, permisos: undefined,
      alguno: [Permission.LOGISTICS_PAGOS_VER, Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR],
    });
  });

  it('[EMB.50] el desglose se lee con las mismas llaves que el reporte, y sólo se LEE', () => {
    expect(meta(TripClosureController.prototype.desglose)).toEqual({
      ruta: 'operaciones/:sucursal/:guia/desglose', verbo: RequestMethod.GET, permisos: undefined,
      alguno: [Permission.LOGISTICS_PAGOS_VER, Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR],
    });
  });

  it('ver el cierre: VER embarques o VER del módulo Pagos de viaje', () => {
    expect(meta(TripClosureController.prototype.cierre)).toEqual({
      ruta: 'shipments/:id', verbo: RequestMethod.GET, permisos: undefined,
      alguno: [Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_PAGOS_VER],
    });
  });

  it('escribir (cerrar parada, registrar cargadores) pide GESTIONAR: el de siempre o el del módulo, nunca VER', () => {
    expect(meta(TripClosureController.prototype.cerrarParada)).toEqual({
      ruta: 'paradas/:recipientId/cierre', verbo: RequestMethod.POST, permisos: undefined,
      alguno: [Permission.LOGISTICS_GUIDES_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR],
    });
    expect(meta(TripClosureController.prototype.cargadores)).toEqual({
      ruta: 'shipments/:id/cargadores', verbo: RequestMethod.PUT, permisos: undefined,
      alguno: [Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR],
    });
    for (const fn of [TripClosureController.prototype.cerrarParada, TripClosureController.prototype.cargadores]) {
      expect(meta(fn).alguno).not.toContain(Permission.LOGISTICS_PAGOS_VER);
    }
  });
});

describe('[EMB.47] TripClosureService.reporte — cuánto le toca a cada quien de cada operación', () => {
  // Cuatro guías inventadas de la misma catorcena:
  //  A 00/0000001 traspaso a TI006, con tripulación completa y dos cargadores;
  //  B 06/0000002 entrega a cliente, sin hoja en la Suite;
  //  C 00/0000003 sólo carga a camión de ruta (no paga: fuera de alcance);
  //  D 01/0000004 traspaso + cliente, con chofer pero sin horario ni cargadores.
  const VIAJES = [
    { sucursal: '00', guia_embarque: '0000001', fecha: '2026-10-09', paradas: 1, chofer_nombre: 'CHOFER UNO', total: '1000' },
    { sucursal: '06', guia_embarque: '0000002', fecha: '2026-10-10', paradas: 2, chofer_nombre: null, total: '500.5' },
    { sucursal: '00', guia_embarque: '0000003', fecha: '2026-10-10', paradas: 1, chofer_nombre: 'CHOFER RUTA', total: '9000' },
    { sucursal: '01', guia_embarque: '0000004', fecha: '2026-10-08', paradas: 2, chofer_nombre: 'CHOFER DOS', total: '700' },
  ];
  const PARADAS = [
    { sucursal: '00', guia_embarque: '0000001', serie: 2, folio: 'F1', cliente_code: 'TI006', destino_nombre: 'SUCURSAL ZAMORA CANINDO' },
    { sucursal: '06', guia_embarque: '0000002', serie: 1, folio: 'F2', cliente_code: 'C0001', destino_nombre: 'CLIENTE PRUEBA' },
    { sucursal: '06', guia_embarque: '0000002', serie: 1, folio: 'F3', cliente_code: 'C0002', destino_nombre: 'CLIENTE PRUEBA DOS' },
    { sucursal: '00', guia_embarque: '0000003', serie: 2, folio: 'F4', cliente_code: 'RUTA21', destino_nombre: 'R.D. 21 PH PRUEBA' },
    { sucursal: '01', guia_embarque: '0000004', serie: 2, folio: 'F5', cliente_code: 'TI001', destino_nombre: 'SUCURSAL PADRE HIDALGO' },
    { sucursal: '01', guia_embarque: '0000004', serie: 1, folio: 'F6', cliente_code: 'C0003', destino_nombre: 'CLIENTE TRES' },
  ];
  // Kepler: B lleva 10 + 5 cajas; la carga a ruta de C trae 400 que no deben aparecer en ningún lado.
  const CAJAS = [
    { sucursal: '06', serie: 1, folio: 'F2', cajas: '10' },
    { sucursal: '06', serie: 1, folio: 'F3', cajas: '5' },
    { sucursal: '00', serie: 2, folio: 'F4', cajas: '400' },
    { sucursal: '00', serie: 2, folio: 'F1', cajas: '480' },
  ];
  const SUITE = [
    { shipment_id: 's-a', folio: 'EMB-A', kepler_sucursal: '00', kepler_guia: '0000001', guide_id: 'g-a', driver_id: 'd1',
      helper1_id: 'h1', helper2_id: null, driver_commission: '300', helper1_commission: '150', helper2_commission: '0',
      viatico_driver: '125', viatico_helper1: '125', viatico_helper2: null,
      departure_time: '05:30:00', arrival_time: '16:10:00', overnight: false },
    { shipment_id: 's-d', folio: 'EMB-D', kepler_sucursal: '01', kepler_guia: '0000004', guide_id: 'g-d', driver_id: 'd2',
      helper1_id: null, helper2_id: null, driver_commission: null, helper1_commission: null, helper2_commission: null,
      viatico_driver: null, viatico_helper1: null, viatico_helper2: null,
      departure_time: null, arrival_time: null, overnight: false },
  ];
  // Lo guardado al registrar a los cargadores: 500 cajas × $0.20 = $100, $50 cada quien.
  const CARGAS = [
    { shipment_id: 's-a', driver_id: CARGADOR_A, rate: '50', boxes: '500', rate_per_box: '0.2' },
    { shipment_id: 's-a', driver_id: CARGADOR_B, rate: '50', boxes: '500', rate_per_box: '0.2' },
  ];
  // d2 no está en el padrón activo: su nombre no se inventa.
  const DRIVERS = [
    { id: 'd1', full_name: 'CHOFER PRUEBA', roles: ['chofer'] },
    { id: 'h1', full_name: 'AYUDANTE PRUEBA', roles: ['ayudante'] },
    { id: CARGADOR_A, full_name: 'CARGADOR A', roles: ['ayudante'] },
    { id: CARGADOR_B, full_name: 'CARGADOR B', roles: ['ayudante'] },
  ];
  const lista = {
    'analytics.erp_shipment_trips': VIAJES, 'analytics.erp_shipment_stops': PARADAS, 'analytics.erp_shipment_stop_load': CAJAS,
    __raw: SUITE, 'logistics.load_details': CARGAS, 'logistics.drivers': DRIVERS,
  };
  const primero = { 'logistics.config_finance': { id: 'cfg-1', value: '0.2000', active: true } };
  const porGuia = async (r = { lista, primero }) => {
    const { svc } = baseFalsa(r);
    const rep = await svc.reporte('2026-10-08', '2026-10-21');
    return { rep, por: Object.fromEntries(rep.operaciones.map((o) => [o.guia, o])) };
  };

  it('las cargas a camión de ruta quedan fuera y se CUENTAN, no se esconden', async () => {
    const { rep } = await porGuia();
    expect(rep.fuera_de_alcance).toBe(1);
    expect(rep.operaciones.map((o) => o.guia)).not.toContain('0000003');
    expect(rep.operaciones).toHaveLength(3);
  });

  it('dice qué le falta a cada operación y pone primero lo que más falta', async () => {
    const { rep, por } = await porGuia();
    expect(por['0000002'].faltan).toEqual(['chofer', 'horario', 'cargadores']);
    expect(por['0000004'].faltan).toEqual(['horario', 'cargadores']);
    expect(por['0000001'].faltan).toEqual([]);
    expect(rep.operaciones.map((o) => o.guia)).toEqual(['0000002', '0000004', '0000001']);
  });

  it('reparte comisión, viático y carga por persona con el concepto de Kepler del traspaso', async () => {
    const { por } = await porGuia();
    const a = por['0000001'];
    expect(a.renglones.map((r) => [r.persona, r.rol, r.codigo, r.importe])).toEqual([
      ['CHOFER PRUEBA', 'chofer', '054', 300],
      ['CHOFER PRUEBA', 'chofer', '027', 125],
      ['AYUDANTE PRUEBA', 'ayudante', '054', 150],
      ['AYUDANTE PRUEBA', 'ayudante', '027', 125],
      ['CARGADOR A', 'cargador', '054', 50],
      ['CARGADOR B', 'cargador', '054', 50],
    ]);
    expect(a.repartido).toBe(800);
    expect(a.cargador_ids).toEqual([CARGADOR_A, CARGADOR_B]);
  });

  it('con cargadores, cajas y tarifa son las GUARDADAS, no las de hoy', async () => {
    const { por } = await porGuia({ lista, primero: { 'logistics.config_finance': { id: 'cfg-1', value: '0.5000', active: true } } });
    expect(por['0000001']).toEqual(expect.objectContaining({ cajas: 500, tarifa_por_caja: 0.2, carga_total: 100, cargadores: 2 }));
  });

  it('sin cargadores, la carga se calcula: cajas de Kepler × tarifa vigente ese día', async () => {
    const { por } = await porGuia();
    expect(por['0000002']).toEqual(expect.objectContaining({
      tipo: 'cliente', cajas: 15, tarifa_por_caja: 0.2, carga_total: 3, renglones: [], repartido: 0, shipment_id: null,
    }));
  });

  it('PRUEBA NEGATIVA: sin renglones en Kepler las cajas son null y la carga no se inventa', async () => {
    const { por } = await porGuia();
    expect(por['0000004']).toEqual(expect.objectContaining({ tipo: 'mixto', cajas: null, carga_total: null }));
  });

  it('PRUEBA NEGATIVA: sin tarifa activa la carga es null, no $0', async () => {
    const { por } = await porGuia({ lista, primero: {} as any });
    expect(por['0000002']).toEqual(expect.objectContaining({ cajas: 15, tarifa_por_caja: null, carga_total: null }));
  });

  it('quien no está en el padrón activo sale declarado, no con otro nombre', async () => {
    const conComision = [SUITE[0], { ...SUITE[1], driver_commission: '200', departure_time: '06:00:00', arrival_time: '14:00:00' }];
    const { por } = await porGuia({ lista: { ...lista, __raw: conComision }, primero });
    expect(por['0000004'].renglones).toEqual([expect.objectContaining({ persona_id: 'd2', persona: 'Persona sin nombre en el padrón', codigo: '054' })]);
  });

  it('destinos que pagan, chofer de Kepler, padrón y corte', async () => {
    const { rep, por } = await porGuia();
    expect(por['0000004'].destinos).toBe('SUCURSAL PADRE HIDALGO · CLIENTE TRES');
    expect(por['0000002']).toEqual(expect.objectContaining({ chofer_kepler: null, importe: 500.5 }));
    expect(por['0000001']).toEqual(expect.objectContaining({ shipment_folio: 'EMB-A', departure_time: '05:30', arrival_time: '16:10' }));
    expect(rep.personas).toHaveLength(4);
    expect(rep.corte).toEqual({ desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' });
  });

  it('PRUEBA NEGATIVA: un viaje tomado SIN guía no se da por completo (falta chofer y horario)', async () => {
    const sinGuia = { ...SUITE[0], guide_id: null, driver_id: null, helper1_id: null, departure_time: null, arrival_time: null };
    const { por } = await porGuia({ lista: { ...lista, __raw: [sinGuia] }, primero });
    expect(por['0000001'].faltan).toEqual(['chofer', 'horario']);
  });

  it('sucursal o fechas mal formadas: 400', async () => {
    const { svc } = baseFalsa({ lista });
    await expect(svc.reporte(undefined, undefined, 'Morelia')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.reporte('2026-10-21', '2026-10-08')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.reporte('08/10/2026', '2026-10-21')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('[EMB.47] renglonesDeLaOperacion y cajasPorGuia', () => {
  const suite = {
    shipment_id: 's', folio: 'F', kepler_sucursal: '00', kepler_guia: 'G', guide_id: 'g', driver_id: 'd1', helper1_id: null, helper2_id: null,
    driver_commission: '300', helper1_commission: null, helper2_commission: null, viatico_driver: '100', viatico_helper1: null, viatico_helper2: null,
    departure_time: '06:00:00', arrival_time: '15:00:00', overnight: false,
  };
  const nombre = (id: string) => `N-${id}`;

  it('entrega a cliente: 075 comisión y 128 viático; la carga va a 054', () => {
    const r = renglonesDeLaOperacion('cliente', suite, [{ shipment_id: 's', driver_id: 'c1', rate: '12.5', boxes: '62.5', rate_per_box: '0.2' }], nombre);
    expect(r.map((x) => [x.persona, x.concepto, x.codigo])).toEqual([
      ['N-d1', 'comision', '075'], ['N-d1', 'viatico', '128'], ['N-c1', 'carga', '054'],
    ]);
  });

  it('un viaje mixto se pide como traspaso', () => {
    expect(renglonesDeLaOperacion('mixto', suite, [], nombre).map((x) => x.codigo)).toEqual(['054', '027']);
  });

  it('montos en cero o vacíos no generan renglón', () => {
    const r = renglonesDeLaOperacion('traspaso', { ...suite, driver_commission: '0', viatico_driver: null }, [], nombre);
    expect(r).toEqual([]);
  });

  it('cajas: sin la carga a ruta, el mismo documento una vez, null si Kepler no trae renglones, 0 si son piezas', () => {
    const p = (guia: string, folio: string, cc = 'TI001') => ({ sucursal: '00', guia_embarque: guia, serie: 2, folio, cliente_code: cc, destino_nombre: null });
    const c = cajasPorGuia(
      [p('G1', 'A'), p('G1', 'A'), p('G1', 'R', 'RUTA21'), p('G2', 'B'), p('G3', 'C')],
      [{ sucursal: '00', serie: 2, folio: 'A', cajas: '7' }, { sucursal: '00', serie: 2, folio: 'R', cajas: '99' }, { sucursal: '00', serie: '2', folio: 'C', cajas: '0' }],
    );
    expect(c.get('00|G1')).toBe(7);
    expect(c.get('00|G2')).toBeNull();
    expect(c.get('00|G3')).toBe(0);
  });

  it('PRUEBA NEGATIVA: un folio igual en OTRA sucursal no suma', () => {
    const c = cajasPorGuia(
      [{ sucursal: '00', guia_embarque: 'G1', serie: 2, folio: 'A', cliente_code: 'TI001', destino_nombre: null }],
      [{ sucursal: '06', serie: 2, folio: 'A', cajas: '50' }],
    );
    expect(c.get('00|G1')).toBeNull();
  });
});

describe('[EMB.48] el reporte dice lo que ya se sabe sin capturar nada', () => {
  // «Todos los viajes salen en 0» (Edgar, 2026-10-26). Cuatro guías inventadas:
  //  T 0000010 traspaso con chofer de Kepler (00003, en el padrón) y ruta con tarifa;
  //  A 0000011 sólo tiempo aire (SKU 00022): no es un viaje que cargar;
  //  M 0000012 mercancía y tiempo aire en el mismo documento;
  //  C 0000013 guía ya completa con el mismo chofer: su comisión es la capturada, sin duplicar.
  const VIAJES = [
    { sucursal: '00', guia_embarque: '0000010', fecha: '2026-10-22', paradas: 1, chofer_code: '00003', chofer_nombre: 'CHOFER KEPLER', total: '100' },
    { sucursal: '00', guia_embarque: '0000011', fecha: '2026-10-22', paradas: 1, chofer_code: null, chofer_nombre: null, total: '980' },
    { sucursal: '00', guia_embarque: '0000012', fecha: '2026-10-22', paradas: 1, chofer_code: '99999', chofer_nombre: 'NO ESTA', total: '50' },
    { sucursal: '00', guia_embarque: '0000013', fecha: '2026-10-23', paradas: 1, chofer_code: '00003', chofer_nombre: 'CHOFER KEPLER', total: '70' },
  ];
  const p = (guia: string, folio: string, ruta: string | null) => ({
    sucursal: '00', guia_embarque: guia, serie: 2, folio, cliente_code: 'TI001', destino_nombre: 'TRASPASO A SUCURSAL PRUEBA',
    ruta_clave: ruta, ruta_nombre: ruta === 'R0009' ? 'LA PIEDAD' : 'RUTA SIN TARIFA',
  });
  const lista = {
    'analytics.erp_shipment_trips': VIAJES,
    'analytics.erp_shipment_stops': [p('0000010', 'F10', 'R0009'), p('0000011', 'F11', 'R0009'), p('0000012', 'F12', 'R9999'), p('0000013', 'F13', 'R0009')],
    'analytics.erp_shipment_stop_load': [
      { sucursal: '00', serie: 2, folio: 'F10', cajas: '50', sueltos: '20', renglones: 3 },
      { sucursal: '00', serie: 2, folio: 'F11', cajas: '0', sueltos: '1207', renglones: 1 },
      { sucursal: '00', serie: 2, folio: 'F12', cajas: '10', sueltos: '1250', renglones: 2 },
      { sucursal: '00', serie: 2, folio: 'F13', cajas: '5', sueltos: '0', renglones: 1 },
    ],
    __sin_carga: [
      { sucursal: '00', serie: 2, folio: 'F11', cantidad: '1207', renglones: 1 },
      { sucursal: '00', serie: 2, folio: 'F12', cantidad: '1000', renglones: 1 },
    ],
    __raw: [{
      shipment_id: 's-c', folio: 'EMB-C', kepler_sucursal: '00', kepler_guia: '0000013', guide_id: 'g-c', driver_id: 'd3',
      helper1_id: null, helper2_id: null, driver_commission: '150', helper1_commission: '0', helper2_commission: '0',
      viatico_driver: '100', viatico_helper1: null, viatico_helper2: null, departure_time: '06:00:00', arrival_time: '15:00:00', overnight: false,
    }],
    'logistics.routes': [{ id: 'r1', name: 'LA PIEDAD', kepler_code: 'R0009', driver_commission: '150', helper_commission: '100', sin_comision: false }],
    'logistics.drivers': [{ id: 'd3', full_name: 'CHOFER KEPLER', roles: ['chofer'], kepler_code: '00003' }],
  };
  const primero = { 'logistics.config_finance': { id: 'cfg-1', value: '0.2000', active: true } };
  const reporte = async (l: Record<string, any[]> = lista) => {
    const { svc } = baseFalsa({ lista: l, primero });
    const rep = await svc.reporte('2026-10-22', '2026-11-04');
    return { rep, por: Object.fromEntries(rep.operaciones.map((o) => [o.guia, o])) };
  };

  it('la guía de puro tiempo aire NO es una operación: se cuenta aparte', async () => {
    const { rep } = await reporte();
    expect(rep.solo_tiempo_aire).toBe(1);
    expect(rep.operaciones.map((o) => o.guia)).not.toContain('0000011');
  });

  it('sin capturar nada: la carga y la comisión de la ruta, ya asignada al chofer de Kepler', async () => {
    const { por } = await reporte();
    expect(por['0000010']).toEqual(expect.objectContaining({
      cajas: 50, sueltos: 20, carga_total: 10, chofer_kepler_id: 'd3', faltan: ['horario', 'cargadores'],
      comision_ruta: { chofer: 150, ayudante: 100, ruta: 'LA PIEDAD', sin_tarifa: [] },
    }));
    expect(por['0000010'].renglones).toEqual([expect.objectContaining({
      persona: 'CHOFER KEPLER', rol: 'chofer', concepto: 'comision', codigo: '054', importe: 150, fuente: 'kepler',
    })]);
    expect(por['0000010'].repartido).toBe(150);
  });

  it('el tiempo aire se descuenta de los sueltos de un documento que también lleva mercancía', async () => {
    const { por } = await reporte();
    expect(por['0000012']).toEqual(expect.objectContaining({ cajas: 10, sueltos: 250 }));
  });

  it('PRUEBA NEGATIVA: ruta sin tarifa → comisión null con la ruta nombrada, sin renglón inventado', async () => {
    const { por } = await reporte();
    expect(por['0000012'].comision_ruta).toEqual({ chofer: null, ayudante: null, ruta: null, sin_tarifa: ['RUTA SIN TARIFA'] });
    expect(por['0000012'].renglones).toEqual([]);
  });

  it('PRUEBA NEGATIVA: un chofer de Kepler que no está en el padrón no se asigna (sigue faltando)', async () => {
    const { por } = await reporte();
    expect(por['0000012'].chofer_kepler_id).toBeNull();
    expect(por['0000012'].faltan).toContain('chofer');
  });

  it('PRUEBA NEGATIVA: con la guía completa manda lo capturado; la comisión de Kepler NO se suma encima', async () => {
    const { por } = await reporte();
    expect(por['0000013'].renglones.map((r) => [r.concepto, r.importe, r.fuente])).toEqual([['comision', 150, 'captura'], ['viatico', 100, 'captura']]);
    expect(por['0000013'].repartido).toBe(250);
  });
});

describe('[EMB.50] documentosDelDesglose — la operación documento por documento', () => {
  const paradas = [
    { serie: 2, folio: 'F1', cliente_code: 'TI001', destino_nombre: 'TRASPASO A SUCURSAL PRUEBA', usuario_captura: '9ABC', hora_captura: '10:39' },
    { serie: 2, folio: 'F1', cliente_code: 'TI001', destino_nombre: 'TRASPASO A SUCURSAL PRUEBA', usuario_captura: '9ABC', hora_captura: '10:39' },
    { serie: 1, folio: 'F2', cliente_code: 'C0001', destino_nombre: 'CLIENTE PRUEBA', usuario_captura: null, hora_captura: null },
    { serie: 2, folio: 'F3', cliente_code: 'RUTA21', destino_nombre: 'R.D. 21', usuario_captura: null, hora_captura: null },
  ];
  const cabeceras = [{ serie: 2, folio: 'F1', resp_surtido: '01', resp_checado: '001', resp_embarque: '01' }];
  const cierres = [
    { serie: 2, folio: 'F1', destino_sucursal: '01', recepcion_folio: 'R9', recepcion_fecha: new Date(2026, 9, 22), diferencia: '-12.5', cierre_kepler: 'faltante' },
    { serie: 1, folio: 'F2', destino_sucursal: null, recepcion_folio: null, recepcion_fecha: null, diferencia: null, cierre_kepler: 'la_cierra_la_suite' },
  ];
  const renglones = [
    { serie: 2, folio: 'F1', linea: '2', sku: '100', cantidad: '3', presentacion: 'CJA' },
    { serie: 2, folio: 'F1', linea: '1', sku: '200', cantidad: '536.94', presentacion: 'KG' },
    { serie: 2, folio: 'F1', linea: '3', sku: '00022', cantidad: '1000', presentacion: 'PZA' },
    { serie: 2, folio: 'F1', linea: '4', sku: '300', cantidad: '2', presentacion: 'BTO' },
    { serie: 2, folio: 'F1', linea: '5', sku: '400', cantidad: '9', presentacion: null },
    { serie: 1, folio: 'F2', linea: '1', sku: '100', cantidad: '4', presentacion: 'PAQ' },
    { serie: 2, folio: 'F3', linea: '1', sku: '100', cantidad: '50', presentacion: 'CJA' },
  ];
  const catalogo = {
    surtido: [{ codigo: '01', nombre: 'SURTIDOR PRUEBA' }],
    checado: [{ codigo: '1', nombre: 'UNO' }, { codigo: '01', nombre: 'OTRO' }],
    embarque: [{ codigo: '01', nombre: 'EMBARCADOR PRUEBA' }],
  };
  const productos = new Map([['100', 'PRODUCTO CIEN'], ['00022', 'TIEMPO AIRE']]);
  const docs = documentosDelDesglose(paradas, cabeceras, cierres, renglones, catalogo, productos, new Map([['01|R9', '10XYZ']]));
  const por = Object.fromEntries(docs.map((d) => [d.folio, d]));

  it('un documento repetido en la guía sale una vez', () => {
    expect(docs.map((d) => d.folio)).toEqual(['F2', 'F1', 'F3']);
  });

  it('cajas = CJA y BTO; sueltas = otra presentación; sin presentación no cuenta; el tiempo aire no cuenta', () => {
    expect(por['F1']).toEqual(expect.objectContaining({ cajas: 5, sueltos: 536.94 }));
    expect(por['F1'].renglones.map((r) => [r.linea, r.sku, r.cajas, r.sin_carga])).toEqual([
      [1, '200', 0, false], [2, '100', 3, false], [3, '00022', 0, true], [4, '300', 2, false], [5, '400', 0, false],
    ]);
    expect(por['F1'].renglones[1].producto).toBe('PRODUCTO CIEN');
    expect(por['F2']).toEqual(expect.objectContaining({ cajas: 0, sueltos: 4 }));
  });

  it('PRUEBA NEGATIVA: una carga a ruta no paga: 0 cajas aunque lleve 50, pero sus renglones se ven', () => {
    expect(por['F3']).toEqual(expect.objectContaining({ tipo: 'carga_ruta', cajas: 0, sueltos: 0 }));
    expect(por['F3'].renglones).toHaveLength(1);
  });

  it('quién surtió/checó/embarcó con el catálogo de Kepler; una clave ambigua NO se adivina', () => {
    expect(por['F1'].surtio).toEqual({ codigo: '01', nombre: 'SURTIDOR PRUEBA' });
    expect(por['F1'].embarco).toEqual({ codigo: '01', nombre: 'EMBARCADOR PRUEBA' });
    expect(por['F1'].checo).toEqual({ codigo: '001', nombre: null });
    expect(por['F2'].surtio).toEqual({ codigo: null, nombre: null });
  });

  it('la recepción del traspaso: folio, día, quién la capturó y si llegó completa', () => {
    expect(por['F1'].recepcion).toEqual({ sucursal: '01', folio: 'R9', fecha: '2026-10-22', capturo: '10XYZ', diferencia: -12.5, estado: 'faltante' });
    expect(por['F1'].capturo).toBe('9ABC');
  });

  it('PRUEBA NEGATIVA: una entrega a cliente no tiene recepción de sucursal', () => {
    expect(por['F2'].recepcion).toBeNull();
  });
});

describe('[EMB.50] TripClosureService.desglose — entradas', () => {
  it('sucursal o guía mal formadas: 400; guía que Kepler no tiene: 404', async () => {
    const { svc } = baseFalsa({ lista: {} });
    await expect(svc.desglose('Morelia', '0001')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.desglose('00', 'G-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.desglose('00', '0009999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('suma del desglose = suma de sus documentos que pagan', async () => {
    const { svc } = baseFalsa({ lista: {
      'analytics.erp_shipment_stops': [{ serie: 2, folio: 'F1', cliente_code: 'TI001', destino_nombre: 'X', usuario_captura: null, hora_captura: null }],
      __sin_carga: [{ serie: 2, folio: 'F1', linea: '1', sku: '100', cantidad: '7', presentacion: 'CJA' }],
    } });
    const d = await svc.desglose('00', '0000001');
    expect(d).toEqual(expect.objectContaining({ sucursal: '00', guia: '0000001', cajas: 7, sueltos: 0 }));
  });
});

describe('[EMB.51] cada importe dice cómo salió', () => {
  const nombre = (id: string) => `N-${id}`;
  const breakdown = {
    horario: { salida: '05:30', llegada: '16:10', duerme_fuera: false },
    tarifas: { cafe: 25, desayuno: 100, comida: 100, cena: 100 },
    driver: { va: true, cafe: true, desayuno: true, comida: true, cena: false, subtotal: 225 },
    helper1: { va: true, cafe: true, desayuno: true, comida: true, cena: false, subtotal: 225 },
  };
  const suite = {
    shipment_id: 's', folio: 'F', kepler_sucursal: '00', kepler_guia: 'G', guide_id: 'g', driver_id: 'd1', helper1_id: 'h1', helper2_id: null,
    driver_commission: '180', helper1_commission: '120', helper2_commission: '0', viatico_driver: '225', viatico_helper1: '225', viatico_helper2: null,
    departure_time: '05:30:00', arrival_time: '16:10:00', overnight: false, per_diem_breakdown: breakdown,
  };

  it('pesos con miles y dos decimales, igual en cualquier servidor', () => {
    expect(pesos(61.92)).toBe('$61.92');
    expect(pesos(1729.2)).toBe('$1,729.20');
    expect(pesos(-12.5)).toBe('-$12.50');
  });

  it('comisión de Kepler: la tarifa y la ruta', () => {
    const r = renglonesDeLaOperacion('traspaso', null, [], nombre, { chofer_id: 'd1', comision: 61.92, ruta: 'YURECUARO' });
    expect(r[0].calculo).toBe('Tarifa de la ruta YURECUARO: $61.92 al chofer (el que trae Kepler; se confirma al guardar el horario)');
  });

  it('viático: el horario y las comidas que tocaron, con su tarifa', () => {
    const r = renglonesDeLaOperacion('traspaso', suite, [], nombre, { chofer_id: 'd1', comision: 180, ruta: 'MORELIA' });
    const viatico = r.find((x) => x.persona_id === 'd1' && x.concepto === 'viatico');
    expect(viatico?.calculo).toBe('Salida 05:30, llegada 16:10: café $25.00 + desayuno $100.00 + comida $100.00');
    expect(r.find((x) => x.persona_id === 'h1' && x.concepto === 'comision')?.calculo).toBe('Comisión de la guía: tarifa de la ruta MORELIA para el ayudante');
  });

  it('carga: cajas × tarifa = total, entre cuántos', () => {
    const cargas = [
      { shipment_id: 's', driver_id: 'c1', rate: '4.2', boxes: '42', rate_per_box: '0.2' },
      { shipment_id: 's', driver_id: 'c2', rate: '4.2', boxes: '42', rate_per_box: '0.2' },
    ];
    expect(renglonesDeLaOperacion('traspaso', null, cargas, nombre)[0].calculo).toBe('42 cajas × $0.20 = $8.40 entre 2 cargadores');
  });

  it('PRUEBA NEGATIVA: sin desglose de viático o sin cajas guardadas, se DICE, no se inventa', () => {
    expect(calculoDeViatico(null, 'driver')).toBe('Viático de la guía (sin desglose guardado)');
    expect(calculoDeCarga({ shipment_id: 's', driver_id: 'c1', rate: '30', boxes: null, rate_per_box: null }, 1))
      .toBe('Carga por persona (regla anterior a la tarifa por caja)');
  });
});

describe('[EMB.53] el centro de costo de cada operación', () => {
  // El catálogo de Kepler (kdc3) con los pisos reales y un intruso que no es piso.
  const KDC3 = [
    { codigo: '1-01-10-00', nombre: 'PADRE HIDALGO PISO.' },
    { codigo: '1-01-40-00', nombre: 'OCHO ESQUINAS PISO DE VENTA.' },
    { codigo: '1-01-42-00', nombre: 'LA PIEDAD ABASTOS PISO.' },
    { codigo: '1-02-30-00', nombre: 'MORELIA ABASTOS.' },
    { codigo: '1-08-00-00', nombre: 'CEDIS.' },
  ];
  const centros = centrosDePiso(KDC3);
  const ti = new Map([['TI001', '01'], ['TI002', '03'], ['TI008', '02'], ['TI004', '08']]);
  const p = (cliente_code: string, serie = 2) => ({ sucursal: '00', guia_embarque: 'G', serie, folio: 'F', cliente_code, destino_nombre: null });

  it('cada sucursal a su piso por su código MD (MD-42 La Piedad Abastos → 1-01-42-00)', () => {
    expect(centros.get('01')?.codigo).toBe('1-01-10-00');
    expect(centros.get('03')).toEqual({ codigo: '1-01-40-00', nombre: 'OCHO ESQUINAS PISO DE VENTA.' });
    expect(centros.get('02')?.codigo).toBe('1-01-42-00');
    expect(centros.get('08')?.codigo).toBe('1-02-30-00');
    expect(centros.get('00')?.codigo).toBe('1-08-00-00');
  });

  it('PRUEBA NEGATIVA: si el catálogo trae dos candidatos para un piso, esa sucursal se queda SIN centro', () => {
    const doble = centrosDePiso([...KDC3, { codigo: '1-02-10-00', nombre: 'OTRO PISO 10' }]);
    expect(doble.get('01')).toBeUndefined();
    expect(doble.get('03')?.codigo).toBe('1-01-40-00');
  });

  it('un traspaso a una sola sucursal va a su piso; la carga a ruta de la misma guía no cuenta', () => {
    expect(centroDeOperacion([p('TI002'), p('TI002'), p('RUTA21')], ti, centros))
      .toEqual({ centro: { codigo: '1-01-40-00', nombre: 'OCHO ESQUINAS PISO DE VENTA.' }, sin_centro: null });
  });

  it('PRUEBA NEGATIVA: varios destinos, cliente o un TI desconocido NO se adivinan', () => {
    expect(centroDeOperacion([p('TI001'), p('TI002')], ti, centros)).toEqual({ centro: null, sin_centro: 'varios_destinos' });
    expect(centroDeOperacion([p('C0001', 1)], ti, centros)).toEqual({ centro: null, sin_centro: 'cliente' });
    expect(centroDeOperacion([p('TI001'), p('C0001', 1)], ti, centros)).toEqual({ centro: null, sin_centro: 'cliente' });
    expect(centroDeOperacion([p('TI999')], ti, centros)).toEqual({ centro: null, sin_centro: 'sin_catalogo' });
  });

  describe('[EMB.54] el centro de la plaza: Morelia Madero → Morelia Abastos, Zamora Centro → Canindo', () => {
    const abastos = { codigo: '1-02-30-00', nombre: 'MORELIA ABASTOS.' };
    const canindo = { codigo: '1-03-50-00', nombre: 'CANINDO .' };
    const ocho = { codigo: '1-01-40-00', nombre: 'OCHO ESQUINAS PISO DE VENTA.' };
    const plazas = new Map([
      ['08', abastos], ['07', { codigo: '1-02-32-00', nombre: 'MORELIA MADERO PISO VENTAS.' }],
      ['06', canindo], ['05', { codigo: '1-03-54-00', nombre: 'ZAMORA CENTRO PISO DE VENT' }], ['03', ocho],
    ]);
    const tis = new Map([['TI004', '08'], ['TI007', '07'], ['TI006', '06'], ['TI005', '05'], ['TI002', '03']]);

    it('un traspaso sólo a Madero va al centro de Abastos; sólo a Zamora Centro, al de Canindo', () => {
      expect(centroDeOperacion([p('TI007')], tis, plazas)).toEqual({ centro: abastos, sin_centro: null });
      expect(centroDeOperacion([p('TI005')], tis, plazas)).toEqual({ centro: canindo, sin_centro: null });
    });

    it('las dos sucursales de la plaza son UN destino, no «varios»', () => {
      expect(centroDeOperacion([p('TI007'), p('TI004')], tis, plazas)).toEqual({ centro: abastos, sin_centro: null });
      expect(centroDeOperacion([p('TI005'), p('TI006')], tis, plazas)).toEqual({ centro: canindo, sin_centro: null });
    });

    it('PRUEBA NEGATIVA: dos plazas distintas siguen siendo varios destinos, y 8 Esquinas conserva su centro', () => {
      expect(centroDeOperacion([p('TI007'), p('TI002')], tis, plazas)).toEqual({ centro: null, sin_centro: 'varios_destinos' });
      expect(centroDeOperacion([p('TI004'), p('TI006')], tis, plazas)).toEqual({ centro: null, sin_centro: 'varios_destinos' });
      expect(centroDeOperacion([p('TI002')], tis, plazas)).toEqual({ centro: ocho, sin_centro: null });
    });
  });
});
