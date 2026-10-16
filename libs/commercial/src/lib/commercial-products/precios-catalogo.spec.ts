import * as PRECIOS_SQL from './precios-catalogo.sql';
import * as FICHA_SQL from './ficha-sucursales.sql';
import { conversiones } from './precios-catalogo';
import { ajustePct, armarFila, cambiosDelDia, coincide, margenKepler, opciones, ordenar, precioSinImpuestos, type FichaPrecio } from './precios-catalogo';

/** El mazapán 70001 en la 03, tal como sale de prod el 2026-10-16. */
const mazapan = (over: Partial<FichaPrecio> = {}): FichaPrecio => ({
  sku: '70001', nombre: 'LA ROSA MAZAPAN /30',
  linea: '285', linea_nombre: 'DIST DE LA ROSA SA DE CV', tipo: '001', tipo_nombre: 'DULCES', grupo: '132', grupo_nombre: 'MAZAPAN CACAHUATE',
  iva: '0.0000', ieps: '-8.0000', costo: '66.52',
  u1: 'PAQ', u2: 'PAQ', u3: 'CJA', f2: '1.00', f3: '20.00',
  pv1: '86.93', pv2: '86.93', pv3: '1594.96',
  cb1: ['70001', '724869100106', ''], cb2: ['', '', ''], cb3: ['C70001', '', ''],
  vol1: [{ desde: 3, precio: 80.47 }], vol2: [{ desde: 3, precio: 80.47 }], vol3: [{ desde: 3, precio: 1551.85 }],
  ...over,
});

/**
 * ⛔ Medido el 2026-10-16: `GET price-list` respondía 500 en la primera prueba visual. El regex del costo
 * llevaba `?` y knex convierte CADA signo de interrogación en un parámetro `$n` antes de mandarlo a
 * Postgres. Las pruebas contra `pg` directo pasaban; sólo knex lo rompe. Esta prueba lo impide.
 */
describe('[CAT-PRECIO] SQL apto para knex', () => {
  const todas = { ...PRECIOS_SQL, ...FICHA_SQL } as Record<string, string>;
  it.each(Object.keys(todas))('%s no lleva signos de interrogación', (k) => {
    expect(todas[k]).not.toContain('?');
  });
});

describe('[CAT-PRECIO.2] margen Kepler', () => {
  it('casa con la ficha de Kepler: Oreo 02073 en la 03 = 20.25 %', () => {
    expect(margenKepler(35.7, 27.49, 0, -8)).toBe(20.25);
  });

  it('quita IEPS e IVA en cascada sólo cuando la tasa es negativa (incluida)', () => {
    expect(precioSinImpuestos(116, -16, 0)).toBeCloseTo(100, 6);
    expect(precioSinImpuestos(116, 16, 0)).toBe(116);
    expect(precioSinImpuestos(125.28, -16, -8)).toBeCloseTo(100, 6);
  });

  it('NEGATIVA: sin costo o sin precio no inventa un margen', () => {
    expect(margenKepler(35.7, null, 0, -8)).toBeNull();
    expect(margenKepler(35.7, 0, 0, -8)).toBeNull();
    expect(margenKepler(null, 27.49, 0, -8)).toBeNull();
  });

  it('NEGATIVA: el margen es sobre el costo, no sobre el precio', () => {
    // Sobre el precio la Oreo daría 16.84 %; Kepler dice 20.25 %.
    expect(margenKepler(35.7, 27.49, 0, -8)).not.toBeCloseTo(16.84, 1);
  });
});

describe('[CAT-PRECIO.2] armarFila', () => {
  const f = armarFila(mazapan());

  it('tres unidades con su precio, cambio automático y códigos', () => {
    expect(f.unidades.map((u) => [u.unidad, u.precio, u.volumen])).toEqual([
      ['PAQ', 86.93, [{ desde: 3, precio: 80.47 }]],
      ['PAQ', 86.93, [{ desde: 3, precio: 80.47 }]],
      ['CJA', 1594.96, [{ desde: 3, precio: 1551.85 }]],
    ]);
    expect(f.unidades[0].codigos).toEqual(['70001', '724869100106']);
  });

  it('el costo de cada unidad es costo estándar × factor (la caja trae 20)', () => {
    // 1594.96 / 1.08 / (66.52 × 20) − 1 = 11.01 %
    expect(f.unidades[2].margen_pct).toBe(11.01);
  });

  it('clasificación con nombre; vacío = sin asignar', () => {
    expect(f.tipo).toEqual({ codigo: '001', nombre: 'DULCES' });
    expect(armarFila(mazapan({ grupo: '', grupo_nombre: null })).grupo).toEqual({ codigo: null, nombre: null });
  });

  it('NEGATIVA: una unidad sin rótulo no aparece aunque traiga factor', () => {
    const g = armarFila(mazapan({ u3: '', f3: '20.00', pv3: '0' }));
    expect(g.unidades.map((u) => u.n)).toEqual([1, 2]);
  });

  it('precio en cero = sin precio, no $0.00', () => {
    expect(armarFila(mazapan({ pv3: '0.00' })).unidades[2].precio).toBeNull();
  });
});

