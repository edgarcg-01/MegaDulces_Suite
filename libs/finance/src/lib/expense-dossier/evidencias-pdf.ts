import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { esc } from '../shared/chromium-pdf';

/**
 * `[GX.76]` — **Las evidencias DENTRO del expediente en PDF.**
 *
 * Pedido del usuario (2026-10-07), viendo el PDF de producción: *«también debe de tener ahí la
 * evidencia»*. Hasta hoy el documento sólo LISTABA los archivos y mandaba a consultarlos en el
 * expediente.
 *
 * ## ⚠️ Esto REVIERTE una decisión de `[GX.15]`, a propósito
 * GX.15 dejó escrito que las fotos NO se embebían por dos razones: el tamaño del archivo y que
 * una evidencia con URL que caduca se volviera una copia permanente que viaja por correo. El
 * usuario decidió que el expediente debe bastarse solo. Lo que se conserva de aquella cautela:
 * las fotos se REDUCEN antes de entrar (lado mayor 1400 px, JPEG 78) y el pie sigue diciendo que
 * el documento es respaldo interno.
 *
 * ## Medido antes de construir (prod, 2026-10-07, 480 archivos)
 * **342 son PDF (71 %)**, 91 jpeg, 45 png, 1 Excel y 1 con tipo de ejecutable de Windows. Por eso
 * no alcanza con `<img>`: los PDF se ANEXAN al final con `pdf-lib`, página por página, cada una
 * con una marca de a qué expediente y a qué archivo pertenece. Lo que no es imagen ni PDF, o no se
 * pudo bajar o abrir, **se declara** en la sección — nunca desaparece en silencio.
 */

/** Un archivo del expediente, tal como viaja en `files` (la `public_id` es la llave del bucket). */
export interface ArchivoEvidencia {
  role?: string | null;
  public_id?: string | null;
  kind?: string | null;
}

export interface ImagenEvidencia { etiqueta: string; dataUri: string; reducida: boolean }
export interface PdfEvidencia { etiqueta: string; bytes: Uint8Array; paginas: number }
export interface OmitidaEvidencia { etiqueta: string; motivo: string }

export interface EvidenciasPreparadas {
  imagenes: ImagenEvidencia[];
  pdfs: PdfEvidencia[];
  omitidas: OmitidaEvidencia[];
}

/** Baja un archivo del bucket como data URI; `null` = no se pudo. */
export type Bajar = (key: string) => Promise<string | null>;
/** Reduce una imagen; si no puede, devuelve `null` y entra la original. */
export type Achicar = (bytes: Buffer) => Promise<Buffer | null>;

/** Nombre legible del archivo: de dónde viene y qué rol tiene (`Comprobación 0009069 · comprobante_1`). */
export function etiquetaEvidencia(origen: string, role: string | null | undefined): string {
  return `${origen} · ${String(role || 'archivo').trim() || 'archivo'}`;
}

/** El tipo real del contenido, por el encabezado del data URI y, si miente, por los bytes. */
export function tipoDeContenido(dataUri: string): 'imagen' | 'pdf' | 'otro' {
  const ct = (/^data:([^;,]+)/.exec(dataUri)?.[1] || '').toLowerCase();
  const cuerpo = dataUri.slice(dataUri.indexOf(',') + 1, dataUri.indexOf(',') + 9);
  if (ct === 'application/pdf' || cuerpo.startsWith('JVBER')) return 'pdf'; // "%PDF" en base64
  if (/^image\/(jpe?g|png|webp|gif)$/.test(ct)) return 'imagen';
  return 'otro';
}

/**
 * Baja y clasifica cada archivo. Las imágenes se reducen; los PDF se ABREN aquí (no al final)
 * para saber cuántas páginas tienen y, si alguno está dañado o cifrado, poder decirlo en la
 * sección del documento en vez de que el anexo falle sin explicación.
 */
