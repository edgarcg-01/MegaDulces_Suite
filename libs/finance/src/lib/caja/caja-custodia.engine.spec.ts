/**
 * `[CGA-A.50]` — El retiro en custodia. Las pruebas que importan son las NEGATIVAS: un motor que
 * deja salir del cajón lo que nunca entró, o que olvida un peso de la custodia, vuelve a fabricar
 * los ±$200,000 de octubre con otro nombre.
 */
import {
  saldoDeRetiro, piernasDeCustodia, ajusteDeCustodia, custodiaPermiteCerrar, saldoPorResponsable,
  remanenteDeRetiro, regresoCuadra, valorDePiezas, valorDeLlave,
  origenDelEgreso,
  type RetiroCaos, type CustodiaRetiro, type EnlaceRetiro,
} from './caja-custodia.engine';
import { calcularCorte, type MovimientoDelCorte } from './cash-cut.engine';

const D = 'AST700-19758';
const ret = (id: number, total: number, dia: string, at = `${dia}T12:00:00-06:00`): RetiroCaos =>
  ({ device: D, external_id: id, total, dia, at, operador: '003' });
const cus = (id: number, destino: 'cajon' | 'custodia', cierre?: CustodiaRetiro['cierre']): CustodiaRetiro =>
  ({ device: D, external_id: id, destino, responsable: destino === 'custodia' ? '003' : null, cierre: cierre ?? null });
const enl = (id: number, gasto: string, monto: number, dia_gasto: string): EnlaceRetiro =>
  ({ device: D, external_id: id, cash_ledger_id: gasto, monto, dia_gasto });
const gasto = (monto: number): MovimientoDelCorte => ({ tipo: 'gasto', monto, estado: 'registrado' } as MovimientoDelCorte);

describe('saldoDeRetiro', () => {
  const AHORA = '2026-10-21T18:00:00-06:00';

  it('un retiro de $200,000 pagando varios gastos chicos: lo que le queda es lo que la persona debe', () => {
    const r = ret(1720, 200000, '2026-10-19');
    const s = saldoDeRetiro(r, cus(1720, 'custodia'), [
      enl(1720, 'g1', 13803.05, '2026-10-19'), enl(1720, 'g2', 41250, '2026-10-20'), enl(1720, 'g3', 140750, '2026-10-21'),
    ], AHORA, 72);
    expect(s).toMatchObject({ enlazado: 195803.05, disponible: 4196.95, estado: 'abierto', gastos: 3, responsable: '003' });
  });

  it('pagado hasta el último peso: se cierra solo', () => {
    const s = saldoDeRetiro(ret(1, 50000, '2026-10-21'), cus(1, 'custodia'),
      [enl(1, 'a', 30000, '2026-10-21'), enl(1, 'b', 20000, '2026-10-21')], AHORA, 72);
    expect(s.estado).toBe('cerrado');
    expect(s.disponible).toBe(0);
  });

  it('NEGATIVA: pasado el plazo con saldo es VENCIDO, no abierto', () => {
    const s = saldoDeRetiro(ret(1, 50000, '2026-10-15', '2026-10-15T12:00:00-06:00'), cus(1, 'custodia'),
      [enl(1, 'a', 10000, '2026-10-15')], AHORA, 72);
    expect(s.estado).toBe('vencido');
    expect(s.disponible).toBe(40000);
  });

  it('NEGATIVA: enlazado por encima de lo que salió se declara EXCEDIDO aunque esté clasificado', () => {
    const s = saldoDeRetiro(ret(1, 10000, '2026-10-21'), cus(1, 'custodia'),
      [enl(1, 'a', 8000, '2026-10-21'), enl(1, 'b', 2500, '2026-10-21')], AHORA, 72);
    expect(s.estado).toBe('excedido');
  });

  it('NEGATIVA: un cierre que no explica todo el saldo es cerrado_con_diferencia, no cerrado', () => {
    const s = saldoDeRetiro(ret(1, 10000, '2026-10-21'), cus(1, 'custodia', { tipo: 'cajon', monto: 1500, dia: '2026-10-21' }),
      [enl(1, 'a', 8000, '2026-10-21')], AHORA, 72);
    expect(s.estado).toBe('cerrado_con_diferencia');
    expect(s.disponible).toBe(500);
  });

  it('sin clasificar no se confunde con abierto', () => {
    expect(saldoDeRetiro(ret(1, 10000, '2026-10-21'), null, [], AHORA, 72).estado).toBe('sin_clasificar');
  });
});

