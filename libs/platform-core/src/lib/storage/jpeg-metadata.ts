/**
 * `[NP.7.L.2]` Quita los metadatos de un JPEG SIN re-codificar la imagen. Función pura.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 * Las fotos del levantamiento salen de teléfonos PERSONALES. El EXIF de una foto de cámara trae el GPS
 * (dónde vive quien la tomó, si la tomó en su casa), el modelo del teléfono y la hora; XMP e IPTC pueden
 * traer más. El plan (NP.7.2.1) pide «una foto con GPS se guarda sin EXIF». No se usa `sharp`: en este
 * repo es opcional (se carga con `try/require`) y no está medido que viva en la imagen de producción.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────────────────────
 * Recorre los segmentos y deja sólo lo que hace falta para pintar la imagen:
 *  · se quedan: APP0 (JFIF), APP2 sólo si es `ICC_PROFILE` (color), APP14 sólo si es `Adobe` (sin él
 *    algunos JPEG se pintan con los colores invertidos), y todo lo que no es APPn ni comentario
 *    (tablas, marcos, escaneos);
 *  · se van: APP1 (EXIF y XMP), las demás APPn (IPTC, MPF —que puede traer OTRA imagen con su propio
 *    EXIF—, datos del fabricante) y COM;
 *  · y se corta en el EOI: lo que venga pegado después (Samsung y otros pegan imágenes extra) no viaja.
 *
 * Devuelve `null` si no se puede recorrer (no es JPEG, segmento cortado, sin escaneo): una foto que no
 * se entiende tampoco se puede garantizar limpia, así que se rechaza en vez de guardarse tal cual.
 */
export function quitarMetadatosJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const partes: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let escaneos = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i += 1; // bytes de relleno entre marcadores
    const m = b[i + 1];
    if (m === undefined) return null;
    if (m === 0xd9) {
      partes.push(b.subarray(i, i + 2));
      return escaneos > 0 ? unir(partes) : null;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      partes.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return null;
    const largo = (b[i + 2] << 8) | b[i + 3];
    const fin = i + 2 + largo;
    if (largo < 2 || fin > b.length) return null;
    if (conservar(m, b.subarray(i + 4, fin))) partes.push(b.subarray(i, fin));
    i = fin;
    if (m === 0xda) {
      // Datos del escaneo: corren hasta el siguiente marcador real (0xFF00 es un 0xFF escapado y los
      // RSTn van dentro del escaneo). Un JPEG progresivo trae varios escaneos con tablas entre ellos.
      escaneos += 1;
      const desde = i;
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const s = b[i + 1];
          if (s !== 0x00 && s !== 0xff && !(s >= 0xd0 && s <= 0xd7)) break;
        }
        i += 1;
      }
      if (i >= b.length) return null; // sin EOI: la foto llegó cortada
      partes.push(b.subarray(desde, i));
    }
  }
  return null;
}

const firma = (datos: Uint8Array, texto: string): boolean =>
  datos.length >= texto.length && Array.from(texto).every((c, k) => datos[k] === c.charCodeAt(0));

function conservar(marcador: number, datos: Uint8Array): boolean {
  if (marcador === 0xfe) return false; // COM
  if (marcador < 0xe0 || marcador > 0xef) return true; // no es APPn: es parte de la imagen
  if (marcador === 0xe0) return true; // APP0 / JFIF
  if (marcador === 0xe2) return firma(datos, 'ICC_PROFILE\0');
  if (marcador === 0xee) return firma(datos, 'Adobe');
  return false;
}

function unir(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let k = 0;
  for (const p of partes) { out.set(p, k); k += p.length; }
  return out;
}
