// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { LECTURA_FOTO_VERSION, NOMBRES_CAMPOS, type CampoPropuesto, type PropuestaAmpliada } from './lectura-foto.contract';
import { construirDiccionario, normalizarClave } from './diccionario';

const cp = <T>(valor: T): CampoPropuesto<T> => ({ valor, confianza: 'alta', evidencia: String(valor), de_cara: 'frente', conflicto: null });

const propuesta = (campos: Partial<PropuestaAmpliada['campos']>): PropuestaAmpliada => ({
  version: LECTURA_FOTO_VERSION, caras_leidas: ['frente'], nivel_fisico: null, persona_visible: false, rostro_visible: false,
  campos: { ...(Object.fromEntries(NOMBRES_CAMPOS.map((k) => [k, null])) as PropuestaAmpliada['campos']), ...campos },
});

describe('normalizarClave', () => {
  it('minúsculas, sin acentos (ñ→n) y sólo letras y dígitos', () => {
    expect(normalizarClave('Bon o Bon')).toBe('bonobon');
    expect(normalizarClave('BON O BON')).toBe('bonobon');
    expect(normalizarClave('Bonobon')).toBe('bonobon');
    expect(normalizarClave('Edición Especial')).toBe('edicionespecial');
    expect(normalizarClave('Piñata 2x1!')).toBe('pinata2x1');
    expect(normalizarClave('  ')).toBe('');
    expect(normalizarClave(null)).toBe('');
  });
});

describe('construirDiccionario', () => {
  const fichas = [
    { sku: '95805', propuesta: propuesta({
      marca: cp('Bon o Bon'), fabricante: cp('Arcor / Mundo Dulce S.A. de C.V.'), variante: cp('Fresa'),
      sellos_nom051: cp(['EXCESO CALORÍAS', 'EXCESO AZÚCARES'] as never), alergenos: cp(['leche', 'trigo', 'soya'] as never),
      alergenos_otros: cp(['colorante rojo 40']), empaque: cp({ tipo: 'caja de cartón', material: 'PAP 21', colores: [] }),
    }) },
    { sku: '95806', propuesta: propuesta({
      marca: cp('BON O BON'), variante: cp('fresa'),
      sellos_nom051: cp(['EXCESO CALORÍAS'] as never), alergenos: cp(['leche'] as never),
      empaque: cp({ tipo: 'Caja de cartón', material: null, colores: [] }),
    }) },
    { sku: '95807', propuesta: propuesta({ marca: cp('Bonobon'), variante: cp('Chocolate'), alergenos: cp(['leche', 'leche'] as never) }) },
    // El mismo SKU otra vez (dos lecturas de la misma ficha): cuenta UNA vez en sellos/alérgenos y en skus.
    { sku: '95805', propuesta: propuesta({ marca: cp('Bon o Bon'), sellos_nom051: cp(['EXCESO CALORÍAS'] as never) }) },
    { sku: '02020', propuesta: propuesta({ marca: cp('Trident'), denominacion: cp('Goma de mascar') }) },
  ];
  const d = construirDiccionario(fichas);

  it('⭐ «Bon o Bon», «BON O BON» y «Bonobon» → UNA entrada con 3 formas', () => {
    const bon = d.marcas.find((m) => m.clave === 'bonobon');
    expect(bon).toBeDefined();
    expect(bon?.formas).toEqual([
      { texto: 'Bon o Bon', veces: 2 },
      { texto: 'BON O BON', veces: 1 },
      { texto: 'Bonobon', veces: 1 },
    ]);
    expect(bon?.forma_principal).toBe('Bon o Bon');
    expect(bon?.skus).toEqual(['95805', '95806', '95807']); // SKUs distintos, no fichas
  });

  it('listas ordenadas por cantidad de SKUs (desc)', () => {
    expect(d.marcas.map((m) => m.clave)).toEqual(['bonobon', 'trident']);
    expect(d.variantes.map((v) => [v.clave, v.skus.length])).toEqual([['fresa', 2], ['chocolate', 1]]);
    expect(d.tipos_empaque[0]).toMatchObject({ clave: 'cajadecarton', skus: ['95805', '95806'] });
    expect(d.denominaciones[0].forma_principal).toBe('Goma de mascar');
    expect(d.fabricantes).toHaveLength(1);
  });

  it('empate de forma más vista → la primera que apareció', () => {
    const x = construirDiccionario([
      { sku: '1', propuesta: propuesta({ variante: cp('FRESA') }) },
      { sku: '2', propuesta: propuesta({ variante: cp('Fresa') }) },
    ]);
    expect(x.variantes[0].forma_principal).toBe('FRESA');
  });

  it('sellos / alérgenos cuentan SKUs (no fotos ni fichas repetidas), con la lista cerrada completa', () => {
    expect(d.sellos['EXCESO CALORÍAS']).toBe(2); // 95805 (dos fichas) + 95806
    expect(d.sellos['EXCESO AZÚCARES']).toBe(1);
    expect(d.sellos['EXCESO SODIO']).toBe(0); // medido sobre las fichas leídas, no faltante
    expect(Object.keys(d.sellos)[0]).toBe('EXCESO CALORÍAS'); // el más frecuente primero
    expect(d.alergenos['leche']).toBe(3);
    expect(d.alergenos['soya']).toBe(1);
    expect(d.leyendas['CONTIENE CAFEÍNA - EVITAR EN NIÑOS']).toBe(0);
    expect(d.alergenos_otros.map((a) => a.forma_principal)).toEqual(['colorante rojo 40']);
  });

  it('fichas_leidas y versión', () => {
    expect(d.fichas_leidas).toBe(5);
    expect(d.version).toBe(LECTURA_FOTO_VERSION);
  });

  it('sin fichas: diccionario vacío, las listas cerradas en 0', () => {
    const v = construirDiccionario([]);
    expect(v.marcas).toEqual([]);
    expect(v.fichas_leidas).toBe(0);
    expect(Object.values(v.alergenos).every((n) => n === 0)).toBe(true);
  });
});
