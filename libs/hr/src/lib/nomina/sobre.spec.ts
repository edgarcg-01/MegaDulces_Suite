/**
 * `[NE.1.3]` El sobre al billete, y el residuo que nadie nombra.
 *
 * Los casos fijan lo medido el 2026-11-23: la moneda más chica del sobre es de 50 centavos, el
 * efectivo se calcula al centavo, y por eso **el 79.5 % de los recibos con efectivo pide un importe
 * que ninguna moneda puede armar**. La prueba que más importa es la que exige que ese residuo
 * **salga con nombre** en vez de desaparecer en un redondeo.
 *
 * Cifras inventadas: este repositorio es público.
 */
import {
  armaSobre,
  DENOMINACIONES,
  MONEDA_MINIMA_CENTAVOS,
  pagableEnMonedas,
  residuoNoPagable,
  SobreInvalido,
  sumaDelSobre,
  verificaSobre,
} from './sobre';

describe('lo que las monedas pueden y no pueden armar', () => {
  it('la moneda más chica es de 50 centavos', () => {
    expect(MONEDA_MINIMA_CENTAVOS).toBe(50);
    expect(Math.min(...DENOMINACIONES.map((d) => d.centavos))).toBe(50);
  });

  it('⛔ no existe moneda de 10, 20 ni 5 centavos (medido en el sistema actual)', () => {
    const valores = new Set(DENOMINACIONES.map((d) => d.centavos));
    expect([valores.has(10), valores.has(20), valores.has(5)]).toEqual([false, false, false]);
  });

  it('un importe múltiplo de 50 centavos se paga entero', () => {
    expect([pagableEnMonedas(30950), residuoNoPagable(30950)]).toEqual([30950, 0]);
  });

  it('⭐ uno que no lo es, deja residuo — y el residuo NO es cero', () => {
    // 46 centavos fue el residuo más frecuente de los medidos (330 recibos).
    expect([pagableEnMonedas(309346), residuoNoPagable(309346)]).toEqual([309300, 46]);
  });

  it('el residuo siempre cae entre 0 y 49', () => {
    for (const c of [0, 1, 49, 50, 51, 99, 100, 220654, 309346]) {
      const r = residuoNoPagable(c);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(MONEDA_MINIMA_CENTAVOS);
    }
  });
});

describe('armar el sobre', () => {
  it('usa las piezas grandes primero, como lo arma una persona', () => {
    // $3,093.00 = 3 billetes de 1000 + uno de 50 + dos de 20 + una moneda de 2 + una de 1.
    const s = armaSobre(309300);
    expect(s.piezas).toEqual({ b1000: 3, b50: 1, b20: 2, m2: 1, m1: 1 });
    expect(sumaDelSobre(s.piezas)).toBe(309300);
  });

  it('⭐⭐ con un importe no pagable, el sobre suma lo pagable y DECLARA el residuo', () => {
    const s = armaSobre(309346);
    expect(s.exigibleCentavos).toBe(309346);
    expect(s.entregadoCentavos).toBe(309300);
    expect(s.residuoCentavos).toBe(46);
    expect(sumaDelSobre(s.piezas)).toBe(s.entregadoCentavos);
  });

  it('⛔ prueba negativa: lo que el sobre contiene nunca es lo exigible cuando hay residuo', () => {
    const s = armaSobre(309346);
    expect(s.entregadoCentavos).not.toBe(s.exigibleCentavos);
    expect(s.exigibleCentavos - s.entregadoCentavos).toBe(s.residuoCentavos);
  });

  it('prefiere el billete sobre la moneda del mismo valor', () => {
    expect(armaSobre(10_000).piezas).toEqual({ b100: 1 }); // no m100
    expect(armaSobre(2_000).piezas).toEqual({ b20: 1 }); // no m20
  });

  it('el sobre de cero es un sobre vacío, no un error', () => {
    const s = armaSobre(0);
    expect([s.piezas, s.entregadoCentavos, s.residuoCentavos]).toEqual([{}, 0, 0]);
  });

  it('un importe menor que la moneda más chica es TODO residuo', () => {
    const s = armaSobre(46);
    expect([s.piezas, s.entregadoCentavos, s.residuoCentavos]).toEqual([{}, 0, 46]);
  });

  it('rechaza importes que no son centavos enteros', () => {
    expect(() => armaSobre(100.5)).toThrow(SobreInvalido);
    expect(() => armaSobre(-100)).toThrow(SobreInvalido);
  });
});

describe('verificar un sobre ya armado (el espejo)', () => {
  it('cuadra cuando las piezas suman lo exigible', () => {
    const c = verificaSobre({ b1000: 2, b100: 1 }, 210_000);
    expect([c.cuadra, c.diferenciaCentavos, c.esSoloResiduo]).toEqual([true, 0, false]);
  });

  it('⭐ separa la diferencia ESTRUCTURAL de la que hay que explicar', () => {
    // Le faltan exactamente los 46 centavos que ninguna moneda cubre: eso no es un error de nadie.
    const soloResiduo = verificaSobre({ b1000: 3, b50: 1, b20: 2, m2: 1, m1: 1 }, 309346);
    expect([soloResiduo.cuadra, soloResiduo.diferenciaCentavos, soloResiduo.esSoloResiduo]).toEqual([false, -46, true]);

    // Le falta un billete de 20: eso SÍ hay que explicarlo.
    const falta = verificaSobre({ b1000: 3, b50: 1, b20: 1, m2: 1, m1: 1 }, 309346);
    expect([falta.diferenciaCentavos, falta.esSoloResiduo]).toEqual([-2046, false]);
  });

  it('detecta el sobre con dinero de MÁS', () => {
    const c = verificaSobre({ b1000: 3, b100: 1 }, 309346);
    expect([c.diferenciaCentavos > 0, c.esSoloResiduo]).toEqual([true, false]);
  });

  it('rechaza una denominación que no existe', () => {
    expect(() => sumaDelSobre({ b1000: 1, m10c: 3 })).toThrow(/denominación desconocida/);
  });

  it('rechaza media pieza', () => {
    expect(() => sumaDelSobre({ b1000: 1.5 })).toThrow(SobreInvalido);
  });
});

describe('la forma del problema, sobre una semana', () => {
  it('⭐⭐ cuatro de cada cinco importes dejan residuo, y la suma NO se redondea a cero', () => {
    // Residuos reales más frecuentes de los medidos: 46c (330 veces), 3c (65), 15c (27), 10c (25).
    const importes = [309346, 220603, 185415, 142810, 93500];
    const sobres = importes.map(armaSobre);
    const conResiduo = sobres.filter((s) => s.residuoCentavos > 0);
    expect(conResiduo).toHaveLength(4);
    expect(conResiduo.map((s) => s.residuoCentavos)).toEqual([46, 3, 15, 10]);
    // El total deriva: es chico, pero existe y se puede nombrar en una línea.
    expect(sobres.reduce((t, s) => t + s.residuoCentavos, 0)).toBe(74);
  });
});
