/**
 * `[NE.1.5]` La entrega: el recibo exige exactitud, el sobre no la permite, y acá se decide.
 *
 * Lo medido el 2026-11-23 sobre 927 recibos con efectivo: 737 (79.5 %) piden un importe que
 * ninguna moneda puede armar. Redondear a favor de la persona cuesta 12,698 centavos en el
 * periodo; redondear en contra le quita 24,152 — **casi el doble**, porque los residuos se
 * concentran arriba (46 centavos, 330 veces).
 *
 * La prueba que más importa: el redondeo entra como **concepto del recibo**, así que la aritmética
 * sigue cerrando y se puede sumar cuánto se redondeó. Un redondeo que no deja rastro es la versión
 * elegante del mismo defecto que estamos arreglando.
 *
 * Cifras inventadas: este repositorio es público.
 */
import {
  CLAVE_REDONDEO_A_FAVOR,
  CLAVE_REDONDEO_EN_CONTRA,
  EntregaInvalida,
  preparaEntrega,
  redondeoDelPeriodo,
} from './entrega';
import { efectivoDelRecibo, totalDevengado, type ConceptoDelRecibo } from './recibo';
import { sumaDelSobre } from './sobre';

const sueldo = (c: number): ConceptoDelRecibo => ({ clave: 'sueldo', importe: c, signo: 'devenga' });

describe('cuando el efectivo SÍ se puede armar', () => {
  it('no redondea nada y el sobre suma lo exacto', () => {
    const e = preparaEntrega({ conceptos: [sueldo(530000)], bancoCentavos: 220650 });
    expect(e.redondeoCentavos).toBe(0);
    expect(efectivoDelRecibo(e.recibo)).toBe(309350);
    expect(sumaDelSobre(e.sobre.piezas)).toBe(309350);
    expect(e.sobre.residuoCentavos).toBe(0);
  });

  it('todo al banco: no hay sobre que armar', () => {
    const e = preparaEntrega({ conceptos: [sueldo(220654)], bancoCentavos: 220654 });
    expect([e.redondeoCentavos, efectivoDelRecibo(e.recibo), sumaDelSobre(e.sobre.piezas)]).toEqual([0, 0, 0]);
  });
});

describe('cuando no se puede: la política por default es A FAVOR de la persona', () => {
  it('⭐⭐ paga de más lo que falta para la moneda, y lo deja como CONCEPTO', () => {
    // Efectivo bruto 309346 → residuo 46 → se pagan 309350, 4 centavos a favor.
    const e = preparaEntrega({ conceptos: [sueldo(530000)], bancoCentavos: 220654 });
    expect(e.redondeoCentavos).toBe(4);
    expect(efectivoDelRecibo(e.recibo)).toBe(309350);

    const redondeo = e.recibo.conceptos.find((c) => c.clave === CLAVE_REDONDEO_A_FAVOR);
    expect(redondeo).toBeDefined();
    expect([redondeo?.importe, redondeo?.signo]).toEqual([4, 'devenga']);
    expect(redondeo?.motivo).toMatch(/50 centavos/);
  });

  it('⭐ y la aritmética del recibo SIGUE cerrando con el redondeo adentro', () => {
    const e = preparaEntrega({ conceptos: [sueldo(530000)], bancoCentavos: 220654 });
    expect(totalDevengado(e.recibo.conceptos)).toBe(e.recibo.totalCentavos);
    expect(e.recibo.totalCentavos).toBe(220654 + 309350);
  });

  it('el sobre que resulta NO tiene residuo: el redondeo ya lo resolvió', () => {
    const e = preparaEntrega({ conceptos: [sueldo(530000)], bancoCentavos: 220654 });
    expect(e.sobre.residuoCentavos).toBe(0);
    expect(sumaDelSobre(e.sobre.piezas)).toBe(e.sobre.exigibleCentavos);
  });

  it('nunca paga más de 49 centavos de más', () => {
    for (let resto = 1; resto < 50; resto++) {
      const e = preparaEntrega({ conceptos: [sueldo(100000 + resto)], bancoCentavos: 0 });
      expect(e.redondeoCentavos).toBe(50 - resto);
      expect(e.redondeoCentavos).toBeLessThan(50);
      expect(e.redondeoCentavos).toBeGreaterThan(0);
    }
  });
});

