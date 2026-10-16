import { claveYTexto, compararCampo, compararFicha, coincideBusqueda, mayoriaDeClaves, pasaFiltros, type FichaPlaza } from './ficha-sucursales';

/** La ficha 02073 tal como está en prod el 2026-10-16 (Oreo Dark Fudge): la 03 cambió el precio el 14-oct. */
const ficha = (sucursal: string, over: Partial<FichaPlaza> = {}): FichaPlaza => ({
  sucursal,
  descripcion: 'GALL OREO DARK FUDGE 166.4 GR / MONDELEZ',
  linea: '550', linea_nombre: 'MONDELEZ MEXICO S DE RL CV',
  tipo: '00001', tipo_nombre: 'NO APLICA',
  grupo: '00001', grupo_nombre: 'NO APLICA',
  iva: 0, ieps: -8,
  u1: 'PAQ', u2: 'CJA', u3: '', f2: 48, f3: 0,
  pv1: 50.52, pv2: 1177.15, pv3: 0,
  cb1: ['02073', 'CB1202073', 'CB1302073'], cb2: ['C02073', 'CB2202073', 'CB2302073'], cb3: ['', '', ''],
  mayoreo: 'PAQ:3.00:34.14',
  ultimo_cambio: '2024-11-12',
  ...over,
});

const red = (cambios: Record<string, Partial<FichaPlaza>> = {}) =>
  ['01', '02', '03', '04', '05', '06', '07', '08'].map((s) => ficha(s, cambios[s]));

describe('[CAT-PRECIO.1] mayoriaDeClaves', () => {
  it('todas iguales → igual, sin nadie fuera', () => {
    expect(mayoriaDeClaves([{ sucursal: '01', clave: 'a' }, { sucursal: '02', clave: 'a' }])).toEqual({
      veredicto: 'igual', mayoria: 'a', fuera: [],
    });
  });

  it('una se sale → distinto, y se nombra', () => {
    const r = mayoriaDeClaves([{ sucursal: '01', clave: 'a' }, { sucursal: '02', clave: 'a' }, { sucursal: '03', clave: 'b' }]);
    expect(r).toEqual({ veredicto: 'distinto', mayoria: 'a', fuera: ['03'] });
  });

  it('NEGATIVA: un empate NO elige ganador', () => {
    const r = mayoriaDeClaves([{ sucursal: '01', clave: 'a' }, { sucursal: '02', clave: 'b' }]);
    expect(r.veredicto).toBe('sin_mayoria');
    expect(r.mayoria).toBeNull();
    expect(r.fuera).toEqual([]);
  });

  it('la ausencia también es un valor: la que no tiene precio de caja se sale', () => {
    const r = mayoriaDeClaves([{ sucursal: '01', clave: '10.00' }, { sucursal: '02', clave: '10.00' }, { sucursal: '03', clave: '' }]);
    expect(r.fuera).toEqual(['03']);
  });
});

describe('[CAT-PRECIO.1] claveYTexto', () => {
  it('precio: clave en centavos, texto con unidad', () => {
    expect(claveYTexto('precio1', ficha('03', { pv1: 35.7 }))).toEqual({ clave: '35.70', texto: '$35.70 / PAQ' });
  });

  it('NEGATIVA: un centavo de diferencia SÍ es otra clave (igualdad exacta, no tolerancia)', () => {
    expect(claveYTexto('precio1', ficha('01', { pv1: 35.7 })).clave).not.toBe(claveYTexto('precio1', ficha('02', { pv1: 35.71 })).clave);
  });

  it('precio en cero = sin precio, no $0.00', () => {
    expect(claveYTexto('precio3', ficha('01'))).toEqual({ clave: '', texto: '—' });
  });

  it('impuesto negativo = incluido (nota de la ficha de Kepler)', () => {
    expect(claveYTexto('ieps', ficha('01')).texto).toBe('8 % (incluido)');
    expect(claveYTexto('iva', ficha('01')).texto).toBe('0 %');
  });

  it('el factor de una unidad sin rótulo no cuenta: no inventa diferencias', () => {
    expect(claveYTexto('unidades', ficha('01', { f3: 0 })).clave).toBe(claveYTexto('unidades', ficha('02', { f3: 12 })).clave);
  });

  it('00001 se lee NO APLICA, y una clasificación real se lee por su nombre', () => {
    expect(claveYTexto('tipo', ficha('01')).texto).toBe('NO APLICA');
    expect(claveYTexto('tipo', ficha('01', { tipo: '005', tipo_nombre: 'ABARROTES' })).texto).toBe('ABARROTES');
  });

  it('mayoreo legible', () => {
    expect(claveYTexto('mayoreo', ficha('01')).texto).toBe('PAQ desde 3: $34.14');
    expect(claveYTexto('mayoreo', ficha('01', { mayoreo: '' })).texto).toBe('sin precio por volumen');
  });
});

