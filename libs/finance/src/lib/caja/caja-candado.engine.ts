/**
 * ⛔⛔ `[CGS.14][CGS.15][CGS.3]` — **Los candados de la caja.** Puro: sin base, sin reloj propio.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §2.1–2.2. Decisiones de Edgar,
 * 2026-10-21: **D1** candado duro + llave de emergencia · **D2** suplente y plazo, y con dos
 * jornadas cerradas sin revisar la caja no cierra la tercera (sí captura).
 *
 * Medido ese día en prod: el 20-oct quedó con 30 movimientos ($494,128.13) y **sin corte**, y el 21
 * ya se capturaron 5 gastos ($145,906.50) encima. 4 de 7 cortes se cerraron entre uno y tres días
 * tarde. El sensor horario avisaba; avisar no alcanzó.
 *
 * ── Candado 1: sin corte de ayer, hoy no se captura ─────────────────────────────────────────
 * Si una jornada ANTERIOR a hoy tiene movimientos y no tiene corte cerrado, no se registran
 * movimientos nuevos. La salida siempre está a mano de quien captura: cerrar ese corte (contar,
 * sellar, cerrar). La excepción es la **llave de emergencia**, que da OTRA persona con
 * `FINANCE_CAJA_AUTORIZAR`, con motivo, y vence al terminar el día.
 *
 * ⚠️ Lo que NO bloquea: consultar, contar y cerrar el corte pendiente, ni firmar desde el teléfono.
 *
 * ── Candado 2 (`CGS.3`): sin revisión, no se acumula ────────────────────────────────────────
 * Con `MAXIMO_SIN_REVISAR` cortes cerrados que nadie revisó, la caja no cierra otro. ⛔ Nace
 * APAGADO: sólo cuenta los cortes cerrados desde una fecha de arranque que fija Edgar. Hoy hay 7
 * cerrados sin revisar; prenderlo contra todos trabaría el cierre del primer día.
 */

export interface JornadaPendiente { fecha: string; movimientos: number }

export interface LlaveVigente {
  otorgada_por_username: string | null;
  motivo: string;
  /** Instante ISO. */
  vence_at: string;
}

export interface EstadoParaCapturar {
  /** El día de hoy en México, `YYYY-MM-DD`. */
  hoy: string;
  /** Jornadas con movimientos y SIN corte (de cualquier estado). */
  sinCorte: JornadaPendiente[];
  /** Un corte abierto (borrador) de un día anterior a hoy, si lo hay. */
  borradorAnterior: { folio: string; fecha: string } | null;
  /** La llave de emergencia vigente para esta persona, si la hay. */
  llave: LlaveVigente | null;
  /** `false` = apagado por configuración (interruptor de emergencia). */
  activo: boolean;
}

export type MotivoCandado = 'jornada_sin_corte' | 'corte_sin_cerrar';

export interface Candado {
  bloqueado: boolean;
  motivo: MotivoCandado | null;
  /** La jornada que hay que cerrar primero. */
  jornada: string | null;
  /** La frase para la persona: qué pasa y qué la destraba. */
  texto: string | null;
  /** Se está capturando con una llave: se dice siempre, no se esconde. */
  con_llave: LlaveVigente | null;
  activo: boolean;
}

const dd = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

export function candadoDeCaptura(e: EstadoParaCapturar): Candado {
  const libre: Candado = { bloqueado: false, motivo: null, jornada: null, texto: null, con_llave: null, activo: e.activo };
  if (!e.activo) return libre;

  const anteriores = e.sinCorte.filter((j) => j.fecha < e.hoy && j.movimientos > 0);
  let motivo: MotivoCandado | null = null;
  let jornada: string | null = null;
  let texto: string | null = null;

  if (e.borradorAnterior && e.borradorAnterior.fecha < e.hoy) {
    motivo = 'corte_sin_cerrar';
    jornada = e.borradorAnterior.fecha;
    texto = `No se puede capturar: el corte ${e.borradorAnterior.folio} del ${dd(jornada)} está abierto y sin cerrar. `
      + 'Ciérralo primero (cuenta, sella y cierra), o pide una llave de emergencia a quien autoriza.';
  } else if (anteriores.length) {
    const j = anteriores[0];
    motivo = 'jornada_sin_corte';
    jornada = j.fecha;
    const mas = anteriores.length > 1 ? ` (y ${anteriores.length - 1} jornada(s) más)` : '';
    texto = `No se puede capturar: la jornada del ${dd(j.fecha)} tiene ${j.movimientos} movimiento(s) y no tiene corte cerrado${mas}. `
      + 'Ciérrala primero, o pide una llave de emergencia a quien autoriza.';
  }

  if (!motivo) return libre;
  if (e.llave) {
    return { ...libre, jornada, con_llave: e.llave };
  }
  return { bloqueado: true, motivo, jornada, texto, con_llave: null, activo: true };
}

// ── La llave ──────────────────────────────────────────────────────────────────────────────

export const MINIMO_MOTIVO_LLAVE = 10;

export type MotivoNoLlave = 'sin_usuario' | 'para_si_misma' | 'sin_motivo' | 'sin_destinatario' | 'no_hace_falta';

export const TEXTO_NO_LLAVE: Record<MotivoNoLlave, string> = {
  sin_usuario: 'No se pudo identificar quién da la llave.',
  para_si_misma: 'Nadie se abre su propio candado: la llave la da otra persona.',
  sin_motivo: `Escribe por qué hace falta capturar sin cerrar (al menos ${MINIMO_MOTIVO_LLAVE} caracteres).`,
  sin_destinatario: 'Elige para quién es la llave.',
  no_hace_falta: 'La caja no está bloqueada: no hace falta una llave.',
};

export function puedeDarLlave(input: {
  otorgaId: string | null | undefined;
  paraId: string | null | undefined;
  motivo: string | null | undefined;
  hayCandado: boolean;
}): { ok: boolean; motivo?: MotivoNoLlave } {
  if (!input.otorgaId) return { ok: false, motivo: 'sin_usuario' };
  if (!input.paraId) return { ok: false, motivo: 'sin_destinatario' };
  if (input.paraId === input.otorgaId) return { ok: false, motivo: 'para_si_misma' };
  if (String(input.motivo ?? '').trim().length < MINIMO_MOTIVO_LLAVE) return { ok: false, motivo: 'sin_motivo' };
  if (!input.hayCandado) return { ok: false, motivo: 'no_hace_falta' };
  return { ok: true };
}

// ── Candado 2 (`CGS.3`) ───────────────────────────────────────────────────────────────────

/** D2: con DOS cortes cerrados sin revisar, la caja no cierra el tercero. */
export const MAXIMO_SIN_REVISAR = 2;

export function candadoDeCierre(input: {
  /** Los cortes cerrados y sin revisar que cuentan (desde la fecha de arranque), sin el que se cierra. */
  sinRevisar: Array<{ folio: string; fecha: string }>;
  /** `null` = el candado 2 está apagado (no hay fecha de arranque). */
  desde: string | null;
}): { ok: boolean; texto?: string } {
  if (!input.desde) return { ok: true };
  if (input.sinRevisar.length < MAXIMO_SIN_REVISAR) return { ok: true };
  const lista = input.sinRevisar.map((c) => `${c.folio} (${dd(c.fecha)})`).join(', ');
  return {
    ok: false,
    texto: `No se puede cerrar otro corte: hay ${input.sinRevisar.length} cerrados sin revisar (${lista}). `
      + 'La supervisión los autoriza u observa primero; si no está, la suplente.',
  };
}
