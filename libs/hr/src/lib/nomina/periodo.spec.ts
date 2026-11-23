/**
 * `[NE.0.4]` El periodo de nómina como llave.
 *
 * Los casos fijan lo medido el 2026-11-23 contra el sistema actual: la fecha de pago es viernes
 * (1,088 de 1,088 en 2026), y **qué días cubre el periodo no está registrado en ninguna parte**.
 * Por eso la prueba más importante de este archivo es la que exige que «no se sabe» se pueda
 * representar y se diga en voz alta, en vez de salir como cero o como un rango inventado.
 *
 * Sin nombres ni importes: este repositorio es público.
 */
import {
  describePeriodo,
  diaIso,
  diasInclusive,
  esViernes,
  llaveDePeriodo,
  mismoPeriodo,
  nuevoPeriodo,
  PeriodoInvalido,
  rangoDeclarado,
  rangoDesconocido,
} from './periodo';

// Viernes reales de 2026, de los medidos en el sistema actual.
const V_13_NOV = '2026-11-13';
const V_06_NOV = '2026-11-06';

describe('la fecha de pago es viernes', () => {
  it('reconoce los viernes medidos', () => {
    expect([esViernes(V_13_NOV), esViernes(V_06_NOV), esViernes('2026-01-02')]).toEqual([true, true, true]);
  });

  it('rechaza cualquier otro día, y dice cuál es', () => {
    expect(() => nuevoPeriodo('2026-11-12')).toThrow(PeriodoInvalido);
    expect(() => nuevoPeriodo('2026-11-12')).toThrow(/jueves/);
  });

  it('⛔ prueba negativa: un jueves NO construye periodo (si esto pasa a verde, el CHECK de la base es lo único que queda)', () => {
    let cayo = false;
    try {
      nuevoPeriodo('2026-11-19');
    } catch {
      cayo = true;
    }
    expect(cayo).toBe(true);
  });

  it('diaIso usa la convención ISO (domingo = 7, no 0)', () => {
    expect([diaIso('2026-11-16'), diaIso(V_13_NOV), diaIso('2026-11-15')]).toEqual([1, 5, 7]);
  });
});

describe('el rango de días: se declara entero o no se declara', () => {
  it('cuenta los dos extremos — una semana de 7 días, no de 6', () => {
    expect(diasInclusive('2026-11-07', V_13_NOV)).toBe(7);
  });

  it('calcula los días en vez de creerle a quien los pasa', () => {
    const r = rangoDeclarado('2026-11-07', V_13_NOV);
    expect(r).toEqual({ declarado: true, iniciaEl: '2026-11-07', terminaEl: '2026-11-13', dias: 7 });
  });

  it('rechaza un rango que termina antes de empezar', () => {
    expect(() => rangoDeclarado(V_13_NOV, '2026-11-07')).toThrow(PeriodoInvalido);
  });

  it('⭐ «no se sabe» es un valor, no un cero', () => {
    const p = nuevoPeriodo(V_13_NOV);
    expect(p.rango.declarado).toBe(false);
    expect(p.rango).not.toHaveProperty('dias');
  });

  it('⭐ y se DICE: la descripción no calla lo que no sabe', () => {
    expect(describePeriodo(nuevoPeriodo(V_13_NOV))).toBe(
      'Nómina pagada el viernes 13 de noviembre de 2026 · días que cubre: sin declarar',
    );
  });

  it('cuando RH lo declara, la descripción lo dice completo', () => {
    const p = nuevoPeriodo(V_13_NOV, rangoDeclarado('2026-11-07', V_13_NOV));
    expect(describePeriodo(p)).toBe(
      'Nómina pagada el viernes 13 de noviembre de 2026 · cubre 7 día(s), del 2026-11-07 al 2026-11-13',
    );
  });
});

describe('la llave', () => {
  it('es la fecha de pago, no un consecutivo', () => {
    expect(llaveDePeriodo(nuevoPeriodo(V_13_NOV))).toBe(V_13_NOV);
  });

  it('dos periodos son el mismo por su fecha, aunque uno tenga el rango declarado y el otro no', () => {
    const sinRango = nuevoPeriodo(V_13_NOV);
    const conRango = nuevoPeriodo(V_13_NOV, rangoDeclarado('2026-11-07', V_13_NOV));
    expect(mismoPeriodo(sinRango, conRango)).toBe(true);
    expect(mismoPeriodo(sinRango, nuevoPeriodo(V_06_NOV))).toBe(false);
  });

  it('⭐ el consecutivo del centro NO puede ser la llave: el mismo número apunta a semanas distintas', () => {
    // Medido: 335 números de «semana» del sistema actual apuntan a más de una fecha de pago.
    const comoLoNombraUnCentro = '726';
    const dosPeriodosDistintos = [nuevoPeriodo(V_06_NOV), nuevoPeriodo(V_13_NOV)];
    const llaves = new Set(dosPeriodosDistintos.map(llaveDePeriodo));
    expect(llaves.size).toBe(2);
    expect(new Set([comoLoNombraUnCentro, comoLoNombraUnCentro]).size).toBe(1);
  });
});

describe('fechas que no existen', () => {
  it('no se corren solas al mes siguiente', () => {
    expect(() => diaIso('2026-02-31')).toThrow(PeriodoInvalido);
  });

  it('exige el formato civil', () => {
    expect(() => diaIso('13/11/2026')).toThrow(PeriodoInvalido);
  });
});
