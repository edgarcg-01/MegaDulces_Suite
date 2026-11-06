import knexFactory from 'knex';
import { PATRON_DESCONTINUADO_PG, PATRON_PROMOCION_PG } from '@megadulces/contracts';
import {
  aplicarBusquedaCatalogo,
  claveDeOrdenCatalogo,
  nombreParaOrden,
  normalizarBusqueda,
  ordenListaCatalogo,
  ordenarComoLaLista,
  palabrasDeBusqueda,
  razonDeCoincidencia,
  type FilaParaOrden,
} from './catalogo-busqueda';

/**
 * Buscador de Compras › Catálogo. Lo que estas pruebas impiden que vuelva:
 *  - «mazapan rosa» = 0 porque el nombre dice «LA ROSA MAZAPAN /30» (orden de palabras).
 *  - «pina» = 11 contra 181 de «piña» (acentos y ñ).
 *  - códigos de barras secundarios, proveedor y unidad invisibles para el buscador.
 *  - texto del usuario concatenado en el SQL (debe viajar como binding).
 */

const db = knexFactory({ client: 'pg' });
const base = () => db('catalog.products as p').select('p.id');

describe('normalización', () => {
  it('quita acentos y ñ como f_unaccent(lower())', () => {
    expect(normalizarBusqueda('  PIÑA Mazapán  ')).toBe('pina mazapan');
    expect(palabrasDeBusqueda('mazapan   rosa')).toEqual(['mazapan', 'rosa']);
    expect(palabrasDeBusqueda('   ')).toEqual([]);
    expect(palabrasDeBusqueda(null)).toEqual([]);
  });
});

describe('aplicarBusquedaCatalogo — SQL generado', () => {
  it('texto vacío o sólo espacios no filtra', () => {
    const sinFiltro = base().toSQL().sql;
    expect(aplicarBusquedaCatalogo(base(), '').toSQL().sql).toBe(sinFiltro);
    expect(aplicarBusquedaCatalogo(base(), '   ').toSQL().sql).toBe(sinFiltro);
    expect(aplicarBusquedaCatalogo(base(), undefined).toSQL().sql).toBe(sinFiltro);
  });

  it('palabras en desorden: una condición AND por palabra, con f_unaccent', () => {
    const { sql, bindings } = aplicarBusquedaCatalogo(base(), 'mazapan rosa').toSQL();
    expect(sql).toContain('public.f_unaccent(lower(concat_ws(');
    expect(sql.match(/LIKE \?/g)!.length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/\) and \(/i); // dos grupos unidos por AND
    expect(bindings).toContain('%mazapan%');
    expect(bindings).toContain('%rosa%');
  });

  it('«piña» se busca como «pina» (el binding va sin ñ)', () => {
    const { bindings } = aplicarBusquedaCatalogo(base(), 'PIÑA').toSQL();
    expect(bindings).toContain('%pina%');
    expect(bindings).not.toContain('%piña%');
  });

  it('palabra con dígitos busca en TODOS los códigos (product_barcodes activos)', () => {
    const { sql, bindings } = aplicarBusquedaCatalogo(base(), '4510000170833').toSQL();
    expect(sql).toContain('catalog.product_barcodes pb');
    expect(sql).toContain('pb.deleted_at IS NULL');
    expect(bindings).toContain('%4510000170833%');
  });

  it('palabra sin dígitos NO paga la subconsulta de códigos', () => {
    const { sql } = aplicarBusquedaCatalogo(base(), 'rosa').toSQL();
    expect(sql).not.toContain('product_barcodes');
  });

  it('proveedor: por EXISTS sin join, o por s.name con conProveedor', () => {
    const sinJoin = aplicarBusquedaCatalogo(base(), 'ricolino').toSQL().sql;
    expect(sinJoin).toContain('catalog.suppliers spb');
    const conJoin = aplicarBusquedaCatalogo(
      base().leftJoin('catalog.suppliers as s', 's.id', 'p.supplier_id'),
      'ricolino',
      { conProveedor: true },
    ).toSQL().sql;
    expect(conJoin).toContain('s.name');
    expect(conJoin).not.toContain('catalog.suppliers spb');
  });

  it('«cajas» busca la unidad CJA en la escalera u1/u2/u3', () => {
    const { sql, bindings } = aplicarBusquedaCatalogo(base(), 'cajas').toSQL();
    expect(sql).toContain('analytics.v_kepler_unit_ladder ul');
    expect(sql).toContain('(ul.u1_label, ul.u2_label, ul.u3_label)');
    expect(bindings).toContain('CJA');
  });

  it('una palabra que no es unidad no consulta la escalera', () => {
    expect(aplicarBusquedaCatalogo(base(), 'mazapan').toSQL().sql).not.toContain('v_kepler_unit_ladder');
  });

  it('NEGATIVA: el texto del usuario nunca aparece en el SQL, sólo en bindings', () => {
    const malicioso = "x'); DROP TABLE catalog.products; --";
    const { sql, bindings } = aplicarBusquedaCatalogo(base(), malicioso).toSQL();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain("x'");
    expect(bindings.some((b) => String(b).includes('drop'))).toBe(true);
  });

  it('escapa comodines de LIKE: «50%» se busca literal', () => {
    const { bindings } = aplicarBusquedaCatalogo(base(), '50%').toSQL();
    expect(bindings).toContain('%50\\%%');
  });
});

