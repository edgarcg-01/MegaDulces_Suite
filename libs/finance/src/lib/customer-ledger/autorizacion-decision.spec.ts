import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Permission } from '@megadulces/platform-core';
import type { PedidoPorAutorizar } from '@megadulces/contracts';
import {
  AutorizacionDecisionService,
  CERRAR_DECISION,
  INSERTAR_DECISION,
  ULTIMA_AUTORIZACION,
  VENCER_PENDIENTES,
  desenlace,
  fotoDeLaRegla,
  validarDecision,
} from './autorizacion-decision.service';
import { AutorizacionPedidosController } from './autorizacion-pedidos.controller';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';
import { KeplerAutorizacionPedidoAdapter, type ResultadoEscrituraAutorizacion } from './kepler-autorizacion-pedido.adapter';

/**
 * `[GP.A.2]` La decisión de Crédito y cobranza sobre un pedido: lo puro, el flujo (con Kepler y la base simulados) y el
 * cableado. El SQL de la bitácora corre contra Postgres real en `database/tests/test-newdb-autorizacion-pedidos.js`.
 */

const pedido = (o: Partial<PedidoPorAutorizar> = {}): PedidoPorAutorizar => ({
  sucursal: '08', sucursal_nombre: 'Canindo', serie: 1, folio: '0002067', fecha: '2026-11-17', dias_esperando: 3,
  cliente: 'C3104', cliente_nombre: 'ABARROTES EL SOL', es_contado: false, ruta_vecinal: false, importe: 1_500,
  resultado: { decision: 'bandeja', motivos: [{ condicion: 2, texto: 'excede $500.00 su límite' }] },
  limite: 10_000, plazo_dias: 15, por_cobrar_kepler: 9_000, saldo_cartera: 8_800, otros_pedidos: 0,
  pago: { facturas_pagadas: 4, mediana_dias: 12, a_tiempo: 4, peor_atraso: 0 },
  ...o,
} as PedidoPorAutorizar);

describe('[GP.A.2] validarDecision', () => {
  it('acepta lo que manda el panel y recorta espacios', () => {
    expect(validarDecision(' 08 ', '1', ' 0002067 ', { accion: 'autorizar', motivo: '  paga a tiempo  ' }))
      .toEqual({ sucursal: '08', serie: 1, folio: '0002067', accion: 'autorizar', motivo: 'paga a tiempo' });
  });
  it.each([
    ['sucursal', ['8', 1, '0002067', { accion: 'autorizar', motivo: 'x' }]],
    ['serie', ['08', 0, '0002067', { accion: 'autorizar', motivo: 'x' }]],
    ['folio', ['08', 1, "0'; DROP", { accion: 'autorizar', motivo: 'x' }]],
    ['acción', ['08', 1, '0002067', { accion: 'cancelar', motivo: 'x' }]],
    ['motivo vacío', ['08', 1, '0002067', { accion: 'rechazar', motivo: '   ' }]],
    ['motivo largo', ['08', 1, '0002067', { accion: 'rechazar', motivo: 'x'.repeat(501) }]],
  ])('rechaza %s', (_n, args) => {
    expect(() => validarDecision(...(args as Parameters<typeof validarDecision>))).toThrow(BadRequestException);
  });
});

describe('[GP.A.2] desenlace', () => {
  it('rechazar y escalar no tocan Kepler: «registrado»', () => {
    expect(desenlace('rechazar', null).estado).toBe('registrado');
    expect(desenlace('escalar', null)).toMatchObject({ estado: 'registrado', mensaje: 'Pasado a Dirección General con tu motivo.' });
  });
  it('lo que contestó Kepler pasa tal cual a la bitácora, con su frase', () => {
    expect(desenlace('autorizar', { estado: 'escrito', de: 'CREADO', a: 'AUTORIZADO' })).toEqual({ estado: 'escrito', mensaje: 'Autorizado en Kepler.', reintentable: false });
    expect(desenlace('regresar', { estado: 'ya_estaba', motivo: '…' }).mensaje).toBe('Ya estaba en CREADO en Kepler.');
    expect(desenlace('autorizar', { estado: 'apagado', motivo: 'apagada' })).toEqual({ estado: 'apagado', mensaje: 'apagada', reintentable: false });
    expect(desenlace('autorizar', { estado: 'rechazado', motivo: 'no responde', reintentable: true })).toEqual({ estado: 'rechazado', mensaje: 'no responde', reintentable: true });
  });
});

