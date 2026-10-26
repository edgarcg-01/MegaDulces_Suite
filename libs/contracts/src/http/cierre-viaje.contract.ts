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

/**
 * Lo que le falta a un viaje para repartirse, en el orden en que se captura. `[EMB.47]` Ya no hay
 * «tomar»: la hoja de la Suite se crea sola al capturar al chofer o a los cargadores.
 */
export type FaltaDelViaje = 'chofer' | 'horario' | 'cargadores';

export const FALTA_LABEL: Record<FaltaDelViaje, string> = {
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
 * Qué le falta al viaje, en el orden en que se captura. Vacío = completo: ya se sabe cuánto le toca
 * a cada quien. Es la misma regla que `pendientesDeLaGuia` (chofer y horario).
 *
 * `[EMB.48]` `choferDeKepler`: Kepler trae al chofer y está en el padrón activo. Entonces el chofer
 * NO falta —la guía lo toma de Kepler y no deja cambiarlo—, aunque la hoja todavía no exista.
 */
export function faltasDelViaje(suite: ViajeEnLaSuite | null, choferDeKepler = false): FaltaDelViaje[] {
  if (!suite) return choferDeKepler ? ['horario', 'cargadores'] : ['chofer', 'horario', 'cargadores'];
  const f: FaltaDelViaje[] = [];
  if (!suite.driver_id && !choferDeKepler) f.push('chofer');
  if (!suite.departure_time || !suite.arrival_time) f.push('horario');
  if (!(suite.cargadores > 0)) f.push('cargadores');
  return f;
}

/** Un viaje de Kepler con lo que la Suite sabe de él (base de `OperacionDelReporte`). */
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

// ── [EMB.47] El reporte de reparto: cuánto le toca a cada quien de cada operación ─────────────
//
// Pedido del usuario (2026-10-24): «la finalidad del módulo es sacar los gastos y la repartición…
// sabemos cuántas cajas, cuántos procesos. Sólo necesitamos decirles cuánto les toca de cada
// operación… y generarlo a forma de reporte para que ellos hagan sus solicitudes de gasto». Con
// eso salen el cierre de paradas y el vale: el gasto se pide en Kepler (X-A-15) con este reporte.
//
// Lo único que Kepler NO sabe es quién fue (medido en Oficinas, 14 días: el chofer viene en 58 de
// 103 guías; los ayudantes, nunca). Eso es lo único que se captura.

export type ConceptoDelReparto = 'comision' | 'viatico' | 'carga';
export type RolDelReparto = 'chofer' | 'ayudante' | 'cargador';

export const ROL_LABEL: Record<RolDelReparto, string> = { chofer: 'Chofer', ayudante: 'Ayudante', cargador: 'Cargador' };
export const CONCEPTO_DEL_REPARTO_LABEL: Record<ConceptoDelReparto, string> = {
  comision: 'Comisión', viatico: 'Viático', carga: 'Carga',
};

export interface ConceptoKepler { codigo: string; nombre: string }

/**
 * El concepto de Kepler con que se pide el gasto, por tipo de viaje. Medido en los X-A-10 de
 * Logística de 90 días (`kdm6.c12` / `c9`, al 2026-10-24): traspaso → 054 (384 renglones) + 027
 * (336); cliente → 075 (155) + 128 (142). La carga por caja va a 054 en los dos: decisión del
 * usuario del 2026-10-24. Un viaje mixto (4 de 314 guías del 8 al 21 de octubre) se pide como
 * traspaso.
 */
export const CONCEPTO_DEL_REPARTO: Record<'traspaso' | 'cliente', Record<ConceptoDelReparto, ConceptoKepler>> = {
  traspaso: {
    comision: { codigo: '054', nombre: 'COMISION ARRASTRE MERCANCIA' },
    viatico: { codigo: '027', nombre: 'VIATICOS TRASPASO DE MERCANCIA' },
    carga: { codigo: '054', nombre: 'COMISION ARRASTRE MERCANCIA' },
  },
  cliente: {
    comision: { codigo: '075', nombre: 'COMISIONES LOGISTICAS TLMKT' },
    viatico: { codigo: '128', nombre: 'VIATICOS ENTREGA CLIENTES' },
    carga: { codigo: '054', nombre: 'COMISION ARRASTRE MERCANCIA' },
  },
};

export function conceptoDelReparto(tipo: TipoViajePago, concepto: ConceptoDelReparto): ConceptoKepler {
  return CONCEPTO_DEL_REPARTO[tipo === 'cliente' ? 'cliente' : 'traspaso'][concepto];
}

/**
 * De dónde sale un renglón. `captura`: de lo que alguien guardó (la guía completa, los cargadores).
 * `kepler` `[EMB.48]`: la comisión del chofer que trae Kepler por la tarifa de la ruta, antes de que
 * nadie capture nada — es el MISMO monto que dará la guía al completarse (misma regla, y la guía no
 * deja cambiar al chofer de Kepler).
 */
export type FuenteDelRenglon = 'captura' | 'kepler';

/** Lo que le toca a UNA persona de UNA operación por UN concepto. */
export interface RenglonDelReparto {
  persona_id: string;
  persona: string;
  rol: RolDelReparto;
  concepto: ConceptoDelReparto;
  codigo: string;
  nombre_concepto: string;
  importe: number;
  fuente: FuenteDelRenglon;
  /** `[EMB.51]` Cómo salió el importe, en llano («Tarifa de la ruta MORELIA: $180.00 al chofer»). */
  calculo: string;
}

/**
 * `[EMB.48]` La comisión que paga la ruta del viaje, por persona: la de MAYOR tarifa entre sus
 * rutas (`comisionSugerida`, la misma regla con que se completa la guía). `null` = ninguna ruta del
 * viaje tiene tarifa: se dice cuáles, no se pinta $0.
 */
export interface ComisionDeRuta {
  chofer: number | null;
  ayudante: number | null;
  /** La ruta cuya tarifa se usó. */
  ruta: string | null;
  /** Rutas del viaje sin tarifa en el catálogo. */
  sin_tarifa: string[];
}

/**
 * `[EMB.48]` Productos que viajan en una guía pero NO se cargan: el tiempo aire (SKU 00022) es saldo
 * de recarga, no mercancía. Medido 2026-10-26: 7 de 85 guías de la catorcena llevan SÓLO tiempo aire
 * (1,025 «piezas» a $0.81 a cada sucursal) y salían como operaciones de 0 cajas por pagar.
 */
export const SKUS_SIN_CARGA: readonly string[] = ['00022'];

// ── [EMB.53] La solicitud de gasto como la captura Kepler (X-A-15) ─────────────────────────────
//
// Edgar (2026-10-26): «hagamos un formato para que pasen sus comisiones a solicitudes de gastos para
// que se les pague». Medido en las X-A-15 de Logística de 90 días (sólo lectura, prod):
//  · proveedor SIEMPRE `GNFC002` «COMISION Y VIATICOS LOGISTICA», área FINANZAS (la pide Leonardo);
//  · la cuenta va por concepto: 054 y 027 → 514-001 (429 y 374 renglones); 075 y 128 → 602-015
//    (193 y 165; 2 en blanco);
//  · cada renglón lleva el centro de costo del PISO de la sucursal destino (1-01-40-00 = 8 Esquinas).

/** El proveedor y el área con que Logística pide sus comisiones y viáticos en Kepler. */
export const PROVEEDOR_DE_LA_SOLICITUD = { codigo: 'GNFC002', nombre: 'COMISION Y VIATICOS LOGISTICA', area: 'FINANZAS', moneda: 'PESOS' } as const;

/** La cuenta contable de cada concepto (`kdm6.c8`), medida en las X-A-15 de Logística. */
export const CUENTA_DEL_CONCEPTO: Readonly<Record<string, string>> = { '054': '514-001', '027': '514-001', '075': '602-015', '128': '602-015' };

/** Un centro de costo del catálogo de Kepler (`kdc3`). */
export interface CentroDeCosto {
  codigo: string;
  nombre: string;
}

/** Por qué una operación no tiene centro de costo derivado. */
export type SinCentro = 'cliente' | 'varios_destinos' | 'sin_catalogo';

export const SIN_CENTRO_LABEL: Record<SinCentro, string> = {
  cliente: 'Entrega a cliente: el centro se elige al capturar',
  varios_destinos: 'Varios destinos: se reparte al capturar',
  sin_catalogo: 'El destino no tiene centro de costo en Kepler',
};

/** Una operación del reporte: el viaje de Kepler, sus cajas y cómo se reparte. */
export interface OperacionDelReporte extends ViajePorCompletar {
  /** Cajas de las paradas que pagan (sin las cargas a ruta). `null` = Kepler no trae renglones. */
  cajas: number | null;
  /**
   * `[EMB.48]` Unidades que viajan en otra presentación (paquete, pieza, kilo) y NO pagan por caja.
   * Sin el tiempo aire. `null` = Kepler no trae renglones.
   */
  sueltos: number | null;
  /** `[EMB.48]` Lo que paga la ruta por persona, sepa o no quién fue. */
  comision_ruta: ComisionDeRuta;
  /** `[EMB.48]` El chofer que trae Kepler, ya casado con el padrón activo por su clave. */
  chofer_kepler_id: string | null;
  /** `[EMB.53]` El centro de costo al que va el gasto de esta operación (piso de la sucursal destino). */
  centro: CentroDeCosto | null;
  /** `[EMB.53]` Por qué no hay centro: se dice, no se adivina. */
  sin_centro: SinCentro | null;
  /** La tarifa por caja vigente ese día. `null` = no hay tarifa activa. */
  tarifa_por_caja: number | null;
  /** Lo que paga la carga (cajas × tarifa, o lo ya guardado). `null` = no se puede saber. */
  carga_total: number | null;
  cargador_ids: string[];
  renglones: RenglonDelReparto[];
  /** Σ de los renglones: lo que ya se sabe a quién le toca. */
  repartido: number;
}

/** `GET /logistics/trip-closure/reporte?desde&hasta&sucursal` */
export interface ReporteDePagos {
  corte: Corte;
  operaciones: OperacionDelReporte[];
  /** Guías del periodo que son SÓLO cargas a camión de ruta: no entran (se cuentan, no se esconden). */
  fuera_de_alcance: number;
  /** `[EMB.48]` Guías que sólo llevan tiempo aire: no son un viaje que cargar (se cuentan). */
  solo_tiempo_aire: number;
  /** El padrón activo, para elegir chofer, ayudantes y cargadores. */
  personas: PersonaDelPadron[];
  /** Cuándo se leyó (para la edad del dato). */
  leido_at: string;
}

/** Un renglón para capturar en la solicitud de Kepler: concepto × destino, sumado en la catorcena. */
export interface RenglonDeSolicitud {
  codigo: string;
  nombre_concepto: string;
  /** `[EMB.53]` La cuenta contable de Kepler para ese concepto (`kdm6.c8`). */
  cuenta: string | null;
  /** `[EMB.53]` Centro de costo del renglón; `null` con su motivo cuando no se puede derivar. */
  centro: CentroDeCosto | null;
  sin_centro: SinCentro | null;
  /** El nombre del centro, o los destinos de Kepler si no hay centro. */
  destino: string;
  operaciones: number;
  importe: number;
}

/** De dónde sale cada peso de la solicitud: una línea por operación y concepto. */
export interface DetalleDeSolicitud {
  fecha: string;
  sucursal: string;
  guia: string;
  destino: string;
  rol: RolDelReparto;
  concepto: ConceptoDelReparto;
  codigo: string;
  importe: number;
  fuente: FuenteDelRenglon;
  calculo: string;
}

/** Lo que una persona pide en la catorcena. */
export interface SolicitudDePersona {
  persona_id: string;
  persona: string;
  roles: RolDelReparto[];
  operaciones: number;
  por_concepto: Record<ConceptoDelReparto, number>;
  total: number;
  renglones: RenglonDeSolicitud[];
  detalle: DetalleDeSolicitud[];
}

/** Pesos redondeados al centavo. */
const alCentavo = (n: number): number => centavos(n) / 100;

/**
 * Las solicitudes de la catorcena, una por persona, armadas de los renglones de las operaciones.
 * Se agrupa por concepto de Kepler y destino porque así se captura el gasto: un renglón por
 * concepto y centro de costo (medido en los X-A-10 de octubre: 5 a 16 renglones por persona).
 */
export function solicitudesDelReporte(operaciones: OperacionDelReporte[]): SolicitudDePersona[] {
  const porPersona = new Map<string, SolicitudDePersona & { _ops: Set<string>; _renglon: Map<string, RenglonDeSolicitud & { _ops: Set<string> }> }>();
  for (const op of operaciones) {
    const llaveOp = `${op.sucursal}|${op.guia}`;
    // [EMB.53] Con centro de costo, el renglón es el del centro (como se captura en Kepler): dos
    // nombres de destino del mismo piso («TRASPASO 8 ESQUINAS», «SUCURSAL 8 ESQUINAS») van juntos.
    const destino = op.centro ? op.centro.nombre : op.destinos || '—';
    const llaveCentro = op.centro ? `c:${op.centro.codigo}` : `d:${destino}`;
    for (const r of op.renglones) {
      if (!(r.importe > 0)) continue;
      let s = porPersona.get(r.persona_id);
      if (!s) {
        s = {
          persona_id: r.persona_id, persona: r.persona, roles: [], operaciones: 0,
          por_concepto: { comision: 0, viatico: 0, carga: 0 }, total: 0, renglones: [], detalle: [],
          _ops: new Set(), _renglon: new Map(),
        };
        porPersona.set(r.persona_id, s);
      }
      if (!s.roles.includes(r.rol)) s.roles.push(r.rol);
      s._ops.add(llaveOp);
      s.por_concepto[r.concepto] = alCentavo(s.por_concepto[r.concepto] + r.importe);
      s.total = alCentavo(s.total + r.importe);
      const k = `${r.codigo}|${llaveCentro}`;
      let rs = s._renglon.get(k);
      if (!rs) {
        rs = {
          codigo: r.codigo, nombre_concepto: r.nombre_concepto, cuenta: CUENTA_DEL_CONCEPTO[r.codigo] ?? null,
          centro: op.centro, sin_centro: op.sin_centro, destino, operaciones: 0, importe: 0, _ops: new Set(),
        };
        s._renglon.set(k, rs);
      }
      rs._ops.add(llaveOp);
      rs.importe = alCentavo(rs.importe + r.importe);
      s.detalle.push({
        fecha: op.fecha, sucursal: op.sucursal, guia: op.guia, destino, rol: r.rol,
        concepto: r.concepto, codigo: r.codigo, importe: r.importe, fuente: r.fuente, calculo: r.calculo,
      });
    }
  }
  return [...porPersona.values()]
    .map(({ _ops, _renglon, ...s }) => ({
      ...s,
      operaciones: _ops.size,
      renglones: [..._renglon.values()]
        .map(({ _ops: ops, ...r }) => ({ ...r, operaciones: ops.size }))
        .sort((a, b) => a.codigo.localeCompare(b.codigo) || a.destino.localeCompare(b.destino)),
      detalle: s.detalle.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.guia.localeCompare(b.guia)),
    }))
    .sort((a, b) => a.persona.localeCompare(b.persona, 'es'));
}

