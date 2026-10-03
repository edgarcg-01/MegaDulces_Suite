import { LADO_MAX, UMBRAL_BYTES, debeOptimizar, esOptimizable, ladoEscalado, nombreJpg, optimizarImagen, optimizarImagenes } from './image-compress';

/**
 * `[MS.3.12]` Las fotos de campo se achican antes de subirlas. Lo que se defiende: sólo se toca lo que hace falta
 * (imagen optimizable que pasa del umbral), nunca se agranda, y **nunca se pierde un archivo** por no haberlo podido
 * optimizar. (La parte que decodifica y dibuja necesita un navegador de verdad: se midió en Chromium.)
 */
const archivo = (nombre: string, tipo: string, bytes: number): File => new File([new Uint8Array(bytes)], nombre, { type: tipo });

describe('MS.3.12 · esOptimizable', () => {
  it('fotos sí; GIF (puede estar animado) y PDF no', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'IMAGE/JPEG']) expect(esOptimizable(t)).toBe(true);
    for (const t of ['image/gif', 'application/pdf', 'text/html', '']) expect(esOptimizable(t)).toBe(false);
  });
});

describe('MS.3.12 · ladoEscalado', () => {
  it('⭐ una foto de 48 MP (8000×6000) baja a 2560 de lado largo conservando la proporción', () => {
    expect(ladoEscalado(8000, 6000)).toEqual({ w: LADO_MAX, h: 1920 });
    expect(ladoEscalado(6000, 8000)).toEqual({ w: 1920, h: LADO_MAX });
  });
  it('⛔ NEGATIVA — NUNCA agranda: una imagen más chica queda igual', () => {
    expect(ladoEscalado(1280, 720)).toEqual({ w: 1280, h: 720 });
    expect(ladoEscalado(LADO_MAX, 100)).toEqual({ w: LADO_MAX, h: 100 });
  });
  it('dimensiones inválidas no se tocan ni dividen entre cero', () => {
    expect(ladoEscalado(0, 5000)).toEqual({ w: 0, h: 5000 });
    expect(ladoEscalado(-1, -1)).toEqual({ w: -1, h: -1 });
  });
  it('un lado nunca se redondea a cero', () => {
    expect(ladoEscalado(100000, 10).h).toBeGreaterThanOrEqual(1);
  });
});

describe('MS.3.12 · nombreJpg', () => {
  it('cambia la extensión a .jpg y conserva el nombre', () => {
    expect(nombreJpg('IMG_2041.HEIC')).toBe('IMG_2041.jpg');
    expect(nombreJpg('captura de pantalla.png')).toBe('captura de pantalla.jpg');
    expect(nombreJpg('sin_extension')).toBe('sin_extension.jpg');
    expect(nombreJpg('.png')).toBe('foto.jpg');
  });
});

describe('MS.3.12 · debeOptimizar', () => {
  it('sólo una imagen optimizable que pasa del umbral', () => {
    expect(debeOptimizar({ type: 'image/jpeg', size: UMBRAL_BYTES + 1 })).toBe(true);
    expect(debeOptimizar({ type: 'image/jpeg', size: UMBRAL_BYTES })).toBe(false);
    expect(debeOptimizar({ type: 'application/pdf', size: 50 * 1024 * 1024 })).toBe(false);
    expect(debeOptimizar({ type: 'image/gif', size: 50 * 1024 * 1024 })).toBe(false);
  });
});

describe('MS.3.12 · optimizarImagen — nunca pierde un archivo', () => {
  it('⭐ un PDF, aunque sea enorme, pasa tal cual (el MISMO objeto)', async () => {
    const f = archivo('factura.pdf', 'application/pdf', UMBRAL_BYTES * 5);
    expect(await optimizarImagen(f)).toBe(f);
  });
  it('una foto chica pasa tal cual, sin decodificar', async () => {
    const f = archivo('chica.jpg', 'image/jpeg', 200_000);
    expect(await optimizarImagen(f)).toBe(f);
  });
  it('⛔ NEGATIVA — si el navegador no puede decodificar (aquí no hay createImageBitmap), se sube la ORIGINAL', async () => {
    const f = archivo('grande.jpg', 'image/jpeg', UMBRAL_BYTES * 3);
    expect(typeof createImageBitmap).not.toBe('function'); // el supuesto de esta prueba: jsdom no decodifica
    expect(await optimizarImagen(f)).toBe(f);
  });
  it('una lista conserva el orden y no pierde ninguno', async () => {
    const a = archivo('a.jpg', 'image/jpeg', 10);
    const b = archivo('b.pdf', 'application/pdf', 10);
    const c = archivo('c.png', 'image/png', UMBRAL_BYTES * 2);
    const r = await optimizarImagenes([a, b, c]);
    expect(r).toEqual([a, b, c]);
  });
});
