/**
 * [PU.VG.4b] — Recomputar el estado de una partida DESDE su ledger de movimientos.
 *
 * Módulo PURO (cero imports) para poder romperlo en una prueba sin levantar Nest.
 *
 * ⭐ POR QUÉ ESTE CUADRE Y NO EL OBVIO. El cuadre que todo el mundo escribe —
 * `vigente − (reservado + comprometido + ejercido) = disponible`— **no puede fallar**:
 * `available_amount` no es una columna que pueda derivar, se calcula con esa misma resta en
 * `budget-lines.service.ts`. Auditarlo es auditar una expresión contra sí misma. Lo que SÍ puede
 * derivar es el acumulador guardado en `budget_lines` contra la suma de los movimientos: ahí se
 * ven un UPDATE directo, una transacción a medias, un arreglo a mano — y, sobre todo, el dinero
 * movido entre partidas para que ninguna salga sobregirada.
 *
 * ⚠️ ESTO ES UNA SEGUNDA IMPLEMENTACIÓN, a propósito. Reproduce la máquina de estados del
 * servicio sin llamarla; si las dos coinciden sobre datos reales, la coincidencia significa algo.
 * Si algún día el servicio cambia una transición y esto no, el candado se pone rojo — que es
 * exactamente lo que tiene que pasar.
 *
 * ⛔ Lo que NO se puede reconstruir se DECLARA (ADR-056), nunca se asume:
 *   · un `movement_type` que esta función no modela (p. ej. `reversion`, que está en el CHECK de
 *     la tabla y **ningún código produce**) → `reconstruible: false` con su motivo;
 *   · una `cancelacion` sin `cancel_target` → no se sabe qué bucket bajó (filas anteriores a
 *     `[PU.VG.4a]`);
 *   · un `compromiso` sin `from_reserva` → no se sabe si movió una reserva o consumió disponible.
 */

export type Movimiento = {
  movement_type: string;
  amount: number | string;
  cancel_target?: string | null;
  from_reserva?: boolean | null;
};

export type Acumuladores = {
  vigente: number;
  reserved: number;
  committed: number;
  exercised: number;
  paid: number;
};

export type Reconstruccion = Acumuladores & {
  /** false = esta partida NO se puede juzgar. Nunca se devuelven números inventados junto a esto. */
  reconstruible: boolean;
  /** Por qué no se pudo. NULL cuando sí se pudo — dos ausencias distintas, dos valores distintos. */
  motivo: string | null;
  movimientos: number;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Tipos que esta función sabe aplicar. Uno fuera de esta lista invalida la reconstrucción. */
export const TIPOS_MODELADOS = [
  'apertura', 'ampliacion', 'reduccion', 'transferencia_in', 'transferencia_out',
  'reserva', 'compromiso', 'ejercido', 'pago', 'cancelacion',
];

export function reconstruirAcumuladores(movs: Movimiento[]): Reconstruccion {
  const acc: Acumuladores = { vigente: 0, reserved: 0, committed: 0, exercised: 0, paid: 0 };
  const no = (motivo: string): Reconstruccion => ({ ...acc, reconstruible: false, motivo, movimientos: movs.length });

  for (const m of movs) {
    const amt = Number(m.amount);
    if (!Number.isFinite(amt)) return no(`monto no numérico en un ${m.movement_type}`);
    const t = String(m.movement_type);

    switch (t) {
      case 'apertura':
      case 'ampliacion':
      case 'transferencia_in':
        acc.vigente = r2(acc.vigente + amt); break;
      case 'reduccion':
      case 'transferencia_out':
        acc.vigente = r2(acc.vigente - amt); break;
      case 'reserva':
        acc.reserved = r2(acc.reserved + amt); break;
      case 'compromiso':
        // La transición depende de de dónde salió el dinero, y eso sólo lo dice `from_reserva`.
        if (m.from_reserva == null) return no('compromiso sin from_reserva: no se sabe si movió una reserva o consumió disponible');
        acc.committed = r2(acc.committed + amt);
        if (m.from_reserva === true) acc.reserved = r2(acc.reserved - amt);
        break;
      case 'ejercido':
        acc.committed = r2(acc.committed - amt);
        acc.exercised = r2(acc.exercised + amt); break;
      case 'pago':
        acc.paid = r2(acc.paid + amt); break;
      case 'cancelacion':
        if (m.cancel_target === 'reserva') acc.reserved = r2(acc.reserved - amt);
        else if (m.cancel_target === 'compromiso') acc.committed = r2(acc.committed - amt);
        else return no('cancelacion sin cancel_target: no se sabe qué acumulador bajó');
        break;
      default:
        return no(`movement_type no modelado: ${t}`);
    }
  }
  return { ...acc, reconstruible: true, motivo: null, movimientos: movs.length };
}

/** Una diferencia por campo entre lo guardado y lo reconstruido. Vacío = cuadra. */
export function diferencias(guardado: Partial<Acumuladores>, calc: Acumuladores): string[] {
  const out: string[] = [];
  for (const k of ['vigente', 'reserved', 'committed', 'exercised', 'paid'] as const) {
    const g = Number(guardado[k] ?? 0);
    if (Math.abs(r2(g - calc[k])) >= 0.01) out.push(`${k}: guardado ${g.toFixed(2)} vs ledger ${calc[k].toFixed(2)}`);
  }
  return out;
}
