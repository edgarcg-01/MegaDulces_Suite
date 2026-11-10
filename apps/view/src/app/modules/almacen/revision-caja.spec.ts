import type { PresaleReviewLine } from '@megadulces/contracts';
import {
  alEscanear,
  aplicar,
  filtraLaLista,
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

  it('[MCP.10.2] el producto que la cajera toca pasa a revisarse, aunque no sea el siguiente', () => {
    const p = progresoInicial(LINEAS);
    // Lo blando va arriba en el carrito: sale primero el tercero del pedido.
    expect(renglonActual(LINEAS, p, 'c')?.key).toBe('c');
    // Al resolverlo, vuelve al primero pendiente.
    const p2 = aplicar(p, LINEAS[2], { tipo: 'bien' });
    expect(renglonActual(LINEAS, p2, 'c')?.key).toBe('a');
    expect(resueltos(LINEAS, p2)).toBe(1);
  });

  it('[MCP.10.2] se puede tocar el faltante que se dejó esperando al surtidor', () => {
    const p = aplicar(progresoInicial(LINEAS), LINEAS[1], { tipo: 'despues' });
    expect(renglonActual(LINEAS, p)?.key).toBe('a');
    expect(renglonActual(LINEAS, p, 'b')?.key).toBe('b');
  });

  it('[MCP.10.2] NEGATIVO: tocar uno ya resuelto o una clave que no existe no cambia nada', () => {
    const p = aplicar(progresoInicial(LINEAS), LINEAS[0], { tipo: 'bien' });
    expect(renglonActual(LINEAS, p, 'a')?.key).toBe('b');
    expect(renglonActual(LINEAS, p, 'no-existe')?.key).toBe('b');
  });

  it('cuando todo está resuelto no hay producto actual', () => {
    let p = progresoInicial(LINEAS);
    for (const l of LINEAS) p = aplicar(p, l, { tipo: l.picked < l.ordered ? 'completar' : 'bien' });
    expect(renglonActual(LINEAS, p)).toBeNull();
  });
});

describe('[MCP.10.3] escanear lo que se tiene en la mano', () => {
  // Paleta: 1 paquete (factor 20) · Mazapán: 3 paquetes, faltó 1 · Chicle: 1 caja (factor 400) · Salsa: sin código.
  const LS = [
    L('pal', 1, 1, { codes: [{ code: '7501001', factor: 1 }, { code: '07501001', factor: 20 }] }),
    L('maz', 3, 2, { codes: [{ code: '7502002', factor: 20 }] }),
    L('chi', 1, 1, { factor: 400, unit: 'CJA', codes: [{ code: '7503003', factor: 1 }, { code: 'C7503', factor: 400 }] }),
    L('sal', 1, 1, { codes: [] }),
  ];
  const p0 = progresoInicial(LS);

  it('un renglón de UNA unidad escaneado en esa unidad queda «bien» sin tocar nada', () => {
    const { escaneo, progreso } = alEscanear(LS, p0, ' 07501001 ');
    expect(escaneo.tipo).toBe('confirmado');
    expect(progreso.marcas['pal'].estado).toBe('bien');
    expect(progreso.hist).toHaveLength(1); // «Anterior» lo puede deshacer
  });

  it('NEGATIVO: la PIEZA de un pedido de «1 caja» sólo la señala, no da la caja por buena', () => {
    const { escaneo, progreso } = alEscanear(LS, p0, '7503003');
    expect(escaneo.tipo).toBe('elegido');
    expect(progreso).toBe(p0);
    expect(alEscanear(LS, p0, 'c7503').escaneo.tipo).toBe('confirmado'); // la etiqueta de la caja sí
  });

  it('NEGATIVO: sin quitar ceros: 7501001 (pieza) no confirma el paquete 07501001', () => {
    const { escaneo } = alEscanear(LS, p0, '7501001');
    expect(escaneo.tipo).toBe('elegido');
  });

  it('varias unidades o un faltante: lo señala para revisarlo en grande', () => {
    const r = alEscanear(LS, p0, '7502002');
    expect(r.escaneo).toMatchObject({ tipo: 'elegido', line: { key: 'maz' } });
    expect(r.progreso.marcas['maz'].estado).toBe('falta');
  });

  it('lo ya revisado lo dice; lo que no es del pedido también, y avisa si hay pendientes sin código', () => {
    const { progreso } = alEscanear(LS, p0, '07501001');
    expect(alEscanear(LS, progreso, '07501001').escaneo.tipo).toBe('ya_revisado');
    expect(alEscanear(LS, p0, '999999').escaneo).toEqual({ tipo: 'no_es' });
    expect(alEscanear(LS, p0, '   ').escaneo.tipo).toBe('vacio');
  });

  it('por SKU, por código sin ceros o por nombre lo señala, pero NUNCA lo confirma solo (no dicen la unidad)', () => {
    const conSku = LS.map((l) => (l.key === 'pal' ? { ...l, sku: '44340' } : l));
    const porSku = alEscanear(conSku, progresoInicial(conSku), '44340');
    expect(porSku.escaneo).toMatchObject({ tipo: 'elegido', match: 'sku', line: { key: 'pal' } });
    expect(resueltos(conSku, porSku.progreso)).toBe(0);
    expect(alEscanear(LS, p0, '7502002').escaneo).toMatchObject({ tipo: 'elegido', match: 'codigo' });
    expect(alEscanear(LS, p0, '07502002').escaneo).toMatchObject({ tipo: 'elegido', match: 'codigo_sin_ceros', line: { key: 'maz' } });
    // NEGATIVO: la etiqueta de la caja con ceros de más la encuentra, pero aunque el pedido sea «1 caja» no la confirma.
    const sinCeros = alEscanear(LS, p0, '00C7503');
    expect(sinCeros.escaneo).toMatchObject({ tipo: 'elegido', match: 'codigo_sin_ceros', line: { key: 'chi' } });
    expect(resueltos(LS, sinCeros.progreso)).toBe(0);
    const porNombre = alEscanear(LS, p0, 'producto  SAL');
    expect(porNombre.escaneo).toMatchObject({ tipo: 'elegido', match: 'nombre', line: { key: 'sal' } });
    expect(resueltos(LS, porNombre.progreso)).toBe(0);
  });

  it('por nombre con varias coincidencias no adivina; lo ya revisado por nombre lo dice', () => {
    expect(alEscanear(LS, p0, 'producto').escaneo).toMatchObject({ tipo: 'varios', match: 'nombre' });
    const { progreso } = alEscanear(LS, p0, '07501001');
    expect(alEscanear(LS, progreso, 'producto pal').escaneo.tipo).toBe('ya_revisado');
  });

  it('lo que se va escribiendo filtra la lista, salvo la ráfaga larga de dígitos del lector', () => {
    expect(filtraLaLista('tambo')).toBe(true);
    expect(filtraLaLista('44340')).toBe(true);
    expect(filtraLaLista('7501000044340')).toBe(false);
    expect(filtraLaLista('  ')).toBe(false);
  });

  it('NEGATIVO: si dos pendientes comparten el código no adivina', () => {
    const dos = [L('x', 1, 1, { codes: [{ code: '111', factor: 20 }] }), L('y', 1, 1, { codes: [{ code: '111', factor: 20 }] })];
    const r = alEscanear(dos, progresoInicial(dos), '111');
    expect(r.escaneo.tipo).toBe('varios');
    expect(resueltos(dos, r.progreso)).toBe(0);
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
