import {
  BANDA_EN_LINEA,
  UMBRAL_COLA_PCT,
  bandas,
  costoDeNoFirmar,
  fraseConcentracion,
  leyendaUniverso,
  llegada,
  sumaBanda,
  type FilaConcentracion,
  type VistaConcentracion,
} from './presupuesto-decision';

/**
 * `[PVI.19]`/`[PVI.20]` — **Lo que la superficie de decidir afirma.**
 *
 * ⛔ `concentracion()` ya NO vive acá: era el sexto artefacto duplicado del día y gana el del
 * carril de Gastos (`budget-concentration.ts`, `[PU.VG.10]`). Lo que queda probado es lo que NO
 * estaba duplicado —el veredicto y el costo de no firmar— más lo que la auditoría obligó a
 * agregar: **las tres bandas, el universo y la frase canónica**.
 *
 * El caso de prueba es el canal Mostrador del ejercicio real (2026-10-09), con los OCHO renglones,
 * porque ahí está el defecto que esto cierra: la versión anterior pintaba 4 y contaba 2, y dejaba
 * caer **$45,514,824 en ningún grupo**.
 */

const f = (concepto: string, monto: number | null, pct: number | null, acumulado: number | null): FilaConcentracion =>
  ({ id: concepto.toLowerCase().replace(/ /g, '-'), concepto, monto, pct, acumulado });

/** Las 8 entidades de Mostrador, ordenadas y con su acumulado, como las devuelve el primitivo. */
const MOSTRADOR: VistaConcentracion = {
  total: 353_538_587.63,
  partidas_80: 4,
  pct_mayor: 34.7607,
  sin_monto: 0,
  universo: 'Mostrador',
  parte_de: { de: 'el ingreso del ejercicio', pct: 58.4578 },
  filas: [
    f('Morelia Abastos', 122_891_216.83, 34.7607, 34.7607),
    f('Padre Hidalgo', 58_103_857.07, 16.4350, 51.1957),
    f('Canindo', 54_854_348.29, 15.5157, 66.7114),
    f('8 Esquinas', 52_778_444.77, 14.9286, 81.6400),
    f('La Piedad Abastos', 22_909_527.99, 6.4800, 88.1200),
    f('Morelia Madero', 22_605_296.05, 6.3941, 94.5141),
    f('Zamora Centro', 12_838_038.62, 3.6311, 98.1452),
    f('Yurécuaro', 6_557_858.01, 1.8549, 100.0000),
  ],
};

describe('[PVI.20] ⛔ ninguna fila se cae: las tres bandas suman el total', () => {
  it('⛔ EL DEFECTO QUE CIERRA: las 2 intermedias existen y valen $45,514,824', () => {
    const b = bandas(MOSTRADOR);
    expect(b.medio.map((x) => x.concepto)).toEqual(['La Piedad Abastos', 'Morelia Madero']);
    expect(sumaBanda(b.medio)).toBe(45_514_824.04);
  });

  it('⛔ PRUEBA NEGATIVA: las intermedias son 2.3× las que la pantalla llamaba chicas', () => {
    const b = bandas(MOSTRADOR);
    const medio = sumaBanda(b.medio)!;
    const cola = sumaBanda(b.cola)!;
    expect(cola).toBe(19_395_896.63);
    expect(medio / cola).toBeGreaterThan(2.3);
    // Y ninguna intermedia está por debajo del umbral de cola: no son "chicas".
    for (const x of b.medio) expect(x.pct!).toBeGreaterThan(UMBRAL_COLA_PCT);
  });

  it('⭐ EL CANDADO: cabeza + medio + cola == el total, al centavo', () => {
    const b = bandas(MOSTRADOR);
    const suma = sumaBanda([...b.cabeza, ...b.medio, ...b.cola])!;
    expect(suma).toBe(MOSTRADOR.total);
    expect(b.cabeza.length + b.medio.length + b.cola.length).toBe(MOSTRADOR.filas.length);
  });

  it('la cabeza son las que CRUZAN el 80 %, no las que caben abajo', () => {
    const b = bandas(MOSTRADOR);
    expect(b.cabeza.length).toBe(4);
    expect(b.cabeza[2].acumulado!).toBeLessThan(80);
    expect(b.cabeza[3].acumulado!).toBeGreaterThanOrEqual(80);
  });

  it('una fila sin monto legible va al medio y se ve, no se descarta', () => {
    const v: VistaConcentracion = {
      ...MOSTRADOR, sin_monto: 1,
      filas: [...MOSTRADOR.filas, f('Partida sin importe', null, null, null)],
    };
    const b = bandas(v);
    expect(b.medio.some((x) => x.concepto === 'Partida sin importe')).toBe(true);
    // Y no contamina el total: `sumaBanda` sólo suma lo legible.
    expect(sumaBanda([...b.cabeza, ...b.medio, ...b.cola])).toBe(MOSTRADOR.total);
  });

  it('sin filas no inventa bandas', () => {
    for (const vacio of [null, undefined, { ...MOSTRADOR, filas: [], partidas_80: null }]) {
      const b = bandas(vacio as VistaConcentracion | null);
      expect(b.cabeza.length + b.medio.length + b.cola.length).toBe(0);
    }
    expect(sumaBanda([])).toBeNull();
  });
});

