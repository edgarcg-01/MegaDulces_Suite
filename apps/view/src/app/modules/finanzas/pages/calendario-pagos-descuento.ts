import type { DiscountReason } from '@megadulces/contracts';

/**
 * `[PGP.91]` **La cuenta del descuento al pagar**, fuera del componente para probarla sin TestBed.
 *
 * El proveedor concede un descuento al pagar (pronto pago, volumen u otro): se transfiere el NETO y
 * lo que este pago cubre de la factura queda CUBIERTO por neto + descuento (con «Agregar con otro
 * importe» es sólo una parte de la factura, no la factura completa). Lo cubierto no cambia al capturar
 * el descuento; lo que baja es lo que sale del banco. El % va sobre lo cubierto (con IVA), la misma
 * base que la tasa observada de pronto pago y que la regla del servidor (`normalizarDescuento`).
 *
 * ⛔ Ni el % ni los pesos se leen con `numero()` del componente: ése quita las comas, y «3,5» se
 * volvería 35 y «1166,40» se volvería 116640.
 */

/** `ninguno` = todavía no se eligió motivo (el diálogo abre así en una factura sin descuento). */
export type MotivoDescuento = DiscountReason | 'ninguno';
/** Qué capturó la persona: el % (la tasa se guarda) o los pesos (la tasa no se guarda). */
export type ModoDescuento = 'tasa' | 'pesos';
export interface CuentaDescuento {
  /** Fracción (0.03 = 3 %). En modo pesos es derivada, sólo para mostrar; no se manda. */
  tasa: number | null;
  /** Pesos que se descuentan, a centavos. */
  descuento: number;
  /** Lo que se transfiere: cubierto − descuento. */
  neto: number;
}

/** Redondeo a centavos. El `EPSILON` evita que 1.005 se vaya a 1.00 (el mismo que el servidor). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * % tecleado → fracción con 6 decimales (cabe en `numeric(9,6)` y es lo que el servidor redondea).
 * Liberal con la FORMA (Postel): acepta «3», «3.5», «3,5» y «3 %» (en un % no hay miles, así que la
 * coma sólo puede ser decimal). Lo que no es un número > 0 da null.
 */
export function tasaDePct(txt: string | null | undefined): number | null {
  const p = Number(String(txt ?? '').replace(/[\s%]/g, '').replace(',', '.'));
  return Number.isFinite(p) && p > 0 ? Math.round(p * 1e4) / 1e6 : null;
}

/** Lo que se entendió del campo de pesos: el importe, o por qué no se entiende (null = vacío o válido). */
export interface PesosLeidos {
  pesos: number | null;
  error: string | null;
}
export const PESOS_AMBIGUO = 'Escribe los centavos con punto (1,166.40).';
export const PESOS_NO_SE_ENTIENDE = 'Ese importe no se entiende.';

/**
 * `[PGP.91]` **Pesos tecleados → importe, sin adivinar.** Liberal con la FORMA (Postel): «1166.40»,
 * «1,166.40», «$1,166.40», «$ 1,166.40», «1166». La coma SÓLO es separador de miles, en grupos de 3
 * dígitos. ⛔ Estricto con el SIGNIFICADO: «1166,40» o «12,5» (coma seguida de 1 o 2 dígitos al final,
 * sin punto) pueden ser centavos o miles mal escritos — es ambiguo y se pregunta, no se elige: con
 * `numero()` «1166,40» pasaba como $116,640 y cabía en una factura de $149,640.17. Más de 2 decimales,
 * signo, letras o grupos mal formados: no se entiende.
 */
export function leerPesos(txt: string | null | undefined): PesosLeidos {
  // Sólo se toleran los espacios de las orillas y el que va después del «$». Un espacio ENTRE dígitos
  // («1166 40») es ambiguo —¿miles o centavos?— y quitarlo leería ×100: no se adivina.
  const s = String(txt ?? '').trim().replace(/^\$\s+/, '$');
  if (!s) return { pesos: null, error: null };
  if (/\s/.test(s)) return { pesos: null, error: PESOS_NO_SE_ENTIENDE };
  const cuerpo = s.startsWith('$') ? s.slice(1) : s;
  if (/^[\d,]*\d,\d{1,2}$/.test(cuerpo)) return { pesos: null, error: PESOS_AMBIGUO };
  const forma = /^\d+(\.\d{1,2})?$/.test(cuerpo) || /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(cuerpo);
  if (!forma) return { pesos: null, error: PESOS_NO_SE_ENTIENDE };
  const n = Number(cuerpo.replace(/,/g, ''));
  return Number.isFinite(n) ? { pesos: round2(n), error: null } : { pesos: null, error: PESOS_NO_SE_ENTIENDE };
}
/** El importe solo (null = vacío, ambiguo o no se entiende). */
export function pesosDeTexto(txt: string | null | undefined): number | null {
  return leerPesos(txt).pesos;
}

/** Fracción → el % como se teclea («3», «3.5», «12.86»). Sirve para reabrir lo ya guardado. */
export function pctDeTasa(rate: number | string | null | undefined): string {
  const r = Number(rate);
  return rate === null || rate === undefined || !(r > 0) ? '' : String(Math.round(r * 1e6) / 1e4);
}

/** Lo que este pago cubre de la factura: neto + descuento. `Number()`: los numeric llegan como texto. */
export function cubiertoDe(it: { applied_amount: number | string; discount_amount?: number | string | null }): number {
  return round2(Number(it.applied_amount || 0) + Number(it.discount_amount || 0));
}

/**
 * La cuenta del diálogo: «este pago cubre − descuento = se transfieren».
 * - modo `tasa`: descuento = cubierto × tasa, a centavos (la misma cuenta con la que el servidor
 *   revisa que cuadre).
 * - modo `pesos`: el descuento es lo tecleado; la tasa sale de dividir, sólo para mostrarla.
 */
export function cuenta(cubierto: number, modo: ModoDescuento, pctTxt: string, pesos: number): CuentaDescuento {
  const c = round2(Number(cubierto) || 0);
  const p = Number(pesos) || 0;
  const tasa = modo === 'tasa' ? tasaDePct(pctTxt) : (c > 0 && p > 0 ? p / c : null);
  const descuento = modo === 'tasa' ? (tasa ? round2(c * tasa) : 0) : (p > 0 ? round2(p) : 0);
  return { tasa, descuento, neto: round2(c - descuento) };
}

/**
 * Por qué todavía no se puede guardar (null = se puede). Va ANTES del clic (poka-yoke): el botón
 * se apaga y la razón se lee junto a la cuenta. Son las mismas reglas que el servidor exige.
 * `errorPesos`: lo que `leerPesos` no entendió del campo de pesos (sólo en modo pesos); va primero,
 * porque un importe que no se entiende no es «falta capturar».
 */
export function faltaDescuento(motivo: MotivoDescuento, c: CuentaDescuento, cubierto: number, nota: string, errorPesos: string | null = null): string | null {
  if (errorPesos) return errorPesos;
  if (!(c.descuento > 0)) return motivo === 'ninguno' ? 'Elige el motivo y captura el % o los pesos.' : 'Captura el % o los pesos del descuento.';
  if (!(c.descuento < round2(cubierto) - 0.005) || !(c.tasa !== null && c.tasa > 0 && c.tasa < 1)) {
    return 'El descuento tiene que ser menor que lo que este pago cubre de la factura.';
  }
  if (motivo === 'ninguno') return 'Elige el motivo del descuento.';
  if (motivo === 'otro' && !(nota ?? '').trim()) return 'Falta el detalle: di qué descuento es.';
  return null;
}
