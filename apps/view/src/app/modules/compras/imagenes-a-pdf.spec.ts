import { esImagen, esPdf, separarArchivos } from './imagenes-a-pdf';

const f = (name: string, type = '') => ({ name, type });

describe('[RE.35.4] separar PDF y fotos', () => {
  it('reconoce PDF por tipo o por extensión', () => {
    expect(esPdf(f('a.pdf'))).toBe(true);
    expect(esPdf(f('sin-ext', 'application/pdf'))).toBe(true);
    expect(esPdf(f('foto.jpg', 'image/jpeg'))).toBe(false);
  });

  it('reconoce fotos por tipo o por extensión (incluye HEIC del iPhone, que a veces llega sin tipo)', () => {
    expect(esImagen(f('x', 'image/png'))).toBe(true);
    expect(esImagen(f('IMG_0001.HEIC'))).toBe(true);
    expect(esImagen(f('nota.txt', 'text/plain'))).toBe(false);
  });

  it('separa respetando el orden y deja fuera lo que no se puede leer', () => {
    const r = separarArchivos([f('1.jpg', 'image/jpeg'), f('a.pdf', 'application/pdf'), f('2.png', 'image/png'), f('x.docx')]);
    expect(r.pdfs.map((x) => x.name)).toEqual(['a.pdf']);
    expect(r.imagenes.map((x) => x.name)).toEqual(['1.jpg', '2.png']);
    expect(r.otros.map((x) => x.name)).toEqual(['x.docx']);
  });
});
