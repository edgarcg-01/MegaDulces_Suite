/**
 * `[PGP.94]` **El cierre de un pago del Calendario contra lo que Kepler hizo de verdad.**
 *
 * ⛔ Nace de una medición (prod, sólo lectura, 2026-11-06): **ningún día del Calendario se ha
 * autorizado ni marcado pagado** — 20 lotes del 16-oct al 6-nov en borrador, 0 pagos `executed`.
 * El dinero sale por Kepler y el banco, y la Suite sólo conocía lo PROGRAMADO. Por eso un día que
 * ya pasó decía «sus 17 pagos no se pagaron ($4,442,169.62)» cuando la mayoría sí se pagó. De los
 * 71 pagos pendientes en días pasados (19-oct a 5-nov, $13.9 M) Kepler ya tenía pagados **30
 * ($6.05 M)** —18 el mismo día, 9 un día después— y en parte 6 más; sólo **35 ($6.43 M)** seguían
 * sin pagar, y ninguno de esos tenía día nuevo.
 *
 * ⭐ Kepler sí guarda qué pago saldó cada factura: `kdxf` liga el abono (el pago, `X-D-…`) con el
 * cargo (la factura). Este contrato es la regla que convierte esas aplicaciones en el estado de
 * un pago del Calendario. La lectura (SQL) vive en `payment-calendar.service.ts`; la regla vive
 * aquí para que la pantalla y el servidor no la reescriban cada uno a su modo.
 *
 * ⛔ **Un pago cancelado en Kepler no salda nada** (`[PGP.67]`): la lectura descarta sus
 * aplicaciones con el MISMO cruce que `analytics.v_supplier_payables`, así que «saldada» en el
 * renglón y «pagado en Kepler» no se pueden contradecir. Medido el 2026-11-06: 707 de 11,955
 * aplicaciones de `kdxf` desde septiembre son de documentos cancelados.
 *
 * ⛔ Lo que no se puede medir se DECLARA (ADR-056): una factura que no viene de Kepler
 * (`supplier_payable` y demás) es `sin_medir`, nunca «sin pagar».
 */

/** Cómo salió (o se saldó) un documento de Kepler, según su tipo `X-D-<tipo>-<subtipo>` (`kdmm`). */
export type TipoPagoKepler =
  | 'transferencia' | 'cheque' | 'anticipo' | 'efectivo' | 'banco'
  | 'nota_credito' | 'devolucion' | 'bonificacion' | 'otro';

/**
 * El tipo por su clave de `kdmm` (`c1='X'`, `c2='D'`). Leído del catálogo en prod el 2026-11-06:
 * 20/23/24-1 «Pago prov. Efectivo», 20/23/24-2 «Pago prov. Trans/cheq/banc» (no distingue cuál:
 * por eso `banco`, no `transferencia`), 25 cheque, 26 transferencia, 60 anticipo, 30/35/40
 * devoluciones, 45 bonificación, 55/56 nota de crédito.
 */
export function tipoPagoKepler(docTipo: number | string, docSub: number | string): TipoPagoKepler {
  const t = Number(docTipo);
  const s = Number(docSub);
  if (t === 26) return 'transferencia';
  if (t === 25) return 'cheque';
  if (t === 60) return 'anticipo';
  if (t === 20 || t === 23 || t === 24) return s === 1 ? 'efectivo' : 'banco';
  if (t === 55 || t === 56) return 'nota_credito';
  if (t === 30 || t === 35 || t === 40) return 'devolucion';
  if (t === 45) return 'bonificacion';
  return 'otro';
}

/** ¿Salió dinero? Una nota de crédito o una devolución saldan la factura, pero no son un pago. */
export function esPagoConDinero(tipo: TipoPagoKepler): boolean {
  return tipo === 'transferencia' || tipo === 'cheque' || tipo === 'anticipo' || tipo === 'efectivo' || tipo === 'banco';
}

const NOMBRE_TIPO: Record<TipoPagoKepler, string> = {
  transferencia: 'Transferencia', cheque: 'Cheque', anticipo: 'Anticipo', efectivo: 'Efectivo',
  banco: 'Pago por banco', nota_credito: 'Nota de crédito', devolucion: 'Devolución',
  bonificacion: 'Bonificación', otro: 'Documento',
};
export function nombreTipoPagoKepler(tipo: TipoPagoKepler): string { return NOMBRE_TIPO[tipo]; }

