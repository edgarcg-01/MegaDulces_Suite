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

/** Lo que el resumen lee de una factura y de cada cobro o nota que Kepler le aplicó (`kdm5`). */
export interface AplicacionParaResumen { tipo?: string | null; fecha?: string | null; monto?: number | string | null }
export interface FacturaParaResumen {
  fecha: string | null; importe: number; saldo_documento: number; aplicaciones?: AplicacionParaResumen[] | null;
}

export interface ResumenPeriodoEC {
  /** `null` = el periodo abarca todo el registro: no hay saldo anterior que declarar. */
  inicial: number | null;
  facturado: number; n_facturas: number;
  cobros: number; n_cobros: number;
  notas: number; n_notas: number;
  /** El saldo de las facturas al corte (suma de `saldo_documento`), el que sale de Kepler. */
  saldo_facturas: number;
  /** Abonos que Kepler fecha DESPUÉS del corte (medido: un cliente de la sucursal 02 con 14-dic-2026, año mal
   *  capturado). Ya bajaron el saldo, así que se restan con su nombre en vez de quedar «sin explicar». */
  posteriores: number; n_posteriores: number;
  /** inicial + facturado − cobros − notas − posteriores − saldo_facturas. Cero cuando todo cuadra; si no, se imprime. */
  diferencia: number;
}

/**
 * `[CXC.50]` El resumen del periodo, como el de un estado de cuenta bancario: saldo al inicio + lo facturado −
 * lo pagado = el saldo al corte. UNA función para el PDF y para la ficha de Cartera (lo que Crédito ve es lo que
 * el cliente recibe). Se DERIVA de las facturas y sus aplicaciones de Kepler (`kdm5`), sin otra fuente: medido en
 * prod el 2026-11-23, 21,574 de 21,575 facturas cumplen `saldo = importe − sus aplicaciones`, y con el periodo de
 * 3 meses cuadran 1,607 de 1,609 clientes (uno trae abonos fechados después del corte —van en su renglón— y otro
 * una factura de $0 con $17,100 aplicados). Lo que no cuadre sale en `diferencia`, nunca se reparte en silencio.
 * Cobros (cobro, cobro CFDI) aparte de notas de crédito, devoluciones y ajustes.
 */
export function resumenPeriodo(partidas: readonly FacturaParaResumen[], hoy: string, desde: string | null): ResumenPeriodoEC {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const antes = (f?: string | null) => desde != null && !!f && f < desde;
  const dentro = (f?: string | null) => !!f && (desde == null || f >= desde) && f <= hoy;
  let inicial = 0, facturado = 0, cobros = 0, notas = 0, posteriores = 0, nF = 0, nC = 0, nN = 0, nP = 0, saldo = 0;
  for (const p of partidas) {
    saldo += Number(p.saldo_documento) || 0;
    if (antes(p.fecha)) inicial += p.importe;
    else if (dentro(p.fecha) && p.importe) { facturado += p.importe; nF++; } // la de $0 (cancelada) no cuenta
    for (const a of p.aplicaciones || []) {
      const m = Number(a.monto) || 0;
      if (antes(a.fecha)) inicial -= m;
      else if (dentro(a.fecha)) {
        if (a.tipo === 'cobro') { cobros += m; nC++; } else { notas += m; nN++; }
      } else if (a.fecha && a.fecha > hoy) { posteriores += m; nP++; }
    }
  }
  const out: ResumenPeriodoEC = {
    inicial: desde == null ? null : r2(inicial), facturado: r2(facturado), n_facturas: nF,
    cobros: r2(cobros), n_cobros: nC, notas: r2(notas), n_notas: nN, saldo_facturas: r2(saldo),
    posteriores: r2(posteriores), n_posteriores: nP, diferencia: 0,
  };
  const d = r2((out.inicial ?? 0) + out.facturado - out.cobros - out.notas - out.posteriores - out.saldo_facturas);
  out.diferencia = Math.abs(d) > 0.005 ? d : 0;
  return out;
}

/**
 * `[CXC.50]` La factura más NUEVA primero (Edgar, 2026-11-23: «debería ver sus facturas nuevas»), con el folio
 * para desempatar. El mismo orden en el PDF y en la ficha.
 */
export function masNuevaPrimero(a: { fecha: string | null; folio_digital: string }, b: { fecha: string | null; folio_digital: string }): number {
  return String(b.fecha ?? '').localeCompare(String(a.fecha ?? '')) || b.folio_digital.localeCompare(a.folio_digital);
}

/** `[CXC.50]` Como la fecha límite de una tarjeta: el siguiente vencimiento de lo abierto y al corriente, y cuánto vence ese día. */
export function proximoVencimiento(
  partidas: readonly { saldada: boolean; vencida: boolean; vencimiento: string | null; saldo_documento: number }[],
): { fecha: string; monto: number } | null {
  const vivas = partidas.filter((p) => !p.saldada && !p.vencida && p.vencimiento);
  const fecha = vivas.map((p) => p.vencimiento as string).sort()[0];
  if (!fecha) return null;
  return { fecha, monto: Math.round(vivas.filter((p) => p.vencimiento === fecha).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100 };
}
