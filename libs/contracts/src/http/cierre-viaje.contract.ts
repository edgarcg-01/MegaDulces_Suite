/**
 * `[EMB.24]`–`[EMB.29]` — Pago por viaje cerrado (ADR-091). Contrato compartido entre la API de
 * logística, la de Gastos y las pantallas: la forma de lo que se lee y las reglas de lo que se
 * escribe viven aquí una sola vez, para que pantalla y servidor no puedan decir cosas distintas.
 *
 * Cómo se cierra cada parada (decisiones del usuario, 2026-10-09/12):
 *  · Traspaso a sucursal  → con la RECEPCIÓN que captura la sucursal destino en Kepler (U-A-50).
 *                           Si recibe menos, la parada queda con diferencia; NO frena el pago.
 *  · Carga a camión de ruta → al embarcarse.
 *  · Cliente (Telemarketing) → con la REMISIÓN FIRMADA que sube Logística al regreso (opción A).
 * El viaje se libera cuando ninguna parada está pendiente. La maniobra de carga se libera al
 * registrar la carga de un embarque que ya está en Kepler: cargar no depende de la ruta.
 */

export type TipoParada = 'traspaso' | 'cliente' | 'carga_ruta' | 'otro' | 'manual' | 'sin_documento';
export type EstadoParada = 'cerrada' | 'diferencia' | 'pendiente';
export type EstadoViaje =
  | 'abierto'
  | 'cerrado'
  | 'cerrado_con_diferencia'
  | 'guia_incompleta'
  | 'sin_paradas'
  | 'cancelado';
export type ConceptoPago = 'comision' | 'viatico' | 'maniobra_carga';
export type ResultadoParada = 'entregado' | 'no_entregado';
/** Los mismos valores que el CHECK de `logistics.guide_recipients.incident_type`. */
export type MotivoNoEntrega = 'not_located' | 'wrong_address' | 'customer_rejected' | 'missing_product' | 'other';

/** El concepto de gasto de Kepler con que se registra cada pago (ERP_KEPLER §3.y.2). */
export const CONCEPTO_KEPLER: Record<ConceptoPago, { codigo: string; nombre: string }> = {
  comision: { codigo: '075', nombre: 'Comisiones logísticas' },
  viatico: { codigo: '128', nombre: 'Viáticos entrega clientes' },
  maniobra_carga: { codigo: '186', nombre: 'Maniobras (carga)' },
};

export const ESTADO_VIAJE_LABEL: Record<EstadoViaje, string> = {
  abierto: 'Abierto',
  cerrado: 'Cerrado',
  cerrado_con_diferencia: 'Cerrado con diferencia',
  guia_incompleta: 'Guía incompleta',
  sin_paradas: 'Sin paradas',
  cancelado: 'Cancelado',
};

export const MOTIVO_NO_ENTREGA_LABEL: Record<MotivoNoEntrega, string> = {
  not_located: 'No se encontró al cliente',
  wrong_address: 'Dirección equivocada',
  customer_rejected: 'El cliente no la recibió',
  missing_product: 'Faltó producto',
  other: 'Otro',
};

/** Una parada de la guía con cómo se cerró (`logistics.v_trip_stop_closure`). */
export interface ParadaCierre {
  recipient_id: string;
  guide_id: string;
  sequence_order: number | null;
  customer_name: string;
  kepler_serie: string | null;
  kepler_folio: string | null;
  value: number | null;
  tipo_parada: TipoParada;
  destino_code: string | null;
  importe_embarcado: number | null;
  recepcion_folio: string | null;
  recepcion_importe: number | null;
  recepcion_fecha: string | null;
  diferencia: number | null;
  recipient_status: string;
  delivered_at: string | null;
  delivered_to: string | null;
  incident_type: MotivoNoEntrega | null;
  incident_notes: string | null;
  estado_parada: EstadoParada;
  motivo: string;
  /** URL temporal para ver la remisión subida. `null` = no hay remisión. */
  remision_url: string | null;
}

/** Estado de un viaje (`logistics.v_trip_state`). */
export interface EstadoDeViaje {
  guide_id: string;
  guide_number: string;
  shipment_id: string;
  shipment_folio: string;
  kepler_sucursal: string | null;
  kepler_guia: string | null;
  shipment_date: string;
  estado_viaje: EstadoViaje;
  paradas: number;
  paradas_cerradas: number;
  paradas_con_diferencia: number;
  paradas_pendientes: number;
}

/** Lo que una persona tiene por un viaje o una carga (`logistics.v_trip_pay_items`). */
export interface PagoViaje {
  source: 'guia' | 'carga';
  source_id: string;
  shipment_id: string;
  shipment_folio: string;
  kepler_sucursal: string | null;
  kepler_guia: string | null;
  shipment_date: string;
  guide_number: string | null;
  driver_id: string;
  persona: string;
  rol: 'chofer' | 'ayudante' | 'cargador';
  concept: ConceptoPago;
  amount: number;
  estado_viaje: EstadoViaje | 'cargado' | 'sin_salida';
  liberado: boolean;
  motivo: string;
  en_vale: boolean;
  expense_proof_id: string | null;
  vale_status: string | null;
  vale_folio: string | null;
}

