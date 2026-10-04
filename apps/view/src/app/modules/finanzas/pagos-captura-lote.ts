/**
 * `[PC.3]` — **Qué tan seguro está el sistema de a qué pago va cada comprobante.**
 *
 * La captura por lote suelta varios PDFs a la vez; la IA lee cada uno y el servidor
 * (`/finance/supplier-payments/match-pago`) devuelve los pagos de Kepler con ese monto (±$1)
 * cerca de esa fecha (±7 días). Esta regla decide qué hace la persona con cada fila:
 *
 *  · **listo**    — un solo pago libre, y lo respalda algo MÁS que el monto (el folio de factura
 *                   del concepto coincide, o la fecha está a ±3 días). Viene marcado.
 *  · **revisar**  — hay un pago propuesto, pero sólo lo sostiene el monto (o ya tiene
 *                   comprobante). Un clic para confirmar.
 *  · **elegir**   — varios pagos posibles. La persona elige.
 *  · **sin_pago** — ninguno, o el OCR no leyó monto. Búsqueda a mano.
 *
 * ⛔ **Nada se guarda sin el clic de «Guardar».** «listo» sólo significa que la propuesta viene
 * pre-marcada: dos pagos del mismo monto al mismo proveedor en fechas cercanas son comunes, y
 * ligar mal un comprobante es ligar mal evidencia de dinero (ADR-016: el motor propone, la
 * persona confirma).
 *
 * ⛔ **Un pago que ya tiene comprobante nunca sale «listo»**: puede ser un segundo comprobante
 * legítimo, pero también el mismo subido dos veces. Se pide confirmar.
 */

/** Lo único que la regla necesita saber de un pago candidato. */
export interface CandidatoLote {
  sucursal: string;
  doc_prefix: string;
  folio: string;
  pago_date: string | null;
  deposits: number;
  concepto_match?: boolean;
}

export type Confianza = 'listo' | 'revisar' | 'elegir' | 'sin_pago';

export type MotivoConfianza =
  | 'factura_coincide'
  | 'fecha_cercana'
  | 'solo_monto'
  | 'ya_tiene_comprobante'
  | 'varios_pagos'
  | 'sin_monto'
  | 'sin_candidatos';

export interface Clasificacion<C extends CandidatoLote = CandidatoLote> {
  confianza: Confianza;
  /** El pago propuesto; `null` en «elegir» y «sin_pago». */
  propuesto: C | null;
  motivo: MotivoConfianza;
}

/** Días que separan la fecha del comprobante de la del pago para contar como «cercana». */
export const DIAS_FECHA_CERCANA = 3;

/** Llave de un pago: el folio NO es único entre doctypes (transferencia/cheque/anticipo). */
export function llavePago(c: Pick<CandidatoLote, 'sucursal' | 'doc_prefix' | 'folio'>): string {
  return `${c.doc_prefix} ${c.sucursal}/${c.folio}`;
}

/** Días entre dos fechas `YYYY-MM-DD…` (ignora la hora). `null` si alguna no se puede leer. */
export function diasEntre(a: string | null | undefined, b: string | null | undefined): number | null {
  const da = soloFecha(a);
  const db = soloFecha(b);
  if (da == null || db == null) return null;
  return Math.round(Math.abs(da - db) / 86_400_000);
}

function soloFecha(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function clasificar<C extends CandidatoLote>(
  ocr: { monto: number | null | undefined; fecha: string | null | undefined },
  candidatos: readonly C[],
): Clasificacion<C> {
  if (ocr.monto == null || !isFinite(Number(ocr.monto)) || Number(ocr.monto) <= 0) {
    return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_monto' };
  }
  if (!candidatos.length) return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_candidatos' };

  const libres = candidatos.filter((c) => !(c.deposits > 0));

  if (libres.length === 1) {
    const c = libres[0];
    if (c.concepto_match) return { confianza: 'listo', propuesto: c, motivo: 'factura_coincide' };
    const d = diasEntre(ocr.fecha, c.pago_date);
    if (d != null && d <= DIAS_FECHA_CERCANA) return { confianza: 'listo', propuesto: c, motivo: 'fecha_cercana' };
    return { confianza: 'revisar', propuesto: c, motivo: 'solo_monto' };
  }

  if (libres.length > 1) {
    // Varios pagos libres del mismo monto: si la factura del concepto señala exactamente uno,
    // se propone, pero NO pre-marcado (el folio de factura son dígitos y puede coincidir de más).
    const porFactura = libres.filter((c) => c.concepto_match);
    if (porFactura.length === 1) return { confianza: 'revisar', propuesto: porFactura[0], motivo: 'factura_coincide' };
    return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
  }

  // Todos los candidatos ya tienen comprobante.
  if (candidatos.length === 1) return { confianza: 'revisar', propuesto: candidatos[0], motivo: 'ya_tiene_comprobante' };
  return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
}

/** Texto corto que explica a la persona POR QUÉ la fila quedó como quedó. */
export function textoMotivo(m: MotivoConfianza): string {
  switch (m) {
    case 'factura_coincide': return 'La factura del concepto coincide';
    case 'fecha_cercana': return 'Mismo monto y fecha cercana';
    case 'solo_monto': return 'Sólo coincide el monto — confirma';
    case 'ya_tiene_comprobante': return 'Ese pago ya tiene comprobante — confirma';
    case 'varios_pagos': return 'Varios pagos con ese monto — elige';
    case 'sin_monto': return 'No se leyó el monto';
    case 'sin_candidatos': return 'Ningún pago de Kepler con ese monto cerca de esa fecha';
  }
}

/**
 * Pagos a los que apunta MÁS DE UNA fila del lote. Si dos comprobantes del mismo lote van al
 * mismo pago, ninguno de los dos puede guardarse sin que la persona lo resuelva.
 */
export function pagosRepetidos(llaves: readonly (string | null)[]): Set<string> {
  const vistos = new Set<string>();
  const rep = new Set<string>();
  for (const k of llaves) {
    if (!k) continue;
    if (vistos.has(k)) rep.add(k);
    else vistos.add(k);
  }
  return rep;
}
