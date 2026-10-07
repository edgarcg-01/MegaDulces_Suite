/**
 * `[MS.2.4]` Validación de adjuntos por FIRMA (magic bytes), no por el tipo que declara el cliente.
 * Función pura. ADR-081.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 * `ObjectStorageService.putFile`/`putBuffer` guardan el `Content-Type` DECLARADO en el data URI, y el
 * servidor sólo limita el tamaño del cuerpo. Un `<script>` renombrado a `.png` con
 * `data:image/png;base64,…` se almacenaría y se serviría como imagen. La base ya rechaza cualquier tipo
 * fuera de {jpeg, png, webp, gif, heic, pdf} (CHECK de `request_attachments`), pero eso valida lo que el
 * cliente DICE; esto valida lo que el archivo ES. Y el tipo que se guarda es el DETECTADO, no el declarado.
 */

export const TIPOS_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
] as const;
export type TipoPermitido = (typeof TIPOS_PERMITIDOS)[number];

const arranca = (b: Uint8Array, firma: readonly number[], offset = 0): boolean =>
  b.length >= offset + firma.length && firma.every((x, i) => b[offset + i] === x);

const ascii = (b: Uint8Array, desde: number, hasta: number): string =>
  String.fromCharCode(...Array.from(b.subarray(desde, hasta)));

const MARCAS_HEIC = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** El tipo REAL del archivo según sus primeros bytes, o `null` si no es uno de los permitidos. */
export function detectarTipo(bytes: Uint8Array): TipoPermitido | null {
  if (arranca(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF
  if (arranca(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (arranca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp' && MARCAS_HEIC.has(ascii(bytes, 8, 12))) return 'image/heic';
  return null;
}

export interface AdjuntoValido {
  buffer: Buffer;
  /** El tipo DETECTADO. Es el que se guarda. */
  contentType: TipoPermitido;
  sizeBytes: number;
}

export type ErrorAdjunto =
  | 'no_es_data_uri'
  | 'no_es_base64'
  | 'vacio'
  | 'demasiado_grande'
  | 'tipo_no_permitido'
  | 'tipo_no_coincide';

export type ResultadoAdjunto = { ok: true; adjunto: AdjuntoValido } | { ok: false; error: ErrorAdjunto; detalle: string };

const DATA_URI = /^data:([^;,]*)((?:;[^;,=]+=[^;,]*)*)(;base64)?,([\s\S]*)$/i;

/**
 * Valida un `data:<mime>;base64,<...>`: decodifica, mide, detecta el tipo por firma y exige que el tipo
 * declarado (si lo hay y es uno de los permitidos) coincida con el detectado.
 */
export function validarAdjunto(dataUri: string, maxBytes: number): ResultadoAdjunto {
  const m = DATA_URI.exec(String(dataUri ?? '').trim());
  if (!m) return { ok: false, error: 'no_es_data_uri', detalle: 'El archivo debe venir como data URI (data:<tipo>;base64,<datos>)' };
  if (!m[3]) return { ok: false, error: 'no_es_base64', detalle: 'El archivo debe venir codificado en base64' };

  const declarado = (m[1] || '').toLowerCase().trim();
  const buffer = Buffer.from(m[4].replace(/\s+/g, ''), 'base64');

  if (buffer.length === 0) return { ok: false, error: 'vacio', detalle: 'El archivo está vacío' };
  if (buffer.length > maxBytes) {
    return { ok: false, error: 'demasiado_grande', detalle: `El archivo pesa ${(buffer.length / 1048576).toFixed(1)} MB y el máximo es ${(maxBytes / 1048576).toFixed(0)} MB` };
  }

  const real = detectarTipo(buffer);
  if (!real) return { ok: false, error: 'tipo_no_permitido', detalle: 'Sólo se aceptan imágenes (JPG, PNG, WEBP, GIF, HEIC) y PDF' };

  // Un cliente honesto declara lo que es; uno que declara OTRA cosa está ocultando algo o está roto.
  // `application/octet-stream` y la ausencia de tipo son lo que mandan algunos navegadores: se aceptan.
  const neutro = declarado === '' || declarado === 'application/octet-stream';
  const heic = real === 'image/heic' && (declarado === 'image/heif' || declarado === 'image/heic');
  if (!neutro && declarado !== real && !heic) {
    return { ok: false, error: 'tipo_no_coincide', detalle: `El archivo dice ser ${declarado} pero es ${real}` };
  }
  return { ok: true, adjunto: { buffer, contentType: real, sizeBytes: buffer.length } };
}

/** Un nombre de archivo seguro para guardar y mostrar: sin ruta, sin caracteres de control, ≤ 120. */
export function sanitizarNombre(nombre: string | null | undefined, contentType: TipoPermitido): string {
  const EXT: Record<TipoPermitido, string> = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
  };
  let base = String(nombre ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  if (!base || base === '.' || base === '..') base = `adjunto.${EXT[contentType]}`;
  if (base.length > 120) {
    const punto = base.lastIndexOf('.');
    const ext = punto > 0 && base.length - punto <= 8 ? base.slice(punto) : '';
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}
