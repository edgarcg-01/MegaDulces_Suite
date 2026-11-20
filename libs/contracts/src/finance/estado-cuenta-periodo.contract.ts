/**
 * `[CXC.47]` El periodo del estado de cuenta del cliente — UNA regla para la pantalla de Cartera y para el PDF.
 *
 * El periodo sólo recorta las facturas PAGADAS (entran si se facturaron o se terminaron de pagar dentro de él); las
 * ABIERTAS salen todas, de cualquier fecha, porque son lo que se debe.
 *
 * Default: 3 meses. Medido en prod el 2026-11-20 sobre 1,607 cuentas: el plazo de crédito es de 0 a 15 días en el
 * 98 %, así que tres meses son seis ciclos de cobro o más, y el documento queda corto — la mitad de las cuentas tiene
 * 2 facturas en ese lapso y el 99 % hasta 43; con 12 meses, el 1 % pasa de 290.
 */
export const MESES_ESTADO_CUENTA_POR_DEFECTO = 3;

export type PeriodoEstadoCuenta = '1m' | '3m' | '6m' | '12m' | 'todo';

export const PERIODOS_ESTADO_CUENTA: readonly { clave: PeriodoEstadoCuenta; meses: number | null; etiqueta: string }[] = [
  { clave: '1m', meses: 1, etiqueta: 'Último mes' },
  { clave: '3m', meses: 3, etiqueta: 'Últimos 3 meses' },
  { clave: '6m', meses: 6, etiqueta: 'Últimos 6 meses' },
  { clave: '12m', meses: 12, etiqueta: 'Último año' },
  { clave: 'todo', meses: null, etiqueta: 'Toda la historia' },
];

/** `hoy` (AAAA-MM-DD) menos `meses`, el mismo día del mes, o el último si ese mes es más corto. */
export function restarMeses(hoy: string, meses: number): string {
  const [y, m, d] = hoy.split('-').map(Number);
  const total = y * 12 + (m - 1) - meses;
  const yy = Math.floor(total / 12);
  const mm = total % 12;
  const ultimo = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

/** El `date_from` que manda la pantalla para un periodo: una fecha, o `'todo'`. */
export function dateFromDelPeriodo(hoy: string, clave: PeriodoEstadoCuenta): string {
  const p = PERIODOS_ESTADO_CUENTA.find((x) => x.clave === clave);
  return p?.meses == null ? 'todo' : restarMeses(hoy, p.meses);
}

/** Lo que la regla lee de una factura del auxiliar (`CustomerLedgerService.detalle`). */
export interface FacturaParaPeriodo { saldada: boolean; importe: number; fecha: string | null; pagada_el?: string | null }

/**
 * `[CXC.47]` ¿La factura PAGADA entra al periodo? Sí si se facturó o se terminó de pagar dentro de él. Una en cero
 * (cancelada) nunca: no hay peso que explicar. `desde = null` es «toda la historia».
 */
export function pagadaEnPeriodo(p: FacturaParaPeriodo, desde: string | null): boolean {
  if (!p.saldada || Math.abs(Number(p.importe) || 0) < 0.005) return false;
  if (!desde) return true;
  return (p.fecha != null && p.fecha >= desde) || (p.pagada_el != null && p.pagada_el >= desde);
}
