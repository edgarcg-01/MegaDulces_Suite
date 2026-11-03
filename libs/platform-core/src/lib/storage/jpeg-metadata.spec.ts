import { quitarMetadatosJpeg } from './jpeg-metadata';

/** Un segmento: marcador + largo (incluye sus 2 bytes) + datos. */
const seg = (m: number, datos: number[] | string): number[] => {
  const d = typeof datos === 'string' ? Array.from(datos).map((c) => c.charCodeAt(0)) : datos;
  const n = d.length + 2;
  return [0xff, m, n >> 8, n & 0xff, ...d];
};
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const JFIF = seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
const DQT = seg(0xdb, [0, ...Array(64).fill(1)]);
/** Escaneo con un 0xFF escapado (FF 00) y un RST adentro: los dos son datos, no marcadores. */
const SOS = [...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const EXIF_GPS = seg(0xe1, 'Exif\0\0GPSLatitude 20.6597 GPSLongitude -103.3496');
const XMP = seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>casa</x:xmpmeta>');
const ICC = seg(0xe2, 'ICC_PROFILE\0\x01\x01perfil');
const MPF = seg(0xe2, 'MPF\0otra imagen');
const ADOBE = seg(0xee, 'Adobe\0\x64\0\0\0\0\x01');
const IPTC = seg(0xed, 'Photoshop 3.0\0autor');
const COM = seg(0xfe, 'tomada en mi casa');

const jpeg = (...partes: number[][]): Uint8Array => new Uint8Array(partes.flat());
const texto = (b: Uint8Array | null): string => (b ? String.fromCharCode(...Array.from(b)) : '');

describe('[NP.7.L.2] quitarMetadatosJpeg', () => {
  it('CONTROL: un JPEG sin metadatos sale idéntico, byte por byte', () => {
    const limpio = jpeg(SOI, JFIF, DQT, SOS, EOI);
    expect(Array.from(quitarMetadatosJpeg(limpio)!)).toEqual(Array.from(limpio));
  });

  it('⭐ quita el EXIF con GPS, el XMP, el IPTC y el comentario; deja la imagen igual', () => {
    const sucio = jpeg(SOI, JFIF, EXIF_GPS, XMP, IPTC, COM, DQT, SOS, EOI);
    const out = quitarMetadatosJpeg(sucio)!;
    expect(texto(out)).not.toMatch(/Exif|GPS|xmpmeta|Photoshop|mi casa/);
    expect(Array.from(out)).toEqual(Array.from(jpeg(SOI, JFIF, DQT, SOS, EOI)));
  });

  it('conserva el perfil de color (ICC) y el APP14 de Adobe; quita el MPF (puede traer otra imagen con su EXIF)', () => {
    const out = quitarMetadatosJpeg(jpeg(SOI, JFIF, ICC, MPF, ADOBE, DQT, SOS, EOI))!;
    expect(Array.from(out)).toEqual(Array.from(jpeg(SOI, JFIF, ICC, ADOBE, DQT, SOS, EOI)));
  });

  it('corta en el EOI: la imagen extra que algunos teléfonos pegan después (con su EXIF) no viaja', () => {
    const out = quitarMetadatosJpeg(jpeg(SOI, JFIF, DQT, SOS, EOI, SOI, EXIF_GPS, SOS, EOI))!;
    expect(texto(out)).not.toMatch(/GPS/);
    expect(Array.from(out)).toEqual(Array.from(jpeg(SOI, JFIF, DQT, SOS, EOI)));
  });

  it('JPEG progresivo: varios escaneos con tablas en medio; un APPn entre escaneos también se va', () => {
    const DHT = seg(0xc4, [0, ...Array(16).fill(0)]);
    const out = quitarMetadatosJpeg(jpeg(SOI, JFIF, DQT, SOS, DHT, EXIF_GPS, SOS, EOI))!;
    expect(Array.from(out)).toEqual(Array.from(jpeg(SOI, JFIF, DQT, SOS, DHT, SOS, EOI)));
  });

  it.each([
    ['no es JPEG (PNG)', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['segmento con largo que se sale del archivo', jpeg(SOI, [0xff, 0xe1, 0x7f, 0xff, 1, 2, 3])],
    ['cortada a media imagen (sin EOI)', jpeg(SOI, JFIF, DQT, SOS)],
    ['sin escaneo (sólo encabezados)', jpeg(SOI, JFIF, EOI)],
    ['basura entre segmentos', jpeg(SOI, JFIF, [0x00, 0x11], SOS, EOI)],
  ])('⛔ %s → null (no se puede garantizar limpia: se rechaza)', (_n, b) => {
    expect(quitarMetadatosJpeg(b)).toBeNull();
  });
});
