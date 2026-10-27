import { nombreDeAdjunto } from './nombre-adjunto';

describe('[MS.ADJ.1.1/1.2] nombreDeAdjunto: el nombre dice lo que el archivo ES', () => {
  it('lo normal queda igual', () => {
    expect(nombreDeAdjunto('captura.png', 'image/png')).toBe('captura.png');
    expect(nombreDeAdjunto('Oficio 2026.PDF', 'application/pdf')).toBe('Oficio 2026.PDF');
    expect(nombreDeAdjunto('foto.jpeg', 'image/jpeg')).toBe('foto.jpeg');
    expect(nombreDeAdjunto('IMG_0001.HEIC', 'image/heic')).toBe('IMG_0001.HEIC');
  });

  it('un nombre sin extensión recibe la del tipo (la clave del bucket sale de aquí)', () => {
    expect(nombreDeAdjunto('captura', 'image/png')).toBe('captura.png');
    expect(nombreDeAdjunto('image', 'image/jpeg')).toBe('image.jpg');
    expect(nombreDeAdjunto('reporte.final', 'application/pdf')).toBe('reporte.final.pdf');
  });

  it('⛔ NEGATIVA — una extensión peligrosa al final se quita: `foto.exe` con bytes de JPEG se guarda como `.jpg`', () => {
    expect(nombreDeAdjunto('foto.exe', 'image/jpeg')).toBe('foto.jpg');
    expect(nombreDeAdjunto('factura.pdf.exe', 'application/pdf')).toBe('factura.pdf');
    expect(nombreDeAdjunto('atajo.lnk.png', 'image/png')).toBe('atajo.lnk.png'); // la peligrosa NO está al final: el nombre termina en lo que es
    expect(nombreDeAdjunto('a.bat.cmd', 'application/pdf')).toBe('a.pdf');
    expect(nombreDeAdjunto('pagina.html', 'image/png')).toBe('pagina.png');
  });

  it('⛔ NEGATIVA — una extensión de OTRO tipo no se deja pasar: se agrega la correcta', () => {
    expect(nombreDeAdjunto('reporte.docx', 'application/pdf')).toBe('reporte.docx.pdf');
    expect(nombreDeAdjunto('foto.png', 'image/jpeg')).toBe('foto.png.jpg');
  });

  it('⛔ NEGATIVA — los caracteres de dirección Unicode se quitan: `reporte<RLO>fdp.exe` ya no se lee al revés', () => {
    const c = (n: number): string => String.fromCharCode(n);
    const RLO = c(0x202e);
    const r = nombreDeAdjunto(`reporte${RLO}fdp.exe`, 'application/pdf');
    expect(r).not.toContain(RLO);
    expect(r).toBe('reportefdp.pdf'); // el .exe cae por peligroso; la extensión es la del tipo
    expect(nombreDeAdjunto(`a${c(0x200b)}b${c(0x200f)}.png`, 'image/png')).toBe('ab.png'); // ancho cero y marca de dirección
    expect(nombreDeAdjunto(`${c(0xfeff)}notas.pdf`, 'application/pdf')).toBe('notas.pdf'); // BOM
  });

  it('un nombre vacío o que se queda sin nada recibe uno por omisión', () => {
    expect(nombreDeAdjunto('', 'application/pdf')).toBe('adjunto.pdf');
    expect(nombreDeAdjunto('   ', 'image/png')).toBe('adjunto.png');
    expect(nombreDeAdjunto('.exe', 'image/png')).toBe('adjunto.png');
    expect(nombreDeAdjunto(String.fromCharCode(0x202e), 'image/jpeg')).toBe('adjunto.jpg');
  });
});