describe('piernasDeCustodia + calcularCorte — los dos cortes reales de octubre', () => {
  // Reducido a lo que importa: el retiro grande del 19 (#1650, $135,430) que se fue a pagar, y
  // los gastos del 21 pagados con él.
  const retiros = [ret(1650, 135430, '2026-10-19')];
  const custodias = [cus(1650, 'custodia')];
  const enlaces = [enl(1650, 'g21a', 100000, '2026-10-21'), enl(1650, 'g21b', 35430, '2026-10-21')];

  it('el 19 el cajón NO debe tener el retiro que se llevaron', () => {
    const p = piernasDeCustodia('2026-10-19', retiros, custodias, enlaces);
    expect(p.dispensado_en_custodia).toBe(135430);
    expect(ajusteDeCustodia(p)).toBe(-135430);
    const t = calcularCorte({
      fondoInicial: 1000, movimientos: [], cajeroSinCapturar: { dispensado: 135430, depositado: 0 },
      custodia: p, conteo: [{ denominacion: 500, piezas: 2 }],
    });
    expect(t.esperado).toBe(1000);
    expect(t.veredicto).toBe('cuadra');
  });

  it('el 21 los gastos pagados con la custodia NO salen del cajón', () => {
    const p = piernasDeCustodia('2026-10-21', retiros, custodias, enlaces);
    expect(p.gastos_de_custodia).toBe(135430);
    const t = calcularCorte({
      fondoInicial: 1000, movimientos: [gasto(100000), gasto(35430)], cajeroSinCapturar: { dispensado: 0, depositado: 0 },
      custodia: p, conteo: [{ denominacion: 500, piezas: 2 }],
    });
    expect(t.esperado).toBe(1000);
    expect(t.veredicto).toBe('cuadra');
  });

  it('CONTROL: sin custodia, los mismos hechos reproducen el «falta» y el «imposible» de octubre', () => {
    const t19 = calcularCorte({ fondoInicial: 1000, movimientos: [], cajeroSinCapturar: { dispensado: 135430 }, conteo: [{ denominacion: 500, piezas: 2 }] });
    expect(t19.veredicto).toBe('falta');
    const t21 = calcularCorte({ fondoInicial: 1000, movimientos: [gasto(100000), gasto(35430)], conteo: [{ denominacion: 500, piezas: 2 }] });
    expect(t21.veredicto).toBe('esperado_imposible');
  });

  it('⭐ sin ninguna custodia el esperado es IDÉNTICO al de [CG.96] (no se mueve un corte viejo)', () => {
    const base = { fondoInicial: 23757, movimientos: [gasto(511206)], cajeroSinCapturar: { dispensado: 484660, depositado: 238010 } };
    const sin = calcularCorte(base);
    const conVacia = calcularCorte({ ...base, custodia: piernasDeCustodia('2026-10-22', [ret(9, 484660, '2026-10-22')], [], []) });
    expect(conVacia.esperado).toBe(sin.esperado);
  });

  it('NEGATIVA: un gasto enlazado a un retiro que fue AL CAJÓN sí sale del cajón', () => {
    const p = piernasDeCustodia('2026-10-21', [ret(7, 5000, '2026-10-21')], [cus(7, 'cajon')], [enl(7, 'g', 5000, '2026-10-21')]);
    expect(p.gastos_de_custodia).toBe(0);
    expect(ajusteDeCustodia(p)).toBe(0);
  });

  it('el sobrante que vuelve al cajón entra en el corte del día en que volvió, no en el del retiro', () => {
    const c = [cus(1650, 'custodia', { tipo: 'cajon', monto: 4196.95, dia: '2026-10-22' })];
    expect(piernasDeCustodia('2026-10-21', retiros, c, []).sobrantes_al_cajon).toBe(0);
    expect(piernasDeCustodia('2026-10-22', retiros, c, []).sobrantes_al_cajon).toBe(4196.95);
  });

  it('el regreso a CAOS anula el depósito en el cajón (ese efectivo nunca estuvo en el cajón)', () => {
    const c = [cus(1650, 'custodia', { tipo: 'regreso_caos', monto: 4000, dia: '2026-10-22', deposito_external_id: 1700 })];
    const p = piernasDeCustodia('2026-10-22', retiros, c, []);
    const t = calcularCorte({ fondoInicial: 1000, movimientos: [], cajeroSinCapturar: { depositado: 4000 }, custodia: p, conteo: [{ denominacion: 500, piezas: 2 }] });
    expect(t.esperado).toBe(1000);
  });

  it('NEGATIVA: un faltante NO entra al cajón ni a la máquina', () => {
    const c = [cus(1650, 'custodia', { tipo: 'faltante', monto: 4196.95, dia: '2026-10-22' })];
    expect(ajusteDeCustodia(piernasDeCustodia('2026-10-22', retiros, c, []))).toBe(0);
  });
});

