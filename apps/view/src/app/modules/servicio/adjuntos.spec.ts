import { avisoRechazados, esAceptable, revisarEnlace, separar, unirArchivos } from './adjuntos';

const f = (name: string, type: string) => ({ name, type });

describe('[MS.ADJ.3] adjuntos de la Mesa (pantalla)', () => {
  it('imágenes y PDF se aceptan', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf']) expect(esAceptable(f('a', t))).toBe(true);
  });

  it('⛔ NEGATIVA — Word, Excel, PowerPoint, zip, ejecutables y SVG NO se aceptan (D1)', () => {
    for (const t of [
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/x-msdownload', 'image/svg+xml', 'text/html',
    ]) expect(esAceptable(f('x', t))).toBe(false);
  });

  it('un archivo sin tipo (Windows con .heic) se juzga por extensión; el servidor igual valida por firma', () => {
    expect(esAceptable(f('IMG_1.HEIC', ''))).toBe(true);
    expect(esAceptable(f('oficio.pdf', ''))).toBe(true);
    expect(esAceptable(f('macro.xlsm', ''))).toBe(false);
    expect(esAceptable(f('Carpeta', ''))).toBe(false); // una carpeta soltada llega sin tipo y sin extensión
  });

  it('separar y el aviso: dicen qué se rechazó y a dónde ir', () => {
    const { buenos, malos } = separar([f('a.png', 'image/png'), f('b.docx', 'application/msword'), f('c.pdf', 'application/pdf')]);
    expect(buenos.map((x) => x.name)).toEqual(['a.png', 'c.pdf']);
    expect(avisoRechazados(malos)).toContain('b.docx');
    expect(avisoRechazados(malos)).toContain('enlace de Google');
    expect(avisoRechazados([1, 2, 3, 4, 5].map((n) => f(`n${n}`, 'x')))).toContain('y 2 más');
  });

  it('unirArchivos respeta el tope y avisa si tiró algo', () => {
    expect(unirArchivos([1, 2, 3], [4, 5], 5)).toEqual({ lista: [1, 2, 3, 4, 5], excedio: false });
    expect(unirArchivos([1, 2, 3, 4], [5, 6, 7], 5)).toEqual({ lista: [1, 2, 3, 4, 5], excedio: true });
  });

  it('enlace de Google válido', () => {
    const r = revisarEnlace('  https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit?usp=sharing ');
    expect(r.ok).toBe(true);
    expect(revisarEnlace('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view').ok).toBe(true);
  });

  it.each([
    ['vacío', ''],
    ['texto', 'mi hoja de cálculo'],
    ['http', 'http://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit'],
    ['otro dominio', 'https://evil.com/docs.google.com/document'],
    ['host por sufijo', 'https://docs.google.com.evil.com/document/d/1AbCdEfGhIjKlMnOp'],
    ['userinfo', 'https://docs.google.com@evil.com/document/d/1AbCdEfGhIjKlMnOp'],
    ['puerto', 'https://docs.google.com:8443/document/d/1AbCdEfGhIjKlMnOp'],
    ['javascript:', 'javascript:alert(1)'],
  ])('⛔ NEGATIVA — enlace no aceptado: %s', (_n, url) => {
    expect(revisarEnlace(url).ok).toBe(false);
  });
});
