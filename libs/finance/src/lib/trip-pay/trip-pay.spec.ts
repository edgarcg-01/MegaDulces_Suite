import 'reflect-metadata';
vi.mock('../shared/chromium-pdf', () => ({ htmlAPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-prueba')) }));
import { BadRequestException, ConflictException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS_KEY, Permission } from '@megadulces/platform-core';
import { TripPayController } from './trip-pay.controller';
import { TripPayService } from './trip-pay.service';

/**
 * `[EMB.29]` — El vale de comisiones y viáticos de logística (ADR-091).
 *
 * El corte y el resumen ya tienen su spec (`trip-pay.logic.spec.ts`) y el «no se paga dos
 * veces» su candado contra Postgres (índice único, `test-newdb-emb-pago-por-viaje.js`). Aquí,
 * lo que arma el servicio: que el vale lleve SÓLO lo liberado y no pagado, que quede a nombre
 * de quien lo preparó (así no puede aprobarlo él mismo) y que una carrera termine en 409 sin
 * dejar la hoja PDF huérfana. Base de mentira; nombres inventados.
 */

const PERSONA = '66666666-6666-4666-8666-666666666666';
const VALE = '77777777-7777-4777-8777-777777777777';
const CORTE = { desde: '2026-09-24', hasta: '2026-10-07' };

const fila = (o: Record<string, any>) => ({
  source: 'guia', source_id: 'g1', shipment_id: 's1', shipment_folio: 'EMB-2026-00001', kepler_sucursal: '01',
  kepler_guia: '0001597', shipment_date: '2026-09-30', guide_number: 'GUIA-1', driver_id: PERSONA,
  persona: 'CHOFER PRUEBA', rol: 'chofer', concept: 'comision', amount: '129.00', estado_viaje: 'cerrado',
  liberado: true, motivo: 'Viaje cerrado', en_vale: false, expense_proof_id: null, vale_status: null, vale_folio: null,
  ...o,
});

function baseFalsa(items: any[], opts: { falla?: any } = {}) {
  const inserts: Array<{ tabla: string; filas: any }> = [];
  const updates: Array<{ tabla: string; datos: any }> = [];
  const trx: any = (tabla: string) => {
    const b: any = {
      where: () => b, whereIn: () => b, whereBetween: () => b, orderBy: () => b, select: () => b,
      first: async () => (tabla === 'logistics.drivers' ? { full_name: 'CHOFER PRUEBA' } : undefined),
      update: async (datos: any) => { updates.push({ tabla, datos }); return 0; },
      insert: (filas: any) => {
        if (opts.falla && tabla === 'finance.trip_pay_lines') throw opts.falla;
        inserts.push({ tabla, filas });
        return { returning: async () => [{ id: VALE }], then: (ok: any) => Promise.resolve([]).then(ok) };
      },
      then: (ok: any, ko: any) => Promise.resolve(tabla === 'logistics.v_trip_pay_items' ? items : []).then(ok, ko),
    };
    return b;
  };
  trx.fn = { now: () => 'NOW()' };
  trx.raw = (sql: string) => ({ sql });
  const tk: any = { run: async (fn: (t: any) => any) => fn(trx) };
  const ctx: any = { requireTenantId: () => 'tenant-prueba' };
  const storage: any = {
    putBuffer: vi.fn().mockResolvedValue({ key: 'finance/tenant-prueba/expense-proofs/hoja.pdf' }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { svc: new TripPayService(tk, ctx, storage), storage, inserts, updates };
}

describe('TripPayService.crearVale', () => {
  const ITEMS = [
    fila({ source_id: 'g1', concept: 'comision', amount: '129.00' }),
    fila({ source_id: 'g1', concept: 'viatico', amount: '200.00' }),
    fila({ source: 'carga', source_id: 'c1', concept: 'maniobra_carga', amount: '30', kepler_sucursal: '02' }),
    // Lo que NO debe entrar al vale:
    fila({ source_id: 'g2', concept: 'comision', amount: '500', liberado: false, estado_viaje: 'abierto', motivo: 'Faltan paradas' }),
    fila({ source_id: 'g3', concept: 'comision', amount: '700', en_vale: true, expense_proof_id: 'otro-vale' }),
    fila({ source_id: 'g4', concept: 'comision', amount: '900', estado_viaje: 'cancelado' }),
  ];

  it('arma el vale sólo con lo liberado y sin pagar, a nombre de quien lo preparó', async () => {
    const { svc, storage, inserts } = baseFalsa(ITEMS);
    const v = await svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, 'Quien Prepara');
    expect(v).toEqual({ id: VALE, importe: 359, renglones: 3, persona: 'CHOFER PRUEBA' });

    const [vale] = inserts.filter((i) => i.tabla === 'finance.expense_proofs');
    expect(vale.filas).toMatchObject({
      solicitante: 'CHOFER PRUEBA', departamento: 'Logística', sucursal: '01', fecha_gasto: '2026-10-07',
      folio_solicitud: null, importe: 359, clasificacion: 'no_comprobable', forma_pago: 'efectivo',
      status: 'recibida', created_by: 'Quien Prepara',
    });
    const meta = JSON.parse(vale.filas.capture_meta);
    expect(meta.fuente).toBe('logistica_viajes');
    expect(meta.conceptos).toEqual({ '075': 129, '128': 200, '186': 30 });
    expect(JSON.parse(vale.filas.files)[0]).toMatchObject({ role: 'comprobante_1', url: 'finance/tenant-prueba/expense-proofs/hoja.pdf' });

    const [renglones] = inserts.filter((i) => i.tabla === 'finance.trip_pay_lines');
    expect(renglones.filas.map((r: any) => [r.source_id, r.concept, r.amount])).toEqual([
      ['g1', 'comision', 129], ['g1', 'viatico', 200], ['c1', 'maniobra_carga', 30],
    ]);
    expect(renglones.filas.every((r: any) => r.expense_proof_id === VALE && r.driver_id === PERSONA)).toBe(true);
    expect(storage.putBuffer).toHaveBeenCalledTimes(1);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('antes de insertar, da de baja lo que estaba en un vale RECHAZADO (se puede volver a pagar)', async () => {
    const { svc, updates } = baseFalsa(ITEMS);
    await svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, 'Quien Prepara');
    expect(updates).toEqual([{ tabla: 'finance.trip_pay_lines as l', datos: expect.objectContaining({ vigente: false }) }]);
  });

  it('PRUEBA NEGATIVA: si otro vale ganó la carrera (23505) responde 409 y borra la hoja subida', async () => {
    const { svc, storage } = baseFalsa(ITEMS, { falla: Object.assign(new Error('duplicada'), { code: '23505' }) });
    await expect(svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, 'Quien Prepara')).rejects.toBeInstanceOf(ConflictException);
    expect(storage.remove).toHaveBeenCalledWith('finance/tenant-prueba/expense-proofs/hoja.pdf');
  });

  it('cualquier otro error se propaga, también sin dejar la hoja huérfana', async () => {
    const { svc, storage } = baseFalsa(ITEMS, { falla: new Error('se cayó la base') });
    await expect(svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, 'Quien Prepara')).rejects.toThrow('se cayó la base');
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('sin nada liberado por pagar: 409 y no genera hoja', async () => {
    const { svc, storage } = baseFalsa(ITEMS.slice(3));
    await expect(svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, 'Quien Prepara')).rejects.toBeInstanceOf(ConflictException);
    expect(storage.putBuffer).not.toHaveBeenCalled();
  });

  it('sin quién lo prepara o con id inválido: 400', async () => {
    const { svc } = baseFalsa(ITEMS);
    await expect(svc.crearVale(PERSONA, CORTE.desde, CORTE.hasta, '')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.crearVale('no-es-uuid', CORTE.desde, CORTE.hasta, 'Quien Prepara')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('TripPayService.corte y persona', () => {
  it('el corte suma liberado, retenido y en vale por persona', async () => {
    const { svc } = baseFalsa([
      fila({ concept: 'comision', amount: '129' }),
      fila({ source_id: 'g2', concept: 'comision', amount: '50', liberado: false, estado_viaje: 'abierto' }),
      fila({ source_id: 'g3', concept: 'comision', amount: '70', en_vale: true }),
    ]);
    const c = await svc.corte(CORTE.desde, CORTE.hasta);
    expect(c.corte).toEqual({ ...CORTE, pago: '2026-10-09' });
    expect(c.totales).toEqual({ liberado: 129, retenido: 50, en_vale: 70 });
  });

  it('fechas mal formadas o al revés: 400', async () => {
    const { svc } = baseFalsa([]);
    await expect(svc.corte('2026-10-07', '2026-09-24')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.corte('07/10/2026', undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persona separa pagable, retenido y en vale, y omite lo cancelado', async () => {
    const { svc } = baseFalsa([
      fila({ source_id: 'g1' }),
      fila({ source_id: 'g2', liberado: false, estado_viaje: 'abierto' }),
      fila({ source_id: 'g3', en_vale: true }),
      fila({ source_id: 'g4', estado_viaje: 'cancelado' }),
    ]);
    const d = await svc.persona(PERSONA, CORTE.desde, CORTE.hasta);
    expect(d.pagables.map((i) => i.source_id)).toEqual(['g1']);
    expect(d.retenidos.map((i) => i.source_id)).toEqual(['g2']);
    expect(d.en_vale.map((i) => i.source_id)).toEqual(['g3']);
  });
});

describe('TripPayController — rutas, permisos y quién prepara', () => {
  const meta = (fn: (...a: any[]) => any) => ({
    ruta: Reflect.getMetadata(PATH_METADATA, fn),
    verbo: Reflect.getMetadata(METHOD_METADATA, fn),
    permisos: Reflect.getMetadata(ANY_PERMISSIONS_KEY, fn),
  });
  const AMBOS = [Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR];

  it('las tres rutas aceptan Finanzas (comprobar) o Logística (gestionar), y nadie más', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TripPayController)).toBe('finance/trip-pay');
    expect(meta(TripPayController.prototype.corte)).toEqual({ ruta: 'corte', verbo: RequestMethod.GET, permisos: AMBOS });
    expect(meta(TripPayController.prototype.persona)).toEqual({ ruta: 'personas/:driverId', verbo: RequestMethod.GET, permisos: AMBOS });
    expect(meta(TripPayController.prototype.crearVale)).toEqual({ ruta: 'vales', verbo: RequestMethod.POST, permisos: AMBOS });
  });

  it('el vale queda a nombre del usuario de la sesión, no de lo que mande el cuerpo', async () => {
    const svc: any = { crearVale: vi.fn().mockResolvedValue({ id: VALE }) };
    const c = new TripPayController(svc);
    await c.crearVale({ driver_id: PERSONA, ...CORTE }, { user: { username: 'prueba', full_name: 'Persona Prueba' } });
    expect(svc.crearVale).toHaveBeenCalledWith(PERSONA, CORTE.desde, CORTE.hasta, 'Persona Prueba');
    await c.crearVale({ driver_id: PERSONA }, { user: { username: 'prueba' } });
    expect(svc.crearVale).toHaveBeenLastCalledWith(PERSONA, undefined, undefined, 'prueba');
  });
});