// ── [EMB.50] El desglose de una operación ─────────────────────────────────────────────────────
//
// Edgar (2026-10-26): «que se pueda desglosar el movimiento (cuántas cajas), quién hizo
// recepciones, etc.». Por documento de la guía: sus cajas (con la MISMA regla que el reporte:
// presentación capturada CJA/BTO, sin tiempo aire), quién surtió/checó/embarcó según Kepler, y en
// un traspaso su recepción en la sucursal destino (U-A-50) con quién la capturó.

/** Una persona según un catálogo de Kepler: `nombre` null = la clave no está (o es ambigua). */
export interface ResponsableKepler {
  codigo: string | null;
  nombre: string | null;
}

/** Un renglón del documento, en la presentación en que se CAPTURÓ (`kdm2.c54`/`c55`). */
export interface RenglonDelDocumento {
  linea: number | null;
  sku: string;
  producto: string | null;
  cantidad: number | null;
  presentacion: string | null;
  /** La cantidad, si la presentación es caja o bulto; si no, 0. */
  cajas: number;
  /** Tiempo aire y demás `SKUS_SIN_CARGA`: viaja, no se carga. */
  sin_carga: boolean;
}

export type EstadoRecepcion = 'cerrada' | 'faltante' | 'sobrante' | 'pendiente' | 'destino_desconocido';

