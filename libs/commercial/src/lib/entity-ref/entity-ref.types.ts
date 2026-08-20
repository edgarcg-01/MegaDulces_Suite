/**
 * Referencia universal a un registro — "de qué estoy hablando" en una sola cadena.
 *
 * Existe porque hasta ahora cada pantalla sabía abrir SU tabla y nada más: la entrada
 * abría su detalle, el ajuste era texto, el proveedor era un string que se pasaba por
 * nombre a otra ruta. Con un `ref` estable cualquier celda puede volverse un enlace y
 * cualquier panel puede resolverlo sin saber de qué pantalla vino.
 *
 * Formato: `<kind>:<parte>|<parte>|…`, cada parte URL-encodeada (los folios traen ceros
 * a la izquierda y hay que preservarlos tal cual, así que NUNCA se normalizan a número).
 *
 * `doc_prefix` viaja en el ref de entradas y pagos aunque hoy las entradas sean 100%
 * XA2001: el folio de Kepler NO es único entre doctypes (verificado en el decode de la
 * fase CC — un XD2601 y un XD2501 pueden compartir folio). Dejarlo afuera funcionaría
 * hoy y rompería en silencio el día que entre un segundo doctype.
 */

export type EntityKind = 'ent' | 'lin' | 'adj' | 'pay' | 'prov' | 'sku';

export const ENTITY_KINDS: EntityKind[] = ['ent', 'lin', 'adj', 'pay', 'prov', 'sku'];

/** Cuántas partes lleva cada tipo — valida el ref antes de tocar la DB. */
const ARITY: Record<EntityKind, number> = { ent: 3, lin: 3, adj: 3, pay: 3, prov: 1, sku: 1 };

export interface ParsedRef {
  kind: EntityKind;
  parts: string[];
}

export function makeRef(kind: EntityKind, ...parts: (string | number | null | undefined)[]): string {
  return `${kind}:${parts.map((p) => encodeURIComponent(String(p ?? ''))).join('|')}`;
}

export function parseRef(ref: string): ParsedRef {
  const raw = String(ref || '').trim();
  const i = raw.indexOf(':');
  if (i <= 0) throw new Error(`Referencia inválida: "${raw}"`);
  const kind = raw.slice(0, i) as EntityKind;
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`Tipo de referencia desconocido: "${kind}"`);
  const parts = raw.slice(i + 1).split('|').map((p) => decodeURIComponent(p));
  if (parts.length !== ARITY[kind]) {
    throw new Error(`Referencia "${kind}" espera ${ARITY[kind]} parte(s), recibió ${parts.length}`);
  }
  if (parts.some((p) => !p)) throw new Error(`Referencia "${raw}" tiene partes vacías`);
  return { kind, parts };
}

/** Un dato del registro. `source` nombra la columna de origen: en este proyecto saber
 *  de dónde sale el número es la mitad del valor. */
export interface RefField {
  label: string;
  value: string | number | null;
  /** Cómo pintarlo. `money` y `date` los formatea el front (una sola definición). */
  kind?: 'text' | 'money' | 'date' | 'mono' | 'pct' | 'qty';
  /** Columna/tabla de origen, p.ej. "kdm2.c8" o "erp_goods_receipts.monto". */
  source?: string;
}

/** Algo a lo que este registro lleva. Cada relación trae SU propio ref → es clickeable. */
export interface RefRelation {
  ref: string;
  label: string;
  sub?: string | null;
  amount?: number | null;
  date?: string | null;
  /** Encabezado bajo el que se agrupa en el panel. */
  group: string;
  /** true = el vínculo es una estimación (proveedor+fecha), no una liga estructural. */
  heuristic?: boolean;
}

export interface RefBadge {
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info';
  title?: string;
}

export interface RefResult {
  ref: string;
  kind: EntityKind;
  title: string;
  subtitle?: string | null;
  badges: RefBadge[];
  fields: RefField[];
  relations: RefRelation[];
  /** Lo que el panel NO puede afirmar: matches heurísticos, tablas que no existen,
   *  relaciones ocultas por permisos. Se pinta al pie, no se esconde. */
  notes: string[];
}
