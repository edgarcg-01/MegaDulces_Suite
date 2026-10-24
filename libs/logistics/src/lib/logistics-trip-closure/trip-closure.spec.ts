import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Permission, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { TripClosureController } from './trip-closure.controller';
import { TripClosureService } from './trip-closure.service';

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
      whereNull: () => b, whereNot: () => b, whereIn: () => b, join: () => b, leftJoin: () => b,
      orderBy: () => b, orderByRaw: () => b, select: () => b, forUpdate: () => b, distinct: () => b,
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
  trx.raw = (sql: string) => ({ sql });
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
  });

  it('ver el cierre pide sólo VER embarques', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TripClosureController)).toBe('logistics/trip-closure');
    expect(meta(TripClosureController.prototype.cierre)).toEqual({
      ruta: 'shipments/:id', verbo: RequestMethod.GET, permisos: [Permission.LOGISTICS_SHIPMENTS_VER],
    });
  });

  it('cerrar una parada pide GESTIONAR guías; registrar cargadores, GESTIONAR embarques', () => {
    expect(meta(TripClosureController.prototype.cerrarParada)).toEqual({
      ruta: 'paradas/:recipientId/cierre', verbo: RequestMethod.POST, permisos: [Permission.LOGISTICS_GUIDES_GESTIONAR],
    });
    expect(meta(TripClosureController.prototype.cargadores)).toEqual({
      ruta: 'shipments/:id/cargadores', verbo: RequestMethod.PUT, permisos: [Permission.LOGISTICS_SHIPMENTS_GESTIONAR],
    });
  });
});
