import { BadRequestException } from '@nestjs/common';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[PQ.20]` El interruptor de la escritura a Kepler vive en la Suite y se lee en cada envío.
 * Falla cerrada: sin renglón = apagada. Sólo la tabla AUSENTE (base sin migrar) deja el
 * comportamiento anterior, para que desplegar antes de migrar no apague nada.
 */
function svcCon(first: () => Promise<unknown>) {
  const svc = Object.create(CommercialReplenishmentService.prototype) as any;
  const qb: any = { where: () => qb, first };
  svc.tk = { run: (fn: (trx: unknown) => unknown) => fn(() => qb) };
  return svc;
}

describe('[PQ.20] interruptorKepler', () => {
  it('renglón encendido sin tope → encendida, tope null', async () => {
    const svc = svcCon(async () => ({ encendida: true, tope_dia: null }));
    expect(await svc.interruptorKepler('t', '00', 'compra')).toEqual({ encendida: true, tope_dia: null, genera_orden: false });
  });
  it('tope numérico viaja como número', async () => {
    const svc = svcCon(async () => ({ encendida: true, tope_dia: '5' }));
    expect(await svc.interruptorKepler('t', '00', 'compra')).toEqual({ encendida: true, tope_dia: 5, genera_orden: false });
  });
  it('NEGATIVA: sin renglón → APAGADA (falla cerrada)', async () => {
    const svc = svcCon(async () => undefined);
    expect(await svc.interruptorKepler('t', '05', 'traspaso')).toEqual({ encendida: false, tope_dia: null, genera_orden: false });
  });
  it('[PQ.22] genera_orden sólo con true estricto (columna ausente = false)', async () => {
    expect((await svcCon(async () => ({ encendida: true, tope_dia: null, genera_orden: true })).interruptorKepler('t', '00', 'compra')).genera_orden).toBe(true);
    expect((await svcCon(async () => ({ encendida: true, tope_dia: null, genera_orden: 'true' })).interruptorKepler('t', '00', 'compra')).genera_orden).toBe(false);
  });
  it('tabla ausente (42P01) → undefined: manda la variable de entorno', async () => {
    const svc = svcCon(async () => { throw Object.assign(new Error('no existe'), { code: '42P01' }); });
    expect(await svc.interruptorKepler('t', '00', 'compra')).toBeUndefined();
  });
  it('NEGATIVA: cualquier otro error de base NO se traga', async () => {
    const svc = svcCon(async () => { throw Object.assign(new Error('timeout'), { code: '57014' }); });
    await expect(svc.interruptorKepler('t', '00', 'compra')).rejects.toThrow('timeout');
  });
});

describe('[PQ.20] setKeplerSwitch valida antes de escribir', () => {
  const svc = Object.create(CommercialReplenishmentService.prototype) as any;
  svc.tenantCtx = { requireTenantId: () => 't', get: () => ({ userId: 'u' }) };
  svc.tk = { run: vi.fn() };
  it.each([
    ['09', 'compra', { encendida: true }, 'Sucursal'],
    ['00', 'venta', { encendida: true }, 'Tipo'],
    ['00', 'compra', {}, 'encendida'],
    ['00', 'compra', { encendida: true, tope_dia: 0 }, 'tope'],
    ['00', 'compra', { encendida: true, tope_dia: 2.5 }, 'tope'],
    ['00', 'traspaso', { encendida: true, genera_orden: true }, 'compra'],
    ['00', 'compra', { encendida: true, genera_orden: 'si' }, 'genera_orden'],
  ])('NEGATIVA: %s/%s %j', async (s, t, dto, msg) => {
    await expect(svc.setKeplerSwitch(s, t, dto)).rejects.toThrow(BadRequestException);
    await expect(svc.setKeplerSwitch(s, t, dto)).rejects.toThrow(new RegExp(msg, 'i'));
    expect(svc.tk.run).not.toHaveBeenCalled();
  });
});
