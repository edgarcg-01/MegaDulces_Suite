/**
 * `[NP.7.L.11d]` La foto que viaja al lector: recortada a la silueta (D6, opción A), reducida y sin metadatos.
 *
 * Con imágenes SINTÉTICAS hechas con sharp: el producto (azul) al centro, una «persona» (rojo) en la esquina,
 * fuera de la guía, y marcas verdes justo dentro de las esquinas de la guía de la vista previa (`.cs-guia`).
 * ⚠️ NO valida el recorte con fotos reales del levantamiento (no hay corpus todavía, NP.7.L.11b): sólo que la
 * geometría hace lo que dice.
 */
import sharp from 'sharp';
import {
  CALIDAD_JPEG, GUIA_VISOR_INSET_X, GUIA_VISOR_INSET_Y, LADO_MAX_PX, bytesDeDataUri, prepararFoto, rectanguloDeRecorte, sharpDisponible,
} from './preparar-foto';

type Color = { r: number; g: number; b: number };
const ROJO: Color = { r: 230, g: 20, b: 20 };
const AZUL: Color = { r: 20, g: 40, b: 220 };
const VERDE: Color = { r: 20, g: 210, b: 40 };
const GRIS: Color = { r: 128, g: 128, b: 128 };

const bloque = (width: number, height: number, background: Color, left: number, top: number) =>
  ({ input: { create: { width, height, channels: 3 as const, background } }, left, top });

/** 600×800 (3:4): producto al centro, «persona» arriba a la izquierda, marcas verdes dentro de la guía. */
async function escena(): Promise<Buffer> {
  const W = 600;
  const H = 800;
  const gx = Math.round(W * GUIA_VISOR_INSET_X);
  const gy = Math.round(H * GUIA_VISOR_INSET_Y);
  return sharp({ create: { width: W, height: H, channels: 3, background: GRIS } })
    .composite([
      bloque(200, 300, AZUL, 200, 250),
      bloque(60, 90, ROJO, 0, 0),
      bloque(10, 10, VERDE, gx + 2, gy + 2),
      bloque(10, 10, VERDE, W - gx - 12, H - gy - 12),
    ])
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Cuántos píxeles se parecen a `c` (tolerancia amplia: la imagen es JPEG). */
async function pixeles(jpeg: Buffer, c: Color): Promise<number> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.abs(data[i] - c.r) < 60 && Math.abs(data[i + 1] - c.g) < 60 && Math.abs(data[i + 2] - c.b) < 60) n++;
  }
  return n;
}

describe('[NP.7.L.11d] rectanguloDeRecorte (geometría pura)', () => {
  it('3:4 de 3024×4032: la silueta (46 %, 3:4) + 30 % por lado, centrada', () => {
    expect(rectanguloDeRecorte(3024, 4032)).toEqual({ x: 399, y: 532, ancho: 2226, alto: 2968 });
  });

  it('⭐ revisión 2026-11-05: en 3:4 viaja el 54.2 % del área; los márgenes (que se guardan) NO los ve el lector', () => {
    // Es la cifra que declara `rostro_visible` en `lectura-foto.contract.ts`: `false` = «sin rostro EN EL RECORTE».
    for (const [W, H] of [[960, 1280], [3024, 4032]]) {
      const r = rectanguloDeRecorte(W, H);
      expect((r.ancho * r.alto) / (W * H)).toBeCloseTo(0.542, 3);
      expect(r.x).toBeGreaterThan(0);
      expect(r.y).toBeGreaterThan(0);
    }
  });

  it('9:16 vertical: nunca menos que la guía de la vista previa (64 % del alto)', () => {
    const r = rectanguloDeRecorte(1080, 1920);
    expect(r.alto).toBe(Math.round(1920 * (1 - 2 * GUIA_VISOR_INSET_Y)));
    expect(r.ancho).toBe(795);
  });

  it('horizontal 16:9: el alto se topa con la imagen (no se sale)', () => {
    expect(rectanguloDeRecorte(1920, 1080)).toEqual({ x: 253, y: 0, ancho: 1413, alto: 1080 });
  });

  it('cualquier tamaño: queda dentro de la imagen y contiene la guía de la vista previa', () => {
    for (const [W, H] of [[1, 1], [10, 3000], [3000, 10], [640, 480], [1200, 1600], [4096, 3072], [777, 1333]]) {
      const r = rectanguloDeRecorte(W, H);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.ancho).toBeLessThanOrEqual(W);
      expect(r.y + r.alto).toBeLessThanOrEqual(H);
      expect(r.x).toBeLessThanOrEqual(Math.ceil(W * GUIA_VISOR_INSET_X));
      expect(r.y).toBeLessThanOrEqual(Math.ceil(H * GUIA_VISOR_INSET_Y));
    }
  });
});