describe('razonDeCoincidencia', () => {
  const rosa = {
    nombre: 'LA ROSA MAZAPAN /30',
    sku: '07300',
    descripcion: null,
    codigos: ['7501100100015', '4510000170833'],
    codigoPrincipal: '7501100100015',
    proveedor: 'DULCES DE LA ROSA SA DE CV',
    unidades: ['PZA', 'CJA'],
  };

  it('sin texto → null', () => {
    expect(razonDeCoincidencia(rosa, '')).toBeNull();
    expect(razonDeCoincidencia(rosa, '   ')).toBeNull();
  });

  it('palabras en desorden dentro del nombre → null (no hace falta explicar)', () => {
    expect(razonDeCoincidencia(rosa, 'mazapan rosa')).toBeNull();
  });

  it('acentos y ñ: «pina» coincide con «PIÑA» por nombre', () => {
    expect(razonDeCoincidencia({ nombre: 'PALETA PIÑA ENCHILADA', sku: '1', codigos: [] }, 'pina')).toBeNull();
    expect(razonDeCoincidencia({ nombre: 'PALETA PIÑA', sku: null, codigos: [] }, 'piña xyz')).toBeNull(); // xyz no coincide
  });

  it('SKU', () => {
    expect(razonDeCoincidencia(rosa, '07300')).toBe('SKU');
  });

  it('código principal vs código adicional', () => {
    expect(razonDeCoincidencia(rosa, '7501100100015')).toBe('código de barras');
    expect(razonDeCoincidencia(rosa, '4510000170833')).toBe('código de barras adicional 4510000170833');
  });

  it('proveedor', () => {
    const p = { ...rosa, nombre: 'MAZAPAN /30', proveedor: 'DE LA ROSA' };
    expect(razonDeCoincidencia(p, 'mazapan rosa')).toBe('proveedor');
  });

  it('unidad «caja» → se maneja en CJA, combinada con nombre', () => {
    expect(razonDeCoincidencia(rosa, 'mazapan caja')).toBe('se maneja en CJA');
  });

  it('varias razones se unen con « · »', () => {
    expect(razonDeCoincidencia(rosa, '07300 4510000170833')).toBe(
      'SKU · código de barras adicional 4510000170833',
    );
  });

  it('NEGATIVA: «caja» no coincide si el producto no se maneja en caja', () => {
    expect(razonDeCoincidencia({ ...rosa, unidades: ['PZA'] }, 'mazapan caja')).toBeNull();
    expect(razonDeCoincidencia(rosa, 'chocolate')).toBeNull();
  });
});

/**
 * `[PF.12.1]` El orden por omisión de la lista Sencillo: lo vendible primero.
 *
 * Lo que impide que vuelva (medido en prod el 2026-10-29): una primera página con 49 de 50 renglones que no
 * son mercancía (`***`, `.`, promociones «= GRATIS», sin SKU ni unidades), y buscar «70001» con el 70001
 * detrás de los productos cuyo código de barras CONTIENE 70001.
 */
