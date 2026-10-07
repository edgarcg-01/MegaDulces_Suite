import {
  escaleraUnidades, etiquetaUnidades, evaluarPedidoTipico, textoCajasPiezas, textoSumaUnidades, textoUnidades, UNIDADES_CJ_PZ,
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
  it('sin escalera pero con factor de caja cae a cj/pz (lo de antes)', () => {
    expect(etiquetaUnidades({ uxc: 12 })).toEqual(UNIDADES_CJ_PZ);
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

// [RA-PRO.70] Escalera REAL con los factores de prod (costo por peldaño ÷ costo base), 2026-10-03.
const esc = (o: Parameters<typeof escaleraUnidades>[0]) => escaleraUnidades(o).map((u) => u.abr + '×' + u.factor).join(' · ');

describe('[RA-PRO.70] escaleraUnidades — 1, 2 o 3 unidades, en su medida de origen', () => {
  it('42029 KINDER DELICE: 3 unidades (pz · paq ×10 · cj ×140)', () => {
    expect(esc({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: 9.9961, f3: 139.9504, uxc: 140 })).toBe('pz×1 · paq×10 · cj×140');
  });
  it('70001 MAZAPÁN: 2 unidades — Kepler repite PAQ con factor 1', () => {
    expect(esc({ u1: 'PAQ', u2: 'PAQ', u3: 'CJA', f2: 1, f3: 19.9995, uxc: 20 })).toBe('paq×1 · cj×20');
  });
  it('17083 BOLSA CAMISETA: 2 unidades distintas a las del mazapán (kg · bto ×20)', () => {
    expect(esc({ u1: 'KG', u2: 'KG', u3: 'BTO', f2: 1, f3: 20, uxc: 20 })).toBe('kg×1 · bto×20');
  });
  it('57009 COBERTURA LUSSEL: 1 unidad (cub), sin una caja inventada', () => {
    expect(esc({ u1: 'CUB', u2: null, u3: null, uxc: 1 })).toBe('cub×1');
  });
  it('17063 ROLLO ALTA: 1 unidad aunque Kepler repita KG en los tres peldaños', () => {
    expect(esc({ u1: 'KG', u2: 'KG', u3: 'KG', f2: 1, f3: 1, uxc: 1 })).toBe('kg×1');
  });
  it('83185 CHECHI: 2 peldaños de Kepler (paq · cj ×10)', () => {
    expect(esc({ u1: 'PAQ', u2: 'CJA', u3: null, f2: 10.0008, uxc: 10 })).toBe('paq×1 · cj×10');
  });
  it('⭐ NEGATIVA: si el peldaño de Kepler no coincide con el motor, la mayor trae el factor del motor', () => {
    expect(esc({ u1: 'PZA', u2: 'CJA', f2: 24, uxc: 12 })).toBe('pz×1 · cj×12');
  });
  it('⭐ NEGATIVA: un intermedio que no cabe exacto en la caja no se ofrece', () => {
    expect(esc({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: 12, f3: 140, uxc: 140 })).toBe('pz×1 · cj×140');
  });
  it('etiquetas de una sola unidad: mayor = base, el texto no inventa cajas', () => {
    const et = etiquetaUnidades({ u1: 'KG', u2: 'KG', u3: 'KG', f2: 1, f3: 1, uxc: 1 });
    expect(et).toEqual({ mayor: 'kg', medio: null, medioAbr: 'paq', base: 'kg' });
    expect(textoUnidades(67, 1, et)).toBe('67 kg');
  });
  it('nombres para los botones de captura', () => {
    expect(escaleraUnidades({ u1: 'KG', u2: 'KG', u3: 'BTO', f2: 1, f3: 20, uxc: 20 }).map((u) => u.nombre)).toEqual(['Kilo', 'Bulto']);
  });
  it('⭐ NEGATIVA: base y mayor con el MISMO rótulo (89106 PAQ ×1 / PAQ ×24) → la mayor lleva su tamaño', () => {
    expect(esc({ u1: 'PAQ', u2: 'PAQ', f2: 24, uxc: 24 })).toBe('paq×1 · paq×24×24');
  });
  it('una sola unidad conserva la fracción: 4.3 cubetas no son 4', () => {
    const et = etiquetaUnidades({ u1: 'CUB', uxc: 1 });
    expect(textoUnidades(4.3, 1, et)).toBe('4.3 cub');
  });
});
