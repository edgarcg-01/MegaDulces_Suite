// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import {
  clasificarMovimiento, compararRenglones, ETIQUETA_UNIDAD_IMPORTE, motivosPara, resumirDonde, sumarPorProducto, UNIDAD_IMPORTE_SALIDA, validarResolucion,
  type DocumentoAClasificar, type RenglonDocumento,
} from './excepciones-movimientos.contract';

describe('[MX.1.7] la unidad del importe de una salida depende del destino', () => {
  it('sucursal = valor de traspaso · cliente = precio de venta · ruta = mezcla', () => {
    expect(UNIDAD_IMPORTE_SALIDA).toEqual({ sucursal: 'valor_traspaso', cliente: 'precio_venta', ruta: 'mixta' });
  });
  it('cada unidad tiene etiqueta para la pantalla', () => {
    for (const u of Object.values(UNIDAD_IMPORTE_SALIDA)) expect(ETIQUETA_UNIDAD_IMPORTE[u]).toBeTruthy();
  });
});

const c = (d: DocumentoAClasificar) => clasificarMovimiento(d);

describe('[MX.1.4] clasificarMovimiento — sólo lo que el motor no puede dar por bueno va a la bandeja', () => {
  it('⛔ un traspaso que cuadra NO va (es el 90.7 % de lo que hoy se audita a mano)', () => {
    expect(c({ doc_code: 'TrsfRcv', transfer_status: 'completado' })).toEqual({ estado: 'cuadrado', excepciones: [], a_bandeja: false });
  });

  it('en tránsito y «a ruta o cliente» todavía no son excepción', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'en_transito' }).a_bandeja).toBe(false);
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'sin_recepcion_esperada' }).a_bandeja).toBe(false);
  });

  it('diferencia, sin acuse y sin origen SÍ van', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'diferencia' }).excepciones).toEqual(['diferencia']);
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'sin_acuse' }).excepciones).toEqual(['sin_acuse']);
    expect(c({ doc_code: 'TrsfRcv', transfer_status: 'sin_origen' }).excepciones).toEqual(['sin_origen']);
  });

  it('un ajuste de inventario va SIEMPRE (D3)', () => {
    expect(c({ doc_code: 'InvOut1' })).toEqual({ estado: 'excepcion', excepciones: ['ajuste_inventario'], a_bandeja: true });
    expect(c({ doc_code: 'InvIn1' }).a_bandeja).toBe(true);
  });

  it('⛔ lo que el motor no compara es «sin comparación», nunca «cuadrado»', () => {
    for (const doc_code of ['EntryOr1', 'ApEntOr1', 'Sale2', 'PhysInvIn', 'RtrnPur1', 'WIN_V']) {
      expect(c({ doc_code })).toEqual({ estado: 'sin_comparacion', excepciones: [], a_bandeja: false });
    }
    // un traspaso sin veredicto tampoco se da por bueno
    expect(c({ doc_code: 'TrsfShip' }).estado).toBe('sin_comparacion');
  });

  it('el importe incompleto se SUMA a lo que ya sea: un traspaso que cuadra con dinero sin verificar sí va', () => {
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'completado', lineas_sin_importe: 2 }))
      .toEqual({ estado: 'excepcion', excepciones: ['importe_incompleto'], a_bandeja: true });
    expect(c({ doc_code: 'TrsfShip', transfer_status: 'diferencia', lineas_sin_importe: 1 }).excepciones)
      .toEqual(['diferencia', 'importe_incompleto']);
    // en lo que no se compara, el importe incompleto no inventa una excepción
    expect(c({ doc_code: 'EntryOr1', lineas_sin_importe: 3 }).a_bandeja).toBe(false);
  });
});

const R = (sku: string, producto: string, piezas: number, importe: number | null = piezas * 10, sin_costo = 0): RenglonDocumento =>
  ({ sku, producto, piezas, importe, sin_costo });

