import 'reflect-metadata';
import { PARAMETROS_PROPUESTOS } from '@megadulces/contracts';
import { AutorizacionPedidosService, armarBandeja, pagoDelCliente, type LecturaBandeja } from './autorizacion-pedidos.service';
import { CustomerLedgerService } from './customer-ledger.service';
import { CustomerLedgerController } from './customer-ledger.controller';
import { FinanceCustomerLedgerModule } from './finance-customer-ledger.module';

/**
 * `[GP.A.4]` La bandeja «Por autorizar»: el armado (puro) y el cableado. Las consultas se midieron en prod en sólo
 * lectura el 2026-11-20 (anexo EA §3.6); aquí, lo que la bandeja hace con lo leído.
 */
const P = PARAMETROS_PROPUESTOS;
const fresca = (minutos: number) => ({
  data_as_of: new Date(Date.parse('2026-11-20T18:00:00Z') - minutos * 60_000).toISOString(),
  status: 'fresh' as const, stale: false, age_human: `${minutos} min`, inputs: [],
});
const lectura = (o: Partial<LecturaBandeja> = {}): LecturaBandeja => ({
  hoy: '2026-11-20',
  pedidos: [
    { sucursal: '08', serie: 1, folio: '0001842', cliente: 'C3104', importe: 1_000, fecha: '2026-11-19', nombre: 'ABARROTES EL SOL', limite: 10_000, plazo: 15, por_cobrar: 2_000, ruta_vecinal: false },
  ],
  abiertos: [],
  facturas: [],
  carril: [{ sucursal: '08', encendida: true, tope_dia: 50 }],
  freshness: fresca(2),
  ahora: new Date('2026-11-20T18:00:00Z'),
  ...o,
});

