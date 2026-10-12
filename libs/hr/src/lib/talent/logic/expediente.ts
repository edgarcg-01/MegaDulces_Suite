/**
 * Fase RH · `[RH.2.2]` — el EXPEDIENTE del candidato: qué documentos lleva y cómo se guarda cada uno.
 *
 * El catálogo es copia del canónico de Mega Talento (`BOT-RH/src/documentos.js`, espejo de
 * `DOCUMENTOS_EXPEDIENTE` del portal): las `key` tienen que coincidir EXACTO, porque el bot clasifica
 * lo que le mandan por WhatsApp con esas mismas llaves.
 *
 * Cada documento es una entrada de `talent.candidates.documents` (jsonb), con la misma forma que ya
 * escribe el bot (`slot`, `url`, `filename`, `mime_type`, `origen`, `recibido_en`) más lo de la Suite:
 * `storage_key` (bucket PRIVADO: la URL se firma en cada lectura, nunca se guarda) y el retiro. Nada se
 * borra: retirar un documento lo marca con quién, cuándo y por qué, y deja de contar.
 */

export interface DocumentoExpediente {
  key: string;
  label: string;
  obligatorio: boolean;
}

export const DOCUMENTOS_EXPEDIENTE: readonly DocumentoExpediente[] = [
  { key: 'cv', label: 'Currículum vitae', obligatorio: true },
  { key: 'ine', label: 'INE', obligatorio: true },
  { key: 'curp', label: 'CURP', obligatorio: true },
  { key: 'rfc', label: 'RFC', obligatorio: true },
  { key: 'nss', label: 'NSS', obligatorio: true },
  { key: 'comprobante', label: 'Comprobante de domicilio', obligatorio: true },
  { key: 'acta', label: 'Acta de nacimiento', obligatorio: true },
  { key: 'banco', label: 'Cuenta bancaria', obligatorio: true },
  { key: 'avisoPrivacidad', label: 'Aviso de privacidad', obligatorio: true },
  { key: 'licencia', label: 'Licencia de manejo', obligatorio: false },
  { key: 'midot', label: 'Reporte de la prueba', obligatorio: false },
  { key: 'contrato', label: 'Contrato firmado', obligatorio: false },
];

/** `otro` es lo que el bot no supo clasificar: también se acepta al subir. */
export function esCasillero(x: unknown): x is string {
  return typeof x === 'string' && (x === 'otro' || DOCUMENTOS_EXPEDIENTE.some((d) => d.key === x));
}

/** Tamaño máximo de un documento (la foto de un celular o un PDF escaneado). */
export const MAX_DOCUMENTO_BYTES = 10 * 1024 * 1024;

export type EntradaDocumento = Record<string, unknown>;

/** El casillero de una entrada: el bot lo escribe en `slot` y, a veces, en `tipo`. */
export const casilleroDe = (d: EntradaDocumento): string | null => (d['slot'] ?? d['tipo'] ?? null) as string | null;

/** ¿Sigue vigente? (un documento retirado no cuenta para nada). */
export const vigente = (d: EntradaDocumento): boolean => !d['retired_at'];

/** La llave con la que se reconoce un archivo: el del bucket, la URL externa o la ruta local del bot. */
export const llaveDocumento = (d: EntradaDocumento): string =>
  String(d['storage_key'] ?? d['url'] ?? d['archivo_local'] ?? JSON.stringify(d));

/** La entrada que se agrega al subir un documento desde la Suite. */
export function entradaNueva(a: {
  slot: string; file_name: string; content_type: string; size_bytes: number; storage_key: string;
  por_id: string | null; por_nombre: string; ahora: string;
}): EntradaDocumento {
  return {
    slot: a.slot, filename: a.file_name, mime_type: a.content_type, size_bytes: a.size_bytes,
    storage_key: a.storage_key, origen: 'suite', recibido_en: a.ahora,
    subido_por: a.por_id, subido_por_nombre: a.por_nombre,
  };
}

/**
 * Marca como retirada la entrada con esa llave. Devuelve la lista nueva y la entrada retirada, o
 * `null` si no hay una VIGENTE con esa llave (retirar dos veces no es retirar).
 */
export function retirar(docs: EntradaDocumento[], llave: string, r: {
  motivo: string; por_id: string | null; por_nombre: string; ahora: string;
}): { docs: EntradaDocumento[]; retirada: EntradaDocumento } | null {
  const i = docs.findIndex((d) => vigente(d) && llaveDocumento(d) === llave);
  if (i < 0) return null;
  const retirada = { ...docs[i], retired_at: r.ahora, retired_by: r.por_id, retired_by_name: r.por_nombre, retire_reason: r.motivo };
  return { docs: docs.map((d, j) => (j === i ? retirada : d)), retirada };
}

/** Qué casilleros obligatorios faltan (con lo vigente; `cv_url` de la web también cuenta como CV). */
export function faltantes(docs: EntradaDocumento[], tieneCvWeb: boolean): string[] {
  const hay = new Set(docs.filter(vigente).map(casilleroDe).filter(Boolean));
  if (tieneCvWeb) hay.add('cv');
  return DOCUMENTOS_EXPEDIENTE.filter((d) => d.obligatorio && !hay.has(d.key)).map((d) => d.key);
}
