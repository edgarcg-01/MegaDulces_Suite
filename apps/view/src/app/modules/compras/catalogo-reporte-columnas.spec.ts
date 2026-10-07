import { PriceReportRow } from '../comercial/comercial.service';
import {
  COLUMNAS_DEFAULT,
  COLUMNAS_REPORTE,
  ColumnaReporteId,
  celdaReporte,
  columnasElegidas,
  money,
} from './catalogo-reporte-columnas';

/**
 * `[CAT.7]` — **Cómo se escribe una celda de dinero en la hoja impresa.**
 *
 * Es el lugar donde se cuelan los errores que nadie ve hasta que el papel está sobre la mesa del
 * proveedor: un `$0.00` donde no hay dato, un mayoreo sin su umbral, un precio de caja mostrado
 * como si fuera de pieza. Todos salen de este archivo, así que todos se prueban acá.
 *
 * ⚠️ Postgres manda los `numeric` como **texto**. Las filas de estas pruebas usan strings a
 * propósito: es la forma en que el dato llega de verdad.
 */

const fila = (extra: Partial<PriceReportRow> = {}): PriceReportRow => ({
  product_id: 'p1',
  sku: '70002',
  nombre: 'LA ROSA MAZAPAN 12',
  activo: true,
  cost_base: null,
  supplier_id: 's1',
  supplier_name: 'DISTRIBUIDORA DE LA ROSA SA DE CV',
  brand_name: 'LA ROSA',
  sucursal: '01',
  unit_base: 'PAQ',
  content: null,
  barcode: '7501030470014',
  sold_by_kg: false,
  piece_price: null,
  wholesale_piece_min_qty: null,
  wholesale_piece_price: null,
  pack_size: null,
  pack_price: null,
  wholesale_pack_min_qty: null,
  wholesale_pack_price: null,
  box_size: null,
  box_price: null,
  computed_at: '2026-09-12T01:32:16.492Z',
  ...extra,
});

describe('[CAT.7] money — el formato del dinero', () => {
  it('formatea un numeric de Postgres (texto) como moneda mexicana', () => {
    // Se compara sin el espacio raro que Intl mete entre símbolo y cifra en algunos runtimes.
    expect(money('32.7600')?.replace(/\s/g, ' ')).toContain('32.76');
    expect(money('32.7600')).toMatch(/^\$/);
  });

  it('⛔ lo que no hay devuelve null — nunca un cero', () => {
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
    expect(money('')).toBeNull();
    expect(money('vacío')).toBeNull();
  });

  it('un cero explícito SÍ se formatea: es un dato, no una ausencia', () => {
    expect(money('0')).toContain('0.00');
  });
});

describe('[CAT.7] celdaReporte — cada apartado dice lo que afirma', () => {
  it('⛔ un renglón sin nada de precio sale con guion en TODAS las columnas de precio', () => {
    const r = fila();
    const precios: ColumnaReporteId[] = ['precio_unidad', 'mayoreo_unidad', 'paquete', 'mayoreo_paquete', 'caja', 'costo'];
    for (const id of precios) expect(celdaReporte(r, id)).toBe('—');
  });

  it('el precio de la unidad base sale tal cual, y la unidad viaja en su propia columna', () => {
    const r = fila({ piece_price: '32.7600', unit_base: 'PAQ' });
    expect(celdaReporte(r, 'precio_unidad')).toContain('32.76');
    // La cifra no se renombra según la unidad: eso mentiría en los SKUs con base PAQ.
    expect(celdaReporte(r, 'unidad')).toBe('PAQ');
  });

  it('el mayoreo lleva SU umbral: sin el "desde N" el precio no se puede cobrar', () => {
    const r = fila({ wholesale_piece_price: '2.3000', wholesale_piece_min_qty: 10 });
    expect(celdaReporte(r, 'mayoreo_unidad')).toMatch(/2\.30.*desde 10/);
  });

  it('⛔ mayoreo CON precio y SIN umbral se declara, no se le inventa un "desde 3"', () => {
    const r = fila({ wholesale_pack_price: '101.1500', wholesale_pack_min_qty: null });
    expect(celdaReporte(r, 'mayoreo_paquete')).toContain('sin mínimo declarado');
    expect(celdaReporte(r, 'mayoreo_paquete')).toContain('101.15');
  });

  it('un umbral de 1 no es mayoreo: se trata como si no hubiera umbral', () => {
    const r = fila({ wholesale_piece_price: '2.3000', wholesale_piece_min_qty: 1 });
    expect(celdaReporte(r, 'mayoreo_unidad')).toContain('sin mínimo declarado');
  });

  it('paquete y caja llevan cuántas piezas traen — si no, la cifra no es comparable', () => {
    const r = fila({ pack_price: '17.5600', pack_size: 8, box_price: '813.4400', box_size: 400 });
    expect(celdaReporte(r, 'paquete')).toMatch(/17\.56.*8 pz/);
    expect(celdaReporte(r, 'caja')).toMatch(/813\.44.*400 pz/);
  });

  it('un bulto con precio pero sin tamaño muestra el precio solo, sin inventar el contenido', () => {
    const r = fila({ box_price: '813.4400', box_size: null });
    expect(celdaReporte(r, 'caja')).toContain('813.44');
    expect(celdaReporte(r, 'caja')).not.toContain('pz');
  });

  it('⛔ un tamaño sin precio NO pinta una celda: sin precio no hay nada que reportar', () => {
    const r = fila({ pack_price: null, pack_size: 8 });
    expect(celdaReporte(r, 'paquete')).toBe('—');
  });

  it('las columnas de identidad vacías también salen con guion', () => {
    const r = fila({ sku: null, barcode: null, brand_name: null, content: null, unit_base: null });
    for (const id of ['sku', 'barcode', 'marca', 'contenido', 'unidad'] as ColumnaReporteId[]) {
      expect(celdaReporte(r, id)).toBe('—');
    }
  });
});

describe('[CAT.7] el catálogo de apartados', () => {
  it('el costo NO viene tildado por default: es la cifra que no puede terminar frente al proveedor', () => {
    expect(COLUMNAS_DEFAULT).not.toContain('costo');
  });

  it('por default vienen los cinco apartados de precio + con qué unidad leerlos', () => {
    expect(COLUMNAS_DEFAULT).toEqual(
      expect.arrayContaining(['unidad', 'precio_unidad', 'mayoreo_unidad', 'paquete', 'mayoreo_paquete', 'caja']),
    );
  });

  it('todas las columnas del default existen en el catálogo (nadie tildó un id fantasma)', () => {
    const ids = new Set(COLUMNAS_REPORTE.map((c) => c.id));
    for (const id of COLUMNAS_DEFAULT) expect(ids.has(id)).toBe(true);
  });

  it('cada apartado tiene ayuda escrita: una columna de dinero sin explicar su unidad no se publica', () => {
    for (const c of COLUMNAS_REPORTE) expect(c.ayuda.length).toBeGreaterThan(10);
  });

  it('las columnas se imprimen en el orden del catálogo, no en el orden en que se tildaron', () => {
    const elegidas = columnasElegidas(['caja', 'sku', 'precio_unidad']);
    expect(elegidas.map((c) => c.id)).toEqual(['sku', 'precio_unidad', 'caja']);
  });

  it('todo apartado de precio o costo se alinea a la derecha (cifras tabulares)', () => {
    for (const c of COLUMNAS_REPORTE) {
      if (c.grupo !== 'identidad') expect(c.num).toBe(true);
    }
  });
});