describe('[MX.2.4] compararRenglones — dónde está el error, producto por producto', () => {
  it('el caso real: CEDIS 0000439 → Padre Hidalgo, la cocada salió y no llegó', () => {
    const r = compararRenglones({
      salida: [R('31012', 'COCADA MINI BARRITA BLANCA', 840), R('100', 'PALETA', 50)],
      recepcion: [R('100', 'PALETA', 50)],
    });
    expect(r[0]).toMatchObject({ sku: '31012', estado: 'no_llego', salida: 840, recepcion: null, delta: -840, importe_diferencia: -8400, con_error: true });
    expect(r[1]).toMatchObject({ sku: '100', estado: 'cuadra', con_error: false });
    expect(resumirDonde(['diferencia'], r)).toBe('COCADA MINI BARRITA BLANCA: salieron 840 y no llegó');
  });

  it('falta, sobra y no venía; primero lo que más dinero mueve', () => {
    const r = compararRenglones({
      salida: [R('A', 'BOLSA', 125), R('B', 'VELA', 10, 1000)],
      recepcion: [R('A', 'BOLSA', 50), R('B', 'VELA', 12, 1200), R('C', 'CHICLE', 5)],
    });
    expect(r.map((x) => [x.sku, x.estado])).toEqual([['A', 'falta'], ['B', 'sobra'], ['C', 'no_venia']]);
    expect(resumirDonde(['diferencia'], r)).toBe('BOLSA: salieron 125, llegaron 50 y 2 productos más');
  });

  it('⛔ la suma de los productos con error ES el Δ del documento (control: el caso que cuadra suma 0)', () => {
    const s = [R('A', 'X', 10), R('B', 'Y', 4), R('C', 'Z', 1)];
    const r = compararRenglones({ salida: s, recepcion: [R('A', 'X', 7), R('B', 'Y', 4), R('D', 'W', 2)] });
    expect(r.reduce((t, x) => t + x.delta, 0)).toBe((7 + 4 + 2) - (10 + 4 + 1));
    expect(compararRenglones({ salida: s, recepcion: s }).every((x) => !x.con_error)).toBe(true);
  });

  it('sin acuse: todo pendiente, y dice a dónde iba y cuántos días lleva', () => {
    const r = compararRenglones({ salida: [R('A', 'X', 10), R('B', 'Y', 5)], recepcion: null });
    expect(r.every((x) => x.estado === 'pendiente' && x.delta === 0)).toBe(true);
    expect(resumirDonde(['sin_acuse'], r, { destino: 'Padre Hidalgo', dias: 23 }))
      .toBe('Nadie registró la recepción en Padre Hidalgo en 23 días: 2 productos, 15 piezas');
  });

  it('sin origen, ajuste e importe incompleto nombran el producto', () => {
    expect(compararRenglones({ salida: null, recepcion: [R('A', 'X', 3)] })[0].estado).toBe('sin_respaldo');
    const aj = compararRenglones({ ajuste: [R('A', 'X', -2, -20), R('B', 'Y', 120, 4500)] });
    expect(resumirDonde(['ajuste_inventario'], aj)).toBe('Entraron 1 producto (+$4,500) y salieron 1 (−$20); neto +$4,480. Lo más pesado: Y +120 piezas');
    const sc = compararRenglones({ salida: [R('A', 'X', 1, null, 1)], recepcion: [R('A', 'X', 1, null, 1)] });
    expect(sc[0]).toMatchObject({ estado: 'cuadra', sin_costo: true, con_error: true });
    expect(resumirDonde(['importe_incompleto'], sc)).toBe('Sin costo en Kepler: X');
  });

  it('dos excepciones = dos frases', () => {
    const r = compararRenglones({ salida: [R('A', 'X', 10, null, 1)], recepcion: [R('A', 'X', 9, null, 1)] });
    expect(resumirDonde(['diferencia', 'importe_incompleto'], r)).toBe('X: salieron 10, llegaron 9 · Sin costo en Kepler: X');
  });
});

describe('[MX.2.6] ajustes del día: entradas, salidas y neto', () => {
  it('el caso real: Zamora Centro 2-oct, folio 0000004 entra y 0000091 sale', () => {
    const entrada = [R('17022', 'ALTOS BAJA CORT 18X26 1KG', 49, 2112.77), R('99870', 'RESORTERA', 121, 1171.03)];
    const salida = [R('91085', 'PRODUCTO 91085', -51, -22666.44), R('17162', 'PRODUCTO 17162', -249, -5967.61)];
    const r = compararRenglones({ ajuste: sumarPorProducto([entrada, salida]) });
    expect(r[0].sku).toBe('91085');
    expect(resumirDonde(['ajuste_inventario'], r))
      .toBe('Entraron 2 productos (+$3,284) y salieron 2 (−$28,634); neto −$25,350. Lo más pesado: PRODUCTO 91085 -51 piezas');
  });
  it('el mismo producto en dos folios se suma a su neto (control: sin repetir, no cambia nada)', () => {
    const j = sumarPorProducto([[R('A', 'X', 10, 100)], [R('A', 'X', -4, -40, 1), R('B', 'Y', 1, 5)]]);
    expect(j.find((x) => x.sku === 'A')).toMatchObject({ piezas: 6, importe: 60, sin_costo: 1 });
    expect(sumarPorProducto([[R('A', 'X', 10, 100)]])).toEqual([R('A', 'X', 10, 100)]);
  });
  it('sólo entradas o sólo salidas no inventan la otra mitad', () => {
    expect(resumirDonde(['ajuste_inventario'], compararRenglones({ ajuste: [R('A', 'X', 5, 50)] }))).toBe('Entraron 1 producto, +$50. Lo más pesado: X +5 piezas');
    expect(resumirDonde(['ajuste_inventario'], compararRenglones({ ajuste: [R('A', 'X', -5, -50)] }))).toBe('Salieron 1 producto, −$50. Lo más pesado: X -5 piezas');
  });
});

describe('[MX.2.4] motivos de resolución', () => {
  it('cada excepción tiene al menos un motivo propio además de «otro»', () => {
    for (const e of ['diferencia', 'sin_acuse', 'sin_origen', 'ajuste_inventario', 'importe_incompleto'] as const) {
      expect(motivosPara([e]).filter((m) => m.codigo !== 'otro').length).toBeGreaterThan(0);
    }
    expect(motivosPara(['ajuste_inventario']).map((m) => m.codigo)).not.toContain('faltante_confirmado');
  });
  it('⛔ rechaza motivo inventado, «otro» sin nota y nota enorme; acepta lo válido (control)', () => {
    expect(validarResolucion('lo_que_sea', 'x')).toMatch(/motivo/);
    expect(validarResolucion(null, null)).toMatch(/motivo/);
    expect(validarResolucion('otro', '  ')).toMatch(/nota/);
    expect(validarResolucion('faltante_confirmado', '')).toMatch(/nota/);
    expect(validarResolucion('error_de_captura', 'x'.repeat(1001))).toMatch(/1,000/);
    expect(validarResolucion('corregido_en_kepler', null)).toBeNull();
    expect(validarResolucion('otro', 'Se devolvió al proveedor')).toBeNull();
  });
});
