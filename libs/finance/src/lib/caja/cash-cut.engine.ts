/**
 * CG.15 — Aritmética del corte de caja, en funciones PURAS (ADR-070).
 *
 * El corte es el momento en que alguien dice "esto es lo que hay". Si la cuenta que produce
 * ese número vive enredada con los SELECT, no se puede auditar sin levantar una base. Acá
 * está sola, con sus casos, y el servicio sólo le pasa filas.
 *
 * La misma cuenta la hace la DB (`cut_cerrado_completo_chk`) y la pantalla. Es a propósito:
 * la del servidor es el candado, ésta es para que el capturista vea la diferencia ANTES de
 * cerrar, y la de la pantalla para que la vea mientras cuenta.
 */

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

export interface MovimientoDelCorte {
  tipo: TipoMovimiento;
  monto: number;
  /** Un movimiento cancelado NO entra al corte, pero sigue existiendo (se audita que se canceló). */
  estado?: string;
}

export interface ConteoDenominacion { denominacion: number; piezas: number }

export interface TotalesCorte {
  ingresos: number;
  gastos: number;
  depositos: number;
  /** fondo_inicial + ingresos − gastos − depósitos: lo que DEBERÍA haber en la caja. */
  esperado: number;
  /** Σ(denominación × piezas) + morralla: lo que la persona contó. */
  contado: number;
  /** contado − esperado. Positivo SOBRA, negativo FALTA. */
  diferencia: number;
  /** `cuadra` sólo si |diferencia| ≤ 1 centavo. `sin_contar` NO es `cuadra`. */
  veredicto: 'cuadra' | 'sobra' | 'falta' | 'sin_contar';
  /** Cuántos movimientos entraron y cuántos se ignoraron por estar cancelados. */
  movimientos: number;
  cancelados: number;
}

/** Tolerancia del cuadre: un centavo, por el redondeo de numeric. */
export const CORTE_EPSILON = 0.005;

export function redondea(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * La cuenta completa del corte. Devuelve TODO lo que hace falta para defender el número:
 * los tres totales, el esperado, el contado, la diferencia y el veredicto.
 *
 * ⚠️ `sin_contar` es un veredicto propio a propósito. Si un corte sin conteo devolviera
 * `cuadra` (diferencia 0 contra 0), un día que nadie contó se vería igual que un día que
 * cuadró al centavo — que es exactamente la clase de mentira que esta fase existe para matar.
 */
export function calcularCorte(input: {
  fondoInicial: number;
  movimientos: MovimientoDelCorte[];
  conteo?: ConteoDenominacion[] | null;
  morralla?: number;
}): TotalesCorte {
  const vivos = (input.movimientos ?? []).filter((m) => m && m.estado !== 'cancelado');
  const cancelados = (input.movimientos ?? []).length - vivos.length;

  const suma = (t: TipoMovimiento) =>
    redondea(vivos.filter((m) => m.tipo === t).reduce((a, m) => a + Number(m.monto || 0), 0));

  const ingresos = suma('ingreso');
  const gastos = suma('gasto');
  const depositos = suma('deposito');
  const esperado = redondea(Number(input.fondoInicial || 0) + ingresos - gastos - depositos);

  const piezas = (input.conteo ?? []).filter((d) => d && Number(d.piezas) > 0);
  const morralla = Number(input.morralla || 0);
  const huboConteo = piezas.length > 0 || morralla > 0;
  const contado = redondea(piezas.reduce((a, d) => a + Number(d.denominacion) * Number(d.piezas), 0) + morralla);
  const diferencia = redondea(contado - esperado);

  let veredicto: TotalesCorte['veredicto'];
  if (!huboConteo) veredicto = 'sin_contar';
  else if (Math.abs(diferencia) <= CORTE_EPSILON) veredicto = 'cuadra';
  else veredicto = diferencia > 0 ? 'sobra' : 'falta';

  return {
    ingresos, gastos, depositos, esperado,
    contado: huboConteo ? contado : 0,
    diferencia: huboConteo ? diferencia : 0,
    veredicto, movimientos: vivos.length, cancelados,
  };
}

export interface CorteEstado {
  estado: 'borrador' | 'cerrado' | 'autorizado';
  closed_by?: string | null;
  authorized_by?: string | null;
}

export type MotivoNoAutoriza =
  | 'no_esta_cerrado'
  | 'ya_autorizado'
  | 'misma_persona_que_cerro'
  | 'sin_usuario';

export const TEXTO_NO_AUTORIZA: Record<MotivoNoAutoriza, string> = {
  no_esta_cerrado: 'El corte todavía no se cierra.',
  ya_autorizado: 'Este corte ya está autorizado.',
  misma_persona_que_cerro: 'Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.',
  sin_usuario: 'No se pudo identificar quién autoriza.',
};

/**
 * ⛔ LA DOBLE LLAVE, del lado del código. La DB ya lo impide con un CHECK; esto existe para
 * que el botón se apague con su motivo en vez de que el usuario descubra el candado con un
 * error de Postgres.
 */
export function puedeAutorizar(c: CorteEstado, userId: string | null | undefined): { ok: boolean; motivo?: MotivoNoAutoriza } {
  if (!userId) return { ok: false, motivo: 'sin_usuario' };
  if (c.estado === 'autorizado') return { ok: false, motivo: 'ya_autorizado' };
  if (c.estado !== 'cerrado') return { ok: false, motivo: 'no_esta_cerrado' };
  if (c.closed_by && c.closed_by === userId) return { ok: false, motivo: 'misma_persona_que_cerro' };
  return { ok: true };
}

export type MotivoNoCierra = 'no_es_borrador' | 'sin_conteo' | 'sin_usuario';

export const TEXTO_NO_CIERRA: Record<MotivoNoCierra, string> = {
  no_es_borrador: 'Este corte ya está cerrado.',
  sin_conteo: 'Contá el efectivo antes de cerrar: un corte sin conteo no cuadra nada.',
  sin_usuario: 'No se pudo identificar quién cierra.',
};

export function puedeCerrar(
  c: CorteEstado, userId: string | null | undefined, totales: TotalesCorte,
): { ok: boolean; motivo?: MotivoNoCierra } {
  if (!userId) return { ok: false, motivo: 'sin_usuario' };
  if (c.estado !== 'borrador') return { ok: false, motivo: 'no_es_borrador' };
  // Cerrar sin contar es firmar un papel en blanco.
  if (totales.veredicto === 'sin_contar') return { ok: false, motivo: 'sin_conteo' };
  return { ok: true };
}

/** Motivo de cancelación: mismo piso que el CHECK de la DB, para avisar antes del 400. */
export const CANCEL_MOTIVO_MIN = 5;

export function motivoCancelacionValido(motivo: string | null | undefined): boolean {
  return !!motivo && motivo.trim().length >= CANCEL_MOTIVO_MIN;
}

/**
 * ⛔ Un movimiento que ya entró a un corte CERRADO no se cancela: movería un cuadre que
 * alguien ya firmó. Lo que corresponde es un movimiento nuevo que lo corrija.
 */
export function puedeCancelarse(m: { estado?: string; corte_id?: string | null }, estadoDelCorte?: string | null): boolean {
  if (m.estado === 'cancelado') return false;
  if (m.corte_id && estadoDelCorte && estadoDelCorte !== 'borrador') return false;
  return true;
}

/** Folio del corte. El consecutivo lo da Postgres; acá sólo se le da forma. */
export function buildFolioCorte(year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`consecutivo inválido: ${seq}`);
  return `CC-${year}-${String(seq).padStart(5, '0')}`;
}
