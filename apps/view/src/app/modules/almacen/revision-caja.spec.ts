import type { PresaleReviewLine } from '@megadulces/contracts';
import {
  aplicar,
  cantidadTexto,
  cuerpoDeCierre,
  deshacer,
  diasSinRevisar,
  noHubo,
  pasoDe,
  progresoInicial,
  renglonActual,
  resueltos,
  textoAtraso,
} from './revision-caja';

/**
 * `[MCP.10]` La revisión en caja del lado de la pantalla: qué producto se señala, qué hace cada botón
 * y qué se manda al terminar. Es lo que decide cuánto se cobra.
 */
const L = (key: string, ordered: number, picked: number, extra: Partial<PresaleReviewLine> = {}): PresaleReviewLine => ({
  key, product_id: `p-${key}`, product_name: `Producto ${key}`, unit: 'PAQ', factor: 20,
  ordered, picked, restorable: true, stock: { state: 'con_existencia', qty: 65, checked_at: null }, ...extra,
});
// Paleta bien · Mazapán faltó 1 · Japonés bien
const LINEAS = [L('a', 1, 1), L('b', 3, 2), L('c', 2, 2)];

describe('el producto que se está revisando', () => {
  it('arranca en el primero; lo que el surtidor dejó corto ya viene como faltante', () => {
    const p = progresoInicial(LINEAS);
    expect(renglonActual(LINEAS, p)?.key).toBe('a');
    expect(p.marcas['b'].estado).toBe('falta');
    expect(p.marcas['a'].estado).toBe('por_revisar');
  });

  it('«Está bien» pasa al siguiente con un solo toque', () => {
    const p = aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'bien' });
    expect(renglonActual(LINEAS, p)?.key).toBe('b');
    expect(resueltos(LINEAS, p)).toBe(1);
  });

  it('«Seguir con otro» deja el faltante al final sin resolverlo', () => {
    let p = aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'bien' });
    p = aplicar(p, LINEAS[1], { tipo: 'despues' });
    expect(renglonActual(LINEAS, p)?.key).toBe('c');
    p = aplicar(p, LINEAS[2], { tipo: 'bien' });
    // Ya sólo queda el que se esperaba: vuelve a salir.
    expect(renglonActual(LINEAS, p)?.key).toBe('b');
    expect(p.hist).toHaveLength(2);
  });

  it('cuando todo está resuelto no hay producto actual', () => {
    let p = progresoInicial(LINEAS);
    for (const l of LINEAS) p = aplicar(p, l, { tipo: l.picked < l.ordered ? 'completar' : 'bien' });
    expect(renglonActual(LINEAS, p)).toBeNull();
  });
});

describe('contar (No coincide / Trajo otra cantidad)', () => {
  it('menos de lo pedido = faltante; de más = devolver; justo = bien o completo', () => {
    const p0 = progresoInicial(LINEAS);
    expect(aplicar(p0, LINEAS[0], { tipo: 'contar', vienen: 0 }).marcas['a'].estado).toBe('falta');
    expect(aplicar(p0, LINEAS[0], { tipo: 'contar', vienen: 3 }).marcas['a'].estado).toBe('sobra');
    expect(aplicar(p0, LINEAS[0], { tipo: 'contar', vienen: 1 }).marcas['a'].estado).toBe('bien');
    expect(aplicar(p0, LINEAS[1], { tipo: 'contar', vienen: 3 }).marcas['b'].estado).toBe('completo');
    expect(aplicar(p0, LINEAS[1], { tipo: 'contar', vienen: 1 }).marcas['b']).toMatchObject({ estado: 'falta', vienen: 1 });
  });

  it('nunca cuenta negativo', () => {
    expect(aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'contar', vienen: -4 }).marcas['a'].vienen).toBe(0);
  });
});

