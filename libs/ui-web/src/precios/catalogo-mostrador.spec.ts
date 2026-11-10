import {
  aBuscable, buscarEnCatalogo, escalonesDe, presentacionesDe, productosPorCodigo, tramoNormal,
  unidadDelCodigo, unidadesDelRespaldo,
  type RenglonRespaldo, type TramoMayoreo, type UnidadConFactor,
} from './catalogo-mostrador';

/**
 * `[MOS.1]` — El buscador del mostrador: qué encuentra, cómo cuenta la caja y cómo dice el mayoreo.
 *
 * ⭐ `[VTK.17]` Este spec vivía en `apps/view/src/app/modules/tienda/mostrador-catalogo.spec.ts` y se
 * movió CON el código a `ui-web`: las dos apps (verificador de la tienda y checador del vendedor)
 * buscan con esta misma regla. Los casos de `[MOS.1]` y `[ETQ-PROMO.2]` van intactos; los de abajo
 * del todo son los nuevos del checador.
 *
 * Los negativos pesan tanto como los positivos: una caja que «siempre» se convierte a paquetes se
 * ve bien con el producto de ejemplo y miente con el que no divide exacto.
 */

const u = (x: string, precio: number, factor = 1): UnidadConFactor => ({ u: x, precio_con_iva: precio, factor });

const tier = (o: Partial<TramoMayoreo>): TramoMayoreo => ({
  desde: 3, precio_con_iva: 120, descuento_pct: 4.8, aplica_a: 'paquete',
  ...o,
});

describe('presentacionesDe — qué trae cada presentación', () => {
  it('la caja se cuenta en PAQUETES cuando el producto tiene paquete', () => {
    const p = presentacionesDe([u('PZA', 3.5), u('PAQ', 126, 40), u('CJA', 2380, 800)]);
    expect(p.map((x) => [x.u, x.trae?.n, x.trae?.u])).toEqual([
      ['PZA', undefined, undefined], ['PAQ', 40, 'PZA'], ['CJA', 20, 'PAQ'],
    ]);
    expect(p[2].trae?.palabra).toBe('paquetes');
    expect(p[2].precioPorTrae).toBe(119);            // $2,380 / 20 paquetes
  });

  it('⛔ si la caja no divide exacto entre el paquete, dice las PIEZAS (no inventa 12.5 paquetes)', () => {
    const p = presentacionesDe([u('PZA', 3.5), u('PAQ', 126, 40), u('CJA', 1700, 500)]);
    expect(p[2].trae).toEqual({ n: 500, u: 'PZA', palabra: 'piezas' });
  });

  it('⛔ sin paquete, la caja va en piezas', () => {
    const p = presentacionesDe([u('PZA', 14.5), u('CJA', 320, 24)]);
    expect(p[1].trae).toEqual({ n: 24, u: 'PZA', palabra: 'piezas' });
  });

  it('cuando la base ES el paquete, la caja cuenta paquetes', () => {
    const p = presentacionesDe([u('PAQ', 52), u('CJA', 980, 20)]);
    expect(p[1].trae).toEqual({ n: 20, u: 'PAQ', palabra: 'paquetes' });
  });

  it('la base no "trae" nada y una unidad desconocida conserva su clave', () => {
    const p = presentacionesDe([u('BTO', 40)]);
    expect(p[0].trae).toBeNull();
    expect(p[0].nombre).toBe('BTO');
  });
});

describe('escalonesDe — el mayoreo en la presentación en que Kepler lo captura', () => {
  const uni = [u('PZA', 4.8), u('PAQ', 88, 20), u('CJA', 1690, 400)];

  it('un escalón de paquete se dice por paquete, con el precio normal del paquete', () => {
    const [e] = escalonesDe(uni, [tier({ desde: 5, precio_con_iva: 84 })]);
    expect(e).toMatchObject({ u: 'PAQ', precio: 84, precioNormal: 88, etiqueta: 'c/paquete', desde: 5 });
    expect(tramoNormal(e)).toBe('1 a 4 paquetes');
  });

  it('un escalón de la base se dice por pieza', () => {
    const [e] = escalonesDe(uni, [tier({ aplica_a: 'base', desde: 10, precio_con_iva: 4.5 })]);
    expect(e).toMatchObject({ u: 'PZA', precio: 4.5, precioNormal: 4.8, etiqueta: 'c/pieza' });
  });

  it('⛔ el precio de mayoreo NO se convierte a pieza: es el de UNA unidad de su presentación', () => {
    const [e] = escalonesDe([u('PZA', 3.5), u('PAQ', 126, 40)], [tier({ precio_con_iva: 120 })]);
    expect(e.precio).toBe(120);
    expect(e.etiqueta).toBe('c/paquete');
  });

  it('a granel se dice por kilo', () => {
    const [e] = escalonesDe([u('KG', 98)], [tier({ aplica_a: 'base', desde: 5, precio_con_iva: 92 })]);
    expect(e.etiqueta).toBe('c/kg');
    expect(tramoNormal(e)).toBe('1 a 4 kg');
  });

  it('con mínimo de 2, el tramo normal es "1 pieza"', () => {
    const [e] = escalonesDe([u('PZA', 10)], [tier({ aplica_a: 'base', desde: 2, precio_con_iva: 9 })]);
    expect(tramoNormal(e)).toBe('1 pieza');
  });
});

