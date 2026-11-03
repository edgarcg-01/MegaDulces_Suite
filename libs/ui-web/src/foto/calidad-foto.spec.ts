import { dimensionesDeMedicion, juzgarFoto, medirFoto, UMBRAL_NITIDEZ } from './calidad-foto';

/** Imagen sintética RGBA: `f(x, y)` da la luminancia 0–255. */
function imagen(ancho: number, alto: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(ancho * alto * 4);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    const v = f(x, y); const p = (y * ancho + x) * 4;
    d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
  }
  return d;
}

/** Desenfoque de caja (radio r): simula la foto movida. */
function desenfocar(src: Uint8ClampedArray, ancho: number, alto: number, r: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(src.length);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) {
    let s = 0; let n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(ancho - 1, Math.max(0, x + dx)); const yy = Math.min(alto - 1, Math.max(0, y + dy));
      s += src[(yy * ancho + xx) * 4]; n++;
    }
    const p = (y * ancho + x) * 4; const v = s / n;
    d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
  }
  return d;
}

const W = 120;
const H = 90;
// «Etiqueta»: franjas de texto (alto contraste, bordes finos).
const etiqueta = imagen(W, H, (x, y) => ((Math.floor(x / 12) + Math.floor(y / 14)) % 2 ? 230 : 20));

describe('calidad de la foto · nitidez y contraste', () => {
  it('una etiqueta nítida pasa; la misma, movida, no', () => {
    const nitida = medirFoto(etiqueta, W, H);
    const movida = medirFoto(desenfocar(etiqueta, W, H, 6), W, H);
    expect(nitida.nitidez).toBeGreaterThan(movida.nitidez * 10);
    expect(juzgarFoto(nitida)).toEqual({ ok: true });
    expect(juzgarFoto(movida)).toMatchObject({ ok: false, motivo: 'borrosa' });
  });

  it('una imagen plana (lente tapado, neblina) no tiene nitidez ni contraste', () => {
    const plana = medirFoto(imagen(W, H, () => 128), W, H);
    expect(plana).toEqual({ nitidez: 0, contraste: 0 });
    expect(juzgarFoto(plana)).toMatchObject({ ok: false });
  });

  it('nítida pero opaca (poco contraste) → limpia el lente', () => {
    const opaca = medirFoto(imagen(W, H, (x, y) => ((Math.floor(x / 12) + Math.floor(y / 14)) % 2 ? 140 : 110)), W, H);
    expect(opaca.nitidez).toBeGreaterThan(UMBRAL_NITIDEZ);
    expect(juzgarFoto(opaca)).toMatchObject({ ok: false, motivo: 'opaca' });
  });

  it('prueba negativa: con el umbral en 0, la foto movida PASA (el candado depende del umbral)', () => {
    const movida = medirFoto(desenfocar(etiqueta, W, H, 6), W, H);
    expect(juzgarFoto(movida, { nitidez: 0, contraste: 0 })).toEqual({ ok: true });
  });

  it('la medición se hace a 640 px de lado mayor, sin importar el teléfono', () => {
    expect(dimensionesDeMedicion(4032, 3024)).toEqual({ ancho: 640, alto: 480 });
    expect(dimensionesDeMedicion(500, 300)).toEqual({ ancho: 500, alto: 300 });
  });
});
