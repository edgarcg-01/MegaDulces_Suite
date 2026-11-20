import {
  PARAMETROS_PROPUESTOS,
  clienteBloqueado,
  decidirAutorizacion,
  diasEntre,
  type EntradaAutorizacion,
} from './autorizacion-pedido.reglas';

/**
 * `[GP.A.1]` La regla de autorización automática de pedidos TELEMARK (anexo EA §3.1). Cada condición
 * lleva su caso que pasa y su caso que falla; la base es un pedido que pasa las siete.
 */
const P = PARAMETROS_PROPUESTOS;
const base = (o: Partial<EntradaAutorizacion> = {}): EntradaAutorizacion => ({
  hoy: '2026-11-20',
  pedido: { importe: 1_000, fecha: '2026-11-19' },
  cliente: { nombre: 'ABARROTES UNO', limite: 10_000 },
  por_cobrar_kepler: 2_000,
  pedidos_abiertos: 500,
  facturas: [{ saldo: 2_000, importe: 2_000, vencimiento: '2026-11-30' }],
  edad_datos_min: 2,
  carril: { encendido: true, autorizados_hoy: 3, tope_dia: 50 },
  ...o,
});

describe('[GP.A.1] decidirAutorizacion', () => {
  it('pasa las siete → autorizar, sin motivos, con los números que vio', () => {
    const r = decidirAutorizacion(base(), P);
    expect(r.decision).toBe('autorizar');
    expect(r.motivos).toEqual([]);
    expect(r.numeros).toMatchObject({ limite: 10_000, comprometido: 3_500, excedente: null, vencido_fuera_de_gracia: 0 });
  });

  it('1 · sin límite (0 o null) → bandeja «sin límite en Kepler»', () => {
    for (const limite of [0, null]) {
      const r = decidirAutorizacion(base({ cliente: { nombre: 'X', limite } }), P);
      expect(r.decision).toBe('bandeja');
      expect(r.motivos).toContainEqual({ condicion: 1, texto: 'sin límite en Kepler' });
    }
  });

  it('2 · saldo + otros pedidos + este pedido sobre el límite → dice cuánto excede', () => {
    const r = decidirAutorizacion(base({ por_cobrar_kepler: 9_000 }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.numeros.excedente).toBe(500);
    expect(r.motivos[0].texto).toBe('excede $500.00 su límite');
  });

  it('2 · justo en el límite pasa (negativo del anterior)', () => {
    expect(decidirAutorizacion(base({ por_cobrar_kepler: 8_500 }), P).decision).toBe('autorizar');
  });

  it('2 · ⛔ saldo u otros pedidos desconocidos NO se dan por cero', () => {
    for (const o of [{ por_cobrar_kepler: null }, { pedidos_abiertos: null }]) {
      const r = decidirAutorizacion(base(o), P);
      expect(r.decision).toBe('bandeja');
      expect(r.motivos).toContainEqual({ condicion: 2, texto: 'no pude verificar el saldo' });
    }
  });

  it('2 · [GP.A.0b] el 00031 de la captura de Zamora Centro: límite 10,000, por cobrar en Kepler 56,702.27 → excede', () => {
    const r = decidirAutorizacion(base({ por_cobrar_kepler: 56_702.27, pedidos_abiertos: 0, pedido: { importe: 6_563.14, fecha: '2026-11-19' } }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.numeros.excedente).toBe(53_265.41);
  });

  it('2 · [GP.A.0b] un por cobrar NEGATIVO (saldo a favor, como el 00007) suma a favor, como en Kepler', () => {
    const r = decidirAutorizacion(base({ por_cobrar_kepler: -7_610.28, pedidos_abiertos: 0, pedido: { importe: 15_000, fecha: '2026-11-19' } }), P);
    expect(r.numeros.comprometido).toBe(7_389.72);
    expect(r.decision).toBe('autorizar');
  });

  it('3 · vencido fuera de la gracia → bandeja con monto y días', () => {
    const r = decidirAutorizacion(base({ facturas: [{ saldo: 12_300, importe: 12_300, vencimiento: '2026-09-19' }], por_cobrar_kepler: 0 }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.motivos[0]).toEqual({ condicion: 3, texto: 'tiene $12,300.00 vencidos desde hace 62 días' });
  });

  it('3 · vencido DENTRO de la gracia no detiene (negativo del anterior)', () => {
    const r = decidirAutorizacion(base({ facturas: [{ saldo: 2_000, importe: 2_000, vencimiento: '2026-11-10' }] }), P);
    expect(r.decision).toBe('autorizar');
  });

  it('3 · ⭐ el cliente que sólo debe centavos de una factura cobrada se autoriza (los 17 de [GP.R.1])', () => {
    const r = decidirAutorizacion(base({ facturas: [{ saldo: 0.37, importe: 15_730.37, vencimiento: '2026-08-01' }] }), P);
    expect(r.decision).toBe('autorizar');
    expect(r.numeros.resto_ignorado).toBe(0.37);
  });

  it('3 · negativo: centavos de una factura que NUNCA tuvo cobro sí cuentan como vencido', () => {
    const r = decidirAutorizacion(base({ facturas: [{ saldo: 0.37, importe: 0.37, vencimiento: '2026-08-01' }] }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.motivos[0].condicion).toBe(3);
  });

  it('3 · ⛔ sin cartera o con factura sin vencimiento → no pude verificar', () => {
    expect(decidirAutorizacion(base({ facturas: null }), P).motivos).toContainEqual({ condicion: 3, texto: 'no pude verificar lo vencido' });
    const r = decidirAutorizacion(base({ facturas: [{ saldo: 50, importe: 50, vencimiento: null }] }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.motivos[0].condicion).toBe(3);
  });

  it('4 · «NO TOCAR» al inicio del nombre → bandeja y bloqueado (no se puede autorizar ni a mano)', () => {
    const r = decidirAutorizacion(base({ cliente: { nombre: '  no tocar abarrotes uno', limite: 10_000 } }), P);
    expect(r.decision).toBe('bandeja');
    expect(r.bloqueado).toBe(true);
  });

  it('4 · negativo: «no tocar» en medio del nombre o «BAJA» en «TRABAJADORES» no bloquean', () => {
    expect(clienteBloqueado('SINDICATO DE TRABAJADORES')).toBe(false);
    expect(clienteBloqueado('ABARROTES NO TOCAR')).toBe(false);
    expect(decidirAutorizacion(base({ cliente: { nombre: 'SINDICATO DE TRABAJADORES', limite: 10_000 } }), P).decision).toBe('autorizar');
  });

  it('5 · lectura vieja o de edad desconocida → bandeja', () => {
    expect(decidirAutorizacion(base({ edad_datos_min: 40 }), P).motivos[0]).toEqual({ condicion: 5, texto: 'no pude verificar el saldo: la lectura es de hace 40 min' });
    expect(decidirAutorizacion(base({ edad_datos_min: null }), P).decision).toBe('bandeja');
  });

  it('6 · carril apagado, sin tope o con el tope alcanzado → bandeja', () => {
    expect(decidirAutorizacion(base({ carril: { encendido: false, autorizados_hoy: 0, tope_dia: 50 } }), P).decision).toBe('bandeja');
    expect(decidirAutorizacion(base({ carril: { encendido: true, autorizados_hoy: 0, tope_dia: null } }), P).decision).toBe('bandeja');
    const r = decidirAutorizacion(base({ carril: { encendido: true, autorizados_hoy: 50, tope_dia: 50 } }), P);
    expect(r.motivos[0]).toEqual({ condicion: 6, texto: 'ya se autorizaron 50 hoy: es el tope del día' });
  });

  it('7 · pedido viejo → aparte (ni automático ni bandeja), aunque además falle otra', () => {
    const r = decidirAutorizacion(base({ pedido: { importe: 1_000, fecha: '2026-03-25' }, cliente: { nombre: 'X', limite: 0 } }), P);
    expect(r.decision).toBe('aparte');
    expect(r.motivos.map((m) => m.condicion)).toEqual([1, 7]);
  });

  it('7 · el último movimiento manda sobre la fecha del pedido (negativo del anterior)', () => {
    const r = decidirAutorizacion(base({ pedido: { importe: 1_000, fecha: '2026-03-25', ultimo_movimiento: '2026-11-18' } }), P);
    expect(r.decision).toBe('autorizar');
  });

  it('junta TODOS los motivos, no sólo el primero', () => {
    const r = decidirAutorizacion(base({ cliente: { nombre: 'NO TOCAR X', limite: 0 }, edad_datos_min: 99 }), P);
    expect(r.motivos.map((m) => m.condicion)).toEqual([1, 4, 5]);
  });

  it('diasEntre cuenta días de calendario y no inventa ante una fecha rota', () => {
    expect(diasEntre('2026-09-19', '2026-11-20')).toBe(62);
    expect(diasEntre('no-es-fecha', '2026-11-20')).toBeNull();
  });
});