describe('custodiaPermiteCerrar', () => {
  it('NEGATIVA: un retiro sin clasificar frena el corte, con monto', () => {
    const p = piernasDeCustodia('2026-10-23', [ret(1, 163080, '2026-10-23'), ret(2, 58900, '2026-10-23')], [cus(2, 'cajon')], []);
    expect(custodiaPermiteCerrar(p)).toEqual({ ok: false, motivo: 'retiros_sin_clasificar', retiros: 1, monto: 163080 });
  });
  it('todo clasificado: cierra', () => {
    const p = piernasDeCustodia('2026-10-23', [ret(1, 163080, '2026-10-23')], [cus(1, 'custodia')], []);
    expect(custodiaPermiteCerrar(p)).toEqual({ ok: true });
  });
});

describe('saldoPorResponsable', () => {
  it('suma sólo lo abierto o vencido, por persona', () => {
    const AHORA = '2026-10-23T18:00:00-06:00';
    const s = [
      saldoDeRetiro(ret(1, 200000, '2026-10-19', '2026-10-19T12:00:00-06:00'), cus(1, 'custodia'), [enl(1, 'a', 150000, '2026-10-20')], AHORA, 72),
      saldoDeRetiro(ret(2, 30000, '2026-10-23'), cus(2, 'custodia'), [], AHORA, 72),
      saldoDeRetiro(ret(3, 10000, '2026-10-23'), cus(3, 'custodia'), [enl(3, 'b', 10000, '2026-10-23')], AHORA, 72),
    ];
    expect(saldoPorResponsable(s)).toEqual([{ responsable: '003', abiertos: 1, vencidos: 1, monto: 80000, mas_viejo_horas: 102 }]);
  });
});

