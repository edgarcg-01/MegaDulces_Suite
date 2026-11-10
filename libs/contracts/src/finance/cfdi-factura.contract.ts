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