describe('← Anterior', () => {
  it('regresa el último toque a como estaba', () => {
    let p = aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'bien' });
    p = aplicar(p, LINEAS[1], { tipo: 'nohay' });
    p = deshacer(p);
    expect(p.marcas['b'].estado).toBe('falta');
    expect(renglonActual(LINEAS, p)?.key).toBe('b');
    p = deshacer(p);
    expect(p.marcas['a'].estado).toBe('por_revisar');
    // CONTROL: sin historial no pasa nada.
    expect(deshacer(p)).toBe(p);
  });
});

describe('lo que se manda al terminar', () => {
  it('completo sube a lo pedido, no hay se queda con lo que vino, devuelto no cobra lo de más', () => {
    const lineas = [...LINEAS, L('d', 2, 2)];
    let p = progresoInicial(lineas);
    p = aplicar(p, lineas[0], { tipo: 'bien' });
    p = aplicar(p, lineas[1], { tipo: 'completar' });
    p = aplicar(p, lineas[2], { tipo: 'contar', vienen: 1 });
    p = aplicar(p, lineas[2], { tipo: 'nohay' });
    p = aplicar(p, lineas[3], { tipo: 'contar', vienen: 5 });
    p = aplicar(p, lineas[3], { tipo: 'devuelto' });
    expect(cuerpoDeCierre(lineas, p).lines).toEqual([
      { key: 'a', final: 1 },
      { key: 'b', final: 3 },
      { key: 'c', final: 1 },
      { key: 'd', final: 2, returned: 3 },
    ]);
    expect(noHubo(lineas, p)).toEqual([{ line: lineas[2], faltan: 1 }]);
  });

  it('NEGATIVO: no deja terminar con un producto sin revisar', () => {
    const p = aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'bien' });
    expect(() => cuerpoDeCierre(LINEAS, p)).toThrow(/Falta revisar/);
  });

  it('NEGATIVO: un producto que el surtido borró sin copia sólo acepta «No hay»', () => {
    const viejo = L('x', 1, 0, { restorable: false });
    const p0 = progresoInicial([viejo]);
    expect(aplicar(p0, viejo, { tipo: 'completar' })).toBe(p0);
    expect(aplicar(p0, viejo, { tipo: 'contar', vienen: 1 })).toBe(p0);
    expect(cuerpoDeCierre([viejo], aplicar(p0, viejo, { tipo: 'nohay' })).lines).toEqual([{ key: 'x', final: 0 }]);
  });
});

describe('textos y pasos', () => {
  it('dice la unidad en palabras y en singular cuando es una', () => {
    expect(cantidadTexto(1, 'CJA')).toBe('1 caja');
    expect(cantidadTexto(65, 'PAQ')).toBe('65 paquetes');
    // Lo que no conoce lo deja tal cual: no inventa unidades.
    expect(cantidadTexto(2, 'TIRA')).toBe('2 TIRA');
  });
  it('a granel avanza de medio en medio', () => {
    expect(pasoDe('KG')).toBe(0.5);
    expect(pasoDe('PAQ')).toBe(1);
  });
});

describe('lo que no se revisó no caduca: cuántos días lleva', () => {
  it('cuenta días en hora de México, no en UTC', () => {
    // 23:30 del 28 en México ya es 29 en UTC: sigue siendo de AYER para la cajera.
    expect(diasSinRevisar('2026-10-29T05:30:00.000Z', '2026-10-29')).toBe(1);
    expect(diasSinRevisar('2026-10-29T16:00:00.000Z', '2026-10-29')).toBe(0);
    expect(diasSinRevisar('2026-10-24T16:00:00.000Z', '2026-10-29')).toBe(5);
  });
  it('lo de hoy no es atraso; lo de antes se dice', () => {
    expect(textoAtraso(0)).toBeNull();
    expect(textoAtraso(1)).toBe('Sin revisar · desde ayer');
    expect(textoAtraso(5)).toBe('Sin revisar · hace 5 días');
  });
});
