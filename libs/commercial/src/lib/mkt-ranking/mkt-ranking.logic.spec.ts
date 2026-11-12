import {
  cubrimiento, puntaje, ordenarRanking, promedioGeneral, objetivoSugerido, resolverSemana, lunesDe, numeroSemana,
  unidadesDePago, textoRegla, esCanal, palabrasDePromo, nombreCoincide, identificarProductos,
} from './mkt-ranking.logic';

describe('[MKT.10] semanas', () => {
  it('el lunes de cualquier día, también del domingo', () => {
    expect(lunesDe('2026-11-02')).toBe('2026-11-02');
    expect(lunesDe('2026-11-05')).toBe('2026-11-02');
    expect(lunesDe('2026-11-08')).toBe('2026-11-02'); // domingo
  });

  it('numera como el Excel: la del 2 al 8 de noviembre de 2026 es la 45', () => {
    expect(numeroSemana('2026-11-02')).toBe(45);
    expect(numeroSemana('2026-01-05')).toBe(2);
  });

  it('sin fecha da la última semana CERRADA; la semana actual va marcada en curso hasta hoy', () => {
    expect(resolverSemana(undefined, '2026-11-11')).toMatchObject({ lunes: '2026-11-02', domingo: '2026-11-08', hasta: '2026-11-08', en_curso: false });
    expect(resolverSemana('2026-11-10', '2026-11-11')).toMatchObject({ lunes: '2026-11-09', hasta: '2026-11-11', en_curso: true });
  });

  it('[negativa] una semana que no ha empezado se rechaza', () => {
    expect(() => resolverSemana('2026-11-20', '2026-11-11')).toThrow('semana_futura');
  });
});

describe('[MKT.10] cubrimiento y ranking', () => {
  it('⭐ el tope de 100 %: objetivo 1 y venta 34 cuenta como 100 %, no como 3,400 % (el caso de CAN, semana 45)', () => {
    expect(cubrimiento(34, 1)).toBe(1);
    expect(cubrimiento(5, 10)).toBe(0.5);
  });

  it('⭐ sin objetivo NO es cero: no se puede medir', () => {
    expect(cubrimiento(10, null)).toBeNull();
    expect(cubrimiento(10, 0)).toBeNull();
  });

  it('el puntaje promedia SÓLO las promos con objetivo y cuenta aparte las que no tienen', () => {
    const p = puntaje([
      { promo_id: 'a', objetivo: 10, venta: 10 },
      { promo_id: 'b', objetivo: 10, venta: 0 },
      { promo_id: 'c', objetivo: null, venta: 7 },
    ]);
    expect(p).toEqual({ puntaje: 0.5, con_objetivo: 2, sin_objetivo: 1, cumplidas: 1, sin_venta: 1 });
  });

  it('⭐ un caso raro ya no voltea el ranking (con el promedio sin tope del Excel, B ganaba)', () => {
    const a = { nombre: 'A', ...puntaje([{ promo_id: '1', objetivo: 10, venta: 10 }, { promo_id: '2', objetivo: 10, venta: 9 }]) };
    const b = { nombre: 'B', ...puntaje([{ promo_id: '1', objetivo: 1, venta: 34 }, { promo_id: '2', objetivo: 10, venta: 0 }]) };
    const r = ordenarRanking([b, a]);
    expect(r.map((x) => x.nombre)).toEqual(['A', 'B']);
    expect(r[0].lugar).toBe(1);
  });

  it('los que no se pueden medir van al final y SIN lugar; el promedio general no los cuenta como cero', () => {
    const r = ordenarRanking([
      { nombre: 'Sin objetivos', ...puntaje([{ promo_id: '1', objetivo: null, venta: 3 }]) },
      { nombre: 'Medida', ...puntaje([{ promo_id: '1', objetivo: 4, venta: 2 }]) },
    ]);
    expect(r.map((x) => [x.nombre, x.lugar])).toEqual([['Medida', 1], ['Sin objetivos', null]]);
    expect(promedioGeneral(r)).toBe(0.5);
    expect(promedioGeneral([{ puntaje: null }])).toBeNull();
  });

  it('empate en puntaje: gana quien cumplió más promos', () => {
    const r = ordenarRanking([
      { nombre: 'X', puntaje: 0.5, con_objetivo: 2, sin_objetivo: 0, cumplidas: 0, sin_venta: 0 },
      { nombre: 'Y', puntaje: 0.5, con_objetivo: 2, sin_objetivo: 0, cumplidas: 1, sin_venta: 1 },
    ]);
    expect(r[0].nombre).toBe('Y');
  });
});

describe('[MKT.10] objetivo sugerido', () => {
  it('promedio de las semanas de historia, hacia arriba, mínimo 1', () => {
    expect(objetivoSugerido([10, 12, 9, 11])).toBe(11);
    expect(objetivoSugerido([0, 0, 1, 0])).toBe(1);
  });
  it('[negativa] sin historia no se inventa un objetivo', () => {
    expect(objetivoSugerido([])).toBeNull();
  });
});

