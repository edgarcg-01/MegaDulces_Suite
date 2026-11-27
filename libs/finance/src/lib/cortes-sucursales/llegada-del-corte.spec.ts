/**
 * `[CSU.27]` Pruebas de «¿llegó el dinero del corte?» y de la venta sin forma de pago.
 *
 * Casos REALES de noviembre de 2026, medidos en prod el 2026-11-26 (`database/scripts/csu27-corte-prod.js`):
 *  · Morelia Abastos `0000161` (Caja 3-39, 2-nov): corte $173,631.85; 118 tickets por $182,383.10 menos $8,751.25 de
 *    devoluciones = el corte al centavo; esperado neto $84,195.66 → «Corte distinto» +$89,436.19 = venta sin forma de
 *    pago. Sus 4 depósitos están en Santander 1604 → llegó.
 *  · Zamora Centro `0000154` (Caja 2-221, 24-nov): «Corte distinto» +$188.33, pero el corte NO es la venta del turno
 *    menos devoluciones (difiere $188.33) → se queda sin causa.
 *  · Morelia Abastos `0000165` (Caja 2-35, 3-nov): 8 depósitos; `UA0501-0000401` ($8,335.54) sin conciliar → el corte
 *    sale «sin conciliar» aunque lo demás llegó.
 */
import type { CobroLlegada, CorteCobro, CorteRow, CortesSucursalesResponse } from '@megadulces/contracts';
import { anexarLlegadaYVenta, llegadaDelCorte, resumenVentaTurno, ventaDelTurno, ventaSinFormaDePago, type VentaTurnoCruda } from './llegada-del-corte';

const G161: VentaTurnoCruda[] = [
  { sucursal: '08', caja: '3', turno: '39', dia: '2026-11-02', tickets: 118, total: '182383.10' },
  // Otro turno de la misma caja, y el mismo folio de turno en otra sucursal: no entran.
  { sucursal: '08', caja: '3', turno: '40', dia: '2026-11-03', tickets: 90, total: '150000.00' },
  { sucursal: '01', caja: '3', turno: '39', dia: '2026-11-02', tickets: 5, total: '999.00' },
];
const C161 = { sucursal: '08', caja: '3', turno: '39', fecha: '2026-11-02', monto: 173631.85, cuadre: 'corte_distinto' as const, diferencia: 89436.19, devoluciones_total: 8751.25 };

describe('[CSU.27] la venta del turno', () => {
  it('0000161: 118 tickets por $182,383.10, sólo de su sucursal, caja y turno', () => {
    expect(ventaDelTurno(C161, G161)).toEqual({ tickets: 118, total: 182383.1 });
  });
  it('el turno que cruza la medianoche suma los tickets del día siguiente; a dos días ya no', () => {
    const g = [...G161, { sucursal: '08', caja: '3', turno: '39', dia: '2026-11-03', tickets: 2, total: '100.00' }];
    expect(ventaDelTurno(C161, g)).toEqual({ tickets: 120, total: 182483.1 });
    const lejos = [...G161, { sucursal: '08', caja: '3', turno: '39', dia: '2026-11-04', tickets: 2, total: '100.00' }];
    expect(ventaDelTurno(C161, lejos)).toEqual({ tickets: 118, total: 182383.1 });
  });
  it('el folio con ceros a la izquierda es el mismo turno («039» = «39»)', () => {
    expect(ventaDelTurno({ ...C161, turno: '039' }, G161)).toEqual({ tickets: 118, total: 182383.1 });
  });
  it('sin tickets, sin caja o con el turno repetido en otro corte cercano → no hay venta (no se inventa)', () => {
    expect(ventaDelTurno({ ...C161, turno: '41' }, G161)).toBeNull();
    expect(ventaDelTurno({ ...C161, caja: null }, G161)).toBeNull();
    expect(ventaDelTurno(C161, G161, 1)).toBeNull();
  });
});

describe('[CSU.27] venta sin forma de pago', () => {
  const v161 = { tickets: 118, total: 182383.1 };
  it('0000161: «Corte distinto» arriba de lo esperado y el corte = venta − devoluciones → $89,436.19', () => {
    expect(ventaSinFormaDePago(C161, v161)).toBe(89436.19);
  });
  it('0000154: «Corte distinto» +$188.33 pero el corte NO es la venta del turno → sin causa', () => {
    const c = { monto: 12673.69, cuadre: 'corte_distinto' as const, diferencia: 188.33, devoluciones_total: 0 };
    expect(ventaSinFormaDePago(c, { tickets: 40, total: 12485.36 })).toBeNull();
  });
  it('sin la venta del turno no se afirma', () => {
    expect(ventaSinFormaDePago(C161, null)).toBeNull();
  });
  it('sólo «Corte distinto»: un sobrante del arqueo, un faltante o un corte que cuadra no se renombran', () => {
    for (const cuadre of ['sobrante_arqueo', 'faltante_arqueo', 'cuadra', 'sin_arqueo'] as const) {
      expect(ventaSinFormaDePago({ ...C161, cuadre }, v161)).toBeNull();
    }
  });
  it('un corte ABAJO de lo esperado no es venta sin forma de pago', () => {
    expect(ventaSinFormaDePago({ ...C161, diferencia: -5000 }, v161)).toBeNull();
  });
  it('centavos (menos de $1) no son venta sin forma de pago', () => {
    expect(ventaSinFormaDePago({ ...C161, diferencia: 0.6 }, v161)).toBeNull();
  });
});

