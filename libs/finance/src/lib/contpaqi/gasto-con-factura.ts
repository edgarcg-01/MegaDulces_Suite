/**
 * `[CP.8.87]` — **El asiento de un GASTO pagado con factura, como lo asienta la contadora.**
 *
 * Medido antes de escribirlo (`[CP.8.86]`, `database/scripts/simula-gasto-con-factura-contpaqi.js`): sobre ene–sep
 * 2026, la contadora asienta el gasto con factura como UNA póliza por pago, con las facturas del proveedor (UUID
 * en los renglones), cargo a la cuenta de gasto que ese proveedor ya usó, el IVA de las facturas y el abono al
 * banco — la póliza del mantenimiento del equipo de reparto (520-073-0000, un proveedor persona física) es el ejemplo. Con esta forma
 * se reproducen **246 de 276 (89.1 %)**.
 *
 *   por factura   cargo <cuenta de gasto> por (total − IVA − IEPS) · cargo 1060 por el IVA · cargo 1470100 por el IEPS
 *   banco         abono por lo pagado
 *   redondeo      la diferencia < $1: a favor → abono 4200010000; en contra → cargo 5201000000
 *
 * ⛔ Lo que NO arma, y dice por qué (nunca un asiento a medias):
 *   · factura con RETENCIÓN (ISR/IVA retenido: honorarios, arrendamiento) — esa póliza lleva renglones que este
 *     armador no sabe emitir; se manda a confirmar;
 *   · una cuenta que no es de gasto (52) — la historia del proveedor puede apuntar a otra cosa y cuadraría igual;
 *   · facturas que no dan lo pagado (≥ $1).
 *
 * Mismo contrato que `pago-proveedor.ts`: puro, sin Nest ni base; recibe las facturas y la cuenta, no las elige.
 */
import { ABONO, AsientoRechazado, CARGO, TIPO_POLIZA_EGRESO, type Asiento, type MovimientoAsiento } from './poliza-egreso';
import { CUENTA } from './pago-proveedor';

export interface FacturaGasto {
  uuid: string;
  total: number;
  iva: number;
  ieps: number;
  /** Σ de impuestos retenidos del CFDI (`total_retenidos`). > 0 no se arma. */
  retenido: number;
  fecha: string;
}

export interface EntradaGasto {
  fecha: string;
  concepto: string;
  /** Cuenta del banco en ContPAQi (`102xxxxxxx`). */
  cuenta_banco: string;
  pagado: number;
  /** La cuenta de gasto (52, 10 dígitos) que decide el proveedor. */
  cuenta_gasto: string;
  facturas: FacturaGasto[];
}

export interface AsientoGasto extends Asiento {
  uuids: string[];
  redondeo: number;
}

const cent = (n: number): number => Math.round(Number(n) * 100);

/** El rubro con que se firma una categoría de gasto «por proveedor» (`cuenta_prefijo`). */
export const PREFIJO_GASTO_POR_PROVEEDOR = '52';

/**
 * `[CP.8.87]` ¿La regla es un GASTO que se arma por proveedor? Es `por_proveedor` —la forma que ya usa
 * `compra_mercancia`, sin cambiar el esquema— con el rubro de gasto (`52`) en vez del de compra (`2120`).
 */
export function esGastoPorProveedor(r: { tipo_regla?: string | null; cuenta_prefijo?: string | null } | null | undefined): boolean {
  return !!r && r.tipo_regla === 'por_proveedor' && String(r.cuenta_prefijo ?? '').startsWith(PREFIJO_GASTO_POR_PROVEEDOR);
}

/**
 * `[CP.8.87]` **La cuenta de gasto de un proveedor: la que la contadora usó MÁS con ese RFC antes de la fecha.**
 * Medido (`gasto-por-rfc-contpaqi.js`): acierta 93.0 % (1,328/1,428), placebo 9.0 %. Empate: la de código menor.
 * Sin historia → null: no se adivina (la define Contabilidad). La usan la póliza (`FuentePagoProveedor`) y el
 * Calendario de Pagos (`[PGP.111b]`): UNA regla, dos lectores.
 */
export function cuentaGastoMasUsada(historia: readonly { cuenta: string; f: string }[], antesDe?: string): { cuenta: string; veces: number; total: number } | null {
  const h = antesDe ? historia.filter((x) => x.f < antesDe) : [...historia];
  if (!h.length) return null;
  const c = new Map<string, number>();
  for (const x of h) c.set(x.cuenta, (c.get(x.cuenta) ?? 0) + 1);
  const [cuenta, veces] = [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return { cuenta, veces, total: h.length };
}

export function armarGastoConFactura(e: EntradaGasto): AsientoGasto {
  if (!/^52\d{8}$/.test(String(e.cuenta_gasto ?? ''))) {
    throw new AsientoRechazado('cuenta_no_es_gasto', `«${e.cuenta_gasto}» no es una cuenta de gasto (52, 10 dígitos): no se arma.`);
  }
  if (!e.facturas.length) throw new AsientoRechazado('sin_facturas', 'No se sabe qué facturas paga el movimiento: no se arma.');
  const pagado = cent(e.pagado);
  if (pagado <= 0) throw new AsientoRechazado('importe_invalido', `Pagado no positivo: ${e.pagado}.`);
  const conRetencion = e.facturas.filter((f) => cent(f.retenido) > 0);
  if (conRetencion.length) {
    throw new AsientoRechazado('retencion',
      `${conRetencion.length === 1 ? 'La factura trae' : `${conRetencion.length} facturas traen`} retención de impuestos: esa póliza lleva renglones de retención que el puente no emite todavía. Va a confirmar.`);
  }

  const movs: MovimientoAsiento[] = [];
  const mov = (cuenta: string, abono: boolean, c: number): void => {
    if (c > 0) movs.push({ cuenta, abono, importe: c / 100, concepto: e.concepto, seg_negocio: 0 });
  };
  let base = 0, iva = 0, ieps = 0;
  for (const f of e.facturas) {
    const t = cent(f.total), i = cent(f.iva), p = cent(f.ieps);
    if (t <= 0) throw new AsientoRechazado('importe_invalido', `Factura ${f.uuid} con total no positivo.`);
    if (i < 0 || p < 0 || i + p > t) throw new AsientoRechazado('importe_invalido', `Factura ${f.uuid}: impuestos que no caben en su total.`);
    base += t - i - p; iva += i; ieps += p;
  }
  mov(e.cuenta_gasto, CARGO, base);
  mov(CUENTA.IVA_ACREDITABLE, CARGO, iva);
  mov(CUENTA.IEPS_ACREDITABLE, CARGO, ieps);
  mov(e.cuenta_banco, ABONO, pagado);

  // ── Compuerta: lo facturado tiene que dar lo pagado; menos de $1 va al redondeo.
  const dif = base + iva + ieps - pagado;
  if (Math.abs(dif) >= 100) {
    throw new AsientoRechazado('no_cuadra',
      `Las facturas no dan lo pagado: diferencia ${(dif / 100).toFixed(2)}. Falta o sobra una factura, o es un pago parcial: va a confirmar.`);
  }
  if (dif > 0) mov(CUENTA.OTROS_INGRESOS, ABONO, dif);
  if (dif < 0) mov(CUENTA.NO_DEDUCIBLES, CARGO, -dif);

  return {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: e.fecha,
    concepto: e.concepto,
    movimientos: movs,
    total: (base + iva + ieps + Math.max(0, -dif)) / 100,
    uuids: e.facturas.map((f) => f.uuid),
    redondeo: dif / 100,
  };
}