describe('[CAT-PRECIO.1] compararFicha — el caso real 02073', () => {
  const fila = compararFicha('02073', red({ '03': { pv1: 35.7, pv2: 1569.06, ultimo_cambio: '2026-10-14' } }), 1000);

  it('marca los dos precios, y sólo los precios', () => {
    expect(fila.campos.map((c) => c.campo)).toEqual(['precio1', 'precio2']);
  });

  it('la 03 se sale de la mayoría (que aquí es el precio viejo) y la brecha se mide', () => {
    const p1 = fila.campos[0];
    expect(p1.sucursales_fuera).toEqual(['03']);
    expect(p1.mayoria).toBe('$50.52 / PAQ');
    expect(p1.diferencia_pct).toBeCloseTo(41.51, 2);
  });

  it('dice quién movió el precio al último: la 03', () => {
    expect(fila.cambio_mas_reciente).toEqual({ sucursal: '03', fecha: '2026-10-14' });
  });

  it('NEGATIVA: si dos plazas cambiaron el mismo día, no elige una', () => {
    const f = compararFicha('x', red({ '03': { pv1: 1, ultimo_cambio: '2026-10-14' }, '04': { ultimo_cambio: '2026-10-14' } }));
    expect(f.cambio_mas_reciente).toBeNull();
  });

  it('NEGATIVA: fichas idénticas no producen campos', () => {
    expect(compararFicha('02073', red()).campos).toEqual([]);
  });

  it('una sola plaza con otro grupo se detecta (lo que el Concentrador sí tiene)', () => {
    const f = compararFicha('02073', red({ '05': { grupo: '164', grupo_nombre: 'GALLETAS BFY/BISCUITS' } }));
    expect(f.campos.map((c) => c.campo)).toEqual(['grupo']);
    expect(f.campos[0].valores.find((v) => v.sucursal === '05')).toEqual({ sucursal: '05', texto: 'GALLETAS BFY/BISCUITS', fuera: true });
  });

  it('en sin_mayoria ninguna celda se pinta como fuera', () => {
    const c = compararCampo('precio1', [ficha('01'), ficha('02', { pv1: 40 })]);
    expect(c?.veredicto).toBe('sin_mayoria');
    expect(c?.valores.every((v) => v.fuera === null)).toBe(true);
  });
});

describe('[CAT-PRECIO.1] filtros', () => {
  const fichas = red({ '03': { pv1: 35.7 }, '05': { grupo: '164', grupo_nombre: 'GALLETAS' } });
  const fila = compararFicha('02073', fichas);

  it('busca por código de barras de cualquier unidad', () => {
    expect(coincideBusqueda(fila, fichas, 'CB2202073')).toBe(true);
    expect(coincideBusqueda(fila, fichas, 'oreo')).toBe(true);
    expect(coincideBusqueda(fila, fichas, 'chocolate')).toBe(false);
  });

  it('varias palabras en cualquier orden; NEGATIVA: si una falta, no encuentra', () => {
    expect(coincideBusqueda(fila, fichas, 'fudge oreo')).toBe(true);
    expect(coincideBusqueda(fila, fichas, 'oreo chocolate')).toBe(false);
  });

  it('por campo y por plaza: la plaza tiene que salirse EN ese campo', () => {
    expect(pasaFiltros(fila, { campo: 'precio1' })).toBe(true);
    expect(pasaFiltros(fila, { campo: 'ieps' })).toBe(false);
    expect(pasaFiltros(fila, { sucursal: '05' })).toBe(true);
    expect(pasaFiltros(fila, { campo: 'precio1', sucursal: '05' })).toBe(false);
    expect(pasaFiltros(fila, { campo: 'grupo', sucursal: '05' })).toBe(true);
  });
});