describe('buscarEnCatalogo — nombre, proveedor, SKU o código de barras', () => {
  const item = (c: string, n: string, b: string[], pv?: number): RenglonRespaldo => ({ c, n, b, u: [{ u: 'PZA', p: 1, s: 1, f: 1 }], ...(pv !== undefined ? { pv } : {}) });
  const PROV = ['DULCES DE LA ROSA', 'RICOLINO'];
  const cat = [
    item('70001', 'PAL CHIQUI HUESO C/CHILE ALVHER /40', ['7501234500012']),
    item('14030', 'MAZAPAN DE LA ROSA GRANDE 30P', ['7501056310012'], 0),
    item('14055', 'PULPARINDO 20P', ['7501056320011'], 0),
    item('96158', 'PALETA PAYASO 45G', ['7501000911288'], 1),
    item('00700', 'PIÑA ENCHILADA', [], 1),
  ].map((x) => aBuscable(x, PROV));
  const buscar = (q: string) => buscarEnCatalogo(cat, q).map((r) => [r.b.codigo, r.por]);

  it('por nombre, con palabras en cualquier orden y sin acentos', () => {
    expect(buscar('chile chiqui')).toEqual([['70001', 'nombre']]);
    expect(buscar('pina')).toEqual([['00700', 'nombre']]);
  });

  it('por proveedor: trae los productos que no lo dicen en el nombre', () => {
    expect(buscar('ricolino')).toEqual([['96158', 'proveedor'], ['00700', 'proveedor']]);
    const rosa = buscar('rosa');
    expect(rosa[0]).toEqual(['14030', 'nombre']);     // lo dice en el nombre: va primero
    expect(rosa).toContainEqual(['14055', 'proveedor']);
  });

  it('por SKU, sin los ceros a la izquierda, por prefijo', () => {
    // `700` ES la clave 00700 (exacto, primero) y es el principio de 70001.
    expect(buscar('700')).toEqual([['00700', 'sku'], ['70001', 'sku']]);
    expect(buscar('1403')).toEqual([['14030', 'sku']]);
  });

  it('por código de barras, también un pedazo', () => {
    expect(buscar('7501056')).toEqual([['14030', 'barcode'], ['14055', 'barcode']]);
  });

  it('el código EXACTO va primero (es lo que se escaneó)', () => {
    const r = buscarEnCatalogo(cat, '7501056320011');
    expect(r[0].b.codigo).toBe('14055');
    expect(r[0].exacto).toBe(true);
  });

  it('nombre y proveedor juntos', () => {
    expect(buscar('paleta ricolino')).toEqual([['96158', 'varios']]);
  });

  it('⛔ sin texto no devuelve el catálogo entero, y lo que no casa no sale', () => {
    expect(buscar('')).toEqual([]);
    expect(buscar('zzz')).toEqual([]);
  });

  it('⛔ un producto sin proveedor no casa por proveedor con texto vacío', () => {
    const sinProv = aBuscable(item('1', 'GOMA', []), PROV);
    expect(sinProv.proveedor).toBeNull();
    expect(buscarEnCatalogo([sinProv], 'rosa')).toEqual([]);
  });

  /** `[ETQ-PROMO.2]` Una promoción de Kepler SÍ sale, marcada y después de los productos (igual que en la etiquetera). */
  describe('promociones de Kepler (pm:1)', () => {
    // El nombre de la promoción EMPIEZA con lo buscado y el del producto no: sin el orden por promoción, la promoción saldría
    // primero (por «empieza con»). Así la prueba distingue de verdad el orden y no se pasa por casualidad.
    const promo = { ...item('09089', 'OREO BASE 9 KG = GRATIS 1 CJ MAS', []), pm: 1 as const };
    const real = item('10245', 'GALLETA OREO 36 G', []);
    const base = [promo, real].map((x) => aBuscable(x, PROV));
    const lista = (q: string) => buscarEnCatalogo(base, q).map((r) => [r.b.codigo, r.esPromocion]);

    it('⭐ buscar por nombre devuelve LOS DOS: el producto primero y la promoción marcada al final', () => {
      expect(lista('oreo')).toEqual([['10245', false], ['09089', true]]);
    });

    it('⭐ la promoción va al final aunque venga primera en el catálogo (base = [promo, real])', () => {
      expect(buscarEnCatalogo(base, 'oreo')[0].b.codigo).toBe('10245');
    });

    it('⭐ si se teclea su clave EXACTA (con o sin ceros) la promoción va primero', () => {
      expect(lista('09089')[0]).toEqual(['09089', true]);
      expect(lista('9089')[0]).toEqual(['09089', true]);
    });

    it('⛔ [negativa] un producto real nunca se marca como promoción', () => {
      expect(buscarEnCatalogo(base, 'galleta').every((r) => r.esPromocion === false)).toBe(true);
    });
  });
});