describe('[CGA-A.55] los billetes del retiro', () => {
  // El ejemplo de Edgar: un retiro de $100,000 = 200 × $500, cuatro movimientos de caja.
  const RETIRO = { '500': 200 };

  it('el ejemplo: 200 billetes, se entregan 180, deben quedar 20 × $500 más el cambio', () => {
    const r = remanenteDeRetiro(RETIRO, [
      { billetes: { '500': 50 } },
      { billetes: { '500': 60 }, cambio: { '200': 1, '100': 3 } },
      { billetes: { '500': 40 } },
      { billetes: { '500': 30 } },
    ]);
    expect(r.remanente).toEqual({ '500': 20, '200': 1, '100': 3 });
    expect(r.valor).toBe(10500);
    expect(r.faltan).toEqual([]);
    expect(r.completo).toBe(true);
  });

  it('NEGATIVA: entregar un billete que el retiro no traía se declara como faltante', () => {
    const r = remanenteDeRetiro({ '200': 100 }, [{ billetes: { '500': 10 } }]);
    expect(r.faltan).toEqual([{ llave: '500', faltan: 10 }]);
  });

  it('el cambio que regresa SÍ se puede volver a entregar', () => {
    const r = remanenteDeRetiro({ '500': 2 }, [
      { billetes: { '500': 1 }, cambio: { '100': 2 } },
      { billetes: { '100': 2 } },
    ]);
    expect(r.faltan).toEqual([]);
    expect(r.remanente).toEqual({ '500': 1 });
  });

  it('NEGATIVA: un enlace sin billetes (los viejos) deja el remanente por denominación SIN AFIRMAR', () => {
    expect(remanenteDeRetiro(RETIRO, [{ billetes: null }]).completo).toBe(false);
  });

  it('el regreso a CAOS cuadra sólo billete por billete', () => {
    expect(regresoCuadra({ '500': 20 }, { '500': 20 })).toEqual({ ok: true });
    // NEGATIVA: mismo monto, otros billetes ($10,000 en 50 × $200 en lugar de 20 × $500).
    expect(regresoCuadra({ '500': 20 }, { '200': 50 })).toEqual({
      ok: false, diferencias: [{ llave: '500', quedaba: 20, regreso: 0 }, { llave: '200', quedaba: 0, regreso: 50 }],
    });
    // NEGATIVA: la morralla del remanente no puede entrar a la máquina.
    expect(regresoCuadra({ '500': 20, '10': 3 }, { '500': 20 }).ok).toBe(false);
  });

  it('las llaves del catálogo: la moneda de $20 no es el billete de $20', () => {
    expect(valorDeLlave('20m')).toBe(20);
    expect(valorDeLlave('B20')).toBeNull();
    expect(valorDePiezas({ '20': 2, '20m': 1, '0.5': 2 })).toBe(61);
  });
});

describe('[CGA-A.56] de dónde salió el dinero de un egreso', () => {
  const DESDE = '2026-11-01';
  const g = (o: Partial<Parameters<typeof origenDelEgreso>[0]>) =>
    origenDelEgreso({ tipo: 'gasto', fecha: '2026-11-05', retiros: 0, declarado: null, desde: DESDE, ...o });

  it('con retiros enlazados es CAOS, y sin retiros puede declararse cajón', () => {
    expect(g({ retiros: 2 })).toEqual({ ok: true, origen: 'caos' });
    expect(g({ declarado: 'cajon' })).toEqual({ ok: true, origen: 'cajon' });
  });
  it('NEGATIVA: desde el arranque, un egreso sin origen no se guarda', () => {
    expect(g({})).toEqual({ ok: false, motivo: 'falta_origen' });
  });
  it('antes del arranque (o sin arranque) no se exige: el freno nace apagado', () => {
    expect(g({ fecha: '2026-10-31' })).toEqual({ ok: true, origen: null });
    expect(g({ desde: null })).toEqual({ ok: true, origen: null });
  });
  it('NEGATIVA: «cajón» con retiros enlazados es una contradicción', () => {
    expect(g({ retiros: 1, declarado: 'cajon' })).toEqual({ ok: false, motivo: 'cajon_con_retiros' });
  });
  it('NEGATIVA: «CAOS» sin decir qué retiro no alcanza', () => {
    expect(g({ declarado: 'caos' })).toEqual({ ok: false, motivo: 'caos_sin_retiro' });
  });
  it('NEGATIVA: otro origen no existe', () => {
    expect(g({ declarado: 'banco' })).toEqual({ ok: false, motivo: 'origen_invalido' });
  });
  it('un ingreso no sale de ningún lado: no se le exige', () => {
    expect(g({ tipo: 'ingreso' })).toEqual({ ok: true, origen: null });
  });
});
