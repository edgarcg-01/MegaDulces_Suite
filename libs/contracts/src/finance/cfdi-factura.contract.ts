/**
 * `[PGP.108]` **Cada factura del pago, con su CFDI — y si es PUE o PPD.**
 *
 * Para armar la póliza de egreso de ContPAQi (y saber si el IVA espera un REP) cada factura que el
 * pago salda tiene que tener su CFDI. Medido en prod (sólo lectura, 2026-11-09), contra los renglones
 * del Calendario de los últimos 60 días:
 * - Por el documento de Kepler (`kdxe`: acreedor, importe, fecha) + el RFC del acreedor
 *   (`analytics.v_supplier_rfc`) contra los CFDI recibidos tipo I (`fiscal.cfdis`), con
 *   **total ±$1 y fecha ±45 días**: un solo candidato en **67.5 % de los renglones (70 % del dinero)**;
 *   control negativo (el importe corrido $37.13): **0.3 %**. El resto: 32 con varios candidatos,
 *   58 sin CFDI y 17 sin RFC → los decide una persona.
 * - El camino de la pantalla (`v_payable_evidence`) daba 13 %: pierde justo las facturas ya saldadas.
 * - `metodo_pago` viene en el 100 % de los CFDI recibidos. Por dinero, 91 % es PPD.
 *
 * ⛔ **Uno a uno.** Un CFDI liga UNA factura: si es el único candidato de dos (mismo proveedor, mismo
 * total, fechas cercanas), ninguna se liga sola (`varios`). ⛔ Lo que no se pudo ligar se DECLARA
 * (`sin_documento`, `sin_rfc`, `ninguno`, `varios`): nunca se adivina el PUE/PPD.
 */

/** ±$1 entre el total del CFDI y el importe del documento de Kepler (el mismo margen medido). */
export const TOLERANCIA_CFDI = 1;
/** ±45 días entre la fecha del CFDI y la del documento de Kepler (control negativo 0.3 %). */
export const VENTANA_CFDI_DIAS = 45;

export type MetodoPagoCfdi = 'PUE' | 'PPD';

/** Lo que se sabe de la factura por su documento de Kepler. */
export interface FacturaParaCfdi {
  /** Id del renglón del pago (`payment_allocation_items.id`). */
  item_id: string;
  /** RFC del acreedor (`v_supplier_rfc`); null si Kepler no lo tiene ni se dedujo. */
  rfc: string | null;
  /** Importe del documento (`kdxe.c11`); null si el documento no se encontró en Kepler. */
  importe: number | null;
  /** Fecha del documento (`kdxe.c7`, `YYYY-MM-DD`). */
  fecha: string | null;
}

/** Un CFDI recibido, tipo I, vigente. */
export interface CfdiRecibido {
  uuid: string;
  emisor_rfc: string;
  total: number;
  fecha: string;
  metodo_pago: string | null;
  forma_pago: string | null;
  /** IVA e IEPS trasladados y retenciones, del propio CFDI (nunca se calculan). */
  iva: number | null;
  ieps: number | null;
  retenido: number | null;
}

export type EstadoCfdiFactura = 'unico' | 'varios' | 'ninguno' | 'sin_rfc' | 'sin_documento';

export interface CfdiDeLaFactura {
  estado: EstadoCfdiFactura;
  /** `[PGP.111b]` El RFC del acreedor (del documento de Kepler), aunque el CFDI no se haya ligado; null si no se sabe. */
  rfc?: string | null;
  /** El CFDI ligado; sólo con `unico`. */
  cfdi: CfdiRecibido | null;
  /** Cuántos candidatos hubo (para decirlo: «3 CFDI posibles»). */
  candidatos: number;
  /** PUE o PPD del CFDI ligado; null si no se ligó o el CFDI no lo trae. */
  metodo: MetodoPagoCfdi | null;
}