/**
 * `XD2601` — la forma en que Kepler, `analytics.erp_supplier_payments` y los comprobantes de pago
 * (`finance.supplier_payment_proofs`) nombran el tipo del pago: X, D, tipo y subtipo a dos dígitos.
 */
export function docPrefixKepler(docTipo: number | string, docSub: number | string): string {
  const dos = (n: number | string) => String(Number(n)).padStart(2, '0');
  return `XD${dos(docTipo)}${dos(docSub)}`;
}

/** Una aplicación de `kdxf`: cuánto de UN documento de Kepler se aplicó a UNA factura del pago. */
export interface AplicacionKepler {
  sucursal: string;
  doc_tipo: number;
  doc_sub: number;
  folio: string;
  /** Fecha del documento de pago (`kdxe.c7`), `YYYY-MM-DD`. Null si Kepler no la trae. */
  fecha: string | null;
  aplicado: number;
  /** Cuenta de tesorería del pago (`kdxe.c22`) y su nombre en `kdb1` («SANTANDER 2169»). */
  cuenta: string | null;
  cuenta_nombre: string | null;
  /** El comprobante (PDF) subido para ESE pago, si existe y no está rechazado. */
  comprobante_id: string | null;
  comprobante_estado: string | null;
}

/** Una factura del pago, con lo que Kepler dice de ella. */
export interface FacturaParaCierre {
  /**
   * Lo que todavía se debe según Kepler, con la misma cuenta que `v_supplier_payables`
   * (importe − aplicado por documentos vigentes). **`null` = no se pudo medir**: la factura no
   * viene de Kepler, o su documento no se encontró.
   */
  pendiente: number | null;
  aplicaciones: AplicacionKepler[];
}

/** El estado de UNA factura, medido. */
export type EstadoFacturaCierre = 'pagada' | 'saldada_sin_dinero' | 'en_parte' | 'sin_pagar' | 'sin_medir';

/**
 * El estado de un pago del Calendario frente a Kepler.
 * - `pagado`: todas sus facturas medidas quedaron saldadas, y al menos una con dinero.
 * - `saldado_sin_dinero`: saldadas, pero sólo con notas de crédito o devoluciones.
 * - `en_parte`: alguna se saldó o se abonó y otra sigue debiéndose.
 * - `sin_pagar`: Kepler no registra nada desde que se programó.
 * - `sin_medir`: ninguna de sus facturas viene de Kepler.
 */
export type EstadoCierreKepler = 'pagado' | 'saldado_sin_dinero' | 'en_parte' | 'sin_pagar' | 'sin_medir';

/** Un documento de Kepler que tocó las facturas del pago (las aplicaciones sumadas por documento). */
export interface PagoKeplerDelCierre {
  sucursal: string;
  doc_prefix: string;
  folio: string;
  tipo: TipoPagoKepler;
  fecha: string | null;
  aplicado: number;
  cuenta: string | null;
  cuenta_nombre: string | null;
  comprobante_id: string | null;
  comprobante_estado: string | null;
}

export interface CierreKeplerPago {
  estado: EstadoCierreKepler;
  /**
   * Días entre el día programado y el último pago CON DINERO que tocó sus facturas: 0 = el mismo
   * día, positivo = después, negativo = antes. Null si no hubo pago con dinero.
   */
  desfase_dias: number | null;
  /** Lo aplicado por pagos con dinero a sus facturas (las notas y devoluciones no suman aquí). */
  pagado: number;
  facturas: Record<EstadoFacturaCierre, number>;
  /** Los documentos de Kepler que lo explican, el más reciente primero. */
  pagos: PagoKeplerDelCierre[];
}

/** Tolerancia de saldo: la misma que `v_supplier_payables` (`pendiente > 0.005`). */
const SALDO_CERO = 0.005;
/**
 * Un abono a una factura que sigue viva cuenta como «en parte» sólo si es de cuando ya estaba
 * programada (o hasta 3 días antes: Kepler se captura después de que sale el dinero, la misma
 * holgura que `[TP.19.4]`). Uno de hace meses es historia de la factura, no de este pago.
 */
const HOLGURA_DIAS = 3;

function dias(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
}

