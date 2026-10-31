/**
 * Fase CP `[CP.8.91]` — **El armador de las comisiones bancarias: una póliza por banco y mes (D6).**
 *
 * Puro, sin Nest ni base, como `poliza-egreso.ts` y `traspasos.ts`: recibe las comisiones del mes y la cuenta firmada,
 * no las elige.
 *
 * ── La forma, MEDIDA en sus pólizas (staging de ContPAQi, ene–sep 2026) ─────────────────────────────────────
 * Contabilidad asienta las comisiones en UNA póliza de egreso (tipo 2) por cuenta de banco y por mes: «PAGO COMISIONES
 * <banco> <cuenta>» (117 pólizas, 10 a 16 al mes, hasta 888 renglones). Los cargos van AGREGADOS: uno a 5200650000
 * «Comisiones y situaciones» por el total de las comisiones y uno a 1060000000 «IVA acreditable» por el total de su
 * IVA —las mismas dos cuentas en las 117—. Los abonos van UNO POR MOVIMIENTO de banco: cada comisión y cada IVA, aparte.
 * El 90.6 % de sus renglones de banco casa con un movimiento de Bancos (cuenta, importe, mes del estado); de los que
 * casan, el 94 % es `comision_bancaria` o su IVA. 79 de 113 van fechadas el último día del mes (el resto, del 23 al 30).
 *
 *   cargo  <cuenta de gasto firmada>   Σ comisiones
 *   cargo  1060000000                  Σ IVA de las comisiones y el IVA suelto del banco
 *   abono  <banco>                     cada comisión y, detrás, su IVA; cada IVA suelto
 *
 * ⛔ Lo que NO arma: los pagos de crédito que ella mete en la póliza de Banorte (2140 y 5500) son otra cosa y no entran;
 *    una cuenta que no es de gasto (52) no se usa —cuadraría igual y no se vería hasta la balanza—; sin comisiones no
 *    hay póliza.
 */
import { CUENTA } from './pago-proveedor';
import { ABONO, AsientoRechazado, CARGO, TIPO_POLIZA_EGRESO, asientoCuadra, type Asiento, type MovimientoAsiento } from './poliza-egreso';
import { ultimoDiaDelMes } from './traspasos';

/** La categoría de Bancos que se arma por banco × mes cuando está firmada (D6). */
export const CATEGORIA_COMISION = 'comision_bancaria';

/** Una comisión del banco (`comision_bancaria`) y el IVA que el banco cargó por ella el mismo día, si lo hay. */
export interface ComisionDelBanco {
  id: string;
  fecha: string;
  importe: number;
  /** El IVA hermano (`iva_acreditable`, 16 % el mismo día): otro movimiento de banco, otro abono. */
  iva: number | null;
}

export interface EntradaComisiones {
  /** `YYYY-MM`. */
  mes: string;
  /** La cuenta del banco en ContPAQi (`102…`). */
  cuenta_banco: string;
  /** Como lo nombra ella en el título («BBVA 5712»). */
  alias: string | null;
  /** La cuenta de gasto FIRMADA para `comision_bancaria` (52, 10 dígitos). */
  cuenta_gasto: string;
  comisiones: ComisionDelBanco[];
  /**
   * IVA del banco sin su comisión en Bancos (no hay un egreso del 16 % ese día: lo cobró por varias juntas). Ella lo
   * asienta en la misma póliza, al IVA acreditable. Medido: 242 de sus renglones de ene–sep.
   */
  ivas_sueltos?: { id: string; fecha: string; importe: number }[];
}

const cent = (n: number): number => Math.round(Number(n) * 100);

export function armarComisionesDelMes(e: EntradaComisiones): Asiento {
  if (!/^52\d{8}$/.test(String(e.cuenta_gasto ?? ''))) {
    throw new AsientoRechazado('cuenta_no_es_gasto', `«${e.cuenta_gasto}» no es una cuenta de gasto (52, 10 dígitos): no se arma.`);
  }
  if (!e.comisiones.length) throw new AsientoRechazado('sin_comisiones', `${e.cuenta_banco} no tiene comisiones en ${e.mes}.`);
  // Cada movimiento de banco es un abono: la comisión seguida de su IVA, y el IVA suelto por su cuenta, en orden de fecha.
  const items = [
    ...e.comisiones.map((c) => ({ id: c.id, fecha: c.fecha, base: cent(c.importe), iva: cent(c.iva ?? 0) })),
    ...(e.ivas_sueltos ?? []).map((s) => ({ id: s.id, fecha: s.fecha, base: 0, iva: cent(s.importe), suelto: true })),
  ].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let base = 0;
  let iva = 0;
  const abonos: MovimientoAsiento[] = [];
  const abono = (c: number): void => { abonos.push({ cuenta: e.cuenta_banco, abono: ABONO, importe: c / 100, concepto: '', seg_negocio: 0 }); };
  for (const x of items) {
    const suelto = 'suelto' in x;
    if (suelto ? x.iva <= 0 : x.base <= 0 || x.iva < 0) {
      throw new AsientoRechazado('importe_invalido', `${suelto ? 'IVA suelto' : 'Comisión'} ${x.id} con importe no positivo o IVA negativo.`);
    }
    if (x.base > 0) { base += x.base; abono(x.base); }
    if (x.iva > 0) { iva += x.iva; abono(x.iva); }
  }
  const cargo = (cuenta: string, c: number): MovimientoAsiento => ({ cuenta, abono: CARGO, importe: c / 100, concepto: '', seg_negocio: 0 });
  const asiento: Asiento = {
    tipo_poliza: TIPO_POLIZA_EGRESO,
    fecha: ultimoDiaDelMes(e.mes),
    concepto: `PAGO COMISIONES ${e.alias ?? e.cuenta_banco}`,
    movimientos: [cargo(e.cuenta_gasto, base), ...(iva > 0 ? [cargo(CUENTA.IVA_ACREDITABLE, iva)] : []), ...abonos],
    total: (base + iva) / 100,
  };
  // ⛔ Última compuerta: si no cuadra es un error de este código, no un dato malo.
  if (!asientoCuadra(asiento)) throw new Error(`armarComisionesDelMes: la póliza de ${e.cuenta_banco} (${e.mes}) no cuadra.`);
  return asiento;
}
