/**
 * `[PU.VG.7]` EL RITMO: cuanto del presupuesto anual DEBERIA llevarse consumido a la fecha.
 *
 * -- Por que existe ----------------------------------------------------------
 * El ledger de egresos no tiene eje de tiempo: `budget_lines.period_month` esta en NULL en las
 * 139 filas de prod (medido 2026-10-09). No es un descuido -- `budget-materialize.service.ts`
 * agrupa el plan por `cuenta|sucursal` y COLAPSA los 17 meses a una sola linea; el mes se usa
 * para derivar `recurrence` y se descarta. Consecuencia: `available_amount` es un numero ANUAL,
 * asi que se puede quemar el ano entero en enero y ninguna compuerta se entera hasta el cierre.
 *
 * La correccion obvia --meter el mes en el grano-- es DESTRUCTIVA: `source_ref` es la clave
 * natural con la que `materialize` reconcilia, y el propio archivo advierte que cambiarla borra y
 * recrea las lineas existentes, PERDIENDO SU HISTORIAL DE MOVIMIENTOS. Ademas multiplicaria 14
 * renglones por 17 y `budget.expense_obligations.budget_line_id` (Fase TP) cuelga de ellos.
 *
 * Por eso el perfil mensual se lee AL LADO, no en lugar de: ya vive en
 * `budget.expense_plan_lines.year_month` y no hay que guardar nada. Es la regla 3 del contrato
 * (el numero viejo se conserva al lado) aplicada al grano.
 *
 * -- El mes en curso se EXCLUYE, y el criterio no es nuevo -------------------
 * `year_month < mesEnCurso`, identico al de `analytics.v_expense_arbiter.mes_en_curso` y al que
 * ya usa `budget-expense-plan.service.ts`. Un segundo criterio para la misma idea seria un
 * segundo primitivo (ADR-056). MEDIDO: incluir octubre movia la brecha de FY2026 de
 * $13,653,449.54 a $19,903,668.37 -- 46% de inflacion sin que pasara nada en el negocio.
 *
 * -- Lo que este modulo NO hace ---------------------------------------------
 * No emite verde. No hay umbral de materialidad registrado en ningun lado (medido: cero columnas
 * umbral/threshold/materialidad en `budget.*`, cero filas de gasto en `analytics.kpi_thresholds`),
 * asi que inventar un 5% aca seria fabricar una politica que nadie firmo. Devuelve los hechos y
 * `umbral_registrado: false`, que es la ausencia con nombre.
 */

/** Una fila del plan de gasto, al grano en que vive: cuenta x sucursal x mes. */
export interface PlanRow {
  account_code: unknown;
  sucursal?: unknown;
  year_month: unknown;
  monto: unknown;
}

/** Una partida del ledger, al grano en que vive: cuenta x sucursal, sin mes. */
export interface LedgerRow {
  account_code: unknown;
  cost_center?: unknown;
  concept?: unknown;
  original_amount: unknown;
  reserved_amount?: unknown;
  committed_amount?: unknown;
  exercised_amount?: unknown;
}

export type EstadoRitmo =
  | 'sin_plan'
  | 'sin_perfil'
  | 'desfase_plan_vs_linea'
  | 'sin_consumo'
  | 'sobre_perfil'
  | 'bajo_perfil'
  | 'en_ritmo';

export interface Ritmo {
  account_code: string;
  sucursal: string;
  concept: string | null;
  /** Suma de los meses del plan YA CERRADOS. `null` cuando no se puede calcular. */
  deberia: number | null;
  /** `reserved + committed + exercised`. El pagado NO entra: ya paso por ejercido. */
  consumido: number;
  brecha: number | null;
  brecha_pct: number | null;
  meses_plan: number;
  meses_cerrados: number;
  anual_plan: number | null;
  anual_linea: number;
  estado: EstadoRitmo;
  motivo: string | null;
}

/**
 * `Number(null)` es 0, no NaN, asi que `isFinite` no atrapa una columna ausente -- un cero es
 * plausible donde un NaN es inverosimil. Por eso la ausencia se chequea ANTES de convertir. Es el
 * defecto que ya dio un falso verde sobre $49M en este mismo carril.
 */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const cents = (n: number) => Math.round(n * 100) / 100;
const key = (cuenta: unknown, suc: unknown) => String(cuenta ?? '') + '|' + String(suc ?? '');

export interface Perfil {
  anual: number;
  hasta_mes_cerrado: number;
  meses: number;
  meses_cerrados: number;
}

/**
 * Acumula el plan por cuenta x sucursal, separando los meses cerrados del total.
 * `mesEnCurso` llega de afuera (`YYYY-MM`) para no clonar el criterio aca dentro.
 */