describe('[CSU.27] ¿llegó el dinero del corte?', () => {
  const banco = { estado: 'en_banco' as const };
  it('0000161: sus 4 depósitos están en el banco → llegó', () => {
    const l = llegadaDelCorte({ monto: 173631.85, fecha: '2026-11-02' },
      [{ monto: 8600, llegada: banco }, { monto: 50371.35, llegada: banco }, { monto: 80000, llegada: banco }, { monto: 34660.5, llegada: banco }],
      '2026-11-26');
    expect(l).toEqual({ estado: 'llego', llego: 173631.85, por_saber: 0, sin_conciliar: 0, puente: 0, sin_deposito: 0, edad_dias: null });
  });
  it('0000165: un depósito sin conciliar basta para que el corte lo diga, aunque lo demás llegó', () => {
    const l = llegadaDelCorte({ monto: 214268.21, fecha: '2026-11-03' },
      [{ monto: 205932.67, llegada: banco }, { monto: 8335.54, llegada: { estado: 'sin_conciliar' } }], '2026-11-26');
    expect(l.estado).toBe('sin_conciliar');
    expect(l.sin_conciliar).toBe(8335.54);
    expect(l.llego).toBe(205932.67);
  });
  it('sin depósito: lleva su edad en días, no un veredicto', () => {
    const l = llegadaDelCorte({ monto: 189678.93, fecha: '2026-11-25' }, [], '2026-11-26');
    expect(l).toMatchObject({ estado: 'sin_deposito', sin_deposito: 189678.93, edad_dias: 1 });
  });
  it('parte depositada con testigo y parte sin depositar → parcial, con su edad', () => {
    const l = llegadaDelCorte({ monto: 167460.31, fecha: '2026-11-19' }, [{ monto: 89874.62, llegada: banco }], '2026-11-26');
    expect(l).toMatchObject({ estado: 'parcial', llego: 89874.62, sin_deposito: 77585.69, edad_dias: 7 });
  });
  it('en una cuenta cuyo libro de Bancos no llega → por saber, NO «llegó» ni «sin conciliar»', () => {
    const l = llegadaDelCorte({ monto: 90000, fecha: '2026-11-17' }, [{ monto: 90000, llegada: { estado: 'banco_sin_libro' } }], '2026-11-26');
    expect(l).toMatchObject({ estado: 'por_saber', por_saber: 90000, llego: 0 });
  });
  it('lo puente no falta: devoluciones + banco = llegó', () => {
    const l = llegadaDelCorte({ monto: 1000, fecha: '2026-11-03' },
      [{ monto: 900, llegada: banco }, { monto: 100, llegada: { estado: 'puente' } }], '2026-11-26');
    expect(l).toMatchObject({ estado: 'llego', llego: 900, puente: 100 });
  });
  it('caja sin asiento y sin cuenta cuentan como sin testigo', () => {
    for (const estado of ['caja_sin_asiento', 'sin_cuenta'] as const) {
      expect(llegadaDelCorte({ monto: 100, fecha: '2026-11-03' }, [{ monto: 100, llegada: { estado } }], '2026-11-26').estado).toBe('sin_conciliar');
    }
  });
  it('sin conciliar gana sobre parcial y por saber (es lo que alguien tiene que ir a ver)', () => {
    const l = llegadaDelCorte({ monto: 300, fecha: '2026-11-03' },
      [{ monto: 100, llegada: { estado: 'banco_sin_libro' } }, { monto: 100, llegada: { estado: 'sin_conciliar' } }], '2026-11-26');
    expect(l.estado).toBe('sin_conciliar');
  });
  it('centavos sin depositar (menos de $1) no hacen parcial', () => {
    const l = llegadaDelCorte({ monto: 106478.89, fecha: '2026-11-18' }, [{ monto: 106478.56, llegada: banco }], '2026-11-26');
    expect(l).toMatchObject({ estado: 'llego', sin_deposito: 0.33, edad_dias: null });
  });
});

describe('[CSU.27] el resumen de la venta del turno (el mismo que usa el detalle)', () => {
  it('0000161: neto = tickets − devoluciones = el corte', () => {
    expect(resumenVentaTurno(C161, { tickets: 118, total: 182383.1 }))
      .toEqual({ tickets: 118, total: 182383.1, devoluciones: 8751.25, neto: 173631.85, igual_al_corte: true });
  });
  it('sin venta → null', () => {
    expect(resumenVentaTurno(C161, null)).toBeNull();
  });
});