describe('[MKT.14] incentivos', () => {
  it('proporcional paga la fracción (como hoy el Excel); completo sólo unidades enteras', () => {
    expect(unidadesDePago(0.25, 'proporcional')).toBe(0.25);
    expect(unidadesDePago(2.99, 'completo')).toBe(2);
    expect(unidadesDePago(3, 'completo')).toBe(3);
    expect(unidadesDePago(-1, 'proporcional')).toBe(0);
  });

  it('⭐ el texto de la regla sale de sus datos: el monto que se lee es el que se paga', () => {
    expect(textoRegla({ tipo: 'por_caja', pago: 25, base_monto: null })).toBe('$25.00 por caja vendida');
    expect(textoRegla({ tipo: 'por_monto', pago: 5, base_monto: 120 })).toBe('$5.00 por cada $120.00 vendidos');
  });

  it('sólo hay cuatro canales', () => {
    expect(['mostrador', 'preventa', 'ruta', 'mayoreo'].every(esCanal)).toBe(true);
    expect(esCanal('vecinal')).toBe(false);
  });
});

describe('[MKT.15] el producto de la promoción (casos medidos en prod, 4 semanas de mostrador)', () => {
  const leche = {
    code: '09066', descripcion: '3 LECHE SAN JUAN = GRATIS 1 MAS', esSimbolico: true, tickets: 138,
    candidatos: [
      { sku: '99891', nombre: 'LECHE ENTERA 1L / 1 SAN JUAN', tickets: 66 },
      { sku: '99893', nombre: 'LECHE DESLACTOSADA 1L / 1 SAN JUAN', tickets: 64 },
      { sku: '70001', nombre: 'LA ROSA MAZAPAN /30', tickets: 30 },
    ],
  };

  it('las palabras son lo que se COMPRA (antes del «=»), sin plural ni palabras vacías', () => {
    expect(palabrasDePromo('3 LECHES DEMO 1LT = GRATIS 1 MAS')).toEqual(['LECHE', 'DEMO']);
    expect(palabrasDePromo('4 GALL INDICADAS = GRATIS 1 GALL MARIAS')).toEqual(['GALL']);
    expect(palabrasDePromo('$120 NUTRESA = GRATIS 1 EXH NUCITA')).toEqual(['NUTRESA']);
    expect(palabrasDePromo(null)).toEqual([]);
  });

  it('el nombre coincide si una palabra EMPIEZA igual, sin importar acentos', () => {
    expect(nombreCoincide('LECHE ENTERA 1L', ['LECHE'])).toBe(true);
    expect(nombreCoincide('BARCEL FUEGO', ['BARCEL', 'BIMBO'])).toBe(true);
    expect(nombreCoincide('CHOC M&M S PEANUT /6', ['GALLETA'])).toBe(false);
    expect(nombreCoincide('PIÑATA PACK', ['PINATA'])).toBe(true);
    expect(nombreCoincide(null, ['LECHE'])).toBe(false);
  });

  it('09066 «3 LECHE SAN JUAN» → las dos leches; el mazapán del mismo ticket NO', () => {
    const r = identificarProductos(leche);
    expect(r.metodo).toBe('ticket_y_nombre');
    expect(r.productos.map((x) => x.sku)).toEqual(['99891', '99893']);
    expect(r.productos[0].pct).toBe(48);
  });

  it('00517 «4 GALL INDICADAS»: los M&M del 39 % de los tickets NO se adivinan', () => {
    const r = identificarProductos({
      code: '00517', descripcion: '4 GALL INDICADAS = GRATIS 1 GALL MARIAS CHOCOTELA', esSimbolico: true, tickets: 36,
      candidatos: [{ sku: '06004', nombre: 'CHOC M&M S PEANUT /6', tickets: 14 }],
    });
    expect(r.metodo).toBe('sin_identificar');
    expect(r.productos).toEqual([]);
  });

  it('un producto que coincide de nombre pero sale en < 10 % de los tickets no cuenta', () => {
    const r = identificarProductos({ ...leche, candidatos: [{ sku: '99892', nombre: 'LECHE LIGTH 1L', tickets: 13 }] });
    expect(r.metodo).toBe('sin_identificar');
  });

  it('con menos de 3 tickets no se decide nada', () => {
    const r = identificarProductos({ ...leche, tickets: 2, candidatos: [{ sku: '99891', nombre: 'LECHE ENTERA', tickets: 2 }] });
    expect(r.metodo).toBe('pocos_tickets');
    expect(r.productos).toEqual([]);
  });

  it('27100 «WINIS T7 + % GRATIS» a precio real: el producto es el mismo código', () => {
    const r = identificarProductos({ code: '27100', descripcion: 'WINIS T7 SURTIDO TUBO /24 + % GRATIS', esSimbolico: false, tickets: 498, candidatos: [] });
    expect(r.metodo).toBe('mismo_codigo');
    expect(r.productos.map((x) => x.sku)).toEqual(['27100']);
  });

  it('el propio código nunca es su producto, y se topa a 6', () => {
    const muchos = Array.from({ length: 9 }, (_, i) => ({ sku: `9989${i}`, nombre: `LECHE ${i}`, tickets: 50 - i }));
    const r = identificarProductos({ ...leche, candidatos: [{ sku: '09066', nombre: 'LECHE', tickets: 138 }, ...muchos] });
    expect(r.productos).toHaveLength(6);
    expect(r.productos.some((x) => x.sku === '09066')).toBe(false);
  });
});