describe('[CAT-PRECIO.2] conversiones de unidad', () => {
  it('el ejemplo de Compras: 1 PZA · PAQ = 10 PZA · CJA = 14 PAQ = 140 PZA', () => {
    expect(conversiones('PZA', { u: 'PAQ', f: 10 }, { u: 'CJA', f: 140 })).toEqual(['1 PZA', 'PAQ = 10 PZA', 'CJA = 14 PAQ = 140 PZA']);
  });

  it('41029 real: PAQ base y caja de 30, sin unidad 3', () => {
    expect(conversiones('PAQ', { u: 'CJA', f: 30 }, null)).toEqual(['1 PAQ', 'CJA = 30 PAQ']);
  });

  it('70001 real: la unidad 2 repite la base (PAQ ×1); la caja se dice en la base', () => {
    expect(conversiones('PAQ', { u: 'PAQ', f: 1 }, { u: 'CJA', f: 20 })).toEqual(['1 PAQ', 'PAQ = 1 PAQ', 'CJA = 20 PAQ']);
  });

  it('NEGATIVA: si la caja no es múltiplo del paquete, no se inventa «N paquetes»', () => {
    expect(conversiones('PZA', { u: 'PAQ', f: 12 }, { u: 'CJA', f: 100 })[2]).toBe('CJA = 100 PZA');
  });

  it('NEGATIVA: sin factor en la ficha = sin conversión, no «= 0»', () => {
    expect(conversiones('PZA', { u: 'PAQ', f: 0 }, null)).toEqual(['1 PZA', null]);
  });

  it('llega al renglón, en la unidad que corresponde', () => {
    const f = armarFila(mazapan());
    expect(f.unidades.map((u) => u.conversion)).toEqual(['1 PAQ', 'PAQ = 1 PAQ', 'CJA = 20 PAQ']);
  });
});

describe('[CAT-PRECIO.3] cambios del día', () => {
  it('neto del día: anterior del primero contra nuevo del último', () => {
    const { porClave } = cambiosDelDia([
      { sku: '70001', unidad: 'paq', precio_anterior: '19.00', precio_nuevo: '18.00', delta: '-1', hora: '09:00' },
      { sku: '70001', unidad: 'PAQ', precio_anterior: '18.00', precio_nuevo: '20.00', delta: '2', hora: '12:00' },
    ]);
    expect(porClave.get('70001|PAQ')).toEqual({ anterior: 19, nuevo: 20, ajuste_pct: 5.26, hora: '12:00' });
  });

  it('NEGATIVA: un centavo se oculta y se cuenta', () => {
    const r = cambiosDelDia([{ sku: '1', unidad: 'PZA', precio_anterior: '3.35', precio_nuevo: '3.36', delta: '0.01', hora: '01:00' }]);
    expect(r.porClave.size).toBe(0);
    expect(r.ocultos).toBe(1);
  });

  it('NEGATIVA (revisión): un centavo con flotantes engañosos también se oculta (35.70 → 35.71)', () => {
    const r = cambiosDelDia([
      { sku: 'a', unidad: 'PZA', precio_anterior: '35.70', precio_nuevo: '35.71', delta: '0.01', hora: '01:00' },
      { sku: 'b', unidad: 'PZA', precio_anterior: '0.29', precio_nuevo: '0.28', delta: '-0.01', hora: '01:00' },
    ]);
    expect(r.porClave.size).toBe(0);
    expect(r.ocultos).toBe(2);
  });

  it('NEGATIVA (revisión): subir y volver al mismo precio el mismo día no se lista ni se cuenta como centavo', () => {
    const r = cambiosDelDia([
      { sku: 'a', unidad: 'PZA', precio_anterior: '10.00', precio_nuevo: '12.00', delta: '2', hora: '09:00' },
      { sku: 'a', unidad: 'PZA', precio_anterior: '12.00', precio_nuevo: '10.00', delta: '-2', hora: '10:00' },
    ]);
    expect(r.porClave.size).toBe(0);
    expect(r.ocultos).toBe(0);
  });

  it('el cambio llega a la unidad correcta del renglón', () => {
    const { porClave } = cambiosDelDia([{ sku: '70001', unidad: 'CJA', precio_anterior: '1500', precio_nuevo: '1594.96', delta: '94.96', hora: null }]);
    const fila = armarFila(mazapan(), porClave);
    expect(fila.unidades[2].cambio?.ajuste_pct).toBe(6.33);
    expect(fila.unidades[0].cambio).toBeNull();
  });

  it('% de la historia del ejemplo de Compras: 18 → 20 = +11.11 %, 19 → 18 = −5.26 %', () => {
    expect(ajustePct(18, 20)).toBe(11.11);
    expect(ajustePct(19, 18)).toBe(-5.26);
    expect(ajustePct(0, 18)).toBeNull();
  });
});

describe('[CAT-PRECIO.2] búsqueda, orden y opciones', () => {
  const a = armarFila(mazapan());
  const b = armarFila(mazapan({ sku: '02073', nombre: 'GALL OREO DARK FUDGE', linea: '550', linea_nombre: 'MONDELEZ', tipo: '00001', tipo_nombre: 'NO APLICA', grupo: '', grupo_nombre: null, cb1: ['02073'] }));

  it('busca por varias palabras y por código de barras', () => {
    expect(coincide(a, 'rosa mazapan')).toBe(true);
    expect(coincide(a, '724869100106')).toBe(true);
    expect(coincide(a, 'mazapan oreo')).toBe(false);
  });

  it('ordena por artículo o agrupado por línea', () => {
    expect(ordenar([a, b], 'articulo').map((f) => f.sku)).toEqual(['02073', '70001']);
    expect(ordenar([a, b], 'linea').map((f) => f.sku)).toEqual(['70001', '02073']);
  });

  it('opciones con conteo; lo vacío se ofrece como «Sin asignar»', () => {
    expect(opciones([a, b], 'grupo')).toEqual([
      { codigo: '132', nombre: 'MAZAPAN CACAHUATE', productos: 1 },
      { codigo: '', nombre: 'Sin asignar', productos: 1 },
    ]);
  });
});
