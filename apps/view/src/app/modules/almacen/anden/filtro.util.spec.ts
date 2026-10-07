import { coincide, filtrar, normalizar } from './filtro.util';

describe('normalizar', () => {
  it('baja a minúsculas y quita acentos', () => {
    expect(normalizar('Mazapán')).toBe('mazapan');
    expect(normalizar('  OBLEAS con Cajeta  ')).toBe('obleas con cajeta');
  });

  it('tolera nulos sin lanzar', () => {
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
  });
});

describe('coincide — la barra busca por nombre, SKU y rack', () => {
  const it1 = { nombre: 'Mazapán De la Rosa 28g', sku: '00052', barcode: '7501030470014', rack: 'R04-N02-A' };

  it('encuentra sin acento y sin mayúsculas', () => {
    expect(coincide(it1, 'mazapan')).toBe(true);
    expect(coincide(it1, 'MAZAPÁN')).toBe(true);
  });

  it('encuentra por SKU y por código de barras — es lo que dispara la pistola', () => {
    expect(coincide(it1, '00052')).toBe(true);
    expect(coincide(it1, '7501030470014')).toBe(true);
  });

  it('encuentra por rack: ver todo lo que va a R04 y caminar una sola vez', () => {
    expect(coincide(it1, 'R04')).toBe(true);
    expect(coincide(it1, 'r04-n02')).toBe(true);
  });

  it('varias palabras acotan (AND), no amplían', () => {
    expect(coincide(it1, 'mazapan 28')).toBe(true);
    expect(coincide(it1, 'mazapan pulparindo')).toBe(false);
  });

  it('consulta vacía no filtra', () => {
    expect(coincide(it1, '')).toBe(true);
    expect(coincide(it1, '   ')).toBe(true);
  });

  it('no inventa coincidencias', () => {
    expect(coincide(it1, 'bocadin')).toBe(false);
  });
});

describe('filtrar', () => {
  const items = [
    { nombre: 'Mazapán De la Rosa 28g', sku: '00052', rack: 'R04-N02-A' },
    { nombre: 'Pulparindo Enchilado 14g', sku: '00303', rack: 'R04-N03-C' },
    { nombre: 'Bocadín Chocolate 12g', sku: '00384', rack: 'R07-N01-B' },
  ];

  it('devuelve todo si no hay consulta', () => {
    expect(filtrar(items, '').length).toBe(3);
  });

  it('un código completo deja UNA sola: eso es lo que permite que Enter la abra', () => {
    expect(filtrar(items, '00303').length).toBe(1);
  });

  it('por rack agrupa lo que va al mismo pasillo', () => {
    expect(filtrar(items, 'R04').length).toBe(2);
  });

  it('sin coincidencias devuelve vacío, no todo', () => {
    expect(filtrar(items, 'zzz').length).toBe(0);
  });
});
