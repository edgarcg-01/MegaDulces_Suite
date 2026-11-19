import {
  avisosDelRenglon,
  cantidadTexto,
  estadoDeOrden,
  etiquetasDelRenglon,
  fechaKepler,
  pieSucursal,
  totalEtiquetas,
  validarPedidoImpresion,
  type BoxLabelLineRow,
} from './box-labels.contract';

/** El espécimen: la etiqueta física de la foto (Suc 08, orden 0000474), medido en prod el 2026-11-19. */
const ESPECIMEN: BoxLabelLineRow = {
  sucursal: '08',
  sucursal_nombre: 'Sucursal Morelia Abastos',
  serie: 1,
  folio: '0000474',
  linea: 1,
  sku: '70106',
  nombre: 'LA ROSA BOTA GRANDE 418GR',
  unidad: 'CJA',
  unidad_base: 'PZA',
  uxc: 18,
  cajas: 20,
  cajas_completas: 20,
  piezas_sueltas: 0,
  codigo: 'C70106',
  kepler_unidad_caja: 'CJA',
  kepler_factor_caja: 18,
  kepler_codigo_caja: 'C70106',
  sin_catalogo: false,
};

/** Media caja real: Suc 01, orden 0000685, 40045 — 0.5 CJA × 100 → 50 PAQ sueltas. */
const MEDIA_CAJA: BoxLabelLineRow = {
  ...ESPECIMEN,
  sucursal: '01',
  sucursal_nombre: 'Sucursal PH',
  folio: '0000685',
  sku: '40045',
  nombre: 'PRODUCTO 40045',
  unidad_base: 'PAQ',
  uxc: 100,
  cajas: 0.5,
  cajas_completas: 0,
  piezas_sueltas: 50,
  codigo: 'C40045',
  kepler_codigo_caja: 'C40045',
  kepler_factor_caja: 100,
};

describe('[RE.ETQ.1.3] fechaKepler — la cuenta de Kepler, día de la Ciudad de México', () => {
  it('el espécimen: 5-nov-2026 → 308-26', () => {
    expect(fechaKepler('2026-11-05T18:00:00Z')).toBe('308-26');
  });
  it('el 1-ene cuenta como 0', () => {
    expect(fechaKepler('2026-01-01T12:00:00-06:00')).toBe('0-26');
  });
  it('31-dic de un año bisiesto → 365', () => {
    expect(fechaKepler('2028-12-31T12:00:00-06:00')).toBe('365-28');
  });
  it('a las 23:30 del 17-nov en CDMX (05:30 UTC del 18) sigue siendo el 17: 320-26, no 321-26', () => {
    expect(fechaKepler('2026-11-18T05:30:00Z')).toBe('320-26');
  });
  it('prueba negativa: el mismo instante leído como UTC daría otro día — la función NO lo hace', () => {
    expect(fechaKepler('2026-11-18T05:30:00Z')).not.toBe('321-26');
  });
  it('un instante que no se puede leer no inventa fecha', () => {
    expect(fechaKepler('no-es-fecha')).toBeNull();
  });
});

describe('[RE.ETQ.1.2] etiquetasDelRenglon — una por caja', () => {
  it('el espécimen: 20 etiquetas, 1:20 … 20:20, UXC 18, C70106, pie de la sucursal', () => {
    const e = etiquetasDelRenglon(ESPECIMEN, '308-26');
    expect(e).toHaveLength(20);
    expect(e[0]).toEqual({
      clave: '70106',
      codigo: 'C70106',
      consecutivo: '1:20',
      n: 1,
      total: 20,
      contenido: 'UXC 18',
      fecha: '308-26',
      nombre: 'LA ROSA BOTA GRANDE 418GR',
      pie: 'Suc 08 Sucursal Morelia Abastos',
      incompleta: false,
    });
    expect(e[19].consecutivo).toBe('20:20');
  });

  it('reimprimir sólo la 7 sale idéntica a la 7 de la primera vez', () => {
    const todas = etiquetasDelRenglon(ESPECIMEN, '308-26');
    const sola = etiquetasDelRenglon(ESPECIMEN, '308-26', [7]);
    expect(sola).toEqual([todas[6]]);
  });

  it('consecutivos repetidos o fuera de rango se ignoran', () => {
    expect(etiquetasDelRenglon(ESPECIMEN, '308-26', [3, 3, 0, 21, 2]).map((x) => x.n)).toEqual([2, 3]);
  });

  it('[RE.ETQ.1.5] la media caja lleva su etiqueta y dice sus piezas sueltas (Kepler imprime 0)', () => {
    const e = etiquetasDelRenglon(MEDIA_CAJA, '300-26');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ consecutivo: '1:1', contenido: '50 PAQ', incompleta: true });
  });

  it('20.5 cajas: 21 etiquetas, la 21:21 con las sueltas', () => {
    const l = { ...ESPECIMEN, cajas: 20.5, cajas_completas: 20, piezas_sueltas: 9 };
    const e = etiquetasDelRenglon(l, '308-26');
    expect(totalEtiquetas(l)).toBe(21);
    expect(e[19]).toMatchObject({ consecutivo: '20:21', contenido: 'UXC 18', incompleta: false });
    expect(e[20]).toMatchObject({ consecutivo: '21:21', contenido: '9 PZA', incompleta: true });
  });

  it('sin UXC en la orden se dice, no se inventa', () => {
    expect(etiquetasDelRenglon({ ...ESPECIMEN, uxc: null }, '308-26', [1])[0].contenido).toBe('UXC ?');
  });
});