describe('[GP.A.4] armarBandeja', () => {
  it('con todo en orden y el carril encendido, la regla diría «autorizar»', () => {
    const b = armarBandeja(lectura(), P);
    expect(b.pendientes).toHaveLength(1);
    expect(b.pendientes[0].resultado.decision).toBe('autorizar');
    expect(b.pendientes[0].sucursal_nombre).toBe('Morelia Abastos');
    expect(b.parametros.origen).toBe('propuesta');
    expect(b.autorizados_hoy).toBeNull();
  });

  it('⛔ el carril apagado (sin renglón) manda a la bandeja y lo dice: condición 6', () => {
    const b = armarBandeja(lectura({ carril: [] }), P);
    expect(b.pendientes[0].resultado.decision).toBe('bandeja');
    expect(b.pendientes[0].resultado.motivos.map((m) => m.condicion)).toEqual([6]);
    expect(b.sucursales_encendidas).toEqual([]);
  });

  it('los otros pedidos abiertos suman, sin contar el propio', () => {
    const b = armarBandeja(lectura({ abiertos: [
      { sucursal: '08', cliente: 'C3104', serie: 1, folio: '0001842', importe: 1_000, fecha: '2026-11-19' },
      { sucursal: '08', cliente: 'C3104', serie: 1, folio: '0001800', importe: 7_500, fecha: '2026-11-10' },
    ] }), P);
    expect(b.pendientes[0].otros_pedidos).toBe(7_500);
    expect(b.pendientes[0].resultado.numeros.excedente).toBe(500);
  });

  it('negativo: un pedido muerto de hace meses del mismo cliente NO le come el crédito', () => {
    const b = armarBandeja(lectura({ abiertos: [
      { sucursal: '08', cliente: 'C3104', serie: 1, folio: '0000300', importe: 50_000, fecha: '2026-05-10' },
    ] }), P);
    expect(b.pendientes[0].otros_pedidos).toBe(0);
    expect(b.pendientes[0].resultado.decision).toBe('autorizar');
  });

  it('un pedido viejo va aparte, no a la bandeja del día', () => {
    const b = armarBandeja(lectura({ pedidos: [
      { sucursal: '05', serie: 1, folio: '0000047', cliente: '00031', importe: 6_563.14, fecha: '2026-04-01', nombre: 'X', limite: 10_000, plazo: 2, por_cobrar: 56_702.27, ruta_vecinal: false },
    ] }), P);
    expect(b.pendientes).toHaveLength(0);
    expect(b.aparte).toHaveLength(1);
  });

  it('el cliente que sólo debe centavos de una factura cobrada pasa; la cartera viva se reporta', () => {
    const b = armarBandeja(lectura({ facturas: [
      { sucursal: '08', cliente: 'C3104', saldo: 0.37, importe: 15_730.37, vencimiento: '2026-08-01', dias_pago: null },
    ] }), P);
    expect(b.pendientes[0].resultado.decision).toBe('autorizar');
    expect(b.pendientes[0].resultado.numeros.resto_ignorado).toBe(0.37);
    expect(b.pendientes[0].saldo_cartera).toBe(0.37);
  });

  it('⛔ datos viejos (más de 15 min) mandan a la bandeja: condición 5', () => {
    const b = armarBandeja(lectura({ freshness: fresca(40) }), P);
    expect(b.pendientes[0].resultado.motivos.map((m) => m.condicion)).toEqual([5]);
  });

  it('[D-A12] CONTADO sale de la bandeja a su propia lista, sin «por cobrar» inventado; con el carril encendido pasaría solo', () => {
    const b = armarBandeja(lectura({ pedidos: [
      { sucursal: '08', serie: 1, folio: '0002000', cliente: 'CONTADO', importe: 3_000, fecha: '2026-11-19', nombre: 'CONTADO', limite: null, plazo: null, por_cobrar: null, ruta_vecinal: false },
    ] }), P);
    expect(b.pendientes).toHaveLength(0);
    expect(b.contado).toHaveLength(1);
    expect(b.contado[0].es_contado).toBe(true);
    expect(b.contado[0].por_cobrar_kepler).toBeNull();
    expect(b.contado[0].resultado.decision).toBe('autorizar');
  });

  it('[D-A13] un pedido de la ruta vecinal va aparte con su marca, aunque sea reciente', () => {
    const b = armarBandeja(lectura({ pedidos: [
      { sucursal: '05', serie: 1, folio: '0000801', cliente: '30028', importe: 2_000, fecha: '2026-11-15', nombre: 'X', limite: 10_000, plazo: 2, por_cobrar: 0, ruta_vecinal: true },
    ] }), P);
    expect(b.pendientes).toHaveLength(0);
    expect(b.aparte).toHaveLength(1);
    expect(b.aparte[0].ruta_vecinal).toBe(true);
  });

  it('el más viejo primero', () => {
    const b = armarBandeja(lectura({ pedidos: [
      { sucursal: '08', serie: 1, folio: 'B', cliente: 'C1', importe: 1, fecha: '2026-11-19', nombre: 'B', limite: 10, plazo: 1, por_cobrar: 0, ruta_vecinal: false },
      { sucursal: '08', serie: 1, folio: 'A', cliente: 'C2', importe: 1, fecha: '2026-11-18', nombre: 'A', limite: 10, plazo: 1, por_cobrar: 0, ruta_vecinal: false },
    ] }), P);
    expect(b.pendientes.map((x) => x.folio)).toEqual(['A', 'B']);
  });
});

describe('[GP.A.4] pagoDelCliente', () => {
  const f = (dias_pago: number | null, saldo = 0) => ({ sucursal: '08', cliente: 'C', saldo, importe: 100, vencimiento: null, dias_pago });
  it('mediana, a tiempo y peor atraso, de las facturas pagadas', () => {
    expect(pagoDelCliente([f(10), f(14), f(20), f(31), f(null, 50)], 15)).toEqual({ facturas_pagadas: 4, mediana_dias: 17, a_tiempo: 2, peor_atraso: 16 });
  });
  it('negativo: sin plazo en Kepler no se dice «a tiempo» (null, no 0)', () => {
    expect(pagoDelCliente([f(10)], null)).toEqual({ facturas_pagadas: 1, mediana_dias: 10, a_tiempo: null, peor_atraso: null });
  });
  it('sin facturas pagadas, todo null', () => {
    expect(pagoDelCliente([], 15)).toEqual({ facturas_pagadas: 0, mediana_dias: null, a_tiempo: null, peor_atraso: null });
  });
});

describe('[GP.A.4] el cableado (que compile no es que arranque, #414)', () => {
  const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
  it('la bandeja es provider del módulo de Cartera, junto al servicio que reusa', () => {
    const providers = meta<unknown>('providers', FinanceCustomerLedgerModule);
    expect(providers).toContain(AutorizacionPedidosService);
    expect(providers).toContain(CustomerLedgerService);
  });
  it('los constructores toman lo que el módulo provee (si cambia, revisar el arranque)', () => {
    expect(AutorizacionPedidosService.length).toBe(3);
    expect(CustomerLedgerController.length).toBe(5);
  });
});