export async function prepararEvidencias(
  archivos: readonly { origen: string; archivo: ArchivoEvidencia }[],
  bajar: Bajar,
  achicar: Achicar,
): Promise<EvidenciasPreparadas> {
  const out: EvidenciasPreparadas = { imagenes: [], pdfs: [], omitidas: [] };
  for (const { origen, archivo } of archivos) {
    const etiqueta = etiquetaEvidencia(origen, archivo.role);
    const key = String(archivo.public_id || '').trim();
    if (!key || /^https?:\/\//i.test(key)) {
      out.omitidas.push({ etiqueta, motivo: 'archivo anterior al bucket actual: se consulta en el expediente' });
      continue;
    }
    const dataUri = await bajar(key).catch(() => null);
    if (!dataUri) { out.omitidas.push({ etiqueta, motivo: 'no se pudo descargar del almacenamiento' }); continue; }
    const bytes = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
    const tipo = tipoDeContenido(dataUri);
    if (tipo === 'imagen') {
      const chica = await achicar(bytes).catch(() => null);
      out.imagenes.push(chica
        ? { etiqueta, dataUri: `data:image/jpeg;base64,${chica.toString('base64')}`, reducida: true }
        : { etiqueta, dataUri, reducida: false });
    } else if (tipo === 'pdf') {
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        out.pdfs.push({ etiqueta, bytes: new Uint8Array(bytes), paginas: doc.getPageCount() });
      } catch {
        out.omitidas.push({ etiqueta, motivo: 'el PDF está dañado o protegido y no se pudo anexar' });
      }
    } else {
      const ct = (/^data:([^;,]+)/.exec(dataUri)?.[1] || 'desconocido').toLowerCase();
      out.omitidas.push({ etiqueta, motivo: `no es foto ni PDF (${ct}): se consulta en el expediente` });
    }
  }
  return out;
}

/**
 * La sección «Las evidencias» del PDF. Arranca en página nueva: una foto partida entre dos
 * páginas no se puede leer. Cada ausencia se dice.
 */
export function htmlEvidencias(e: EvidenciasPreparadas): string {
  if (!e.imagenes.length && !e.pdfs.length && !e.omitidas.length) {
    return '<p class="vacio">El expediente no tiene archivos de evidencia.</p>';
  }
  const fotos = e.imagenes.map((i) => `<figure class="evid">
      <figcaption>${esc(i.etiqueta)}${i.reducida ? '' : ' <span class="mut">(sin reducir)</span>'}</figcaption>
      <img src="${i.dataUri}" alt="${esc(i.etiqueta)}">
    </figure>`).join('');
  const anexos = e.pdfs.length
    ? `<p class="anexos"><strong>Anexados al final de este archivo</strong> (en este orden):</p>
       <ul class="files">${e.pdfs.map((p) => `<li>${esc(p.etiqueta)} <span class="mut">· PDF de ${p.paginas} ${p.paginas === 1 ? 'página' : 'páginas'}</span></li>`).join('')}</ul>`
    : '';
  const omitidas = e.omitidas.length
    ? `<div class="falta"><strong>No se pudieron incluir</strong><ul>${e.omitidas.map((o) => `<li>${esc(o.etiqueta)} — ${esc(o.motivo)}</li>`).join('')}</ul></div>`
    : '';
  return `${anexos}${fotos}${omitidas}`;
}

/**
 * Anexa los PDF de evidencia DESPUÉS del expediente, y marca cada página anexada con a qué
 * expediente y a qué archivo pertenece: suelta del resto, una página de un ticket no dice nada.
 */
export async function anexarPdfs(principal: Uint8Array, pdfs: readonly PdfEvidencia[], expediente: string): Promise<Uint8Array> {
  if (!pdfs.length) return principal;
  const final = await PDFDocument.load(principal);
  const fuente = await final.embedFont(StandardFonts.Helvetica);
  for (const p of pdfs) {
    const src = await PDFDocument.load(p.bytes, { ignoreEncryption: true });
    const paginas = await final.copyPages(src, src.getPageIndices());
    paginas.forEach((pag, i) => {
      final.addPage(pag);
      const marca = `Anexo · ${expediente} · ${p.etiqueta} · pág. ${i + 1} de ${paginas.length}`;
      // Helvetica estándar es WinAnsi: lo que no quepa ahí (emojis, etc.) se cambia por «?».
      const segura = marca.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');
      const { width } = pag.getSize();
      const tam = 7;
      pag.drawRectangle({ x: 0, y: 0, width, height: 14, color: rgb(1, 1, 1), opacity: 0.85 });
      pag.drawText(segura, { x: 8, y: 4, size: tam, font: fuente, color: rgb(0.32, 0.32, 0.36) });
    });
  }
  return final.save();
}
