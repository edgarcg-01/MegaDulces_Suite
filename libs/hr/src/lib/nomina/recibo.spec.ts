/**
 * `[NE.1.1]` La aritmética del recibo.
 *
 * Los casos fijan lo medido el 2026-11-23 en el sistema actual: la identidad se cumple en 252 de
 * 254 recibos, y los 2 que fallan entregan efectivo de más **sin concepto que lo explique**. La
 * prueba que más importa de este archivo es la que demuestra que **ese recibo ya no se puede
 * construir**, y que el error dice cuánto y de qué lado.
 *
 * Estructura real, cifras inventadas: este repositorio es público.
 */
import {
  armaRecibo,
  centavosAPesos,
  cuadreDeRecibo,
  efectivoDelRecibo,
  pesosACentavos,
  ReciboInvalido,
  totalDevengado,
  type ConceptoDelRecibo,
  type EntregaDelRecibo,
} from './recibo';

const sueldo = (c: number): ConceptoDelRecibo => ({ clave: 'sueldo', importe: c, signo: 'devenga' });
const banco = (c: number): EntregaDelRecibo => ({ forma: 'banco', importe: c });
const efvo = (c: number): EntregaDelRecibo => ({ forma: 'efectivo', importe: c });

describe('el dinero son centavos enteros', () => {
  it('convierte pesos redondeando una sola vez, en el borde', () => {
    expect([pesosACentavos(2206.54), pesosACentavos(0.1), pesosACentavos(1481.2)]).toEqual([220654, 10, 148120]);
  });

  it('⭐ no arrastra el error de punto flotante del sistema viejo', () => {
    // Medido: un total semanal del sistema actual sale como 519937.59999999788.
    const sumandoEnPesos = 0.1 + 0.2;
    expect(sumandoEnPesos).not.toBe(0.3); // así suma hoy
    expect(pesosACentavos(0.1) + pesosACentavos(0.2)).toBe(pesosACentavos(0.3)); // así suma desde ahora
  });

  it('vuelve a pesos sólo para mostrar', () => {
    expect(centavosAPesos(220654)).toBe(2206.54);
  });

  it('rechaza un importe con decimales: un centavo partido es un centavo que alguien no cobra', () => {
    expect(() => armaRecibo([sueldo(100.5)], [banco(100.5)])).toThrow(/centavos enteros/);
  });

  it('rechaza un importe negativo: el signo va aparte', () => {
    expect(() => armaRecibo([{ clave: 'sueldo', importe: -100, signo: 'devenga' }], [banco(100)])).toThrow(
      /el importe es positivo/,
    );
  });
});

describe('lo entregado es exactamente la suma de los conceptos', () => {
  it('un recibo simple: todo al banco', () => {
    const r = armaRecibo([sueldo(220654)], [banco(220654)]);
    expect(r.totalCentavos).toBe(220654);
  });

  it('la estructura real: una parte al banco y el resto en efectivo', () => {
    const r = armaRecibo([sueldo(530000)], [banco(220654), efvo(309346)]);
    expect([r.totalCentavos, efectivoDelRecibo(r)]).toEqual([530000, 309346]);
  });

  it('con horas extra y los dos ajustes', () => {
    const conceptos: ConceptoDelRecibo[] = [
      sueldo(500000),
      { clave: 'horas_extra', importe: 20000, signo: 'devenga' },
      { clave: 'ajuste_mas', importe: 5000, signo: 'devenga', motivo: 'apoyo de transporte' },
      { clave: 'ajuste_menos', importe: 3000, signo: 'descuenta', motivo: 'préstamo' },
    ];
    const r = armaRecibo(conceptos, [banco(220654), efvo(301346)]);
    expect(r.totalCentavos).toBe(522000);
    expect(totalDevengado(conceptos)).toBe(522000);
  });

  it('⛔⛔ EL CASO MEDIDO: efectivo de más sin concepto NO se puede construir, y el error dice cuánto', () => {
    // Los 2 recibos de 254 que no cuadran: el banco paga el sueldo completo y además sale efectivo.
    expect(() => armaRecibo([sueldo(220654)], [banco(220654), efvo(13790)])).toThrow(ReciboInvalido);
    expect(() => armaRecibo([sueldo(220654)], [banco(220654), efvo(13790)])).toThrow(
      /no cuadra: se entregan 13790 centavos de más/,
    );
    expect(() => armaRecibo([sueldo(220654)], [banco(220654), efvo(13790)])).toThrow(/Falta el concepto/);
  });

  it('y tampoco se puede entregar de MENOS', () => {
    expect(() => armaRecibo([sueldo(220654)], [banco(200000)])).toThrow(/20654 centavos de menos/);
  });

  it('⭐ el mismo caso, agregándole su concepto, SÍ se construye', () => {
    const r = armaRecibo(
      [sueldo(220654), { clave: 'ajuste_mas', importe: 13790, signo: 'devenga', motivo: 'bono de asistencia perfecta' }],
      [banco(220654), efvo(13790)],
    );
    expect(r.totalCentavos).toBe(234444);
  });
});