/** Las aplicaciones que cuentan para ESTE pago: las de cuando ya estaba programado. */
function aplicacionesDelPago(apps: AplicacionKepler[], desde: string): AplicacionKepler[] {
  return apps.filter((a) => a.fecha !== null && dias(a.fecha, desde) >= -HOLGURA_DIAS);
}

export function estadoFacturaCierre(f: FacturaParaCierre, programadaDesde: string): EstadoFacturaCierre {
  if (f.pendiente === null || !Number.isFinite(f.pendiente)) return 'sin_medir';
  const recientes = aplicacionesDelPago(f.aplicaciones, programadaDesde);
  if (f.pendiente <= SALDO_CERO) {
    // Saldada. Si se pagó antes de programarla, el documento que la cerró es igual la explicación.
    const explican = f.aplicaciones;
    if (!explican.length) return 'sin_medir'; // saldo cero sin aplicación: no sabemos con qué
    return explican.some((a) => esPagoConDinero(tipoPagoKepler(a.doc_tipo, a.doc_sub))) ? 'pagada' : 'saldada_sin_dinero';
  }
  return recientes.length ? 'en_parte' : 'sin_pagar';
}

/**
 * El cierre de un pago. `lotDate` es el día al que estaba programado; `programadoDesde`, el día en
 * que entró al Calendario (`created_at` del pago, `YYYY-MM-DD`).
 */
export function cierreDelPago(input: { lotDate: string; programadoDesde: string; facturas: FacturaParaCierre[] }): CierreKeplerPago {
  const facturas: Record<EstadoFacturaCierre, number> = { pagada: 0, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 0 };
  const docs = new Map<string, PagoKeplerDelCierre>();
  for (const f of input.facturas) {
    const est = estadoFacturaCierre(f, input.programadoDesde);
    facturas[est]++;
    if (est === 'sin_medir' || est === 'sin_pagar') continue;
    // Una saldada se explica con lo que la cerró; si nada es de este periodo, con su último documento.
    let explican = aplicacionesDelPago(f.aplicaciones, input.programadoDesde);
    if (!explican.length && (est === 'pagada' || est === 'saldada_sin_dinero')) {
      const ult = [...f.aplicaciones].sort((x, y) => String(y.fecha ?? '').localeCompare(String(x.fecha ?? '')))[0];
      explican = ult ? [ult] : [];
    }
    for (const a of explican) {
      const prefix = docPrefixKepler(a.doc_tipo, a.doc_sub);
      const k = `${a.sucursal}|${prefix}|${a.folio}`;
      const d = docs.get(k);
      if (d) { d.aplicado = Math.round((d.aplicado + a.aplicado) * 100) / 100; continue; }
      docs.set(k, {
        sucursal: a.sucursal, doc_prefix: prefix, folio: a.folio, tipo: tipoPagoKepler(a.doc_tipo, a.doc_sub),
        fecha: a.fecha, aplicado: Math.round(a.aplicado * 100) / 100,
        cuenta: a.cuenta, cuenta_nombre: a.cuenta_nombre,
        comprobante_id: a.comprobante_id, comprobante_estado: a.comprobante_estado,
      });
    }
  }
  const pagos = [...docs.values()].sort((x, y) => String(y.fecha ?? '').localeCompare(String(x.fecha ?? '')));
  const conDinero = pagos.filter((p) => esPagoConDinero(p.tipo));
  const pagado = Math.round(conDinero.reduce((s, p) => s + p.aplicado, 0) * 100) / 100;
  const ultimo = conDinero.map((p) => p.fecha).filter((x): x is string => !!x).sort().pop() ?? null;

  const medidas = input.facturas.length - facturas.sin_medir;
  const saldadas = facturas.pagada + facturas.saldada_sin_dinero;
  let estado: EstadoCierreKepler;
  if (!medidas) estado = 'sin_medir';
  else if (saldadas === medidas) estado = facturas.pagada > 0 ? 'pagado' : 'saldado_sin_dinero';
  else if (saldadas > 0 || facturas.en_parte > 0) estado = 'en_parte';
  else estado = 'sin_pagar';

  return { estado, desfase_dias: ultimo ? dias(ultimo, input.lotDate) : null, pagado, facturas, pagos };
}