describe('la otra política existe, pero deja rastro igual', () => {
  it('en contra: descuenta el residuo y lo nombra', () => {
    const e = preparaEntrega({ conceptos: [sueldo(530000)], bancoCentavos: 220654, politica: 'en_contra' });
    expect(e.redondeoCentavos).toBe(-46);
    expect(efectivoDelRecibo(e.recibo)).toBe(309300);
    const c = e.recibo.conceptos.find((x) => x.clave === CLAVE_REDONDEO_EN_CONTRA);
    expect([c?.importe, c?.signo]).toEqual([46, 'descuenta']);
  });

  it('⭐⭐ sobre el mismo caso, en contra le quita MÁS de lo que a favor cuesta (46 contra 4)', () => {
    const base = { conceptos: [sueldo(530000)], bancoCentavos: 220654 } as const;
    const favor = preparaEntrega({ ...base });
    const contra = preparaEntrega({ ...base, politica: 'en_contra' });
    expect(favor.redondeoCentavos).toBe(4);
    expect(Math.abs(contra.redondeoCentavos)).toBe(46);
    expect(Math.abs(contra.redondeoCentavos)).toBeGreaterThan(favor.redondeoCentavos);
  });

  it('rechaza una política que no existe', () => {
    expect(() =>
      preparaEntrega({ conceptos: [sueldo(100)], bancoCentavos: 0, politica: 'absorber' as 'a_favor' }),
    ).toThrow(/política de residuo desconocida/);
  });
});

describe('el redondeo se puede auditar', () => {
  it('⭐ suma cuánto se redondeó en el periodo, en vez de diluirlo peso por peso', () => {
    const entregas = [
      preparaEntrega({ conceptos: [sueldo(100046)], bancoCentavos: 0 }), // +4
      preparaEntrega({ conceptos: [sueldo(100003)], bancoCentavos: 0 }), // +47
      preparaEntrega({ conceptos: [sueldo(100050)], bancoCentavos: 0 }), // 0
      preparaEntrega({ conceptos: [sueldo(100015)], bancoCentavos: 0, politica: 'en_contra' }), // −15
    ];
    expect(redondeoDelPeriodo(entregas)).toEqual({ aFavorCentavos: 51, enContraCentavos: 15, conRedondeo: 3 });
  });
});

describe('los bordes', () => {
  it('el banco no puede superar lo devengado', () => {
    expect(() => preparaEntrega({ conceptos: [sueldo(100)], bancoCentavos: 500 })).toThrow(EntregaInvalida);
    expect(() => preparaEntrega({ conceptos: [sueldo(100)], bancoCentavos: 500 })).toThrow(/supera lo devengado/);
  });

  it('rechaza un banco que no es centavos enteros', () => {
    expect(() => preparaEntrega({ conceptos: [sueldo(100)], bancoCentavos: 10.5 })).toThrow(EntregaInvalida);
    expect(() => preparaEntrega({ conceptos: [sueldo(100)], bancoCentavos: -1 })).toThrow(EntregaInvalida);
  });

  it('un devengado de cero no explota', () => {
    const e = preparaEntrega({ conceptos: [sueldo(0)], bancoCentavos: 0 });
    expect([e.redondeoCentavos, e.recibo.totalCentavos]).toEqual([0, 0]);
  });

  it('un importe menor a la moneda más chica se paga entero por redondeo a favor', () => {
    // Devengado 30 centavos: no hay moneda, así que a favor se pagan 50.
    const e = preparaEntrega({ conceptos: [sueldo(30)], bancoCentavos: 0 });
    expect([e.redondeoCentavos, efectivoDelRecibo(e.recibo)]).toEqual([20, 50]);
  });
});
