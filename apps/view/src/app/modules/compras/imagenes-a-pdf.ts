import { loadLibs } from './compras-pdf-comun';

/**
 * `[RE.35.4]` Las fotos de la factura se juntan en UN PDF antes de subirse.
 *
 * La carga de entradas es sólo PDF por decisión de Edgar (2026-08-27): el expediente que sostiene
 * un pago tiene que tener todas sus hojas en UN archivo, y una foto suelta de una hoja de tres no lo
 * sostiene. Juntar las fotos acá respeta esa regla —el servidor sigue recibiendo un solo PDF— y deja
 * que el auxiliar arrastre lo que tenga a la mano (pedido de Francisco, 2026-10-06).
 */

const EXT_IMAGEN = /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i;

export function esPdf(f: Pick<File, 'type' | 'name'>): boolean {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

export function esImagen(f: Pick<File, 'type' | 'name'>): boolean {
  return f.type.startsWith('image/') || EXT_IMAGEN.test(f.name);
}

/** Separa lo que se puede leer (PDF y fotos) de lo que no. Conserva el orden en que llegaron. */
export function separarArchivos<T extends Pick<File, 'type' | 'name'>>(files: T[]): { pdfs: T[]; imagenes: T[]; otros: T[] } {
  const pdfs: T[] = [], imagenes: T[] = [], otros: T[] = [];
  for (const f of files) (esPdf(f) ? pdfs : esImagen(f) ? imagenes : otros).push(f);
  return { pdfs, imagenes, otros };
}

/** Lado mayor de cada página: suficiente para que el OCR lea y el archivo no pese de más. */
const LADO_MAX = 2000;

/**
 * Junta las fotos en un PDF de una página por foto, en el orden en que llegaron. Cada página toma
 * el tamaño de su foto (reducida a 2000 px por lado), así no se deforma ni se recorta.
 */
export async function imagenesAPdf(imagenes: File[], nombre = 'factura-fotos.pdf'): Promise<File> {
  if (!imagenes.length) throw new Error('No hay fotos que juntar.');
  const { jsPDF } = await loadLibs();
  let doc: InstanceType<typeof jsPDF> | null = null;
  for (const img of imagenes) {
    const bmp = await createImageBitmap(img);
    const r = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * r), h = Math.round(bmp.height * r);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('El navegador no pudo procesar la foto.');
    ctx.drawImage(bmp, 0, 0, w, h);
    const jpg = canvas.toDataURL('image/jpeg', 0.85);
    const orientacion = w > h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ orientation: orientacion, unit: 'px', format: [w, h] });
    else doc.addPage([w, h], orientacion);
    doc.addImage(jpg, 'JPEG', 0, 0, w, h);
  }
  const blob = (doc as InstanceType<typeof jsPDF>).output('blob');
  return new File([blob], nombre, { type: 'application/pdf' });
}

/**
 * Lo que efectivamente se sube: los PDF tal cual y, si hubo fotos, UN PDF más con todas ellas.
 * `otros` se reporta para decir qué se ignoró.
 */
export async function prepararArchivos(files: File[]): Promise<{ listos: File[]; fotos: number; otros: File[] }> {
  const { pdfs, imagenes, otros } = separarArchivos(files);
  const listos = [...pdfs];
  if (imagenes.length) listos.push(await imagenesAPdf(imagenes));
  return { listos, fotos: imagenes.length, otros };
}
