import { EntradaDetail, EntradaLinea, ReceiptDeposit } from './entradas.service';
import { money } from '../../shared/util';

/**
 * `[RE.13.2]` — El veredicto de una recepción, en llano. **Función pura y compartida**:
 * la usan la vista completa (`/compras/entradas/todas`) y la bandeja de revisión
 * (`/compras/entradas/revision`), que es exactamente la pantalla donde este texto ES el
 * trabajo. Vivía dentro del componente de 1,826 líneas; copiarlo habría garantizado que
 * las dos pantallas terminaran diciendo cosas distintas del mismo expediente.
 *
 * La idea: las tres cifras comparables —lo que Kepler registró, la suma de los renglones y
 * lo que dice el papel del proveedor— no se leen solas. Un descuadre que resulta ser
 * exactamente el IVA no es un problema, y un delta crudo de $1,234.56 no le dice eso a nadie.
 */

/** Dos importes son el mismo por debajo de esto (centavos de redondeo del OCR). */
export const EPS = 1;
/** IVA estándar MX. Sirve para decir "la diferencia ES el IVA" en vez de dejar un delta crudo. */
export const IVA = 0.16;

export type VerdictTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface ReceiptVerdict {
  tone: VerdictTone;
  icon: string;
  kepler: number;
  lineas: number;
  ocr: number | null;
  delta: number | null;
  ocrMeta: string;
  lineasMeta: string;
  titulo: string;
  lectura: string;
}

export function lineasTotal(lineas: EntradaLinea[]): number {
  return (lineas || []).reduce((s, l) => s + (Number(l.importe) || 0), 0);
}

/** "1 renglón" / "2 renglones". Un plural mal puesto es de lo primero que se nota. */
export function plural(n: number, sing: string, plur: string): string {
  return `${n} ${n === 1 ? sing : plur}`;
}

/** El comprobante que manda para el cuadre: el validado si lo hay, si no el más reciente. */
export function depForCuadre(d: EntradaDetail): ReceiptDeposit | null {
  const deps = d.deposits || [];
  return deps.find((x) => x.status === 'validado') ?? deps[0] ?? null;
}

/**
 * @param hayAjustes si el proveedor tiene devoluciones/notas de crédito cerca de la fecha —
 *        cambia la pista del descuadre (es la explicación más frecuente después del IVA).
 */
export function receiptVerdict(d: EntradaDetail, hayAjustes = false): ReceiptVerdict {
  const kepler = Number(d.entrada.monto) || 0;
  const lineas = lineasTotal(d.lineas);
  const dep = depForCuadre(d);
  const ocr = dep?.ocr_monto != null ? Number(dep.ocr_monto) : null;
  const delta = ocr == null ? null : Number((ocr - kepler).toFixed(2));
  const conIva = Math.abs(lineas * (1 + IVA) - kepler) <= EPS;
  // Cómo se compone el total de Kepler: lo dice una vez, acá, y no se repite abajo.
  const ocrMeta = !dep ? 'sin remisión adjunta'
    : ocr == null ? 'el OCR no leyó el total'
    : `leído de ${dep.files?.[0]?.name || 'la hoja adjunta'}`;
  // Los renglones son el SUBTOTAL (cantidad × costo, kdm2) y el total de Kepler (c16) va con
  // impuestos, así que casi siempre difieren. Dejar la diferencia a la vista sin explicarla
  // hace dudar de un dato que está bien — y en dulcería no es solo IVA: hay IEPS, por eso no
  // se afirma "16%" salvo que el número lo confirme.
  const nLin = plural(d.lineas.length, 'renglón', 'renglones');
  const dImp = Number((kepler - lineas).toFixed(2));
  const lineasMeta =
    Math.abs(dImp) <= EPS ? `${nLin} · igual al total, sin impuestos`
    : conIva ? `${nLin} · subtotal; Kepler suma el IVA (+${money(dImp)})`
    : dImp > 0 ? `${nLin} · subtotal; Kepler suma impuestos (+${money(dImp)})`
    : `${nLin} · suman ${money(-dImp)} MÁS que el total de Kepler — revisar`;

  if (!dep) {
    return { tone: 'muted', icon: 'pi-paperclip', kepler, lineas, ocr, delta, ocrMeta, lineasMeta,
      titulo: 'Falta la remisión del proveedor',
      lectura: `Kepler registró ${money(kepler)}. Sin el documento adjunto no hay contra qué compararlo — adjuntalo para cerrar la recepción.` };
  }
  if (ocr == null) {
    return { tone: 'warn', icon: 'pi-eye-slash', kepler, lineas, ocr, delta, ocrMeta, lineasMeta,
      titulo: 'El documento está, pero no se pudo leer su total',
      lectura: `Kepler registró ${money(kepler)}. El OCR no encontró el total en la hoja: hay que verificarlo a ojo contra el documento de la derecha.` };
  }
  if (Math.abs(delta as number) <= EPS) {
    return { tone: 'ok', icon: 'pi-check-circle', kepler, lineas, ocr, delta, ocrMeta, lineasMeta,
      titulo: 'El documento cuadra con Kepler',
      lectura: `La remisión dice ${money(ocr)} y Kepler registró ${money(kepler)}: coinciden al centavo.` };
  }
  const dif = Math.abs(delta as number);
  const sentido = (delta as number) > 0 ? 'El documento cobra de MÁS' : 'El documento cobra de MENOS';
  // Explicaciones frecuentes, en orden de probabilidad. Son pistas, no conclusiones.
  const pista = Math.abs(dif - lineas * IVA) <= EPS
    ? ' La diferencia es exactamente el IVA de los renglones — probablemente uno de los dos importes va sin impuesto.'
    : hayAjustes
      ? ' Hay devoluciones o notas de crédito de este proveedor cerca de la fecha; mirá "¿Por qué no cuadra?" más abajo.'
      : '';
  return { tone: 'bad', icon: 'pi-exclamation-triangle', kepler, lineas, ocr, delta, ocrMeta, lineasMeta,
    titulo: `${sentido} ${money(dif)}`,
    lectura: `La remisión dice ${money(ocr)} y Kepler registró ${money(kepler)}.${pista}` };
}

/** Catálogo de motivos de rechazo (RE.13.2). Sin esto el motivo es texto libre y no se puede medir. */
export const MOTIVOS_RECHAZO: { code: string; label: string }[] = [
  { code: 'ilegible', label: 'La hoja está ilegible' },
  { code: 'no_corresponde', label: 'No corresponde a esta entrada' },
  { code: 'total_no_cuadra', label: 'El total no cuadra' },
  { code: 'falta_hoja', label: 'Falta una hoja del paquete' },
  { code: 'duplicada', label: 'Ya se había subido (duplicada)' },
  { code: 'otro', label: 'Otro (explicar)' },
];

export function motivoLabel(code?: string | null): string {
  return MOTIVOS_RECHAZO.find((m) => m.code === code)?.label || '';
}