describe('[GP.A.2] fotoDeLaRegla', () => {
  it('guarda la decisión, los motivos, los números y los parámetros con los que se evaluó', () => {
    const f = fotoDeLaRegla(pedido(), '2026-11-20T20:00:00Z') as Record<string, Record<string, unknown>>;
    expect(f['decision']).toBe('bandeja');
    expect(f['numeros']).toMatchObject({ importe: 1_500, limite: 10_000, por_cobrar_kepler: 9_000, otros_pedidos: 0 });
    expect(f['parametros']).toMatchObject({ graciaDias: 15, pedidoViejoDias: 2, abiertosHorizonteDias: 30 });
    expect(f['data_as_of']).toBe('2026-11-20T20:00:00Z');
  });
});

/** Una base de mentira: contesta por el texto de la sentencia y anota lo que se le pidió. */
function montar(o: {
  interruptor?: boolean; tabla?: boolean; ultima?: Record<string, unknown> | null; insertFalla?: unknown;
  enBandeja?: PedidoPorAutorizar | null; kepler?: ResultadoEscrituraAutorizacion;
} = {}) {
  const llamadas: Array<{ sql: string; v: unknown[] }> = [];
  const trx = {
    raw: vi.fn(async (sql: string, v: unknown[] = []) => {
      llamadas.push({ sql, v });
      if (sql.includes('to_regclass')) return { rows: [{ ok: o.tabla ?? true }] };
      if (sql.includes('kepler_push_switch')) return { rows: o.interruptor === undefined ? [{ encendida: true }] : [{ encendida: o.interruptor }] };
      if (sql === ULTIMA_AUTORIZACION) return { rows: o.ultima ? [o.ultima] : [] };
      if (sql === INSERTAR_DECISION) { if (o.insertFalla) throw o.insertFalla; return { rows: [{ id: 'fila-1' }] }; }
      return { rows: [] };
    }),
  };
  const tk = { run: vi.fn(async (fn: (t: typeof trx) => unknown) => fn(trx)) };
  const tenant = { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' };
  const kepler = { escribir: vi.fn(async () => o.kepler ?? ({ estado: 'escrito', de: 'CREADO', a: 'AUTORIZADO' } as ResultadoEscrituraAutorizacion)) };
  const svc = new AutorizacionDecisionService(tk as never, tenant as never, {} as never, kepler as never);
  vi.spyOn(svc as unknown as { pedidoEnBandeja: () => unknown }, 'pedidoEnBandeja')
    .mockResolvedValue(o.enBandeja === null ? null : { p: o.enBandeja ?? pedido(), data_as_of: '2026-11-20T20:00:00Z' });
  const sql = (s: string) => llamadas.filter((l) => l.sql === s);
  return { svc, kepler, sql };
}

describe('[GP.A.2] decidir', () => {
  it('autorizar: la fila nace «pendiente», Kepler escribe y la fila se cierra «escrito»', async () => {
    const { svc, kepler, sql } = montar();
    const r = await svc.decidir('08', '1', '0002067', { accion: 'autorizar', motivo: 'paga a tiempo' }, 'cyc1');
    expect(r).toEqual({ id: 'fila-1', accion: 'autorizar', estado: 'escrito', mensaje: 'Autorizado en Kepler.', reintentable: false });
    const ins = sql(INSERTAR_DECISION)[0].v;
    expect(ins.slice(0, 8)).toEqual(['08', 1, '0002067', 'C3104', 1_500, 'autorizar', false, 'paga a tiempo']);
    expect(ins.slice(9)).toEqual(['pendiente', 'cyc1', 'cyc1']);
    expect(JSON.parse(String(ins[8]))).toMatchObject({ decision: 'bandeja', numeros: { limite: 10_000 } });
    expect(kepler.escribir).toHaveBeenCalledWith({ sucursal: '08', serie: 1, folio: '0002067', accion: 'autorizar' });
    expect(sql(CERRAR_DECISION)[0].v).toEqual(['escrito', JSON.stringify({ estado: 'escrito', de: 'CREADO', a: 'AUTORIZADO' }), 'cyc1', 'fila-1']);
    expect(sql(VENCER_PENDIENTES)).toHaveLength(1);
  });

  it('⛔ con el interruptor apagado no registra ni toca Kepler', async () => {
    const { svc, kepler, sql } = montar({ interruptor: false });
    await expect(svc.decidir('08', 1, '0002067', { accion: 'autorizar', motivo: 'x' }, 'cyc1')).rejects.toThrow(ConflictException);
    expect(sql(INSERTAR_DECISION)).toHaveLength(0);
    expect(kepler.escribir).not.toHaveBeenCalled();
  });

  it('rechazar no necesita el interruptor ni toca Kepler: nace «registrado»', async () => {
    const { svc, kepler, sql } = montar({ interruptor: false });
    const r = await svc.decidir('08', 1, '0002067', { accion: 'rechazar', motivo: 'debe 92 días' }, 'cyc1');
    expect(r.estado).toBe('registrado');
    expect(sql(INSERTAR_DECISION)[0].v[9]).toBe('registrado');
    expect(kepler.escribir).not.toHaveBeenCalled();
    expect(sql(CERRAR_DECISION)).toHaveLength(0);
  });

  it('Kepler no contesta: la fila se cierra «rechazado» y se puede reintentar', async () => {
    const { svc, sql } = montar({ kepler: { estado: 'rechazado', motivo: 'Kepler 08 no responde', reintentable: true } });
    const r = await svc.decidir('08', 1, '0002067', { accion: 'autorizar', motivo: 'x' }, 'cyc1');
    expect(r).toMatchObject({ estado: 'rechazado', reintentable: true, mensaje: 'Kepler 08 no responde' });
    expect(sql(CERRAR_DECISION)[0].v[0]).toBe('rechazado');
  });

  it('el pedido ya no está CREADO: 404 y nada registrado', async () => {
    const { svc, sql } = montar({ enBandeja: null });
    await expect(svc.decidir('08', 1, '0002067', { accion: 'autorizar', motivo: 'x' }, 'cyc1')).rejects.toThrow(NotFoundException);
    expect(sql(INSERTAR_DECISION)).toHaveLength(0);
  });

  it('[D-A7] regresar exige una autorización vigente de la Suite y escribe «regresar»', async () => {
    const sin = montar();
    await expect(sin.svc.decidir('08', 1, '0002067', { accion: 'regresar', motivo: 'x' }, 'cyc1')).rejects.toThrow(ConflictException);
    const con = montar({ ultima: { id: 'fila-0', cliente_code: 'C3104', importe: 1_500 }, kepler: { estado: 'escrito', de: 'AUTORIZADO', a: 'CREADO' } });
    const r = await con.svc.decidir('08', 1, '0002067', { accion: 'regresar', motivo: 'se pasó del límite' }, 'cyc1');
    expect(r.mensaje).toBe('Regresado a CREADO en Kepler.');
    expect(con.kepler.escribir).toHaveBeenCalledWith(expect.objectContaining({ accion: 'regresar' }));
    expect(JSON.parse(String(con.sql(INSERTAR_DECISION)[0].v[8]))).toEqual({ regresa: 'fila-0' });
  });

  it('dos clics a la vez: el índice único se vuelve un 409 legible', async () => {
    const choque = Object.assign(new Error('duplicate key value violates unique constraint "ux_fin_oa_una_en_curso"'), { code: '23505' });
    const { svc, kepler } = montar({ insertFalla: choque });
    await expect(svc.decidir('08', 1, '0002067', { accion: 'autorizar', motivo: 'x' }, 'cyc1')).rejects.toThrow(/se está escribiendo/);
    expect(kepler.escribir).not.toHaveBeenCalled();
  });

  it('sin la migración o sin usuario, no hace nada', async () => {
    await expect(montar({ tabla: false }).svc.decidir('08', 1, '0002067', { accion: 'rechazar', motivo: 'x' }, 'cyc1')).rejects.toThrow(/migración/);
    await expect(montar().svc.decidir('08', 1, '0002067', { accion: 'rechazar', motivo: 'x' }, undefined)).rejects.toThrow(BadRequestException);
  });
});

describe('[GP.A.2] el cableado (vitest no emite design:paramtypes: se revisa el grafo, #414)', () => {
  const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
  it('el servicio, el adaptador y el controller están en el módulo de Cartera', () => {
    expect(meta<unknown>('providers', FinanceCustomerLedgerModule)).toEqual(expect.arrayContaining([AutorizacionDecisionService, KeplerAutorizacionPedidoAdapter]));
    expect(meta<unknown>('controllers', FinanceCustomerLedgerModule)).toContain(AutorizacionPedidosController);
  });
  it('los constructores toman lo que el módulo provee (si cambia, revisar el arranque)', () => {
    expect(AutorizacionDecisionService.length).toBe(4);
    expect(AutorizacionPedidosController.length).toBe(1);
  });
  it('la ruta escribe con la llave de Crédito y cobranza, no con la de ver Cartera', () => {
    const decidir = AutorizacionPedidosController.prototype.decidir;
    expect(Reflect.getMetadata('path', AutorizacionPedidosController)).toBe('finance/autorizacion-pedidos');
    expect(Reflect.getMetadata('path', decidir)).toBe(':sucursal/:serie/:folio');
    expect(Reflect.getMetadata('permissions', decidir)).toEqual([Permission.FINANCE_PEDIDOS_AUTORIZAR]);
  });
});