export const ESTADO_RECEPCION_LABEL: Record<EstadoRecepcion, string> = {
  cerrada: 'Recibido completo',
  faltante: 'Llegó de menos',
  sobrante: 'Llegó de más',
  pendiente: 'Sin recepción en Kepler',
  destino_desconocido: 'Destino sin sucursal',
};

/** La entrada (`U-A-50`) con que la sucursal destino recibió un traspaso. */
export interface RecepcionDelTraspaso {
  sucursal: string | null;
  folio: string | null;
  fecha: string | null;
  /** Usuario de Kepler que la capturó (`kdm1.c67`). Es una CLAVE: Kepler no trae su nombre. */
  capturo: string | null;
  /** Recibido − embarcado, en pesos. */
  diferencia: number | null;
  estado: EstadoRecepcion;
}

export interface DocumentoDeLaOperacion {
  serie: number;
  folio: string;
  tipo: TipoParadaKepler;
  destino: string | null;
  /** Cajas y unidades sueltas del documento (0 si es una carga a ruta: no paga). */
  cajas: number;
  sueltos: number;
  surtio: ResponsableKepler;
  checo: ResponsableKepler;
  embarco: ResponsableKepler;
  /** Usuario de Kepler que capturó el embarque, y a qué hora. */
  capturo: string | null;
  hora_captura: string | null;
  /** Sólo en traspasos. */
  recepcion: RecepcionDelTraspaso | null;
  renglones: RenglonDelDocumento[];
}

/** `GET /logistics/trip-closure/operaciones/:sucursal/:guia/desglose` */
export interface DesgloseDeOperacion {
  sucursal: string;
  guia: string;
  documentos: DocumentoDeLaOperacion[];
  /** Σ de los documentos que pagan: cuadra con las cajas de la operación en el reporte. */
  cajas: number;
  sueltos: number;
  leido_at: string;
}