/** ¿Ya no hay nada que hacer con este pago? Kepler lo saldó todo (con dinero o con notas). */
export function cierreCompleto(c: CierreKeplerPago | null | undefined): boolean {
  return !!c && (c.estado === 'pagado' || c.estado === 'saldado_sin_dinero') && c.facturas.sin_medir === 0;
}

/** «el mismo día» · «1 día después» · «3 días antes». */
export function textoDesfase(d: number | null): string | null {
  if (d === null) return null;
  if (d === 0) return 'el mismo día';
  const n = Math.abs(d);
  return `${n} ${n === 1 ? 'día' : 'días'} ${d > 0 ? 'después' : 'antes'}`;
}

/** La frase corta del renglón. El detalle (folio, banco, PDF) va aparte. */
export function textoCierre(c: CierreKeplerPago): string {
  const sinMedir = c.facturas.sin_medir ? ` (${c.facturas.sin_medir} sin medir)` : '';
  switch (c.estado) {
    case 'pagado': return `Pagado en Kepler ${textoDesfase(c.desfase_dias) ?? ''}`.trim() + sinMedir;
    case 'saldado_sin_dinero': return 'Saldado en Kepler con nota de crédito o devolución' + sinMedir;
    case 'en_parte': {
      const hechas = c.facturas.pagada + c.facturas.saldada_sin_dinero;
      const faltan = c.facturas.sin_pagar + c.facturas.en_parte;
      return `Pagado en parte: ${hechas} saldada${hechas === 1 ? '' : 's'}, ${faltan} con saldo` + sinMedir;
    }
    case 'sin_pagar': return 'Kepler no registra el pago' + sinMedir;
    default: return 'Sin medir: no viene de Kepler';
  }
}

/**
 * `[PGP.100]` **Por qué un documento de pago de Kepler no tiene su PDF.** Null si no le toca uno
 * (una nota de crédito no tiene comprobante bancario). Un pago de sucursal no está en el espejo de
 * comprobantes: no se le puede subir, y eso NO es «falta comprobante».
 */
export function sinComprobantePorque(p: Pick<PagoKeplerDelCierre, 'tipo' | 'sucursal' | 'comprobante_id'>): string | null {
  if (p.comprobante_id || !esPagoConDinero(p.tipo)) return null;
  if (p.sucursal !== '00') return 'pago de sucursal: todavía no se le puede subir comprobante';
  return 'sin comprobante subido';
}

/**
 * `[PGP.100]` **Qué le falta a un pago para quedar cerrado**, dicho por separado (pedido de Edgar,
 * 2026-11-09: «especificar si falta comprobante o si falta aplicar en Kepler»):
 * - `kepler`: Kepler no registra el pago, o lo registra en parte (falta capturar/aplicar el X-D).
 * - `comprobante`: Kepler lo pagó con dinero desde Matriz y ese documento no tiene su PDF subido.
 * - `sin_medir`: ninguna factura viene de Kepler: no se puede afirmar ni lo uno ni lo otro (ADR-056).
 * Null = cerrado: Kepler lo saldó y cada pago con dinero que se puede comprobar tiene su PDF.
 * ⚠️ Un pago de sucursal sin PDF no cuenta como «falta comprobante»: hoy no se le puede subir.
 */
export interface FaltaParaCerrar {
  kepler: boolean;
  comprobante: number;
  sin_medir: boolean;
  texto: string;
}
export function faltaParaCerrar(c: CierreKeplerPago | null | undefined): FaltaParaCerrar | null {
  if (!c || c.estado === 'sin_medir') {
    return { kepler: false, comprobante: 0, sin_medir: true, texto: 'Sin medir: no viene de Kepler' };
  }
  const kepler = c.estado === 'sin_pagar' || c.estado === 'en_parte';
  const comprobante = c.pagos.filter((p) => sinComprobantePorque(p) === 'sin comprobante subido').length;
  if (!kepler && !comprobante) return null;
  const partes: string[] = [];
  if (kepler) partes.push(c.estado === 'sin_pagar' ? 'aplicar el pago en Kepler' : 'aplicar en Kepler el resto');
  if (comprobante) partes.push(comprobante === 1 ? 'el comprobante' : `${comprobante} comprobantes`);
  return { kepler, comprobante, sin_medir: false, texto: `Falta ${partes.join(' y ')}` };
}