describe('[NP.7.L.11d] prepararFoto (con sharp, imagen sintética)', () => {
  it('sharp está disponible en este entorno', () => {
    expect(sharpDisponible()).toBe(true);
  });

  it('con recorte: lo que está fuera de la silueta NO viaja; el producto y la guía sí', async () => {
    const p = await prepararFoto(await escena(), { recorte: 'silueta' });
    expect(p.mediaType).toBe('image/jpeg');
    expect(p.recorte).toEqual(rectanguloDeRecorte(600, 800));
    const out = Buffer.from(p.base64, 'base64');
    expect(out.length).toBe(p.bytes);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([p.ancho, p.alto]);
    expect(await pixeles(out, ROJO)).toBe(0);
    expect(await pixeles(out, AZUL)).toBeGreaterThan(200 * 300 * 0.8);
    expect(await pixeles(out, VERDE)).toBeGreaterThan(2 * 10 * 10 * 0.5);
  });

  it('prueba negativa: SIN recorte la «persona» sí viaja (el recorte es lo que la quita)', async () => {
    const p = await prepararFoto(await escena(), { recorte: 'ninguno' });
    expect(p.recorte).toBeNull();
    expect([p.ancho, p.alto]).toEqual([600, 800]);
    expect(await pixeles(Buffer.from(p.base64, 'base64'), ROJO)).toBeGreaterThan(60 * 90 * 0.8);
  });

  it(`reduce el lado largo a ${LADO_MAX_PX} px y no agranda una foto chica`, async () => {
    const grande = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: GRIS } }).jpeg().toBuffer();
    const p = await prepararFoto(grande, { recorte: 'silueta' });
    expect(Math.max(p.ancho, p.alto)).toBe(LADO_MAX_PX);
    expect(p.recorte).toEqual({ x: 399, y: 532, ancho: 2226, alto: 2968 });
    const chica = await sharp({ create: { width: 300, height: 400, channels: 3, background: GRIS } }).jpeg().toBuffer();
    const c = await prepararFoto(chica, { recorte: 'ninguno' });
    expect([c.ancho, c.alto]).toEqual([300, 400]);
  });

  it('orienta por EXIF y no deja metadatos en lo que viaja', async () => {
    // 800×600 con orientación 6 (girar 90°): se ve vertical, 600×800.
    const conExif = await sharp({ create: { width: 800, height: 600, channels: 3, background: GRIS } })
      .jpeg({ quality: CALIDAD_JPEG }).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(conExif).metadata()).orientation).toBe(6);
    const p = await prepararFoto(conExif, { recorte: 'ninguno' });
    expect([p.ancho, p.alto]).toEqual([600, 800]);
    const meta = await sharp(Buffer.from(p.base64, 'base64')).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it('lo que no es imagen lanza (el worker lo guarda como error permanente, sin llamada)', async () => {
    await expect(prepararFoto(Buffer.from('esto no es un jpeg'), { recorte: 'silueta' })).rejects.toThrow();
  });
});

describe('[NP.7.L.11d] bytesDeDataUri', () => {
  it('decodifica un data URI en base64 y rechaza lo demás', () => {
    expect(bytesDeDataUri('data:image/jpeg;base64,AQID')).toEqual(Buffer.from([1, 2, 3]));
    expect(bytesDeDataUri(null)).toBeNull();
    expect(bytesDeDataUri('https://ejemplo/foto.jpg')).toBeNull();
    expect(bytesDeDataUri('data:image/jpeg;base64,')).toBeNull();
  });
});
