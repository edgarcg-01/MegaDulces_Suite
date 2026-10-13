import {
  redondearPedido, necesitaMotivo, pasoAjuste, posicionPedido, normalizarPosiciones, aplicarMinimoMenor, EscaleraUnidades,
} from './autoabasto-pedido.contract';

/**
 * `[AB.16]` CANDADO de la regla de redondeo del pedido (FASE_AB §15.2). Los casos son los del
 * documento, tal como los decidió Francisco el 2026-10-07: si alguno cambia, cambió la regla de
 * negocio, no un detalle de implementación.
 */
const cajaDe12: EscaleraUnidades = { unit_base: 'PZA', u2_label: 'CJA', u3_label: null, f2: 12, f3: null, is_weight: false };
const tresPeldanos: EscaleraUnidades = { unit_base: 'PZA', u2_label: 'PAQ', u3_label: 'CJA', f2: 6, f3: 24, is_weight: false };
const granel: EscaleraUnidades = { unit_base: 'KG', u2_label: null, u3_label: null, f2: null, f3: null, is_weight: true };
const soloBase: EscaleraUnidades = { unit_base: 'PAQ', u2_label: 'PAQ', u3_label: null, f2: 1, f3: null, is_weight: false };

const enCajas = (cajas: number) => redondearPedido(cajas * 12, cajaDe12);

describe('redondearPedido — la regla de §15.2', () => {
  it('menos de media caja se pide en la unidad menor: 0.3 caja de 12 → 4 PZA', () => {
    expect(enCajas(0.3)).toMatchObject({ regla: 'menor', cantidad: 4, unidad: 'PZA', cantidad_base: 4 });
  });

  it.each([
    [0.5, 1], [0.8, 1], [3.3, 3], [3.5, 4], [5.7, 6],
  ])('%s cajas → %s cajas completas', (falta, cajas) => {
    expect(enCajas(falta)).toMatchObject({ regla: 'cajas', cantidad: cajas, unidad: 'CJA', cantidad_base: cajas * 12 });
  });

  it('nunca mezcla cajas y piezas en el mismo renglón', () => {
    const r = enCajas(3.3);
    expect(r.unidad).toBe('CJA');
    expect(r.cantidad_base % 12).toBe(0);
  });

  it('publica lo que falta sin redondear, para auditar la resta', () => {
    expect(enCajas(3.3).falta_mayor).toBeCloseTo(3.3, 6);
  });

  it('con tres peldaños, la menor es el del medio (el paquete)', () => {
    // 0.25 caja de 24 = 6 PZA = 1 PAQ
    expect(redondearPedido(6, tresPeldanos)).toMatchObject({ regla: 'menor', cantidad: 1, unidad: 'PAQ', cantidad_base: 6 });
  });

  it('si en la menor da 0, no se pide', () => {
    expect(redondearPedido(0.4, cajaDe12)).toMatchObject({ regla: 'nada', cantidad: 0 });
  });

  it('granel SIN unidad mayor: kilos completos (7.4 → 7, 7.5 → 8)', () => {
    expect(redondearPedido(7.4, granel)).toMatchObject({ regla: 'granel', clase: 'unica', cantidad: 7, unidad: 'KG' });
    expect(redondearPedido(7.5, granel)).toMatchObject({ regla: 'granel', clase: 'unica', cantidad: 8, unidad: 'KG' });
  });

  it('sólo unidad base (el factor 1 no es un peldaño): se pide en la base, entera', () => {
    expect(redondearPedido(2.6, soloBase)).toMatchObject({ regla: 'base', cantidad: 3, unidad: 'PAQ' });
  });

  it('⛔ sin escalera NO inventa unidad: declara la cantidad tal cual', () => {
    expect(redondearPedido(2.345, null)).toMatchObject({ regla: 'sin_escalera', unidad: null, cantidad: 2.35 });
  });

  it('⛔ nada que pedir (cero, negativo o basura) da «nada», nunca una cantidad', () => {
    expect(redondearPedido(0, cajaDe12).regla).toBe('nada');
    expect(redondearPedido(-5, cajaDe12).regla).toBe('nada');
    expect(redondearPedido(Number.NaN, cajaDe12).regla).toBe('nada');
  });
});

