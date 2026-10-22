/**
 * `[RE.43]` — **¿De qué entrada es este papel?** El folio del PROVEEDOR se busca donde Kepler
 * guarda el folio del proveedor (`referencia`), no en NUESTRO folio de entrada.
 *
 * Módulo puro, como `documento-duplicado.ts`: decide a qué entrada se cuelga una factura, así que
 * cada paso tiene que explicarse con una regla y reproducirse en un test.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * EL CASO QUE LO MOTIVÓ (prod, 2026-10-21). La nota `0666` de EL FAROLITO se enlazó sola a
 * `01/0000666` — GUILLERMO LÓPEZ G., $1,500, otra sucursal — porque el emparejamiento comparaba el
 * folio del papel contra `c.folio`, que es el número de NUESTRA orden de entrada. La entrada
 * correcta (`08/0000288`) lo tenía en `referencia = '30-0666'`: Kepler captura ahí el folio del
 * proveedor, con el prefijo de la plaza.
 *
 * MEDIDO sobre 878 papeles de proveedor ya subidos (remisión/factura con folio legible):
 *   · El núcleo del folio casa con `referencia` de SU entrada en **261**, con nuestro folio en **10**.
 *   · Usar nuestro folio como llave cae en la entrada de OTRO proveedor en **283 (32%)** — 100
 *     dentro de la misma sucursal.
 *   · Cuando `referencia` casa, el número se repite: único globalmente en 101/261, en la sucursal
 *     en 225/261, en sucursal + proveedor en **259/261**. Por eso el alcance y el desempate importan.
 *   · `referencia` viene llena en el 96% de las entradas (3,304 / 3,447 a 90 días).
 *
 * ANTES/DESPUÉS, simulado con este módulo sobre 1,150 papeles reales contra la entrada donde de
 * verdad quedaron (2026-10-21):
 *
 *   | alcance  |              | enlace auto bien | **auto MAL** | pregunta | sin coincidencia |
 *   |----------|--------------|-----------------:|-------------:|---------:|-----------------:|
 *   | sucursal | antes        | 633              | 47           | 125      | 345              |
 *   | sucursal | **después**  | **813**          | **21**       | 90       | **226**          |
 *   | global   | antes        | 486              | 95           | 296      | 273              |
 *   | global   | después      | 690              | 66           | 205      | 189              |
 *
 * Lo que queda mal es casi todo por IMPORTE: otra entrada de la misma sucursal con el mismo monto
 * (±$2). Exigir proveedor confirmado para enlazar por importe lo baja a 7, pero hace preguntar en
 * 222 papeles que hoy salen bien solos — se descartó por eso.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */
import { HOJAS_INTERNAS, parecidoNombre, rfcBienFormado, rfcComparable, UMBRAL_NOMBRE } from './receipt-match';
import { esRfcPropio, FOLIO_MINIMO } from './documento-duplicado';

/** Contra qué se compara el folio leído. */
export type LlaveFolio = 'nuestro' | 'proveedor' | 'ambos';

/**
 * ¿El folio leído es NUESTRO (el de la orden de entrada) o del PROVEEDOR?
 *
 * - Hoja interna (orden de entrada, vale) → nuestro.
 * - `XA2001-…` → nuestro aunque la hoja diga factura: es el folio que imprime Kepler, y el OCR a
 *   veces lo levanta de la factura (medido: hay facturas guardadas con `XA2001-0000140`).
 * - Factura / remisión → del proveedor. ⚠️ No se adivina por la forma: `0666` empieza con cero
 *   como los nuestros, y justo ése fue el caso que cayó en la entrada equivocada.
 * - Sin rol (clientes viejos) → se prueban las dos.
 */
export function llaveDelFolio(role?: string | null, folio?: string | null): LlaveFolio {
  const r = (role || '').trim();
  if (HOJAS_INTERNAS.has(r)) return 'nuestro';
  if (/^\s*XA\d{4}/i.test(folio || '')) return 'nuestro';
  if (r === 'factura' || r === 'remision') return 'proveedor';
  return 'ambos';
}

/**
 * Núcleo del folio del proveedor dentro de `referencia`: sin el prefijo de plaza (`30-`), sólo
 * dígitos, sin ceros a la izquierda. `'30-0666'` → `'666'`. Comparable con `folioNucleo()`.
 * ⛔ `sqlNucleoReferencia()` lo replica en SQL; el test compara los dos.
 */
export function nucleoReferencia(ref?: string | null): string | null {
  if (!ref) return null;
  const n = String(ref).replace(/^\s*\d{2}\s*-\s*/, '').replace(/\D/g, '').replace(/^0+/, '');
  return n.length >= FOLIO_MINIMO ? n : null;
}

/** La misma regla de `nucleoReferencia()`, en SQL, sobre la columna dada. */
export const sqlNucleoReferencia = (col: string): string =>
  `ltrim(regexp_replace(regexp_replace(COALESCE(${col}, ''), '^\\s*\\d{2}\\s*-\\s*', ''), '\\D', '', 'g'), '0')`;

/**
 * Kepler a veces captura sólo la COLA del folio: el papel dice `IC - 3384616` y la referencia
 * `10-4616`; `AE 244817` ↔ `10-4817`. Se acepta si la referencia es la cola del folio del papel
 * y tiene al menos este largo. Medido (1,150 papeles, alcance por sucursal): con 4, +63 bien
 * enlazados y +2 mal; con 5 se pierden 58 de esos aciertos para ahorrar 3 errores.
 */
export const SUFIJO_MINIMO = 4;

