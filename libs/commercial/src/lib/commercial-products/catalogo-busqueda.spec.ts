import knexFactory from 'knex';
import {
  aplicarBusquedaCatalogo,
  normalizarBusqueda,
  palabrasDeBusqueda,
  razonDeCoincidencia,
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