describe('[CSU.29] colgar la llegada y la venta de la respuesta', () => {
  const cobro = (folio: string, monto: number): CorteCobro =>
    ({ doc_prefix: 'UA0501', folio, fecha: '2026-11-03', monto, forma_pago: null, concepto: null, medio_cobro: 'banco', cuenta_tesoreria: 'SANTANDER 1604', llegada: null });
  const corte = (x: Partial<CorteRow>): CorteRow => ({
    ...C161, clave: '08-UD2301-0000161', sucursal_nombre: 'Morelia Abastos', documento: 'UD2301-0000161', folio: '0000161',
    referencia: 'Caja 3-39', cobrado: 0, saldo: 0, estado_cobro: 'cobrado', cobros: [], cobros_cancelados: [], devoluciones: [],
    arqueo: null, sin_cuadrar: true, llegada: null, venta_turno: null, venta_sin_forma_de_pago: null, ...x,
  }) as CorteRow;
  const resp = (cortes: CorteRow[]): CortesSucursalesResponse => ({ cortes, llegada: null, venta_sin_forma_de_pago: null }) as unknown as CortesSucursalesResponse;
  const banco: CobroLlegada = { estado: 'en_banco', cuenta: '1604', renglones: [], caja_general: [], cuenta_bancos: 'STDR 1604', libro_hasta: '2026-11-10' };
  const mapa = (pares: Array<[string, CobroLlegada]>) => new Map(pares.map(([f, l]) => [`08|UA0501|${f}`, l]));

  it('0000161: cada depósito trae su llegada, el corte llegó, y su venta sin forma de pago queda dicha', () => {
    const r = resp([corte({ cobros: [cobro('0000363', 8600), cobro('0000393', 50371.35), cobro('0000391', 80000), cobro('0000392', 34660.5)] })]);
    anexarLlegadaYVenta(r, mapa([['0000363', banco], ['0000393', banco], ['0000391', banco], ['0000392', banco]]), G161, '2026-11-26');
    const c = r.cortes[0];
    expect(c.cobros.every((b) => b.llegada?.estado === 'en_banco')).toBe(true);
    expect(c.llegada).toMatchObject({ estado: 'llego', llego: 173631.85, sin_deposito: 0 });
    expect(c.venta_turno).toMatchObject({ tickets: 118, igual_al_corte: true });
    expect(c.venta_sin_forma_de_pago).toBe(89436.19);
    expect(r.llegada).toEqual({ aplicado: 173631.85, llego: 173631.85, por_saber: 0, sin_conciliar: 0, puente: 0, sin_deposito: 0,
      cortes: { sin_deposito: 0, sin_conciliar: 0, parcial: 0, por_saber: 0, llego: 1 } });
    expect(r.venta_sin_forma_de_pago).toEqual({ cortes: 1, monto: 89436.19 });
  });
  it('la consulta de llegada falló → todo lo de llegada queda «no medido» (null), y la venta sí se mide', () => {
    const r = resp([corte({ cobros: [cobro('0000363', 8600)] })]);
    anexarLlegadaYVenta(r, null, G161, '2026-11-26');
    expect(r.cortes[0].cobros[0].llegada).toBeNull();
    expect(r.cortes[0].llegada).toBeNull();
    expect(r.llegada).toBeNull();
    expect(r.venta_sin_forma_de_pago).toEqual({ cortes: 1, monto: 89436.19 });
  });
  it('la venta del turno no se midió → venta y venta sin forma de pago quedan null (no cero)', () => {
    const r = resp([corte({})]);
    anexarLlegadaYVenta(r, new Map(), null, '2026-11-26');
    expect(r.cortes[0].venta_turno).toBeNull();
    expect(r.cortes[0].venta_sin_forma_de_pago).toBeNull();
    expect(r.venta_sin_forma_de_pago).toBeNull();
    expect(r.llegada?.cortes.sin_deposito).toBe(1);
  });
  it('un depósito que no vino en la consulta cuenta como «sin cuenta», nunca como llegado', () => {
    const r = resp([corte({ cobros: [cobro('0000363', 8600), cobro('0009999', 165031.85)] })]);
    anexarLlegadaYVenta(r, mapa([['0000363', banco]]), G161, '2026-11-26');
    expect(r.cortes[0].cobros[1].llegada).toBeNull();
    expect(r.cortes[0].llegada).toMatchObject({ estado: 'sin_conciliar', sin_conciliar: 165031.85, llego: 8600 });
  });
  it('dos cortes de la misma caja y turno a ±3 días: los tickets no se reparten (venta null en los dos)', () => {
    const r = resp([corte({}), corte({ folio: '0000999', fecha: '2026-11-04' })]);
    anexarLlegadaYVenta(r, new Map(), G161, '2026-11-26');
    expect(r.cortes.map((c) => c.venta_turno)).toEqual([null, null]);
    expect(r.venta_sin_forma_de_pago).toEqual({ cortes: 0, monto: 0 });
  });
});
