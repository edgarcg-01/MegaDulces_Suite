/**
 * `[GX.27]` — **El mes del historial de gastos.** Funciones puras.
 *
 * El historial dejó de ser una tabla de 200 renglones y pasó a ser un **calendario**: un mes
 * a la vista, cada día con cuántos levantamientos hubo y cuánto sumaron.
 *
 * Acá vive sólo lo que decide **qué mes se está mirando y qué rango cubre** — sin knex, para
 * poder probarlo sin levantar una base. Mismo criterio que `etapas-del-dia.ts`.
 *
 * ## ⚠️ El mes es el de México
 * Un levantamiento hecho el 30 a las 20:00 de México ya es día 1 en UTC. Si el corte del mes
 * se hiciera en UTC, ese gasto aparecería en el mes siguiente — y el total de octubre se
 * comería el último día de septiembre.
 */

/** Un mes de calendario, `YYYY-MM`. */
export type MesIso = string;

/**
 * Valida `YYYY-MM`.
 *
 * ⛔ Devuelve `null` —no «este mes»— ante algo ilegible. Caer al mes actual en silencio haría
 * que un parámetro roto se vea igual que un mes sin gasto, y quien mira creería que no hubo
 * movimiento. Es la misma regla que `diaValido()`.
 */
export function mesValido(v: unknown): MesIso | null {
  const t = String(v ?? '').trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(t)) return null;
  const mes = Number(t.slice(5, 7));
  const anio = Number(t.slice(0, 4));
  // Un año fuera de rango no es un mes: viene de un parámetro armado a mano.
  if (mes < 1 || mes > 12 || anio < 2000 || anio > 2999) return null;
  return t;
}

/** El mes al que pertenece un día `YYYY-MM-DD`. */
export function mesDe(dia: string): MesIso | null {
  const t = String(dia ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t.slice(0, 7) : null;
}

/**
 * El rango de un mes, **medio abierto**: `[desde, hasta)`.
 *
 * Se devuelve como `YYYY-MM-DD` para que la consulta lo convierta a la hora de México con
 * `AT TIME ZONE`. ⛔ El límite superior es el **día 1 del mes siguiente**, no «el día 31»:
 * calcular el último día del mes a mano es de donde salen los febreros rotos y los gastos del
 * 31 que no aparecen en ningún lado.
 */
export function rangoDelMes(mes: MesIso): { desde: string; hasta: string } {
  const anio = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  const sigAnio = m === 12 ? anio + 1 : anio;
  const sigMes = m === 12 ? 1 : m + 1;
  const dosDig = (n: number) => String(n).padStart(2, '0');
  return {
    desde: `${anio}-${dosDig(m)}-01`,
    hasta: `${sigAnio}-${dosDig(sigMes)}-01`,
  };
}

/** Un día del calendario, con lo que se levantó ese día. */
export interface DiaDelCalendario {
  /** `YYYY-MM-DD`, en hora de México. */
  dia: string;
  n: number;
  monto: number;
}

export interface CalendarioDelMes {
  mes: MesIso;
  /** El mes que pidieron cuando era ilegible y se cayó al actual. `null` = todo en orden. */
  mes_pedido: string | null;
  /** Sólo los días CON movimiento. Los vacíos no viajan: la rejilla los dibuja igual. */
  dias: DiaDelCalendario[];
  total: { n: number; monto: number };
  /** `mios` = lo de esta persona · `todos` = el de toda la empresa (god-mode). */
  alcance: 'mios' | 'todos';
}

/**
 * Suma el mes a partir de sus días.
 *
 * ⚠️ El total se redondea **al final**, no día por día: redondear en cada paso corre la cifra
 * unos centavos y el encabezado deja de cuadrar con la suma de las celdas — que es lo primero
 * que alguien verifica a mano cuando desconfía de un calendario.
 */
export function totalDelMes(dias: readonly DiaDelCalendario[]): { n: number; monto: number } {
  const lista = dias ?? [];
  return {
    n: lista.reduce((a, d) => a + (Number(d?.n) || 0), 0),
    monto: Math.round(lista.reduce((a, d) => a + (Number(d?.monto) || 0), 0) * 100) / 100,
  };
}