/** ¿La referencia es la cola del folio del papel? (`3384616` ↔ `4616`). Nunca el folio entero. */
export function esSufijoDeReferencia(nucleoPapel?: string | null, nucleoRef?: string | null): boolean {
  if (!nucleoPapel || !nucleoRef) return false;
  return nucleoRef.length >= SUFIJO_MINIMO && nucleoPapel.length > nucleoRef.length && nucleoPapel.endsWith(nucleoRef);
}

/** `esSufijoDeReferencia()` en SQL. Bindings: `[nucleoPapel, nucleoPapel]`. */
export const sqlSufijoReferencia = (col: string): string => {
  const n = sqlNucleoReferencia(col);
  return `(length(${n}) >= ${SUFIJO_MINIMO} AND length(?) > length(${n}) AND right(?, length(${n})) = ${n})`;
};

/** La entrada se captura cerca de la fecha del papel: hasta 15 días antes o 60 después (= `identificar`). */
export const DIAS_ANTES = 15;
export const DIAS_DESPUES = 60;

/** Lo que se leyó del papel y sirve para desempatar. */
export interface LecturaPapel {
  rfc?: string | null;
  proveedor?: string | null;
  fecha?: string | null;
  total?: number | null;
}

/** Lo mínimo de una entrada candidata para ordenarla. */
export interface CandidataEntrada {
  proveedor_nombre?: string | null;
  proveedor_rfc?: string | null;
  receipt_date?: string | Date | null;
  monto?: number | string | null;
  deposits?: number | string | null;
}

export interface Desempate {
  /** `true` = el papel es de este proveedor (RFC igual, o nombre parecido) · `false` = RFC distinto · `null` = no se sabe. */
  proveedor_ok: boolean | null;
  /** Días de la entrada respecto a la fecha del papel (`null` = falta alguna fecha). */
  dias: number | null;
  /** ¿Cae en la ventana `[-DIAS_ANTES, +DIAS_DESPUES]`? `null` = no se pudo medir. */
  en_ventana: boolean | null;
}

/** `YYYY-MM-DD` de un `date` de pg (llega como `Date` a medianoche LOCAL) o de un texto. */
function ymd(v?: string | Date | null): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}
const diaUtc = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000;

/** Las señales de desempate de UNA candidata. */
export function desempate(c: CandidataEntrada, l: LecturaPapel, rfcPropio?: string | null): Desempate {
  const rfcPapel = rfcBienFormado(l.rfc) && !esRfcPropio(l.rfc, rfcPropio) ? rfcComparable(l.rfc) : null;
  const rfcK = rfcBienFormado(c.proveedor_rfc) ? rfcComparable(c.proveedor_rfc) : null;
  let proveedor_ok: boolean | null = null;
  if (rfcPapel && rfcK) proveedor_ok = rfcPapel === rfcK;
  else {
    // El nombre sólo SUMA: el papel trae la razón social y Kepler el nombre comercial (GEORGINA
    // CUELLAR MARTÍNEZ ↔ EL FAROLITO). Un nombre distinto no prueba otro proveedor.
    const s = parecidoNombre(l.proveedor, c.proveedor_nombre);
    if (s != null && s >= UMBRAL_NOMBRE) proveedor_ok = true;
  }
  const f = ymd(l.fecha);
  const r = ymd(c.receipt_date);
  const dias = f && r ? Math.round(diaUtc(r) - diaUtc(f)) : null;
  const en_ventana = dias == null ? null : dias >= -DIAS_ANTES && dias <= DIAS_DESPUES;
  return { proveedor_ok, dias, en_ventana };
}

/**
 * Filtra y ordena las candidatas de UN papel. No inventa: lo que no se puede probar se queda.
 *
 * 1. Si alguna cae en la ventana de fechas, se quedan sólo ésas. Si ninguna cae (la fecha se
 *    leyó mal, o no hay), se quedan todas: perder la buena por una fecha mal leída es peor.
 * 2. Orden: proveedor confirmado → sin saber → RFC distinto · sin comprobante · más cerca en fecha
 *    · más cerca en importe.
 *
 * ⛔ El RFC distinto ORDENA, no descarta. La primera versión descartaba y perdía la entrada buena:
 * el RFC acierta el 49% aun con el proveedor correcto (`receipt-match.ts`: Kepler lo trae sucio).
 * Medido sobre 1,150 papeles: descartar dejaba 383 sin coincidencia; ordenar, 287.
 *
 * El resultado se enlaza solo únicamente si queda UNA (eso lo decide quien llama).
 */
export function ordenarCandidatas<T extends CandidataEntrada>(
  cands: T[], l: LecturaPapel, rfcPropio?: string | null,
): (T & Desempate)[] {
  let xs = cands.map((c) => ({ ...c, ...desempate(c, l, rfcPropio) }));
  if (xs.some((c) => c.en_ventana === true)) xs = xs.filter((c) => c.en_ventana === true);
  const total = l.total != null && Number.isFinite(Number(l.total)) ? Number(l.total) : null;
  const dif = (c: T) => (total == null || c.monto == null ? Number.POSITIVE_INFINITY : Math.abs(Number(c.monto) - total));
  const rangoProv = (v: boolean | null) => (v === true ? 0 : v === null ? 1 : 2);
  return xs.sort((a, b) =>
    rangoProv(a.proveedor_ok) - rangoProv(b.proveedor_ok)
    || (Number(a.deposits) || 0) - (Number(b.deposits) || 0)
    || (a.dias == null ? 1e9 : Math.abs(a.dias)) - (b.dias == null ? 1e9 : Math.abs(b.dias))
    || dif(a) - dif(b));
}
