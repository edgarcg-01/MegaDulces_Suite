import {
  BANDA_EN_LINEA,
  UMBRAL_CONCENTRACION,
  concentracion,
  costoDeNoFirmar,
  llegada,
  type FilaVenta,
} from './presupuesto-decision';

/**
 * `[PVI.19]` — **La superficie de decidir, medida contra el ejercicio real.**
 *
 * Las filas de abajo son las NUEVE que la pantalla publica hoy para el canal Mostrador del
 * ejercicio 2027, copiadas al centavo. Suman exactamente su propio subtotal ($353,538,587.63), y
 * ese subtotal viaja como una fila más — que es la trampa principal de este archivo.
 */

const fila = (label: string, meta: number | null, is_rollup = false): FilaVenta => ({
  label,
  channel_label: 'Mostrador',
  entity_key: label.toLowerCase().replace(/ /g, '-'),
  is_rollup,
  meta,
  real: null,
});

/** El canal Mostrador tal como sale de `sales-comparison`: 8 hojas + su subtotal. */
const MOSTRADOR: FilaVenta[] = [
  fila('Padre Hidalgo', 58_103_857.07),
  fila('La Piedad Abastos', 22_909_527.99),
  fila('8 Esquinas', 52_778_444.77),
  fila('Yurécuaro', 6_557_858.01),
  fila('Zamora Centro', 12_838_038.62),
  fila('Canindo', 54_854_348.29),
  fila('Morelia Madero', 22_605_296.05),
  fila('Morelia Abastos', 122_891_216.83),
  fila('Subtotal Mostrador', 353_538_587.63, true),
];

describe('[PVI.19] la concentración que la tabla esconde', () => {
  it('⭐ EL HECHO EJECUTIVO: una entidad es el 34.8 % de todo el canal', () => {
    const c = concentracion(MOSTRADOR);
    expect(c.mayor?.label).toBe('Morelia Abastos');
    expect(Math.round(c.mayor!.share * 1000) / 10).toBe(34.8);
  });

  it('⭐ CUATRO de ocho cargan el 81.6 % del plan', () => {
    const c = concentracion(MOSTRADOR);
    expect(c.cuantas).toBe(4);
    expect(c.de_cuantas).toBe(8);
    expect(Math.round(c.entidades[3].acumulado * 1000) / 10).toBe(81.6);
    expect(c.entidades.slice(0, 4).map((e) => e.label))
      .toEqual(['Morelia Abastos', 'Padre Hidalgo', 'Canindo', '8 Esquinas']);
  });

  it('la cola son dos entidades que juntas no llegan al 5.5 %', () => {
    const c = concentracion(MOSTRADOR);
    expect(c.cola.map((e) => e.label)).toEqual(['Zamora Centro', 'Yurécuaro']);
    const suma = c.cola.reduce((s, e) => s + e.share, 0);
    expect(Math.round(suma * 1000) / 10).toBe(5.5);
  });

  it('la lectura nombra la entidad y el reparto, no publica un porcentaje suelto', () => {
    const l = concentracion(MOSTRADOR).lectura!;
    expect(l).toContain('Morelia Abastos');
    expect(l).toContain('34.8 %');
    expect(l).toContain('4 de 8');
  });
});

describe('[PVI.19] ⛔ las dos trampas del renglón', () => {
  it('⛔ PRUEBA NEGATIVA: contar el subtotal duplicaría el canal y partiría a la mitad cada parte', () => {
    const c = concentracion(MOSTRADOR);
    expect(c.total).toBe(353_538_587.63);

    // Lo que daría no mirar `is_rollup`: el subtotal entra como una novena entidad.
    const conSubtotal = MOSTRADOR.reduce((s, f) => s + (f.meta ?? 0), 0);
    expect(conSubtotal).toBe(353_538_587.63 * 2);
    expect(122_891_216.83 / conSubtotal).toBeCloseTo(0.174, 3);   // 17.4 %, la mitad del real
    // Y el subtotal sería "la mayor", con el 50 % — un renglón que no es una entidad.
    expect(c.entidades.some((e) => e.label.startsWith('Subtotal'))).toBe(false);
  });

  it('⛔ una meta ausente se SALTA, no entra como 0 diluyendo a las demás', () => {
    const c = concentracion([...MOSTRADOR, fila('Sucursal nueva', null)]);
    expect(c.de_cuantas).toBe(8);
    expect(c.total).toBe(353_538_587.63);
    expect(c.entidades.some((e) => e.label === 'Sucursal nueva')).toBe(false);
  });

  it('el corte INCLUYE la entidad donde cae el umbral (3 no alcanzan el 80 %)', () => {
    const c = concentracion(MOSTRADOR);
    expect(c.entidades[2].acumulado).toBeLessThan(UMBRAL_CONCENTRACION);
    expect(c.entidades[3].acumulado).toBeGreaterThanOrEqual(UMBRAL_CONCENTRACION);
  });

  it('sin filas no afirma nada — `lectura` es null, no una frase sobre un conjunto vacío', () => {
    for (const vacio of [null, undefined, [], [fila('Subtotal', 10, true)]]) {
      const c = concentracion(vacio as FilaVenta[] | null);
      expect(c.lectura).toBeNull();
      expect(c.total).toBe(0);
      expect(c.mayor).toBeNull();
    }
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
    const f = costoDeNoFirmar(156, 74_809_091.57)!;
    expect(f).toContain('156');
    expect(f).toContain('Calendario de pagos');
    expect(f).toMatch(/\$74,809,09[12]/);
  });

  it('⛔ sin cola devuelve null — «no hay nada» y «todo al día» no son lo mismo', () => {
    expect(costoDeNoFirmar(0, 0)).toBeNull();
    expect(costoDeNoFirmar(0, null)).toBeNull();
  });

  it('sin monto medible sigue diciendo la consecuencia, sin inventar un peso', () => {
    const f = costoDeNoFirmar(3, null)!;
    expect(f).toContain('Calendario de pagos');
    expect(f).not.toContain('$');
  });
});