describe('[VTK.17] lo que el checador del vendedor agrega: leer UN código, saber su presentación', () => {
  // Forma real del respaldo de prod (medida el 2026-11-09, sucursal 02): las casillas traen EAN y claves
  // internas mezcladas, y `bu` dice de qué presentación es cada una.
  const ticTac: RenglonRespaldo = {
    c: '00052', n: 'TIC TAC CANELA /12',
    b: ['CB1100052', '840004096513', '000052', 'CB3200052', 'C00052'],
    bu: ['PZA', 'PAQ', 'PZA', null, 'CJA'],
    u: [{ u: 'PZA', p: 8.78, s: 8.13, f: 1 }, { u: 'PAQ', p: 93.48, s: 86.56, f: 12 }, { u: 'CJA', p: 1057.11, s: 978.81, f: 144 }],
  };
  const otro: RenglonRespaldo = { c: '33259', n: 'PRODUCTO PRUEBA', b: ['7503008008816'], u: [{ u: 'PZA', p: 20 }] };
  const gemelo: RenglonRespaldo = { c: '33252', n: 'PRODUCTO GEMELO', b: ['7503008008816'], u: [{ u: 'PZA', p: 15 }] };
  const cat = [ticTac, otro, gemelo].map((x) => aBuscable(x, []));

  it('unidadesDelRespaldo: precio con IVA y factor; sin factor (respaldo viejo) queda en 1', () => {
    expect(unidadesDelRespaldo(ticTac)).toEqual([u('PZA', 8.78), u('PAQ', 93.48, 12), u('CJA', 1057.11, 144)]);
    expect(unidadesDelRespaldo(otro)).toEqual([u('PZA', 20)]);
    expect(unidadesDelRespaldo({})).toEqual([]);
  });

  it('⭐ la caja de 144 piezas en paquetes de 12 se dice «12 paquetes»', () => {
    const p = presentacionesDe(unidadesDelRespaldo(ticTac));
    expect(p[2].trae).toEqual({ n: 12, u: 'PAQ', palabra: 'paquetes' });
  });

  it('unidadDelCodigo: el EAN del paquete es del paquete; la clave sola no dice su unidad', () => {
    expect(unidadDelCodigo(ticTac, '840004096513')).toBe('PAQ');
    expect(unidadDelCodigo(ticTac, 'C00052')).toBe('CJA');
    expect(unidadDelCodigo(ticTac, '00052')).toBeNull();
  });

  it('⛔ [negativa] un código sin unidad (null) o con una unidad sin precio no afirma nada', () => {
    expect(unidadDelCodigo(ticTac, 'CB3200052')).toBeNull();
    expect(unidadDelCodigo({ b: ['X1'], bu: ['CJA'], u: [{ u: 'PZA', p: 1 }] }, 'X1')).toBeNull();
    expect(unidadDelCodigo(ticTac, '')).toBeNull();
  });

  it('productosPorCodigo: por EAN, por clave con y sin ceros', () => {
    expect(productosPorCodigo(cat, '840004096513').map((b) => b.codigo)).toEqual(['00052']);
    expect(productosPorCodigo(cat, '52').map((b) => b.codigo)).toEqual(['00052']);
    expect(productosPorCodigo(cat, '00052').map((b) => b.codigo)).toEqual(['00052']);
  });

  it('⭐ [TDA.9] un código en dos productos devuelve LOS DOS (quien llama lo declara ambiguo)', () => {
    expect(productosPorCodigo(cat, '7503008008816').map((b) => b.codigo)).toEqual(['33259', '33252']);
  });

  it('⛔ [negativa] un pedazo de código NO es una lectura: no devuelve parecidos', () => {
    expect(productosPorCodigo(cat, '84000409')).toEqual([]);
    expect(productosPorCodigo(cat, '99999')).toEqual([]);
    expect(productosPorCodigo(cat, '  ')).toEqual([]);
  });
});