describe('ordenListaCatalogo — SQL', () => {
  it('sin texto: sin llave de coincidencia exacta; los únicos bindings son las reglas de promoción y de descontinuado del contrato', () => {
    const o = ordenListaCatalogo('', true);
    expect(o.sql).not.toContain('btrim(p.sku) = ?');
    expect(o.bindings).toEqual([PATRON_PROMOCION_PG, PATRON_DESCONTINUADO_PG]);
    expect(ordenListaCatalogo('   ', true).bindings).toEqual([PATRON_PROMOCION_PG, PATRON_DESCONTINUADO_PG]);
  });

  it('con texto: la PRIMERA llave es la coincidencia exacta por SKU o código principal, y el texto viaja recortado', () => {
    const o = ordenListaCatalogo('  70001 ', true);
    expect(o.llaves[0]).toBe('CASE WHEN btrim(p.sku) = ? OR btrim(p.barcode) = ? THEN 0 ELSE 1 END');
    expect(o.bindings).toEqual(['70001', '70001', PATRON_PROMOCION_PG, PATRON_DESCONTINUADO_PG]);
  });

  it('las llaves van en el orden pedido: exacta · SKU · letras · promoción · unidades · nombre · id', () => {
    const o = ordenListaCatalogo('x', true);
    const pos = (s: string) => o.llaves.findIndex((l) => l.includes(s));
    const orden = [pos('btrim(p.sku) = ?'), pos("nullif(btrim(p.sku), '')"), pos('[[:alpha:]]'), pos('~* ?'), pos('sp.con_unidades'), pos('f_unaccent'), pos('p.id')];
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(o.llaves[o.llaves.length - 1]).toBe('p.id');
    expect(o.sql).toContain('COLLATE "C"');
  });

  it('⛔ [negativa] sin precio por sucursal NO se une `sp`: la llave «con unidades» no aplica (no se inventa)', () => {
    expect(ordenListaCatalogo('x', false).sql).not.toContain('sp.');
    expect(ordenListaCatalogo('x', true).sql).toContain('sp.con_unidades');
  });

  it('⛔ [negativa] la regla de promoción NO se copia en el SQL: viaja como binding desde el contrato', () => {
    const o = ordenListaCatalogo('', true);
    expect(o.sql).not.toMatch(/GRATIS|DESCONTINUAD/i);
    expect(o.bindings).toContain(PATRON_PROMOCION_PG);
    expect(o.bindings).toContain(PATRON_DESCONTINUADO_PG);
  });

  it('⛔ [negativa] el texto del usuario nunca aparece en el SQL, sólo en bindings', () => {
    const malicioso = "70001' OR 1=1; DROP TABLE catalog.products; --";
    const o = ordenListaCatalogo(malicioso, true);
    expect(o.sql).not.toContain('DROP TABLE');
    expect(o.sql).not.toContain("70001'");
    expect(o.bindings[0]).toBe(malicioso);
  });

  it('sólo ORDENA: no filtra, no une, no limita (los conteos y el total no pueden cambiar por él)', () => {
    for (const o of [ordenListaCatalogo('', true), ordenListaCatalogo('70001', false)]) {
      expect(o.sql).not.toMatch(/\b(WHERE|JOIN|LIMIT|OFFSET|HAVING|GROUP BY|FILTER)\b/i);
    }
  });

  it('knex lo acepta con sus bindings (un «?» por binding, ninguno suelto en las expresiones regulares)', () => {
    for (const [texto, con] of [['', true], ['70001', true], ['oreo', false]] as const) {
      const o = ordenListaCatalogo(texto, con);
      expect(o.sql.split('?').length - 1).toBe(o.bindings.length);
      const nativo = db('catalog.products as p').select('p.id').orderByRaw(o.sql, o.bindings).toSQL().toNative();
      expect(nativo.bindings).toHaveLength(o.bindings.length);
      expect(nativo.sql).toContain(`order by CASE`);
    }
  });

  it('su testigo en JS tiene una llave por cada llave del SQL (si cambia una, la prueba obliga a cambiar la otra)', () => {
    const f: FilaParaOrden = { id: 'a', sku: '1', barcode: null, nombre: 'X', conUnidades: true };
    for (const [texto, con] of [['', false], ['', true], ['70001', false], ['70001', true]] as const) {
      // la llave 6 del SQL son dos expresiones (nombre e id), igual que en JS
      expect(claveDeOrdenCatalogo(f, texto, con)).toHaveLength(ordenListaCatalogo(texto, con).llaves.length);
    }
  });
});

