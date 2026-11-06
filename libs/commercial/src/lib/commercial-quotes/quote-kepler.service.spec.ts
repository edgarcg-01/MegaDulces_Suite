/**
 * `[COT.7.4]` Los frenos de «aceptar → Pedido Telemarketing en Kepler», y su ORDEN.
 *
 * Lo que se prueba aquí es cuándo se llama al ERP y cuándo NO: cada freno existe porque sin él se
 * escribe en Kepler un pedido que no debía existir. ⚠️ Con dobles: el SQL no se ejecuta (un doble de
 * Knex no valida SQL). El SQL del adaptador lo valida el ensayo contra Kepler real; el del servicio
 * contra una base real queda NO MEDIDO hasta la prueba HTTP (regla 13).
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { QuoteKeplerService } from './quote-kepler.service';

const ID = '11111111-1111-4111-8111-111111111111';

interface Escenario {
  cab?: Record<string, unknown>;
  lineas?: Array<Record<string, unknown>>;
  cambio?: number;
  switch?: { encendida: boolean; tope_dia: number | null } | null;
  reclamo?: boolean;
  sink?: Record<string, unknown>;
  ajena?: boolean;
  direcciones?: Array<{ key: string }>;
}

function armar(e: Escenario = {}) {
  const sql: string[] = [];
  const cab = {
    id: ID, code: 'COT-2026-00200', status: 'draft', vencida: false, source_branch: '01',
    erp_customer_code: 'C1088', salesperson_code: '00002', terms_discount_pct: '2', delivery_address_key: null,
    kepler_sucursal: null, kepler_folio: null, ...e.cab,
  };
  const lineas = e.lineas ?? [{
    line_number: 1, parent_line_number: null, quantity: 5, unit_price: 718.4, list_price: 731.34, line_total: 3592,
    qty_unit: 'CJA', qty_factor: 8, requested_text: null, sku: '29014',
  }];
  const k: any = Object.assign(
    () => ({ where: () => ({ first: async () => (e.switch === undefined ? { encendida: true, tope_dia: 1 } : e.switch) }) }),
    {
      raw: async (s: string) => {
        sql.push(s.replace(/\s+/g, ' ').trim());
        if (s.includes('FROM commercial.quotes q')) return { rows: [cab] };
        if (s.includes('FROM commercial.quote_lines')) return { rows: lineas };
        if (s.includes('FROM kepler_ods.kdudent')) return { rows: e.direcciones ?? [] };
        if (s.includes('SET kepler_sending_at = now()')) return { rows: e.reclamo === false ? [] : [{ id: ID }] };
        return { rows: [] };
      },
    },
  );
  const tk: any = { run: (fn: (x: unknown) => unknown) => fn(k) };
  const ctx: any = { requireTenantId: () => 't', get: () => ({ userId: 'u1', tenantId: 't' }) };
  const quotes: any = {
    assertPuedeAbrir: vi.fn(async () => { if (e.ajena) throw new ForbiddenException('ajena'); }),
    assertEscribeSucursal: vi.fn(async () => undefined),
  };
  const pricing: any = { checkQuote: vi.fn(async () => ({ price_changed: e.cambio ?? 0 })) };
  const sink: any = {
    entregar: vi.fn(async () => e.sink ?? { estado: 'entregado', kepler: { sucursal: '01', folio: '0003800', renglones: 1, total: 3520.16 } }),
  };
  return { svc: new QuoteKeplerService(tk, ctx, quotes, pricing, sink), sink, sql, quotes };
}

const escribioAceptada = (sql: string[]) => sql.some((s) => s.includes("THEN 'accepted'"));
const anotoError = (sql: string[]) => sql.some((s) => s.includes('SET kepler_error = :m'));

describe('[COT.7.4] QuoteKeplerService.enviar — el camino feliz', () => {
  it('manda los renglones al ERP y deja la cotización aceptada con su folio', async () => {
    const { svc, sink, sql } = armar();
    await expect(svc.enviar(ID, {})).resolves.toEqual({ ya_estaba: false, kepler: { sucursal: '01', folio: '0003800', renglones: 1, total: 3520.16 } });
    expect(sink.entregar).toHaveBeenCalledTimes(1);
    const arg = sink.entregar.mock.calls[0][0];
    expect(arg).toMatchObject({ folio_suite: 'COT-2026-00200', sucursal: '01', cliente: 'C1088', vendedor: '00002', pct_cliente: 2, tope_dia: 1 });
    expect(arg.renglones).toEqual([{ sku: '29014', cantidad: 5, presentacion: 'CJA', factor: 8, precio: 718.4, lista: 731.34, importe: 3592 }]);
    expect(escribioAceptada(sql)).toBe(true);
  });

  it('idempotente: con folio guardado devuelve ése y NO llama al ERP', async () => {
    const { svc, sink } = armar({ cab: { kepler_folio: '0003799', kepler_sucursal: '01' } });
    await expect(svc.enviar(ID, {})).resolves.toEqual({ ya_estaba: true, kepler: { sucursal: '01', folio: '0003799' } });
    expect(sink.entregar).not.toHaveBeenCalled();
  });
});

describe('[COT.7.4] los frenos: ninguno llama al ERP', () => {
  const casos: Array<[string, Escenario, RegExp | typeof ConflictException]> = [
    ['aceptada ya (no borrador ni enviada)', { cab: { status: 'accepted' } }, /sólo una en borrador o enviada/],
    ['vencida', { cab: { vencida: true } }, /venció/],
    ['sin cliente del ERP (D3)', { cab: { erp_customer_code: null } }, /cliente de Kepler/],
    ['sin vendedor (D5)', { cab: { salesperson_code: ' ' } }, /vendedor de Kepler/],
    ['un renglón no casó con el catálogo', { lineas: [{ line_number: 1, parent_line_number: null, quantity: 1, unit_price: 10, line_total: 10, sku: null, requested_text: 'chicles' }] }, /no casaron con el catálogo/],
    ['trae regalo', { lineas: [
      { line_number: 1, parent_line_number: null, quantity: 1, unit_price: 10, line_total: 10, sku: 'A' },
      { line_number: 2, parent_line_number: 1, quantity: 1, unit_price: 0, line_total: 0, sku: 'B' },
    ] }, /regalo/],
    ['el precio cambió en Kepler (D2)', { cambio: 2 }, /cambió en Kepler/],
  ];
  it.each(casos)('%s', async (_n, esc, msg) => {
    const { svc, sink } = armar(esc);
    await expect(svc.enviar(ID, {})).rejects.toThrow(msg as RegExp);
    expect(sink.entregar).not.toHaveBeenCalled();
  });

  it('cotización de otra persona (COT.21): 403 antes de leer nada', async () => {
    const { svc, sink, sql } = armar({ ajena: true });
    await expect(svc.enviar(ID, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(sink.entregar).not.toHaveBeenCalled();
    expect(sql).toEqual([]);
  });

  it('interruptor apagado: 400, se anota el motivo y no se reclama', async () => {
    const { svc, sink, sql } = armar({ switch: { encendida: false, tope_dia: 1 } });
    await expect(svc.enviar(ID, {})).rejects.toThrow(/apagada desde la Suite/);
    expect(sink.entregar).not.toHaveBeenCalled();
    expect(anotoError(sql)).toBe(true);
    expect(sql.some((s) => s.includes('SET kepler_sending_at = now()'))).toBe(false);
  });

  it('sin renglón en el interruptor = apagado (falla cerrada)', async () => {
    const { svc, sink } = armar({ switch: null });
    await expect(svc.enviar(ID, {})).rejects.toThrow(/apagada/);
    expect(sink.entregar).not.toHaveBeenCalled();
  });

  it('otro envío tiene el reclamo: 409 y no se escribe un segundo pedido', async () => {
    const { svc, sink } = armar({ reclamo: false });
    await expect(svc.enviar(ID, {})).rejects.toBeInstanceOf(ConflictException);
    expect(sink.entregar).not.toHaveBeenCalled();
  });
});

describe('[COT.7.4] Kepler rechaza: se anota y no se acepta', () => {
  it('400 con los motivos por renglón, kepler_error guardado, la cotización NO queda aceptada', async () => {
    const { svc, sql } = armar({ sink: { estado: 'rechazado', motivo: '1 renglón(es) no se pueden escribir en Kepler', motivos: ['29014: la presentación CJA trae 8 en la cotización y 12 en la ficha de Kepler'] } });
    const err = await svc.enviar(ID, {}).catch((x) => x);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().motivos).toEqual(['29014: la presentación CJA trae 8 en la cotización y 12 en la ficha de Kepler']);
    expect(anotoError(sql)).toBe(true);
    expect(escribioAceptada(sql)).toBe(false);
  });

  it('el adaptador truena: igual se anota y se suelta el reclamo', async () => {
    const { svc, sink, sql } = armar();
    sink.entregar.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(svc.enviar(ID, {})).rejects.toThrow(/ECONNREFUSED/);
    expect(anotoError(sql)).toBe(true);
    expect(escribioAceptada(sql)).toBe(false);
  });
});

describe('[COT.26] la dirección de entrega: con varias no se adivina', () => {
  const tres = [{ key: '1' }, { key: '2' }, { key: '3' }];

  it('cliente con 3 direcciones y ninguna elegida: 400 y NO llama al ERP', async () => {
    const { svc, sink } = armar({ direcciones: tres });
    await expect(svc.enviar(ID, {})).rejects.toThrow(/3 direcciones de entrega/);
    expect(sink.entregar).not.toHaveBeenCalled();
  });

  it('la elegida viaja como Dir. envío', async () => {
    const { svc, sink } = armar({ direcciones: tres, cab: { delivery_address_key: '2' } });
    await svc.enviar(ID, {});
    expect(sink.entregar.mock.calls[0][0].direccion_envio).toBe('2');
  });

  it('una elegida que ya no está en Kepler: 400', async () => {
    const { svc, sink } = armar({ direcciones: tres, cab: { delivery_address_key: '7' } });
    await expect(svc.enviar(ID, {})).rejects.toThrow(/ya no está en Kepler/);
    expect(sink.entregar).not.toHaveBeenCalled();
  });

  it('con una sola, se usa ésa sin preguntar', async () => {
    const { svc, sink } = armar({ direcciones: [{ key: '1' }] });
    await svc.enviar(ID, {});
    expect(sink.entregar.mock.calls[0][0].direccion_envio).toBe('1');
  });

  it('fijarDireccion: con folio de Kepler ya no se cambia aquí', async () => {
    const { svc, sql } = armar({ direcciones: tres, cab: { kepler_folio: '0003788' } });
    await expect(svc.fijarDireccion(ID, '2', {})).rejects.toThrow(/Dir. envío/);
    expect(sql.some((x) => x.includes('SET delivery_address_key'))).toBe(false);
  });

  it('fijarDireccion: una clave ajena al cliente no se guarda', async () => {
    const { svc, sql } = armar({ direcciones: tres });
    await expect(svc.fijarDireccion(ID, '9', {})).rejects.toThrow(/no es del cliente/);
    expect(sql.some((x) => x.includes('SET delivery_address_key'))).toBe(false);
  });

  it('fijarDireccion: la del cliente se guarda', async () => {
    const { svc, sql } = armar({ direcciones: tres });
    await expect(svc.fijarDireccion(ID, '3', {})).resolves.toMatchObject({ elegida: '3', editable: true });
    expect(sql.some((x) => x.includes('SET delivery_address_key'))).toBe(true);
  });
});

describe('[COT.28] observaciones del pedido', () => {
  it('viajan al ERP con el pedido', async () => {
    const { svc, sink } = armar({ cab: { order_notes: 'cobrar hoy para entregar hoy mismo' } });
    await svc.enviar(ID, {});
    expect(sink.entregar.mock.calls[0][0].observaciones).toBe('cobrar hoy para entregar hoy mismo');
  });

  it('se guardan en una línea, sin espacios de más', async () => {
    const { svc, sql } = armar();
    await expect(svc.fijarObservaciones(ID, '  REMISIÓN\n  urgente ', {})).resolves.toEqual({ order_notes: 'REMISIÓN urgente' });
    expect(sql.some((x) => x.includes('SET order_notes'))).toBe(true);
  });

  it('más de 120 caracteres: 400 y no se guarda', async () => {
    const { svc, sql } = armar();
    await expect(svc.fijarObservaciones(ID, 'Z'.repeat(121), {})).rejects.toThrow(/120 caracteres/);
    expect(sql.some((x) => x.includes('SET order_notes'))).toBe(false);
  });

  it('con folio de Kepler ya no se cambian aquí', async () => {
    const { svc, sql } = armar({ cab: { kepler_folio: '0003789' } });
    await expect(svc.fijarObservaciones(ID, 'algo', {})).rejects.toThrow(/Comentarios/);
    expect(sql.some((x) => x.includes('SET order_notes'))).toBe(false);
  });
});