export interface CargadorRegistrado {
  id: string;
  driver_id: string;
  persona: string;
  rate: number;
  pagado: boolean;
}

/** `GET /logistics/trip-closure/shipments/:id` */
export interface CierreDeEmbarque {
  shipment_id: string;
  viajes: EstadoDeViaje[];
  paradas: ParadaCierre[];
  pagos: PagoViaje[];
  cargadores: CargadorRegistrado[];
  /** `null` = no está capturada: no se pueden registrar cargadores hasta capturarla. */
  tarifa_carga: number | null;
}

/** `POST /logistics/trip-closure/paradas/:recipientId/cierre` */
export interface CerrarParadaBody {
  resultado: ResultadoParada;
  /** Quién recibió. Obligatorio si se entregó. */
  recibio?: string | null;
  /** Por qué no se entregó. Obligatorio si no se entregó. */
  motivo?: MotivoNoEntrega | null;
  nota?: string | null;
  /**
   * Foto de la remisión firmada (o de la evidencia de no entrega), como data URI. OPCIONAL por
   * decisión del 2026-10-12: por ahora la parada se cierra con el resultado registrado por
   * Logística. Si se manda, se valida y se guarda.
   */
  foto?: string | null;
}

/** `PUT /logistics/trip-closure/shipments/:id/cargadores` */
export interface CargadoresBody {
  driver_ids: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOTO = /^data:(image\/(jpeg|jpg|png|webp|heic)|application\/pdf);base64,/i;
/** ~8 MB de archivo (en base64 pesa 4/3). */
export const FOTO_MAX_CHARS = 11_200_000;
export const CARGADORES_MAX = 10;

/** Las paradas que la Suite cierra a mano. Traspasos y cargas a ruta las cierra Kepler. */
export function seCierraEnLaSuite(tipo: TipoParada): boolean {
  return tipo === 'cliente' || tipo === 'manual' || tipo === 'sin_documento' || tipo === 'otro';
}

/** Todo lo que impide cerrar la parada. Vacío = se puede. */
export function erroresDeCierreDeParada(
  body: Partial<CerrarParadaBody> | null | undefined,
  parada: { tipo_parada: TipoParada; recipient_status: string },
): string[] {
  const errs: string[] = [];
  if (!seCierraEnLaSuite(parada.tipo_parada)) {
    errs.push(
      parada.tipo_parada === 'traspaso'
        ? 'Esta parada es un traspaso: se cierra sola cuando la sucursal destino captura la recepción en Kepler.'
        : 'Esta parada es una carga a camión de ruta: se cierra al embarcar.',
    );
    return errs;
  }
  if (parada.recipient_status !== 'pendiente') {
    errs.push('La parada ya se cerró.');
    return errs;
  }
  const b = body ?? {};
  if (b.resultado !== 'entregado' && b.resultado !== 'no_entregado') {
    errs.push('Indica si se entregó o no.');
  }
  if (b.resultado === 'entregado') {
    const r = (b.recibio ?? '').trim();
    if (r.length < 2) errs.push('Escribe el nombre de quien recibió.');
    if (r.length > 200) errs.push('El nombre de quien recibió es demasiado largo.');
  }
  if (b.resultado === 'no_entregado') {
    if (!b.motivo || !(b.motivo in MOTIVO_NO_ENTREGA_LABEL)) errs.push('Elige por qué no se entregó.');
    if (b.motivo === 'other' && !(b.nota ?? '').trim()) errs.push('Explica el motivo.');
  }
  const foto = b.foto ?? '';
  if (foto && !FOTO.test(foto)) errs.push('La foto debe ser una imagen o un PDF.');
  else if (foto && foto.length > FOTO_MAX_CHARS) errs.push('La foto pesa más de 8 MB.');
  return errs;
}

/** Todo lo que impide registrar los cargadores. Vacío = se puede. */
export function erroresDeCargadores(body: Partial<CargadoresBody> | null | undefined, tarifa: number | null): string[] {
  const errs: string[] = [];
  if (tarifa == null || !(tarifa > 0)) {
    errs.push('Falta capturar la tarifa de carga por persona en Logística › Configuración (tarifa_maniobra_carga).');
  }
  const ids = body?.driver_ids;
  if (!Array.isArray(ids)) {
    errs.push('Lista de cargadores inválida.');
    return errs;
  }
  if (ids.some((i) => typeof i !== 'string' || !UUID.test(i))) errs.push('Hay un cargador inválido.');
  if (new Set(ids).size !== ids.length) errs.push('Un cargador está repetido.');
  if (ids.length > CARGADORES_MAX) errs.push(`Máximo ${CARGADORES_MAX} cargadores por carga.`);
  return errs;
}

/** Suma por concepto, redondeada a centavos. */
export function totalesPorConcepto(items: Pick<PagoViaje, 'concept' | 'amount'>[]): Record<ConceptoPago, number> {
  const t: Record<ConceptoPago, number> = { comision: 0, viatico: 0, maniobra_carga: 0 };
  for (const i of items) t[i.concept] = Math.round((t[i.concept] + Number(i.amount || 0)) * 100) / 100;
  return t;
}