describe('ordenarComoLaLista — el orden con datos de ejemplo (testigo de la consulta)', () => {
  const fila = (id: string, sku: string | null, nombre: string, extra: Partial<FilaParaOrden> = {}): FilaParaOrden => ({
    id, sku, barcode: null, nombre, conUnidades: true, ...extra,
  });
  const ACEITE = fila('01', '99001', 'ACEITE 1-2-3 /1L');
  const BOMBON = fila('02', '12000', 'BOMBÓN MINI /50');
  const CHILES = fila('03', '99099', 'CHILES JALAPEÑOS LA MORENA /2.80KG', { barcode: '7501700010014' });
  const ROSA = fila('04', '70001', 'LA ROSA MAZAPAN /30');
  const SIN_UNIDADES = fila('05', '10001', 'AGUA SIN ESCALERA', { conUnidades: false });
  const PROMO = fila('06', '09089', '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS');
  const ASTERISCOS = fila('07', '00001', '***');
  const PUNTO = fila('08', '00002', '.');
  const SIN_SKU = fila('09', null, 'ABARROTES SIN CLAVE');
  const SIN_SKU_VACIO = fila('10', '   ', 'ZAPOTE');
  // [PF.20] Kepler reemplaza el nombre por «* DESCONTINUADO»: con precio real, pero no es lo que se busca primero.
  const DESCONTINUADO = fila('11', '89063', '* DESCONTINUADO');
  const TODAS = [PUNTO, SIN_SKU, PROMO, DESCONTINUADO, ROSA, ASTERISCOS, SIN_UNIDADES, CHILES, SIN_SKU_VACIO, BOMBON, ACEITE];

  it('⭐ sin búsqueda: mercancía primero; luego sin unidades, promoción y descontinuado, sin letras y al final sin SKU', () => {
    expect(ordenarComoLaLista(TODAS, '', true).map((f) => f.nombre)).toEqual([
      'ACEITE 1-2-3 /1L',
      'BOMBÓN MINI /50',
      'CHILES JALAPEÑOS LA MORENA /2.80KG',
      'LA ROSA MAZAPAN /30',
      'AGUA SIN ESCALERA', // sin unidades
      '10 CJS OREO BASE 9 KG = GRATIS 1 CJ MAS', // promoción
      '* DESCONTINUADO', // descontinuado: con las promociones (decide el nombre sin signos)
      '***', // sin letras (empatan: decide el id)
      '.',
      'ABARROTES SIN CLAVE', // sin SKU
      'ZAPOTE', // SKU de puros espacios = sin SKU
    ]);
  });

  it('⭐ buscar «70001»: el SKU exacto va primero aunque su código de barras no y su nombre ordene después', () => {
    // El código de CHILES contiene 70001 (por eso coincide) pero no ES 70001.
    const r = ordenarComoLaLista([CHILES, ROSA], '70001', true).map((f) => f.sku);
    expect(r).toEqual(['70001', '99099']);
  });

  it('buscar un código de barras principal completo también lo pone primero', () => {
    const r = ordenarComoLaLista([ROSA, CHILES], ' 7501700010014 ', true).map((f) => f.sku);
    expect(r).toEqual(['99099', '70001']);
  });

  it('el nombre se compara sin signos al inicio, sin acentos y en minúsculas', () => {
    expect(nombreParaOrden('*** ÁCIDO Ñoño')).toBe('acido nono');
    expect(nombreParaOrden('$1,500.00 MERCA')).toBe('1,500.00 merca');
    expect(nombreParaOrden(null)).toBe('');
    const r = ordenarComoLaLista([fila('b', '2', 'BOTANA'), fila('a', '1', '¡ÁRBOL!'), fila('c', '3', 'avena')], '', true);
    expect(r.map((f) => f.id)).toEqual(['a', 'c', 'b']); // árbol < avena < botana: el «¡» y la tilde no cuentan
  });

  it('⛔ [negativa] sin precio por sucursal, «sin unidades» NO reordena: decide el nombre', () => {
    const r = ordenarComoLaLista([fila('1', '1', 'BETA'), fila('2', '2', 'ALFA', { conUnidades: false })], '', false);
    expect(r.map((f) => f.nombre)).toEqual(['ALFA', 'BETA']);
  });

  it('⛔ [negativa] coincidir por CONTENER el texto no es coincidencia exacta', () => {
    const contiene = fila('1', '170001', 'AAA');
    const igual = fila('2', '70001', 'ZZZ');
    expect(claveDeOrdenCatalogo(contiene, '70001', true)[0]).toBe(1);
    expect(ordenarComoLaLista([contiene, igual], '70001', true).map((f) => f.sku)).toEqual(['70001', '170001']);
  });

  it('sólo ordena: devuelve los mismos renglones, ni uno más ni uno menos', () => {
    const r = ordenarComoLaLista(TODAS, '', true);
    expect(r).toHaveLength(TODAS.length);
    expect(new Set(r)).toEqual(new Set(TODAS));
  });
});
