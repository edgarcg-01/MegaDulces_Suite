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
  /** Lo que cobra esta persona por la carga (su parte del reparto). */
  rate: number;
  pagado: boolean;
}

/** `[EMB.39]` De dónde salen las cajas de la carga. */
export type FuenteCajas = 'kepler' | 'captura';

/**
 * `[EMB.39]` Con qué se paga la carga del embarque: **tarifa por caja × cajas**, repartido en
 * partes iguales entre quienes cargaron (decisión de Edgar, 2026-10-24).
 */
export interface CargaDelEmbarque {
  /** La tarifa por caja VIGENTE el día del embarque. `null` = ese día no había tarifa. */
  tarifa_por_caja: number | null;
  /**
   * Cajas del embarque. Kepler: Σ `kdm2.c54` con presentación CJA/BTO de todas las paradas de la
   * guía. Embarque manual: las capturadas. `null` = no se sabe (no es lo mismo que 0).
   */
  cajas: number | null;
  fuente_cajas: FuenteCajas | null;
  /** Cajas × tarifa, a centavos. `null` si falta cualquiera de las dos. */
  total: number | null;
}

/** `GET /logistics/trip-closure/shipments/:id` */
export interface CierreDeEmbarque {
  shipment_id: string;
  viajes: EstadoDeViaje[];
  paradas: ParadaCierre[];
  pagos: PagoViaje[];
  cargadores: CargadorRegistrado[];
  /** `[EMB.39]` Tarifa, cajas y total de la carga. Sin tarifa o sin cajas no se registran cargadores. */
  carga: CargaDelEmbarque;
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

/** `[EMB.39]` La llave de `logistics.config_finance` con la tarifa de carga por caja. */
export const TARIFA_CARGA_CAJA_KEY = 'tarifa_carga_caja';

const centavos = (v: number): number => Math.round(v * 100);

/** `[EMB.39]` Cajas × tarifa, a centavos. `null` si falta cualquiera de las dos. */
export function totalDeCarga(cajas: number | null, tarifaPorCaja: number | null): number | null {
  if (cajas == null || tarifaPorCaja == null || !Number.isFinite(cajas) || !Number.isFinite(tarifaPorCaja)) return null;
  return centavos(cajas * tarifaPorCaja) / 100;
}

/**
 * `[EMB.39]` Reparte el total de la carga en partes iguales, a centavos, sin perder ni inventar
 * un centavo: lo que no divide exacto va, de a uno, a los primeros de la lista. La suma de las
 * partes es SIEMPRE el total. Sin personas, no hay partes.
 */
export function repartoDeCarga(total: number, personas: number): number[] {
  if (!(personas > 0) || !Number.isFinite(total) || total <= 0) return Array.from({ length: Math.max(0, personas) }, () => 0);
  const c = centavos(total);
  const base = Math.floor(c / personas);
  const sobran = c - base * personas;
  return Array.from({ length: personas }, (_, i) => (base + (i < sobran ? 1 : 0)) / 100);
}

/** Todo lo que impide registrar los cargadores. Vacío = se puede. */
export function erroresDeCargadores(
  body: Partial<CargadoresBody> | null | undefined,
  carga: Pick<CargaDelEmbarque, 'tarifa_por_caja' | 'cajas'> | null,
): string[] {
  const errs: string[] = [];
  const ids = body?.driver_ids;
  if (!Array.isArray(ids)) {
    errs.push('Lista de cargadores inválida.');
    return errs;
  }
  // Quitar a todos no paga nada: no necesita tarifa ni cajas.
  if (ids.length) {
    if (carga?.tarifa_por_caja == null || !(carga.tarifa_por_caja > 0)) {
      errs.push(`No hay tarifa de carga por caja vigente para la fecha del embarque: captúrala en Logística › Configuración (${TARIFA_CARGA_CAJA_KEY}).`);
    }
    if (carga?.cajas == null) {
      errs.push('No se sabe cuántas cajas lleva el embarque: captúralas en «Información» antes de registrar a quienes cargaron.');
    }
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

// ── `[EMB.43]` La catorcena: el corte de pago de Logística ─────────────────────────────────────
//
// Vivía en `libs/finance/.../trip-pay.logic.ts`; se muda aquí porque ahora la usan DOS pantallas
// (Logística › Pagos de viaje y Finanzas › Comisiones de logística) y el servidor. Una regla de dos
// pantallas vive en el contrato una sola vez.
//
// El corte es CATORCENAL de jueves a miércoles, anclado en el jueves 1-ene-2026 (el calendario que
// ya siembra `logistics_baseline.js`). Se paga el viernes siguiente.

const ANCLA_CORTE = Date.UTC(2026, 0, 1); // jueves 1-ene-2026
const DIA_MS = 86_400_000;
const isoDia = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Corte {
  desde: string; // jueves
  hasta: string; // miércoles
  pago: string;  // viernes
}

export function esFecha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
}

/** El corte de 14 días que contiene `fecha` (YYYY-MM-DD). */
export function corteDe(fecha: string): Corte {
  const t = Date.parse(fecha + 'T00:00:00Z');
  if (Number.isNaN(t)) throw new Error(`fecha inválida: ${fecha}`);
  const n = Math.floor((t - ANCLA_CORTE) / (14 * DIA_MS));
  const desde = ANCLA_CORTE + n * 14 * DIA_MS;
  return { desde: isoDia(desde), hasta: isoDia(desde + 13 * DIA_MS), pago: isoDia(desde + 15 * DIA_MS) };
}

/** El último corte que ya cerró (el que se paga ahora) visto desde `hoy`. */
export function corteAPagar(hoy: string): Corte {
  const actual = corteDe(hoy);
  return corteDe(isoDia(Date.parse(actual.desde + 'T00:00:00Z') - DIA_MS));
}

/** El corte vecino: `-1` el anterior, `+1` el siguiente. */
export function corteVecino(c: Pick<Corte, 'desde'>, paso: -1 | 1): Corte {
  return corteDe(isoDia(Date.parse(c.desde + 'T00:00:00Z') + paso * 14 * DIA_MS));
}

/** Lo que una persona cobra en el corte (`GET /finance/trip-pay/corte`). */
export interface ResumenPersona {
  driver_id: string;
  persona: string;
  roles: string[];
  viajes: number;
  cargas: number;
  liberado: Record<ConceptoPago, number>;
  liberado_total: number;
  retenido_total: number;
  retenidos: number;
  en_vale_total: number;
  vales: string[];
}

/** `GET /finance/trip-pay/corte` */
export interface CorteDeLogistica {
  corte: Corte;
  personas: ResumenPersona[];
  totales: { liberado: number; retenido: number; en_vale: number };
}

/** `GET /finance/trip-pay/personas/:driverId` */
export interface DetallePersona {
  corte: Corte;
  driver_id: string;
  persona: string;
  pagables: PagoViaje[];
  retenidos: PagoViaje[];
  en_vale: PagoViaje[];
}

/** `POST /finance/trip-pay/vales` */
export interface ValeCreado {
  id: string;
  importe: number;
  renglones: number;
  persona: string;
}

// ── `[EMB.43]` La bandeja «Por completar»: los viajes de Kepler y lo que les falta ─────────────
//
// El viaje lo trae Kepler (la guía `c86`); la Suite sólo guarda lo que Kepler no sabe: quién más
// fue (ayudantes), el horario y quién cargó. Esta bandeja dice, viaje por viaje, qué falta para
// que se pueda pagar. Las guías de puras cargas a camión de ruta quedan fuera: no pagan comisión
// ni viático, y la carga a ruta no paga por caja (decisión de Edgar, 2026-10-24).

/** Lo que le falta a un viaje para pagarse, en el orden en que se captura. */
export type FaltaDelViaje = 'tomar' | 'chofer' | 'horario' | 'cargadores';

export const FALTA_LABEL: Record<FaltaDelViaje, string> = {
  tomar: 'Sin hoja en la Suite',
  chofer: 'Falta el chofer',
  horario: 'Falta el horario',
  cargadores: 'Falta quién cargó',
};

/** Tipo de una parada de Kepler, por su serie y el código de destino (`kdm1.c10`). */
export type TipoParadaKepler = 'cliente' | 'traspaso' | 'carga_ruta';

/**
 * Serie 1 = entrega a cliente. Serie 2: `TI###` = traspaso a sucursal; `RUTA nn` / `RD 5xx` = carga
 * a camión de ruta. Medido 8–21 oct 2026: 593 paradas serie 1; serie 2 = 638 `TI`, 69 `RUTA`, 54 `RD`.
 * Es la misma regla que `analytics.erp_shipment_stop_closure`.
 */
export function tipoDeParadaKepler(serie: number | string, codigoDestino: string | null | undefined): TipoParadaKepler {
  if (Number(serie) === 1) return 'cliente';
  return /^\s*(RUTA|RD)/i.test(codigoDestino ?? '') ? 'carga_ruta' : 'traspaso';
}

/** Tipo del viaje según sus paradas que SÍ pagan (sin las cargas a ruta). `null` = ninguna paga. */
export type TipoViajePago = 'traspaso' | 'cliente' | 'mixto';
export function tipoDelViaje(tipos: TipoParadaKepler[]): TipoViajePago | null {
  const pagan = new Set(tipos.filter((t) => t !== 'carga_ruta'));
  if (!pagan.size) return null;
  return pagan.size > 1 ? 'mixto' : ([...pagan][0] as TipoViajePago);
}

export const TIPO_VIAJE_LABEL: Record<TipoViajePago, string> = {
  traspaso: 'Traspaso',
  cliente: 'Cliente',
  mixto: 'Traspaso y cliente',
};

/** Lo que la Suite sabe de un viaje (su hoja, su guía y sus cargadores). `null` = no se ha tomado. */
export interface ViajeEnLaSuite {
  shipment_id: string;
  guide_id: string | null;
  driver_id: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  cargadores: number;
}

/**
 * Qué le falta al viaje, en el orden en que se captura. Vacío = completo: ya se puede pagar en
 * cuanto cierren sus paradas. Es la misma regla que `pendientesDeLaGuia` (chofer y horario).
 */
export function faltasDelViaje(suite: ViajeEnLaSuite | null): FaltaDelViaje[] {
  if (!suite) return ['tomar'];
  const f: FaltaDelViaje[] = [];
  if (!suite.driver_id) f.push('chofer');
  if (!suite.departure_time || !suite.arrival_time) f.push('horario');
  if (!(suite.cargadores > 0)) f.push('cargadores');
  return f;
}

/** Un viaje de la bandeja (`GET /logistics/trip-closure/bandeja`). */
export interface ViajePorCompletar {
  sucursal: string;
  guia: string;
  fecha: string;
  paradas: number;
  /** Nombres de los destinos que pagan, separados por « · ». */
  destinos: string;
  tipo: TipoViajePago;
  chofer_kepler: string | null;
  importe: number;
  shipment_id: string | null;
  shipment_folio: string | null;
  guide_id: string | null;
  driver_id: string | null;
  helper1_id: string | null;
  helper2_id: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  overnight: boolean;
  cargadores: number;
  faltan: FaltaDelViaje[];
}

/** Una persona del padrón de Logística, para elegir chofer, ayudantes y cargadores. */
export interface PersonaDelPadron {
  id: string;
  full_name: string;
  roles: string[];
}

/** `GET /logistics/trip-closure/bandeja?desde&hasta&sucursal` */
export interface BandejaDeViajes {
  corte: Corte;
  viajes: ViajePorCompletar[];
  /** Guías del periodo que son SÓLO cargas a camión de ruta: no entran (se cuentan, no se esconden). */
  fuera_de_alcance: number;
  personas: PersonaDelPadron[];
  /** Cuándo se leyó (para la edad del dato). */
  leido_at: string;
}
