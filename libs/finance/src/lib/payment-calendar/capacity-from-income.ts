import type { IngresoDiaRow } from '../budget/income-forecast.sql';

/**
 * `[PU.14]` **De ingreso diario a capacidad de pago diaria.** Pura, sin base de datos: así se prueba.
 *
 * Decisión de Francisco (2026-10-14): el Calendario de Pagos estima su capacidad, por default, con el
 * estimado de ingresos (el que sale del histórico de oct–dic 2025), y si hay que ajustar se hace a
 * mano el día anterior, antes de que el día pase a Pagos.
 *
 *  · Capacidad de un día hábil = lo que entra ESE día (real si ya está cargado, si no el estimado;
 *    bancos + caja general) + lo que entró en los días inhábiles inmediatamente anteriores (fin de
 *    semana, feriado bancario). El dinero del sábado se paga el lunes, no se pierde.
 *  · Días hábiles = lunes a viernes, menos los inhábiles bancarios que declara la versión.
 *  · ⛔ Un día sin real y sin estimado NO se propone en $0 (eso autorizaría «cero» como si se hubiera
 *    medido): se devuelve en `sin_estimado` para que se diga.
 */

export type OrigenIngreso = 'real' | 'estimado' | 'mixto';

export interface CapacidadIngresoItem {
  date: string;
  /** Lo que se propone autorizar ese día. */
  amount: number;
  /** Lo que entra ese mismo día. */
  ingreso_dia: number;
  /** Lo que entró en los días inhábiles anteriores y se suma a este. */
  arrastre: number;
  /** Los días inhábiles que se sumaron. */
  arrastre_de: string[];
  origen: OrigenIngreso;
}

export interface CapacidadDesdeIngreso {
  items: CapacidadIngresoItem[];
  /** Días hábiles del rango sin real ni estimado: no se proponen. */
  sin_estimado: string[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function valorDelDia(row: IngresoDiaRow): { v: number | null; origenes: Set<'real' | 'estimado'> } {
  const origenes = new Set<'real' | 'estimado'>();
  let v: number | null = null;
  for (const canal of ['bancos', 'caja_general'] as const) {
    const real = row.real[canal];
    const est = row.est[canal];
    if (real !== null) { v = (v ?? 0) + real; origenes.add('real'); }
    else if (est !== null) { v = (v ?? 0) + est; origenes.add('estimado'); }
  }
  return { v, origenes };
}

export function esHabil(row: Pick<IngresoDiaRow, 'fecha' | 'dia_semana'>, inhabiles: Set<string>): boolean {
  return row.dia_semana >= 1 && row.dia_semana <= 5 && !inhabiles.has(row.fecha);
}

/**
 * `rows` tiene que empezar ANTES de `from` (al menos una semana): el arrastre del fin de semana
 * previo al primer lunes del rango se acumula con esos días.
 */
export function capacidadDesdeIngreso(
  rows: IngresoDiaRow[],
  inhabilesLista: string[],
  from: string,
  to: string,
): CapacidadDesdeIngreso {
  const inhabiles = new Set(inhabilesLista);
  const items: CapacidadIngresoItem[] = [];
  const sinEstimado: string[] = [];
  let arrastre = 0;
  let arrastreDe: string[] = [];
  let origenesArrastre = new Set<'real' | 'estimado'>();

  for (const row of [...rows].sort((a, b) => (a.fecha < b.fecha ? -1 : 1))) {
    if (row.fecha > to) break;
    const { v, origenes } = valorDelDia(row);
    if (!esHabil(row, inhabiles)) {
      if (v !== null) { arrastre += v; arrastreDe.push(row.fecha); origenes.forEach((o) => origenesArrastre.add(o)); }
      else if (row.fecha >= from) sinEstimado.push(row.fecha);
      continue;
    }
    if (row.fecha >= from) {
      if (v === null) {
        // Sin real ni estimado ese día: NO se propone, ni siquiera con el puro arrastre (eso
        // autorizaría un día no medido). El arrastre sigue acumulado al siguiente día hábil.
        sinEstimado.push(row.fecha);
        continue;
      } else {
        const todos = new Set([...origenes, ...origenesArrastre]);
        items.push({
          date: row.fecha,
          amount: r2((v ?? 0) + arrastre),
          ingreso_dia: r2(v ?? 0),
          arrastre: r2(arrastre),
          arrastre_de: arrastreDe,
          origen: todos.size > 1 ? 'mixto' : todos.has('real') ? 'real' : 'estimado',
        });
      }
    }
    // Un día hábil (dentro o antes del rango) «usa» lo acumulado: se reinicia.
    arrastre = 0;
    arrastreDe = [];
    origenesArrastre = new Set();
  }
  return { items, sin_estimado: sinEstimado };
}