describe('un ajuste sin motivo no se puede auditar después', () => {
  it('exige motivo en el ajuste a favor', () => {
    expect(() => armaRecibo([sueldo(100), { clave: 'ajuste_mas', importe: 50, signo: 'devenga' }], [banco(150)])).toThrow(
      /exige motivo/,
    );
  });

  it('exige motivo en el ajuste en contra', () => {
    expect(() =>
      armaRecibo([sueldo(200), { clave: 'ajuste_menos', importe: 50, signo: 'descuenta' }], [banco(150)]),
    ).toThrow(/exige motivo/);
  });

  it('un motivo en blanco no es un motivo', () => {
    expect(() =>
      armaRecibo([sueldo(100), { clave: 'ajuste_mas', importe: 50, signo: 'devenga', motivo: '   ' }], [banco(150)]),
    ).toThrow(/exige motivo/);
  });
});

describe('formas de pago', () => {
  it('rechaza una forma que no existe', () => {
    expect(() =>
      armaRecibo([sueldo(100)], [{ forma: 'vale' as unknown as 'banco', importe: 100 }]),
    ).toThrow(/forma de pago inválida/);
  });

  it('⭐ rechaza la misma forma dos veces: si no, el total se arma de dos renglones que nadie concilia', () => {
    expect(() => armaRecibo([sueldo(200)], [banco(100), banco(100)])).toThrow(/aparece dos veces/);
  });
});

describe('los bordes', () => {
  it('un recibo sin conceptos no es un recibo', () => {
    expect(() => armaRecibo([], [banco(100)])).toThrow(/sin conceptos/);
  });

  it('un recibo sin entrega no es un recibo', () => {
    expect(() => armaRecibo([sueldo(100)], [])).toThrow(/sin entrega/);
  });

  it('los descuentos no pueden superar lo devengado', () => {
    expect(() =>
      armaRecibo(
        [sueldo(100), { clave: 'ajuste_menos', importe: 500, signo: 'descuenta', motivo: 'préstamo' }],
        [banco(0)],
      ),
    ).toThrow(/superan lo devengado/);
  });
});

describe('el espejo: medir el sistema viejo sin que la corrida se corte', () => {
  it('cuenta la diferencia en vez de lanzar', () => {
    const c = cuadreDeRecibo([sueldo(220654)], [banco(220654), efvo(13790)]);
    expect(c).toEqual({
      cuadra: false,
      devengadoCentavos: 220654,
      entregadoCentavos: 234444,
      diferenciaCentavos: 13790,
    });
  });

  it('⭐ sobre una semana entera: 252 cuadran y 2 no, que es exactamente lo medido', () => {
    const semana = [
      ...Array.from({ length: 252 }, () => ({ c: [sueldo(220654)], e: [banco(220654)] })),
      { c: [sueldo(220654)], e: [banco(220654), efvo(13790)] },
      { c: [sueldo(220654)], e: [banco(220654), efvo(15760)] },
    ];
    const cuadres = semana.map((r) => cuadreDeRecibo(r.c, r.e));
    expect(cuadres.filter((x) => x.cuadra)).toHaveLength(252);
    const descuadrados = cuadres.filter((x) => !x.cuadra);
    expect(descuadrados.map((x) => x.diferenciaCentavos)).toEqual([13790, 15760]);
    // Y la diferencia total de la semana se puede nombrar en una línea, no se redondea.
    expect(descuadrados.reduce((s, x) => s + x.diferenciaCentavos, 0)).toBe(29550);
  });
});
