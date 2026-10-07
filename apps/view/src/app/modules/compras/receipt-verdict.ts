import { EntradaDetail, EntradaLinea, ReceiptDeposit, type MotivoDescarte } from './entradas.service';
import { money } from '../../shared/util';

/**
 * `[RE.13.2]` — El veredicto de una recepción, en llano. **Función pura y compartida**: la usa
 * la vista completa (`/compras/entradas/control/ordenes`), que desde `[RE.24]` es **la** pantalla
 * donde este texto ES el trabajo (la cabina de revisión quedó fuera de uso, pero la sigue
 * importando y por eso esto no se movió). Vivía dentro del componente de 1,826 líneas; copiarlo
 * habría garantizado que las pantallas terminaran diciendo cosas distintas del mismo expediente.
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
  /** RE.14 — la otra captura de la MISMA recepción (oficinas), cuando el par está vigente. */
  gemela: { folio: string; monto: number | null; delta: number | null } | null;
}

/**
 * `[RE.14.4]` — La copia de oficinas que **vale como espejo**. Un par apenas `propuesto` no se
 * usa para explicar el cuadre: si el apareo todavía no está dictaminado, apoyarse en él sería
 * justificar una factura con un documento que quizá no es de esta recepción. `status` puede venir
 * indefinido en respuestas viejas del server, donde `cedis_twins` sólo traía pares vigentes.
 */
export function gemelaVigente(d: EntradaDetail) {
  return (d.cedis_twins || []).find((t) => (t.status ?? 'auto') !== 'propuesto' && t.monto != null) || null;
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
  const gv = gemelaVigente(d);
  const gemela = gv
    ? { folio: gv.folio, monto: gv.monto, delta: gv.monto == null ? null : Number((gv.monto - kepler).toFixed(2)) }
    : null;
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
    return { tone: 'muted', icon: 'pi-paperclip', kepler, lineas, ocr, delta, ocrMeta, lineasMeta, gemela,
      titulo: 'Falta la remisión del proveedor',
      lectura: `Kepler registró ${money(kepler)}. Sin el documento adjunto no hay contra qué compararlo — adjuntalo para cerrar la recepción.` };
  }
  if (ocr == null) {
    return { tone: 'warn', icon: 'pi-eye-slash', kepler, lineas, ocr, delta, ocrMeta, lineasMeta, gemela,
      titulo: 'El documento está, pero no se pudo leer su total',
      lectura: `Kepler registró ${money(kepler)}. El OCR no encontró el total en la hoja: hay que verificarlo a ojo contra el documento de la derecha.` };
  }
  if (Math.abs(delta as number) <= EPS) {
    return { tone: 'ok', icon: 'pi-check-circle', kepler, lineas, ocr, delta, ocrMeta, lineasMeta, gemela,
      titulo: 'El documento cuadra con Kepler',
      lectura: `La remisión dice ${money(ocr)} y Kepler registró ${money(kepler)}: coinciden al centavo.` };
  }
  const dif = Math.abs(delta as number);
  // RE.14.4 — la MISMA recepción está capturada dos veces y los dos importes no siempre casan al
  // centavo. Si la factura coincide con la captura de oficinas, el papel del proveedor está bien:
  // lo que difiere son NUESTRAS dos capturas. Decirle "el documento cobra de más" al capturista
  // lo manda a pelearse con un proveedor que no se equivocó.
  if (gemela?.monto != null && Math.abs(ocr - gemela.monto) <= EPS) {
    return { tone: 'warn', icon: 'pi-clone', kepler, lineas, ocr, delta, ocrMeta, lineasMeta, gemela,
      titulo: 'Cuadra con la captura de oficinas, no con la de la sucursal',
      lectura: `La remisión dice ${money(ocr)} y coincide con lo que oficinas capturó en su folio ${gemela.folio} (${money(gemela.monto)}). La de la sucursal dice ${money(kepler)}: la diferencia de ${money(dif)} es entre nuestras dos capturas, no con el proveedor.` };
  }
  const sentido = (delta as number) > 0 ? 'El documento cobra de MÁS' : 'El documento cobra de MENOS';
  // Explicaciones frecuentes, en orden de probabilidad. Son pistas, no conclusiones.
  const pista = Math.abs(dif - lineas * IVA) <= EPS
    ? ' La diferencia es exactamente el IVA de los renglones — probablemente uno de los dos importes va sin impuesto.'
    : hayAjustes
      ? ' Hay devoluciones o notas de crédito de este proveedor cerca de la fecha; mirá "¿Por qué no cuadra?" más abajo.'
      : '';
  return { tone: 'bad', icon: 'pi-exclamation-triangle', kepler, lineas, ocr, delta, ocrMeta, lineasMeta, gemela,
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

/**
 * `[RE.20.3]` — motivos de **descarte**. Distintos de los de rechazo a propósito: devolver
 * rebota a la sucursal para que suba algo que sí existe; descartar dice que **no existe ni va a
 * existir** una factura de proveedor. Confundirlos deja a la sucursal persiguiendo un papel que
 * nadie va a emitir.
 *
 * `pista` es lo que el revisor tiene que reconocer en la fila para elegir bien.
 */
export const MOTIVOS_DESCARTE: { code: MotivoDescarte; label: string; pista: string }[] = [
  { code: 'traspaso', label: 'Traspaso entre sucursales', pista: 'El proveedor es otra sucursal (código TI…), no hay factura externa.' },
  { code: 'cancelada_erp', label: 'Cancelada o capturada por error', pista: 'El documento no debía existir; quedó en Kepler.' },
  { code: 'duplicada', label: 'Ya está capturada en otra orden', pista: 'La misma recepción entró dos veces con folios distintos.' },
  { code: 'sin_costo', label: 'Entrada sin costo ($0)', pista: 'Muestra, bonificación o corrección: no genera factura.' },
  { code: 'otro', label: 'Otro (explicar)', pista: 'Escribí por qué: el descarte saca la fila del número que se vigila.' },
];

export function motivoDescarteLabel(code?: string | null): string {
  return MOTIVOS_DESCARTE.find((m) => m.code === code)?.label || '';
}
