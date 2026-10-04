/**
 * `[PC.3]`/`[PC.5]` — **Qué tan seguro está el sistema de a qué pago va cada comprobante.**
 *
 * La captura por lote suelta varios PDFs a la vez; la IA lee cada uno y el servidor
 * (`/finance/supplier-payments/match-pago`) devuelve los pagos de Kepler con ese monto (±$1)
 * cerca de esa fecha (±7 días). Encontrar candidatos NO es darlos por buenos: eso lo decide esta
 * regla, con las **cuatro coincidencias exactas** que pidió el usuario (2026-10-03):
 *
 *  · **Banco**     — la cuenta de origen del comprobante es la cuenta de la que Kepler dice que
 *                    salió el pago (`kdm1.c45` ⋈ `kdb1`, vía `analytics.kepler_bank_movements`).
 *  · **Fecha**     — el mismo día.
 *  · **Monto**     — al centavo.
 *  · **Proveedor** — el beneficiario del comprobante es el proveedor del pago.
 *
 * Con eso cada fila queda:
 *  · **listo**    — exactamente UN pago libre en el que coinciden las cuatro. Viene marcado.
 *  · **revisar**  — hay un pago propuesto, pero algo no coincide (o no se pudo leer), o el pago ya
 *                   tiene comprobante. La pantalla marca qué falla; un clic para confirmar.
 *  · **elegir**   — varios pagos posibles y ninguno se distingue. La persona elige.
 *  · **sin_pago** — ninguno, o el OCR no leyó monto. Búsqueda a mano.
 *
 * ⛔ **Nada se guarda sin el clic de «Guardar».** «listo» sólo significa que viene pre-marcado.
 * ⛔ **Lo que no se pudo leer NO cuenta como coincidencia** (`sin_dato` ≠ `ok`): un comprobante
 * sin cuenta de origen legible nunca sale «listo».
 * ⛔ **Un pago que ya tiene comprobante nunca sale «listo»**: puede ser el mismo papel dos veces.
 */

import {
  CRITERIOS_PAGO, ETIQUETA_CRITERIO_PAGO, coincidenciasPago, coincidenTodas, puntosCoincidencia,
  type Chequeo, type CoincidenciasPago, type LecturaComprobante,
} from '@megadulces/contracts';

/** Las comparaciones viven en `libs/contracts` (las usa también el servidor para validar solo). */
export type { Chequeo, CoincidenciasPago as Coincidencias, LecturaComprobante as LecturaOcr };
export const CRITERIOS = CRITERIOS_PAGO;
export const ETIQUETA_CRITERIO = ETIQUETA_CRITERIO_PAGO;
export const coincidencias = (ocr: LecturaComprobante, c: CandidatoLote) => coincidenciasPago(ocr, c);


/** Lo único que la regla necesita saber de un pago candidato. */
export interface CandidatoLote {
  sucursal: string;
  doc_prefix: string;
  folio: string;
  monto: number;
  pago_date: string | null;
  /** El día del pago como `YYYY-MM-DD` (el servidor lo manda como texto para que no se corra). */
  pago_dia?: string | null;
  proveedor_nombre: string | null;
  deposits: number;
  /** Cuenta propia de la que salió el pago, según Kepler (`kdb1.c1`, p. ej. `1463`). */
  clave_banco?: string | null;
  /** La misma cuenta como la conoce Bancos (`finance.bank_accounts.account_label`). */
  account_label?: string | null;
  concepto_match?: boolean;
}


export type Confianza = 'listo' | 'revisar' | 'elegir' | 'sin_pago';

export type MotivoConfianza =
  | 'cuatro_coinciden'
  | 'no_coincide_todo'
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

// ── la decisión ─────────────────────────────────────────────────────────────

export function clasificar<C extends CandidatoLote>(ocr: LecturaComprobante, candidatos: readonly C[]): Clasificacion<C> {
  if (ocr.monto == null || !isFinite(Number(ocr.monto)) || Number(ocr.monto) <= 0) {
    return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_monto' };
  }
  if (!candidatos.length) return { confianza: 'sin_pago', propuesto: null, motivo: 'sin_candidatos' };

  const libres = candidatos.filter((c) => !(c.deposits > 0));
  const conPuntos = libres.map((c) => ({ c, k: coincidencias(ocr, c) }));

  const perfectos = conPuntos.filter((x) => coincidenTodas(x.k));
  if (perfectos.length === 1) return { confianza: 'listo', propuesto: perfectos[0].c, motivo: 'cuatro_coinciden' };
  if (perfectos.length > 1) return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };

  if (conPuntos.length === 1) return { confianza: 'revisar', propuesto: conPuntos[0].c, motivo: 'no_coincide_todo' };
  if (conPuntos.length > 1) {
    // Se propone el que más coincide, sólo si se distingue de los demás. Si empatan, elige la persona.
    const orden = [...conPuntos].sort((a, b) => puntosCoincidencia(b.k) - puntosCoincidencia(a.k));
    if (puntosCoincidencia(orden[0].k) > puntosCoincidencia(orden[1].k)) return { confianza: 'revisar', propuesto: orden[0].c, motivo: 'no_coincide_todo' };
    return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
  }

  // Todos los candidatos ya tienen comprobante.
  if (candidatos.length === 1) return { confianza: 'revisar', propuesto: candidatos[0], motivo: 'ya_tiene_comprobante' };
  return { confianza: 'elegir', propuesto: null, motivo: 'varios_pagos' };
}

/** Texto corto que explica a la persona POR QUÉ la fila quedó como quedó. */
export function textoMotivo(m: MotivoConfianza): string {
  switch (m) {
    case 'cuatro_coinciden': return 'Coinciden banco, fecha, monto y proveedor';
    case 'no_coincide_todo': return 'No coincide todo — revisa lo marcado';
    case 'ya_tiene_comprobante': return 'Ese pago ya tiene comprobante — confirma';
    case 'varios_pagos': return 'Varios pagos posibles — elige';
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