describe('avisosDelRenglon', () => {
  it('el espécimen no lleva avisos', () => {
    expect(avisosDelRenglon(ESPECIMEN)).toEqual([]);
  });
  it('sin c85 en Kepler: «Kepler no reconoce C…»', () => {
    expect(avisosDelRenglon({ ...ESPECIMEN, kepler_codigo_caja: null }).map((a) => a.tipo)).toEqual(['kepler_no_lee_codigo']);
  });
  it('factor 0 en el catálogo, y la caja de Kepler vacía', () => {
    const t = avisosDelRenglon({ ...ESPECIMEN, kepler_factor_caja: 0, kepler_unidad_caja: null }).map((a) => a.tipo);
    expect(t).toEqual(['catalogo_factor_0', 'kepler_caja_otra_unidad']);
  });
  it('factor distinto: se imprime lo de la orden', () => {
    const a = avisosDelRenglon({ ...ESPECIMEN, kepler_factor_caja: 12 });
    expect(a.map((x) => x.tipo)).toEqual(['catalogo_factor_distinto']);
    expect(a[0].texto).toContain('18 por caja');
  });
  it('caja incompleta va primero', () => {
    expect(avisosDelRenglon(MEDIA_CAJA)[0].tipo).toBe('caja_incompleta');
  });
  it('sin catálogo: un solo aviso, no una cascada de falsos', () => {
    expect(avisosDelRenglon({ ...ESPECIMEN, sin_catalogo: true, kepler_codigo_caja: null, kepler_factor_caja: null }).map((a) => a.tipo)).toEqual(['sin_catalogo']);
  });
});

describe('estado, pie y validación', () => {
  it('estadoDeOrden', () => {
    expect(estadoDeOrden(20, 0)).toBe('por_etiquetar');
    expect(estadoDeOrden(20, 7)).toBe('parcial');
    expect(estadoDeOrden(20, 20)).toBe('enviada');
  });
  it('pieSucursal como Kepler', () => {
    expect(pieSucursal('08', 'Sucursal Morelia Abastos')).toBe('Suc 08 Sucursal Morelia Abastos');
    expect(pieSucursal('08', null)).toBe('Suc 08');
  });
  it('cantidadTexto', () => {
    expect([18, 0.5, 12.25, 50].map(cantidadTexto)).toEqual(['18', '0.5', '12.25', '50']);
  });
  it('validarPedidoImpresion acepta el pedido de la pantalla y rechaza lo mal formado', () => {
    const ok = { sucursal: '08', serie: 1, folio: '0000474', via: 'navegador' as const, renglones: [{ linea: 1 }] };
    expect(validarPedidoImpresion(ok)).toBeNull();
    expect(validarPedidoImpresion({ ...ok, sucursal: '8' })).toMatch(/2 dígitos/);
    expect(validarPedidoImpresion({ ...ok, via: 'zpl' as never })).toMatch(/vía/);
    expect(validarPedidoImpresion({ ...ok, renglones: [] })).toMatch(/renglón/);
    expect(validarPedidoImpresion({ ...ok, renglones: [{ linea: 1, consecutivos: [0] }] })).toMatch(/desde 1/);
  });
});
