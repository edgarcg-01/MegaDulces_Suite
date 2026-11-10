/**
 * `[PGP.109]` **Cuándo se genera la póliza de egreso de un pago: PUE al pagar, PPD cuando llega el REP.**
 *
 * Decisión de Contabilidad, transmitida por Edgar (2026-11-10): *«cuando es por PPD, hasta que se genera
 * el REP; si es PUE se genera al pagar»*. Es la P1 de la fase PGP («El cierre contable del pago»).
 *
 * - **PUE** (pago en una exhibición): la póliza de egreso se genera en cuanto el pago queda «Pagado»
 *   (validado con banco y comprobante, `[PGP.107]`).
 * - **PPD** (pago en parcialidades o diferido): la póliza espera el REP (complemento de pago) que el
 *   proveedor timbra después de cobrar —mediana 3.5 días, p90 24— y se genera con él asociado.
 *
 * El REP se reconoce en `analytics.v_rep_de_factura` (`[PGP.110]`): el de ESA factura, vigente, que pagó
 * lo que este pago le aplicó (±$1) cerca del día en que salió del banco (±{@link VENTANA_REP_DIAS} días).
 *
 * ⛔ Lo que no se pudo medir se DECLARA (ADR-056): si la vista de REP no existe o la réplica está detenida
 * (`reps_medidos = false`), un PPD sin REP es `no_medido`, nunca «espera REP» afirmado. Sin CFDI ligado o
 * sin método, la póliza no se puede generar, y se dice por qué.
 */

/** ±$1 entre lo que el REP dice pagado y lo que este pago aplicó a la factura. */
export const TOLERANCIA_REP = 1;
/** ±10 días entre la fecha de pago del REP y la salida del banco. */
export const VENTANA_REP_DIAS = 10;

export interface FacturaParaPoliza {
  item_id: string;
  /** UUID del CFDI ligado (`[PGP.108]`); null si no se ligó. */
  cfdi_uuid: string | null;
  metodo: 'PUE' | 'PPD' | null;
  /** Lo que este pago le aplicó (el neto que salió del banco). */
  aplicado: number;
}

/** Una fila de `analytics.v_rep_de_factura`. */
export interface RepDeFactura {
  factura_uuid: string;
  rep_uuid: string;
  pagado: number;
  /** `YYYY-MM-DD`. */
  fecha_pago: string | null;
  cancelado: boolean;
}

export type EstadoFacturaPoliza = 'pue' | 'con_rep' | 'espera_rep' | 'sin_cfdi' | 'sin_metodo' | 'no_medido';
export type EstadoPolizaEgreso = 'lista' | 'espera_rep' | 'sin_cfdi' | 'sin_metodo' | 'no_medido';

export interface PolizaEgresoDelPago {
  estado: EstadoPolizaEgreso;
  facturas: { item_id: string; estado: EstadoFacturaPoliza; rep_uuid: string | null }[];
}

function dias(a: string, b: string): number {
  return Math.round((Date.parse(`${a.slice(0, 10)}T12:00:00Z`) - Date.parse(`${b.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

/**
 * El estado de la póliza de egreso de UN pago ya «Pagado». `fechaPago` es la de la salida del banco
 * (o el día programado si no hay evidencia guardada). Pura.
 */
export function polizaEgresoDelPago(facturas: readonly FacturaParaPoliza[], reps: readonly RepDeFactura[], fechaPago: string, repsMedidos: boolean): PolizaEgresoDelPago {
  const out = facturas.map((f) => {
    if (!f.cfdi_uuid) return { item_id: f.item_id, estado: 'sin_cfdi' as const, rep_uuid: null };
    if (!f.metodo) return { item_id: f.item_id, estado: 'sin_metodo' as const, rep_uuid: null };
    if (f.metodo === 'PUE') return { item_id: f.item_id, estado: 'pue' as const, rep_uuid: null };
    const uuid = f.cfdi_uuid.toUpperCase();
    const rep = reps.find((r) => !r.cancelado && r.factura_uuid.toUpperCase() === uuid
      && Math.abs(Number(r.pagado) - Number(f.aplicado)) <= TOLERANCIA_REP
      && (!r.fecha_pago || Math.abs(dias(r.fecha_pago, fechaPago)) <= VENTANA_REP_DIAS));
    if (rep) return { item_id: f.item_id, estado: 'con_rep' as const, rep_uuid: rep.rep_uuid };
    return { item_id: f.item_id, estado: repsMedidos ? 'espera_rep' as const : 'no_medido' as const, rep_uuid: null };
  });
  const hay = (e: EstadoFacturaPoliza) => out.some((x) => x.estado === e);
  // Lo que impide generarla manda sobre lo que sólo la hace esperar.
  const estado: EstadoPolizaEgreso = !out.length ? 'sin_cfdi'
    : hay('sin_cfdi') ? 'sin_cfdi'
      : hay('sin_metodo') ? 'sin_metodo'
        : hay('no_medido') ? 'no_medido'
          : hay('espera_rep') ? 'espera_rep'
            : 'lista';
  return { estado, facturas: out };
}

const TEXTO: Record<EstadoPolizaEgreso, string> = {
  lista: 'Póliza de egreso lista para generarse',
  espera_rep: 'Póliza en espera del REP del proveedor',
  sin_cfdi: 'Póliza sin generar: falta ligar el CFDI de una factura',
  sin_metodo: 'Póliza sin generar: el CFDI no dice si es PUE o PPD',
  no_medido: 'Póliza sin medir: no se pudo revisar si llegó el REP',
};
export function textoPolizaEgreso(e: EstadoPolizaEgreso): string { return TEXTO[e]; }