describe('[AB.18] factor de la unidad y reglas del ajuste', () => {
  it('el redondeo dice cuántas unidades base trae su unidad', () => {
    expect(enCajas(3.3).factor).toBe(12);
    expect(enCajas(0.3).factor).toBe(1);
    expect(redondearPedido(6, tresPeldanos).factor).toBe(6);
    expect(redondearPedido(7.5, granel).factor).toBe(1);
  });

  it('sin nada que pedir, ofrece la caja para que el + pueda agregar', () => {
    expect(redondearPedido(0, cajaDe12)).toMatchObject({ regla: 'nada', unidad: 'CJA', factor: 12 });
  });

  it('⛔ sin escalera no inventa factor', () => {
    expect(redondearPedido(5, null).factor).toBeNull();
    expect(redondearPedido(0, null).factor).toBeNull();
  });
});

// Formas reales medidas en prod 2026-10-12: 17004 (KG + bulto de 20) y 01061 (base·KG de 4·CJA de 40).
const granelBulto: EscaleraUnidades = { unit_base: 'KG', u2_label: 'KG', u3_label: 'BTO', f2: null, f3: 20, is_weight: true };
const granelCaja: EscaleraUnidades = { unit_base: null, u2_label: 'KG', u3_label: 'CJA', f2: 4, f3: 40, is_weight: true };

describe('[AB.19] granel con unidad mayor se pide en la mayor', () => {
  it('media bolsa o más → bultos completos', () => {
    expect(redondearPedido(12, granelBulto)).toMatchObject({ regla: 'cajas', clase: 'mayor', cantidad: 1, unidad: 'BTO', cantidad_base: 20 });
    expect(redondearPedido(30, granelBulto)).toMatchObject({ cantidad: 2, unidad: 'BTO' });
  });
  it('menos de medio bulto → kilos completos', () => {
    expect(redondearPedido(7.5, granelBulto)).toMatchObject({ regla: 'menor', clase: 'menor', cantidad: 8, unidad: 'KG', factor: 1 });
  });
  it('con tres peldaños la menor es el kilo (factor 4)', () => {
    expect(redondearPedido(8, granelCaja)).toMatchObject({ regla: 'menor', cantidad: 2, unidad: 'KG', factor: 4 });
    expect(redondearPedido(25, granelCaja)).toMatchObject({ regla: 'cajas', cantidad: 1, unidad: 'CJA', factor: 40 });
  });
  it('sin nada que pedir ofrece el bulto para el +', () => {
    expect(redondearPedido(0, granelBulto)).toMatchObject({ regla: 'nada', clase: 'mayor', unidad: 'BTO', factor: 20 });
  });
});

describe('[AB.19] clase de surtido', () => {
  it('cada regla cae en su lista', () => {
    expect(enCajas(3.3).clase).toBe('mayor');
    expect(enCajas(0.3).clase).toBe('menor');
    expect(redondearPedido(2.6, soloBase).clase).toBe('unica');
    expect(redondearPedido(5, null).clase).toBe('sin_unidad');
  });
  it('lo que en la menor da 0 sigue en la lista de la menor', () => {
    expect(redondearPedido(0.4, cajaDe12)).toMatchObject({ regla: 'nada', clase: 'menor' });
  });
  it('sin nada que pedir: mayor si existe, si no única', () => {
    expect(redondearPedido(0, cajaDe12).clase).toBe('mayor');
    expect(redondearPedido(0, soloBase).clase).toBe('unica');
    expect(redondearPedido(0, null).clase).toBe('sin_unidad');
  });
});

