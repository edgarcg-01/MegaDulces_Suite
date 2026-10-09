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

import {
  ESTADOS_LEVANTAMIENTO, pasaFiltroHistorial,
  type FacetaHistorial, type FacetasHistorial, type FiltroHistorial,
} from '@megadulces/contracts';

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
  /**
   * `[GX.78]` El filtro que se APLICÓ, tal como lo entendió el servidor. La pantalla lo compara
   * con el que pidió: si no coinciden, la cifra es de otra pregunta.
   */
  filtro: FiltroHistorial;
  /** `[GX.78]` El mes sin filtrar, para decir «58 de 392» y no sólo «58». */
  total_sin_filtro: { n: number; monto: number };
  /** `[GX.78]` Las opciones de cada filtro, contadas. */
  facetas: FacetasHistorial;
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

/**
 * `[GX.78]` Un grupo del mes: cuántos levantamientos hay de cada (estado, sucursal, persona).
 * Con estos ~120 grupos se cuentan las tres listas del filtro en memoria, en vez de tres
 * consultas más a la base.
 */
export interface GrupoDelMes {
  status: string | null;
  sucursal: string | null;
  created_by: string | null;
  n: number;
  monto: number;
}

function contar(grupos: readonly GrupoDelMes[], clave: (g: GrupoDelMes) => string | null): FacetaHistorial[] {
  const m = new Map<string, FacetaHistorial>();
  for (const g of grupos) {
    const valor = String(clave(g) ?? '').trim();
    // Sin valor no hay a qué filtrar: elegirlo no podría devolver nada.
    if (!valor) continue;
    const f = m.get(valor) ?? { valor, n: 0, monto: 0 };
    f.n += Number(g.n) || 0;
    f.monto += Number(g.monto) || 0;
    m.set(valor, f);
  }
  return [...m.values()].map((f) => ({ ...f, monto: Math.round(f.monto * 100) / 100 }));
}

/**
 * `[GX.78]` Las opciones de cada filtro, contadas con los OTROS filtros puestos (no con el suyo).
 *
 * ⭐ Así, con «Sucursal 08» elegida, la lista de sucursales sigue mostrando todas con su cifra
 * — se puede pasar de una a otra sin quitar el filtro — y los estados dicen cuántos hay en la 08.
 *
 * Orden: los estados en el del trámite; sucursales por clave; personas por cuántos levantaron.
 */
export function facetasDelMes(
  grupos: readonly GrupoDelMes[],
  filtro: FiltroHistorial,
  conPersonas: boolean,
): FacetasHistorial {
  const sin = (quitar: Partial<FiltroHistorial>): FiltroHistorial => ({ ...filtro, ...quitar });
  const de = (f: FiltroHistorial) => grupos.filter((g) => pasaFiltroHistorial(g, f));

  // Un estado que la regla no conoce va al final, no se esconde: también es un levantamiento.
  const pos = (v: string) => { const i = (ESTADOS_LEVANTAMIENTO as readonly string[]).indexOf(v); return i < 0 ? 99 : i; };
  const estados = contar(de(sin({ estados: [] })), (g) => g.status)
    .sort((a, b) => pos(a.valor) - pos(b.valor));
  const sucursales = contar(de(sin({ sucursal: null })), (g) => g.sucursal)
    .sort((a, b) => a.valor.localeCompare(b.valor));
  const personas = conPersonas
    ? contar(de(sin({ persona: null })), (g) => g.created_by)
      .sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor, 'es'))
    : null;
  return { estados, sucursales, personas };
}
