import {
  etiquetaUnidades, evaluarPedidoTipico, textoCajasPiezas, textoSumaUnidades, textoUnidades, UNIDADES_CJ_PZ,
} from './pedido-redondeo';

// Casos tomados de prod (escalera de Kepler + etiquetera), medidos el 2026-10-02.
const CHECHI = etiquetaUnidades({ u1: 'PAQ', u2: 'CJA', u3: null, uxc: 10, boxSize: 10, packSize: null });   // 83185
const KINDER = etiquetaUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', uxc: 140, boxSize: 140, packSize: 10 }); // 42029
const TURIN = etiquetaUnidades({ u1: '500', u2: 'PAQ', u3: 'CJA', uxc: 20, boxSize: 20, packSize: 10 });    // 91109
const PICOSOS = etiquetaUnidades({ u1: 'PAQ', u2: 'PAQ', u3: 'CJA', uxc: 66, boxSize: 66, packSize: 11 });  // 20323

describe('[RA-PRO.68] etiquetaUnidades — los rótulos los dice Kepler', () => {
  it('83185: la base es PAQUETE, no pieza, y no hay intermedio', () => {
    expect(CHECHI).toEqual({ mayor: 'cj', medio: null, medioAbr: 'paq', base: 'paq' });
  });
  it('KINDER DELICE: caja 140 pz con paquete de 10 → intermedio paq', () => {
    expect(KINDER.mayor).toBe('cj');
    expect(KINDER.medio).toBe(10);
    expect(KINDER.medioAbr).toBe('paq');
    expect(KINDER.base).toBe('pz');
  });
  it('granel con gramaje (500) → la base es "u.", nunca un número', () => {
    expect(TURIN.base).toBe('u.');
    expect(TURIN.medio).toBe(10);
  });
  it('20323: base y paquete se llaman igual → sin intermedio (no "1 paq 3 paq")', () => {
    expect(PICOSOS.medio).toBeNull();
  });
  it('el paquete que no cabe exacto en la caja no se usa', () => {
    expect(etiquetaUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', uxc: 140, boxSize: 140, packSize: 12 }).medio).toBeNull();
  });
  it('si la etiquetera y el motor no coinciden en la caja, no se mezclan', () => {
    expect(etiquetaUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', uxc: 140, boxSize: 120, packSize: 10 }).medio).toBeNull();
  });
  it('bulto: la mayor se escribe bto', () => {
    expect(etiquetaUnidades({ u1: 'KG', u2: 'BTO', uxc: 20 }).mayor).toBe('bto');
    expect(etiquetaUnidades({ u1: 'KG', u2: 'BTO', uxc: 20 }).base).toBe('kg');
  });
  it('sin escalera cae a cj/pz (lo de antes)', () => {
    expect(etiquetaUnidades({})).toEqual({ ...UNIDADES_CJ_PZ, medioAbr: 'paq' });
  });
});

describe('[RA-PRO.68] textoUnidades — de mayor a menor', () => {
  it('83185: 4.3 cj → "4 cj 3 paq" (antes decía "4 cj 3 pz")', () => {
    expect(textoUnidades(4.3, 10, CHECHI)).toBe('4 cj 3 paq');
    expect(textoCajasPiezas(4.3, 10)).toBe('4 cj 3 pz');   // la función vieja no cambia
  });
  it('KINDER: 165 pz → "1 cj 2 paq 5 pz"', () => {
    expect(textoUnidades(165 / 140, 140, KINDER)).toBe('1 cj 2 paq 5 pz');
  });
  it('KINDER: 145 pz → "1 cj 5 pz" (no "0 paq")', () => {
    expect(textoUnidades(145 / 140, 140, KINDER)).toBe('1 cj 5 pz');
  });
  it('KINDER: sólo paquetes', () => {
    expect(textoUnidades(30 / 140, 140, KINDER)).toBe('3 paq');
  });
  it('cero → "0 cj"', () => {
    expect(textoUnidades(0, 10, CHECHI)).toBe('0 cj');
  });
  it('sin factor de caja → cajas con decimal en su unidad mayor', () => {
    expect(textoUnidades(2.35, 0, CHECHI)).toBe('2.4 cj');
  });
});

describe('[RA-PRO.68] textoSumaUnidades — no suma peras con manzanas', () => {
  it('las cajas se suman; las sueltas sólo con su misma unidad', () => {
    const s = textoSumaUnidades([
      { cajas: 4.3, uxc: 10, et: CHECHI },          // 4 cj 3 paq
      { cajas: 165 / 140, uxc: 140, et: KINDER },   // 1 cj 2 paq 5 pz
    ]);
    expect(s).toBe('5 cj 5 paq 5 pz');
  });
  it('sin etiquetas se comporta como antes (cj + pz)', () => {
    expect(textoSumaUnidades([{ cajas: 6.5, uxc: 12 }, { cajas: 5, uxc: 20 }])).toBe('11 cj 6 pz');
  });
});

describe('[RA-PRO.69] evaluarPedidoTipico — informa, no rellena', () => {
  it('GONAC: $11.9k contra un típico de $214k → bajo, por MONTO', () => {
    const e = evaluarPedidoTipico(32, 11_921, 908, 214_113);
    expect(e.criterio).toBe('monto');
    expect(e.nivel).toBe('bajo');
    expect(e.pct).toBeCloseTo(0.0557, 3);
  });
  it('sin monto usa cajas', () => {
    expect(evaluarPedidoTipico(500, 0, 908, null).criterio).toBe('cajas');
    expect(evaluarPedidoTipico(850, 0, 908, null).nivel).toBe('alcanza');
  });
  it('a la mitad o más → cerca', () => {
    expect(evaluarPedidoTipico(0, 120_000, null, 214_113).nivel).toBe('cerca');
  });
  it('sin pedido típico → sin_dato, nunca "bajo"', () => {
    expect(evaluarPedidoTipico(10, 1000, null, null)).toEqual({ criterio: null, llevas: 0, tipico: null, pct: null, nivel: 'sin_dato' });
  });
});