describe('[PVI.20] ⛔ el universo se declara, siempre', () => {
  it('⛔ EL HALLAZGO DE LA AUDITORÍA: la frase dice de QUÉ es el 80 %, nunca «del plan»', () => {
    const s = fraseConcentracion(MOSTRADOR)!;
    expect(s).toBe('4 partidas cruzan el 80 % de Mostrador. La mayor sola es el 34.8 %.');
    expect(s).not.toContain('del plan');
  });

  it('⛔ y la leyenda dice de qué es RECORTE: 81.6 % de Mostrador no es 81.6 % del plan', () => {
    expect(leyendaUniverso(MOSTRADOR)).toBe('Mostrador — 58.5 % de el ingreso del ejercicio');
  });

  it('cuando el universo ES el total, no inventa un «parte de»', () => {
    const completo: VistaConcentracion = {
      ...MOSTRADOR, universo: 'el ingreso del ejercicio', parte_de: null,
    };
    expect(leyendaUniverso(completo)).toBe('el ingreso del ejercicio');
  });

  it('⭐ el ejercicio COMPLETO cuenta otra historia, y la frase la refleja', () => {
    // Medido en prod: ingreso 33 líneas, mayor 20.32 %, 9 cruzan el 80 %.
    const ingreso: VistaConcentracion = {
      total: 604_775_116.21, partidas_80: 9, pct_mayor: 20.32, sin_monto: 0,
      universo: 'el ingreso del ejercicio', parte_de: null,
      filas: [f('Ventas mostrador · 08', 122_891_216.83, 20.32, 20.32)],
    };
    expect(fraseConcentracion(ingreso)).toContain('9 partidas cruzan el 80 % de el ingreso del ejercicio');
    expect(fraseConcentracion(ingreso)).toContain('20.3 %');
  });

  it('el singular se escribe en singular', () => {
    const una: VistaConcentracion = { ...MOSTRADOR, partidas_80: 1 };
    expect(fraseConcentracion(una)).toContain('1 partida cruza el 80 %');
  });

  it('sin concentración no hay frase: null, no una oración vacía', () => {
    expect(fraseConcentracion(null)).toBeNull();
    expect(fraseConcentracion({ ...MOSTRADOR, partidas_80: null })).toBeNull();
    expect(leyendaUniverso(null)).toBeNull();
  });
});

describe('[PVI.19] ¿vamos a llegar?', () => {
  it('⛔ EL CASO DE PROD: sin real no inventa un cumplimiento de 0 %, dice qué falta', () => {
    const l = llegada(604_775_116, null, { realDisponible: false, periodosSinMeta: 3 });
    expect(l.clave).toBe('sin_real');
    expect(l.tono).toBe('muted');
    expect(l.frase).toContain('no se puede decir');
    expect(l.falta).toEqual(['meta de 3 períodos', 'venta real del ejercicio']);
  });

  it('⛔ PRUEBA NEGATIVA: 0 % de cumplimiento y «no se puede medir» NO son lo mismo', () => {
    const sinDato = llegada(604_775_116, null, { realDisponible: false });
    const ceroReal = llegada(604_775_116, 0);
    expect(sinDato.clave).toBe('sin_real');
    expect(ceroReal.clave).toBe('atras');
    expect(ceroReal.tono).toBe('bad');
    expect(sinDato.tono).not.toBe('bad');
  });

  it('sin meta tampoco se inventa: lo que falta es la meta, no el real', () => {
    const l = llegada(null, 100);
    expect(l.clave).toBe('sin_meta');
    expect(l.falta).toEqual(['meta del ejercicio']);
  });

  it('dentro de la banda es «en línea», no «arriba» ni «abajo»', () => {
    const m = 1000;
    expect(llegada(m, m * (1 + BANDA_EN_LINEA)).clave).toBe('en_linea');
    expect(llegada(m, m * (1 - BANDA_EN_LINEA)).clave).toBe('en_linea');
    expect(llegada(m, m * 1.05).clave).toBe('adelante');
    expect(llegada(m, m * 0.95).clave).toBe('atras');
  });

  it('el tono separa vigilar de actuar: 10 % abajo avisa, 11 % exige', () => {
    expect(llegada(1000, 900).tono).toBe('warn');
    expect(llegada(1000, 890).tono).toBe('bad');
  });
});

describe('[PVI.19] lo que cuesta no firmar', () => {
  it('nombra la consecuencia, no el conteo', () => {
    const s = costoDeNoFirmar(156, 74_809_091.57)!;
    expect(s).toContain('156');
    expect(s).toContain('Calendario de pagos');
    expect(s).toMatch(/\$74,809,09[12]/);
  });

  it('⛔ sin cola devuelve null — «no hay nada» y «todo al día» no son lo mismo', () => {
    expect(costoDeNoFirmar(0, 0)).toBeNull();
    expect(costoDeNoFirmar(0, null)).toBeNull();
  });

  it('sin monto medible sigue diciendo la consecuencia, sin inventar un peso', () => {
    const s = costoDeNoFirmar(3, null)!;
    expect(s).toContain('Calendario de pagos');
    expect(s).not.toContain('$');
  });
});
