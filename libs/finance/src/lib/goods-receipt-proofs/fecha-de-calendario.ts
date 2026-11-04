/**
 * La fecha que leyó el OCR, sólo si EXISTE en el calendario; si no, `null`.
 *
 * Nace de una factura real (entrada 08/0422, 2026-11-03): el modelo leyó «2024-04-31», que tiene
 * la forma AAAA-MM-DD pero no existe (abril tiene 30). Ese texto iba directo a la columna `date`
 * de `finance.goods_receipt_proofs` y Postgres rechazaba el INSERT completo — el capturista no
 * podía subir la factura por un error de lectura de un campo que ni siquiera decide nada.
 *
 * Validar la FORMA no basta (la regex acepta 04-31 y 02-30); se valida que el día exista. Lo que
 * el OCR leyó tal cual se conserva en `ocr_raw`: acá sólo se decide qué entra a la columna tipada,
 * y lo que no es fecha se declara como ausencia (`null`), no se corrige adivinando.
 */
export function fechaDeCalendario(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
