import type { MismaFactura, MovimientoDeFactura } from '@megadulces/contracts';

/**
 * `[RE.85]` La cadena de una factura que citan VARIAS entradas (ver `MismaFactura` en contracts). Motor PURO:
 * el servicio carga las entradas hermanas, los ajustes de Kepler y los renglones; aquí se arma la cadena y
 * se decide el motivo de cada movimiento.
 *
 * Medido en prod (2026-11-23, 90 días): 11 facturas citadas por más de una entrada (22 entradas); en 2, en
 * fechas distintas — el caso de la entrada que vuelve a cargar lo que faltó.
 */

/** Una referencia que nombra una factura del proveedor: «0-F-319», «F1389», «30-F1429». */
const CITA_FACTURA = /F-?\s*\d/i;
export const citaFactura = (ref: string | null | undefined): boolean => !!ref && CITA_FACTURA.test(ref);

/**
 * El motivo que escribió quien capturó, sin la condición de pago que Kepler le antepone. El concepto de la
 * entrada (`kdm1.c24`) y el motivo de la devolución empiezan por la condición («2% 10 DIAS FALTO 1 CAJA…»);
 * si no queda nada más, no hay motivo («2% 10 DIAS» a secas es la condición, no un porqué).
 */
export function motivoDeKepler(texto: string | null | undefined): string | null {
  const t = (texto || '').replace(/^\s*\d+(?:\.\d+)?\s*%\s*\d+\s*D[IÍ]AS\b\s*/i, '').trim();
  return t || null;
}

export interface EntradaDeFactura {
  folio: string; fecha: string | null; monto: number; concepto: string | null;
}
export interface RenglonMovido { sku: string | null; nombre: string | null; cantidad: number; unidad: string | null }
export interface AjusteDeFactura {
  tipo: '40' | '55'; folio: string; fecha: string | null; monto: number; motivo: string | null;
  /** La entrada a la que Kepler lo aplicó. */
  entrada_folio: string | null;
  /** Sólo devoluciones: lo que se descontó, para reconocer lo que vuelve a entrar. */
  renglones: RenglonMovido[];
}

const centavos = (x: number) => Math.round(x * 100) / 100;
const fmtCant = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

/**
 * ¿Lo que entró en ESTA entrada es exactamente lo que una devolución anterior descontó? Todos sus renglones
 * (sku + cantidad + unidad) tienen que estar en la devolución; con uno que no, no se afirma nada.
 */
function reEntradaDe(renglones: RenglonMovido[], fecha: string | null, ajustes: AjusteDeFactura[]): string | null {
  if (!renglones.length) return null;
  for (const a of ajustes) {
    if (a.tipo !== '40' || (fecha && a.fecha && a.fecha > fecha)) continue;
    const casa = renglones.every((r) => a.renglones.some((d) =>
      d.sku != null && d.sku === r.sku && Math.abs(d.cantidad - r.cantidad) < 1e-6 && (d.unidad || '') === (r.unidad || '')));
    if (!casa) continue;
    const que = renglones.map((r) => `${fmtCant(r.cantidad)} ${r.unidad ?? ''} ${r.nombre ?? r.sku}`.replace(/\s+/g, ' ').trim()).join(', ');
    return `Llegó lo que se había descontado en la devolución ${a.folio}: ${que}`;
  }
  return null;
}

/**
 * Arma la cadena. `null` si sólo esta entrada cita la factura (no hay nada que relacionar). Orden: por fecha,
 * y en la misma fecha la entrada antes que lo que se le aplicó.
 */
export function armarMismaFactura(a: {
  referencia: string;
  folioEsta: string;
  entradas: EntradaDeFactura[];
  ajustes: AjusteDeFactura[];
  /** Los renglones de CADA entrada (folio → renglones): para deducir el motivo de todas, no sólo de la que se ve. */
  renglones: Record<string, RenglonMovido[]>;
  cfdi: MismaFactura['cfdi'];
}): MismaFactura | null {
  if (a.entradas.filter((e) => e.folio !== a.folioEsta).length === 0) return null;
  const movs: MovimientoDeFactura[] = [];
  for (const e of a.entradas) {
    const esEsta = e.folio === a.folioEsta;
    const deKepler = motivoDeKepler(e.concepto);
    const derivado = !deKepler ? reEntradaDe(a.renglones[e.folio] ?? [], e.fecha, a.ajustes) : null;
    movs.push({
      tipo: 'entrada', folio: e.folio, fecha: e.fecha, importe: centavos(e.monto),
      motivo: deKepler ?? derivado, motivo_origen: deKepler ? 'kepler' : derivado ? 'derivado' : 'sin_motivo',
      es_esta: esEsta, aplicada_a: null,
    });
  }
  for (const j of a.ajustes) {
    const m = motivoDeKepler(j.motivo);
    movs.push({
      tipo: j.tipo === '40' ? 'devolucion' : 'nota', folio: j.folio, fecha: j.fecha, importe: centavos(-j.monto),
      motivo: m, motivo_origen: m ? 'kepler' : 'sin_motivo', es_esta: false, aplicada_a: j.entrada_folio,
    });
  }
  const rango = (m: MovimientoDeFactura) => (m.tipo === 'entrada' ? 0 : 1);
  movs.sort((x, y) => (x.fecha ?? '').localeCompare(y.fecha ?? '') || rango(x) - rango(y) || x.folio.localeCompare(y.folio));
  const neto = centavos(movs.reduce((s, m) => s + m.importe, 0));
  return {
    referencia: a.referencia, movimientos: movs, neto_kepler: neto, cfdi: a.cfdi,
    diferencia: a.cfdi ? centavos(neto - a.cfdi.total) : null,
  };
}
