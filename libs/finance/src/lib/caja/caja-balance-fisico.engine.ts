/**
 * `[LE.CU.2]` — **El balance físico de Caja General**: lo que hay (cajón contado + bóveda) contra
 * lo que el libro dice que debería haber. Funciones PURAS (ADR-070).
 *
 * ── Por qué es el testigo que manda ────────────────────────────────────────────────────────────
 * El libro, Kepler y CAOS registran lo que alguien capturó, cobró o depositó. El efectivo contado no
 * depende de nadie: es el único que ve lo que ninguno de los otros registró (§36.1). Pero sólo
 * prueba el **neto**: `entradas sin libro − salidas sin libro`, nunca cada lado (§36.5).
 *
 * ── El bulto ──────────────────────────────────────────────────────────────────────────────────
 * `cash_ledger_cuts.contado` = piezas por denominación + `morralla`. La morralla es el metal de
 * menos de 50¢ (`[LE.2.12]`), pero los cortes sellados antes de esa regla traen cientos de miles
 * tecleados ahí, sin desglose: **$188,560** al cierre del 3-nov, que en el arqueo de Control
 * aparecen como cheques (§36.5, §36.8). Contarlo como efectivo invierte el signo del balance
 * (faltan $48,047.70 ↔ sobran $140,512.30). Por eso el bulto **se separa y se declara**: el
 * balance se publica con lo contado pieza por pieza, y el otro escenario al lado.
 */
import { redondea2 } from './caja-cuadre.engine';

/** El tope de la morralla: lo que pase de aquí no es metal suelto, es un monto tecleado. */
export const MORRALLA_TOPE = 0.49;

export interface ConteoCajon {
  /** Σ denominación × piezas. */
  piezas: number;
  /** Lo tecleado como morralla. */
  morralla: number;
}

/** Lo contado de verdad y el bulto declarado sin contar. La morralla legítima (≤ 49¢) es contado. */
export function separaBulto(c: ConteoCajon): { contado: number; bulto: number } {
  const m = Number(c.morralla) || 0;
  const p = Number(c.piezas) || 0;
  return m > MORRALLA_TOPE ? { contado: redondea2(p), bulto: redondea2(m) } : { contado: redondea2(p + m), bulto: 0 };
}

export interface EntradaBalance {
  inicial: { cajon: number; boveda: number | null };
  ingresos: number;
  gastos: number;
  final: { conteo: ConteoCajon; boveda: number | null };
}

export interface Balance {
  /** `null` si falta la bóveda de un extremo: sin ella no hay balance, y se dice. */
  esperado: number | null;
  contado: number | null;
  /** contado − esperado. Negativo = falta efectivo contra el libro. */
  diferencia: number | null;
  bulto: number;
  /** La diferencia si el bulto fuera efectivo. Se publica al lado, nunca en lugar de la otra. */
  diferencia_si_bulto_es_efectivo: number | null;
  medible: boolean;
}

export function balanceFisico(e: EntradaBalance): Balance {
  const { contado, bulto } = separaBulto(e.final.conteo);
  if (e.inicial.boveda == null || e.final.boveda == null) {
    return { esperado: null, contado: null, diferencia: null, bulto, diferencia_si_bulto_es_efectivo: null, medible: false };
  }
  const esperado = redondea2(Number(e.inicial.cajon) + e.inicial.boveda + Number(e.ingresos) - Number(e.gastos));
  const fisico = redondea2(contado + e.final.boveda);
  return {
    esperado,
    contado: fisico,
    diferencia: redondea2(fisico - esperado),
    bulto,
    diferencia_si_bulto_es_efectivo: redondea2(fisico + bulto - esperado),
    medible: true,
  };
}