function dias(a: string, b: string): number {
  return Math.round((Date.parse(`${a.slice(0, 10)}T12:00:00Z`) - Date.parse(`${b.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

const metodoDe = (m: string | null | undefined): MetodoPagoCfdi | null => {
  const x = String(m ?? '').trim().toUpperCase();
  return x === 'PUE' || x === 'PPD' ? x : null;
};

/** Los candidatos de UNA factura: mismo RFC, total ±$1, fecha ±45 días. */
export function candidatosCfdi(f: FacturaParaCfdi, cfdis: readonly CfdiRecibido[]): CfdiRecibido[] {
  if (!f.rfc || f.importe === null || !f.fecha) return [];
  const rfc = f.rfc.trim().toUpperCase();
  return cfdis.filter((c) => c.emisor_rfc.trim().toUpperCase() === rfc
    && Math.abs(Number(c.total) - Number(f.importe)) <= TOLERANCIA_CFDI
    && Math.abs(dias(c.fecha, f.fecha as string)) <= VENTANA_CFDI_DIAS);
}

/**
 * El CFDI de cada factura. Pura. Uno a uno: un CFDI que es el único candidato de dos facturas no
 * liga ninguna.
 */
export function cfdisDeFacturas(facturas: readonly FacturaParaCfdi[], cfdis: readonly CfdiRecibido[]): Map<string, CfdiDeLaFactura> {
  const out = new Map<string, CfdiDeLaFactura>();
  const unicos = new Map<string, string[]>(); // uuid → facturas que lo tienen como único candidato
  const cand = new Map<string, CfdiRecibido[]>();
  for (const f of facturas) {
    const c = candidatosCfdi(f, cfdis);
    cand.set(f.item_id, c);
    if (c.length === 1) unicos.set(c[0].uuid, [...(unicos.get(c[0].uuid) ?? []), f.item_id]);
  }
  for (const f of facturas) {
    const c = cand.get(f.item_id) ?? [];
    const rfc = f.rfc ? f.rfc.trim().toUpperCase() : null;
    if (f.importe === null || !f.fecha) { out.set(f.item_id, { estado: 'sin_documento', cfdi: null, candidatos: 0, metodo: null, rfc }); continue; }
    if (!f.rfc) { out.set(f.item_id, { estado: 'sin_rfc', cfdi: null, candidatos: 0, metodo: null, rfc }); continue; }
    if (!c.length) { out.set(f.item_id, { estado: 'ninguno', cfdi: null, candidatos: 0, metodo: null, rfc }); continue; }
    if (c.length > 1 || (unicos.get(c[0].uuid) ?? []).length > 1) {
      out.set(f.item_id, { estado: 'varios', cfdi: null, candidatos: Math.max(c.length, 2), metodo: null, rfc });
      continue;
    }
    out.set(f.item_id, { estado: 'unico', cfdi: c[0], candidatos: 1, metodo: metodoDe(c[0].metodo_pago), rfc });
  }
  return out;
}

const TEXTO: Record<EstadoCfdiFactura, string> = {
  unico: 'CFDI ligado',
  varios: 'Varios CFDI posibles: elige',
  ninguno: 'Sin CFDI que case',
  sin_rfc: 'Sin RFC del proveedor',
  sin_documento: 'Sin documento de Kepler',
};
export function textoCfdi(e: EstadoCfdiFactura): string { return TEXTO[e]; }

/** PUE se paga en una exhibición; PPD en parcialidades o diferido y su IVA espera el REP del proveedor. */
export function textoMetodo(m: MetodoPagoCfdi): string {
  return m === 'PUE' ? 'PUE · una exhibición' : 'PPD · espera REP';
}

// ─── [PGP.158][PGP.163] El aviso fiscal del renglón, en el momento de pagar ────────────────────
//
// Nace de un reporte a Edgar (2026-11-19): «estamos pagando facturas con más de un mes». Una factura
// PUE se paga dentro del MES DE CALENDARIO en que se emitió; si no, el proveedor la cancela y la
// sustituye por una PPD (a una PUE no se le puede poner REP). Medido ese día en prod (ene–oct): 1 de
// cada 7 PUE pagadas por transferencia salió fuera de su mes; las PUE cobradas con tarjeta (04/28)
// ya se pagaron al momento y NO avisan. Y la bandeja de hallazgos no la revisa nadie (~7 mil en
// «nuevo»): el aviso va en el renglón del pago, donde se decide. D (Edgar): aviso, no candado.

/** Formas de pago del CFDI en las que la PUE espera NUESTRO pago: cheque y transferencia. */
export const FORMAS_PUE_POR_PAGAR: ReadonlySet<string> = new Set(['02', '03']);
/** LISR 27-III: una erogación de más de esto en efectivo no es deducible. */
export const TOPE_EFECTIVO_DEDUCIBLE = 2000;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Último día del mes de `fecha` (`YYYY-MM-DD`): la fecha límite de una PUE. */
export function finDeMes(fecha: string): string {
  const [y, m] = fecha.slice(0, 10).split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${String(y)}-${String(m).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
}
/** `2026-11-30` → `30-nov`. */
export function fechaCortaMx(fecha: string): string {
  const [, m, d] = fecha.slice(0, 10).split('-').map(Number);
  return `${String(d)}-${MESES_C[m - 1]}`;
}

export type ClaveAvisoFiscal = 'pue_limite' | 'pue_fuera_de_mes' | 'pue_mes_cerrado' | 'pue_pagada_fuera' | 'cfdi_cancelado' | 'efectivo_no_deducible';
export interface AvisoFiscal {
  clave: ClaveAvisoFiscal;
  /** `warn` = hay que hacer algo; `info` = sólo la fecha límite. */
  nivel: 'info' | 'warn';
  texto: string;
}

/** `[PGP.158]` Lo que el servidor manda de cada renglón: su CFDI y, si no hay vigente, el cancelado que casa. */
export interface CfdiDelRenglon {
  cfdi: CfdiDeLaFactura;
  /** `[PGP.163]` UUID de un CFDI CANCELADO que casa con la factura cuando no hay uno vigente; null si no hay. */
  cancelado_uuid: string | null;
}

export interface EntradaAvisoFiscal {
  /** Undefined = todavía no llegó (NO MEDIDO): no avisa nada. */
  renglon: CfdiDelRenglon | null | undefined;
  /** El día del pago (`lot_date`). */
  fecha_pago: string;
  /** Hoy en MX (`YYYY-MM-DD`). */
  hoy: string;
  /** El pago ya salió (`executed`). */
  pagado: boolean;
  /** Cómo sale el pago. */
  metodo_pago: string | null;
  /** Lo que sale por esta factura. */
  importe: number;
}

/**
 * `[PGP.158][PGP.163]` **Los avisos fiscales de una factura del pago**, el más urgente primero.
 * Puro: lo usa la pantalla con lo que el servidor ya ligó (`cfdisDeFacturas`), sin otra fuente.
 */
export function avisosFiscales(e: EntradaAvisoFiscal): AvisoFiscal[] {
  const out: AvisoFiscal[] = [];
  const r = e.renglon;
  if (r && r.cancelado_uuid && r.cfdi.estado !== 'unico') {
    out.push({ clave: 'cfdi_cancelado', nivel: 'warn', texto: 'El proveedor canceló esta factura en el SAT: no la pagues sin la que la sustituye' });
  }
  const c = r?.cfdi;
  if (c && c.estado === 'unico' && c.metodo === 'PUE' && c.cfdi && FORMAS_PUE_POR_PAGAR.has(String(c.cfdi.forma_pago ?? '').trim())) {
    const limite = finDeMes(c.cfdi.fecha);
    const mes = MESES[Number(c.cfdi.fecha.slice(5, 7)) - 1];
    if (e.pagado) {
      if (e.fecha_pago > limite) out.push({ clave: 'pue_pagada_fuera', nivel: 'warn', texto: `PUE de ${mes} pagada fuera de su mes: pide al proveedor que la sustituya por PPD` });
    } else if (e.hoy > limite) {
      out.push({ clave: 'pue_mes_cerrado', nivel: 'warn', texto: `PUE de ${mes}: su mes ya cerró. Pide al proveedor que la sustituya por PPD antes de pagarla` });
    } else if (e.fecha_pago > limite) {
      out.push({ clave: 'pue_fuera_de_mes', nivel: 'warn', texto: `PUE: págala a más tardar el ${fechaCortaMx(limite)} (está para el ${fechaCortaMx(e.fecha_pago)}), o pide PPD` });
    } else {
      out.push({ clave: 'pue_limite', nivel: 'info', texto: `PUE: pagar a más tardar el ${fechaCortaMx(limite)}` });
    }
  }
  if (e.metodo_pago === 'efectivo' && e.importe > TOPE_EFECTIVO_DEDUCIBLE) {
    out.push({ clave: 'efectivo_no_deducible', nivel: 'warn', texto: 'En efectivo, arriba de $2,000 no es deducible: págala por transferencia o cheque' });
  }
  return out;
}
