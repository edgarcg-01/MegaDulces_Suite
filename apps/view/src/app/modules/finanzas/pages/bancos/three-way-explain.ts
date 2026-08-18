import { ThreeWay, ThreeWayAccount, ThreeWayDetail, ThreeWayRow } from '../../bank.service';

/**
 * Descomposición de un descuadre del Control-total.
 *
 * La propiedad que la hace confiable: el Δ del control-total es la suma de los Δ
 * por cuenta. Por eso el reparto se hace acá, sobre `por_cuenta`, y NO sumando
 * movimientos sueltos — esos no reproducen el total, porque un movimiento casado
 * con importe distinto también mueve el Δ y no aparecería en ninguna lista de
 * "faltantes".
 *
 * Ese invariante NO está garantizado por construcción: el total de Kepler suma
 * todas sus cuentas, mientras `por_cuenta` sale del cruce Workbook↔ContPAQi, así
 * que una cuenta que exista sólo en Kepler entraría al total sin caer en ninguna
 * fila. No se pudo descartar con datos (el feed de Kepler está vacío en local),
 * así que el componente calcula el residuo y lo muestra cuando aparece, en vez
 * de dar por buena la suma.
 */

/** Par de fuentes que se está comparando. */
export type TwPair = 'wk' | 'wc' | 'kc';
/** Renglón del control-total. */
export type TwRow = 'ingresos' | 'egresos';

export interface PairMeta {
  a: string;
  b: string;
  /** Qué falta mirar en el detalle a nivel movimiento para este par. */
  hint: string;
}

export const PAIR_META: Record<TwPair, PairMeta> = {
  wk: { a: 'Workbook', b: 'Kepler', hint: 'movimientos del banco que Kepler no tiene, y de Kepler que el banco no movió' },
  wc: { a: 'Workbook', b: 'ContPAQi', hint: 'movimientos del banco que no están en los libros, y de los libros sin banco' },
  kc: { a: 'Kepler', b: 'ContPAQi', hint: 'movimientos que una fuente registra y la otra no' },
};

/** Contribución de una cuenta al descuadre total. */
export interface ExplainAccount {
  bank: string;
  account_label: string;
  /** Su parte del Δ. La suma de todas da el Δ del control-total. */
  delta: number;
  /** Porcentaje del descuadre total que explica esta cuenta (sobre |Δ| total). */
  pct: number;
  /** La cuenta no aparece en una de las dos fuentes: el hueco es entero. */
  falta_en: string | null;
}

/** Δ de una cuenta para un par y un renglón dados. */
export function accountDelta(a: ThreeWayAccount, row: TwRow, pair: TwPair): number {
  const w = row === 'ingresos' ? a.wb_in : a.wb_out;
  const k = row === 'ingresos' ? a.kep_in : a.kep_out;
  const c = row === 'ingresos' ? a.cp_in : a.cp_out;
  return pair === 'wk' ? w - k : pair === 'wc' ? w - c : k - c;
}

/** Δ del control-total para un par y un renglón. */
export function totalDelta(r: ThreeWayRow, pair: TwPair): number {
  return pair === 'wk' ? r.delta_wk : pair === 'wc' ? r.delta_wc : r.delta_kc;
}

/**
 * Reparte el descuadre entre las cuentas, de mayor a menor aporte.
 *
 * Se descartan las que aportan menos de un centavo: son ruido de redondeo y
 * alargan la lista sin explicar nada.
 */
export function explainAccounts(d: ThreeWay, row: TwRow, pair: TwPair): ExplainAccount[] {
  const total = Math.abs(totalDelta(d.total[row], pair)) || 1;
  return d.por_cuenta
    .map((a) => {
      const delta = round2(accountDelta(a, row, pair));
      return {
        bank: a.bank,
        account_label: a.account_label,
        delta,
        pct: Math.round((Math.abs(delta) / total) * 1000) / 10,
        falta_en: missingSource(a, pair),
      };
    })
    .filter((x) => Math.abs(x.delta) >= 0.01)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/** Si la cuenta no existe en una de las dos fuentes del par, decirlo por su nombre. */
function missingSource(a: ThreeWayAccount, pair: TwPair): string | null {
  if (pair === 'wk' && !a.kep_has) return 'Kepler';
  if (pair === 'wc' && !a.linked) return 'ContPAQi';
  if (pair === 'kc') {
    if (!a.kep_has) return 'Kepler';
    if (!a.linked) return 'ContPAQi';
  }
  return null;
}

/** Movimiento suelto que participa del descuadre, ya normalizado para pintarlo. */
export interface ExplainMovement {
  /** Dónde está registrado: el banco, Kepler o ContPAQi. */
  fuente: 'Workbook' | 'Kepler' | 'ContPAQi';
  fecha: string;
  importe: number;
  concepto: string;
  /** Qué fuente NO lo tiene. */
  falta_en: string;
}

/**
 * Los movimientos del detalle de una cuenta que NO están en las dos fuentes del
 * par — o sea, los que empujan el Δ.
 *
 * OJO: su suma NO tiene por qué dar el Δ de la cuenta. Un movimiento presente en
 * las dos fuentes pero con importe distinto también mueve el Δ y acá no aparece
 * (sale marcado en el Detalle 3 vías). Por eso el panel presenta esta lista como
 * "lo que falta en una u otra", nunca como la aritmética del descuadre: esa vive
 * en el reparto por cuenta.
 */
export function explainMovements(dd: ThreeWayDetail, row: TwRow, pair: TwPair, limit = 25): ExplainMovement[] {
  const dir = row === 'ingresos' ? 'in' : 'out';
  const out: ExplainMovement[] = [];

  for (const e of dd.excel) {
    if (e.dir !== dir) continue;
    const faltaK = pair !== 'wc' && !e.kepler;
    const faltaC = pair !== 'wk' && !e.contpaqi;
    if (pair === 'wk' && !faltaK) continue;
    if (pair === 'wc' && !faltaC) continue;
    if (pair === 'kc' && e.kepler === e.contpaqi) continue;
    const falta = pair === 'kc'
      ? (e.kepler ? 'ContPAQi' : 'Kepler')
      : faltaK ? 'Kepler' : 'ContPAQi';
    out.push({ fuente: 'Workbook', fecha: e.fecha, importe: e.importe, concepto: e.concepto || '—', falta_en: falta });
  }

  // Los huérfanos dicen que el BANCO no tiene el movimiento; NO dicen nada de la
  // otra fuente. Por eso en el par Kepler↔ContPAQi se etiquetan como "el banco" y
  // no como "falta en la otra": afirmar eso sería inventar lo que estas listas no
  // establecen. Para ese par la evidencia dura son las filas de arriba, donde las
  // dos fuentes se comparan contra el mismo movimiento bancario.
  const orphanFalta = pair === 'kc' ? 'el banco' : 'Workbook';
  if (pair !== 'wc') {
    for (const k of dd.kepler_only) {
      if (k.dir !== dir) continue;
      out.push({ fuente: 'Kepler', fecha: k.fecha, importe: k.importe, concepto: k.concepto || k.doc, falta_en: orphanFalta });
    }
  }
  if (pair !== 'wk') {
    for (const c of dd.contpaqi_only) {
      if (c.dir !== dir) continue;
      out.push({ fuente: 'ContPAQi', fecha: c.fecha, importe: c.importe, concepto: c.concepto || c.poliza, falta_en: orphanFalta });
    }
  }

  // Los importes grandes primero: son los que mueven la aguja del descuadre.
  return out.sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe)).slice(0, limit);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