describe('[AB.20] mínimo de $200 en unidad menor', () => {
  // 4 piezas de una caja de 12 (regla 'menor').
  const cuatroPiezas = enCajas(0.3);
  it('menos de $200 no se pide, y se queda en la menor para el +', () => {
    const r = aplicarMinimoMenor(cuatroPiezas, 30, 'bajo_minimo'); // 4 × $30 = $120
    expect(r.estado).toBe('debajo');
    expect(r.valor_menor).toBe(120);
    expect(r.redondeo).toMatchObject({ regla: 'nada', clase: 'menor', cantidad: 0, cantidad_base: 0, unidad: 'PZA', factor: 1 });
  });
  it('⛔ un AGOTADO se pide aunque valga menos de $200', () => {
    expect(aplicarMinimoMenor(cuatroPiezas, 30, 'agotado')).toMatchObject({ estado: 'agotado', valor_menor: 120, redondeo: cuatroPiezas });
    expect(aplicarMinimoMenor(cuatroPiezas, 30, 'bajo_reorden').estado).toBe('debajo');
  });
  it('justo $200 o más se pide igual', () => {
    expect(aplicarMinimoMenor(cuatroPiezas, 50, 'bajo_minimo').estado).toBe('cumple'); // $200
    expect(aplicarMinimoMenor(cuatroPiezas, 80, 'bajo_minimo')).toMatchObject({ estado: 'cumple', valor_menor: 320, redondeo: cuatroPiezas });
  });
  it('⛔ sin costo NO se supone nada: el renglón se queda y se declara', () => {
    expect(aplicarMinimoMenor(cuatroPiezas, null, 'bajo_minimo')).toMatchObject({ estado: 'sin_costo', valor_menor: null, redondeo: cuatroPiezas });
    expect(aplicarMinimoMenor(cuatroPiezas, 0, 'bajo_minimo').estado).toBe('sin_costo');
  });
  it('no toca cajas, una sola unidad ni lo que no se pide', () => {
    expect(aplicarMinimoMenor(enCajas(3.3), 1, 'bajo_minimo').estado).toBe('no_aplica');
    expect(aplicarMinimoMenor(redondearPedido(2.6, soloBase), 1, 'bajo_minimo').estado).toBe('no_aplica');
    expect(aplicarMinimoMenor(redondearPedido(7.4, granel), 1, 'bajo_minimo').estado).toBe('no_aplica');
    expect(aplicarMinimoMenor(redondearPedido(0, cajaDe12), 1, 'bajo_minimo').estado).toBe('no_aplica');
  });
  it('granel en kilos (tiene bulto) también lleva el mínimo', () => {
    // 8 kg × $20 = $160 < $200
    expect(aplicarMinimoMenor(redondearPedido(7.5, granelBulto), 20, 'bajo_minimo').estado).toBe('debajo');
  });
});

describe('[AB.19] posiciones del pedido', () => {
  it('sano y sobrestock caen en «otros»', () => {
    expect(posicionPedido('agotado')).toBe('agotado');
    expect(posicionPedido('bajo_reorden')).toBe('bajo_reorden');
    expect(posicionPedido('sano')).toBe('otros');
    expect(posicionPedido('sobrestock')).toBe('otros');
  });
  it('⛔ normalizar tira lo desconocido y lo repetido, y respeta el orden', () => {
    expect(normalizarPosiciones(['bajo_reorden', 'x', 'agotado', 'agotado'])).toEqual(['agotado', 'bajo_reorden']);
    expect(normalizarPosiciones('agotado')).toEqual([]);
    expect(normalizarPosiciones(null)).toEqual([]);
  });
});

describe('[AB.18] necesitaMotivo — más de ±20% del sugerido', () => {
  it.each([
    [10, 10, false], [10, 12, false], [10, 8, false],
    [10, 13, true], [10, 7, true], [10, 0, true],
    [0, 0, false], [0, 1, true],
  ])('sugerido %s, cantidad %s → %s', (s, c, esperado) => {
    expect(necesitaMotivo(s, c)).toBe(esperado);
  });
});

describe('[AB.18] pasoAjuste — de uno en uno, nunca negativo', () => {
  it('sube y baja de a uno', () => {
    expect(pasoAjuste(3, 1)).toBe(4);
    expect(pasoAjuste(3, -1)).toBe(2);
  });
  it('⛔ no baja de cero', () => {
    expect(pasoAjuste(0, -1)).toBe(0);
  });
});