export function perfilAcumulado(rows: readonly PlanRow[], mesEnCurso: string): Map<string, Perfil> {
  const out = new Map<string, Perfil>();
  for (const r of rows ?? []) {
    const k = key(r.account_code, r.sucursal ?? '');
    const monto = num(r.monto) ?? 0;
    const ym = String(r.year_month ?? '');
    const p = out.get(k) ?? { anual: 0, hasta_mes_cerrado: 0, meses: 0, meses_cerrados: 0 };
    p.anual = cents(p.anual + monto);
    p.meses++;
    // El mes en curso se excluye: un promedio no se puede marcar, se contamina.
    if (ym && ym < mesEnCurso) {
      p.hasta_mes_cerrado = cents(p.hasta_mes_cerrado + monto);
      p.meses_cerrados++;
    }
    out.set(k, p);
  }
  return out;
}

/** La llave con la que una partida del ledger encuentra su perfil. */
export function llaveDePartida(linea: LedgerRow): string {
  return key(linea.account_code, linea.cost_center ?? '');
}

/** Evalua una partida del ledger contra su perfil. Nunca devuelve verde por ausencia. */
export function evaluarRitmo(linea: LedgerRow, perfil: Perfil | undefined): Ritmo {
  const anualLinea = num(linea.original_amount) ?? 0;
  const consumido = cents(
    (num(linea.reserved_amount) ?? 0) +
      (num(linea.committed_amount) ?? 0) +
      (num(linea.exercised_amount) ?? 0),
  );
  const base: Ritmo = {
    account_code: String(linea.account_code ?? ''),
    sucursal: String(linea.cost_center ?? ''),
    concept: linea.concept == null ? null : String(linea.concept),
    deberia: null,
    consumido,
    brecha: null,
    brecha_pct: null,
    meses_plan: perfil?.meses ?? 0,
    meses_cerrados: perfil?.meses_cerrados ?? 0,
    anual_plan: perfil ? perfil.anual : null,
    anual_linea: anualLinea,
    estado: 'sin_plan',
    motivo: 'La partida no tiene renglones de plan: no hay perfil contra el cual medirla.',
  };
  if (!perfil) return base;

  // El anual del plan y el de la partida tienen que ser el mismo numero. Si alguien amplio o
  // redujo la partida despues de materializar, el perfil describe otro presupuesto y medir el
  // ritmo contra el daria una brecha que no significa nada.
  if (Math.abs(cents(perfil.anual - anualLinea)) >= 0.01) {
    return {
      ...base,
      estado: 'desfase_plan_vs_linea',
      motivo:
        'El plan suma ' + perfil.anual + ' y la partida ' + anualLinea +
        ': se movio despues de materializar.',
    };
  }

  if (perfil.meses_cerrados === 0) {
    return {
      ...base,
      estado: 'sin_perfil',
      motivo: 'El plan todavia no cierra ni un mes: el periodo no empezo a transcurrir.',
    };
  }

  const deberia = perfil.hasta_mes_cerrado;
  const brecha = cents(consumido - deberia);
  const brecha_pct = deberia === 0 ? null : cents((brecha / deberia) * 100);
  const estado: EstadoRitmo =
    consumido === 0 && deberia > 0
      ? 'sin_consumo'
      : brecha > 0
        ? 'sobre_perfil'
        : brecha < 0
          ? 'bajo_perfil'
          : 'en_ritmo';
  const motivo =
    estado === 'sin_consumo'
      ? 'Con ' + perfil.meses_cerrados + ' de ' + perfil.meses +
        ' meses cerrados el plan ya devengo ' + deberia + ' y el ledger no registra un peso.'
      : null;
  return { ...base, deberia, brecha, brecha_pct, estado, motivo };
}

export interface ResumenRitmo {
  partidas: number;
  sobre_perfil: number;
  sin_consumo: number;
  no_evaluables: number;
  /** Suma de brechas de las partidas que SI se pudieron evaluar. `null` si ninguna lo fue. */
  brecha_total: number | null;
  /** No existe umbral de materialidad registrado: el consumidor no debe pintar semaforo. */
  umbral_registrado: false;
}

export function resumirRitmo(filas: readonly Ritmo[]): ResumenRitmo {
  const evaluables = filas.filter((f) => f.brecha != null);
  return {
    partidas: filas.length,
    sobre_perfil: filas.filter((f) => f.estado === 'sobre_perfil').length,
    sin_consumo: filas.filter((f) => f.estado === 'sin_consumo').length,
    no_evaluables: filas.filter(
      (f) =>
        f.estado === 'sin_plan' || f.estado === 'sin_perfil' || f.estado === 'desfase_plan_vs_linea',
    ).length,
    brecha_total: evaluables.length
      ? cents(evaluables.reduce((a, f) => a + (f.brecha as number), 0))
      : null,
    umbral_registrado: false,
  };
}
