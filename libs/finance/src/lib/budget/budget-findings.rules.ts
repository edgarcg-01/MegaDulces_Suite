/**
 * `[PU.VG.8]` **El presupuesto deja de declarar hacia adentro.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-09: `finance.findings` tiene **157,262 filas y 41 reglas, y
 * NINGUNA es de presupuesto**. Este carril lleva seis declaraciones medidas —supuesto sin firmar,
 * partidas sin un peso registrado, relleno plano, ejercicio parcial publicado como anual, freno
 * duro ausente— y las seis viven **sólo en una pantalla que nadie abre**. Una declaración que no
 * llega a una bandeja no es un control: es una nota.
 *
 * No se inventa bandeja: se usa la que ya existe (`FINANCE_FINDINGS_SINK_PORT`, 5 consumidores).
 * ADR-056 — un primitivo no cierra la fase hasta vivir en `libs/` compartido, y éste ya vivía.
 *
 * ── Las reglas de este módulo son PURAS ──────────────────────────────────────
 * Reciben lo ya medido y devuelven hallazgos. No consultan, no saben de Postgres y no deciden
 * cuándo corren. Así se pueden romper a propósito en una unitaria, que es lo único que distingue
 * una compuerta de una intención.
 *
 * ── Lo que NINGUNA de estas reglas hace ──────────────────────────────────────
 * **Inventar un importe.** Si la entrada no trae cifra, el hallazgo no se emite — nunca se publica
 * `importe: 0`, que en una bandeja ordenada por monto manda el hallazgo al fondo y lo entierra.
 * Y **ninguna mira ejercicios de prueba**: el duplicado FY2027 publicaría cada hallazgo dos veces,
 * con el mismo texto, y eso enseña a ignorar la bandeja más rápido que no tenerla.
 */

import type { FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

/** Las reglas se registran con su nombre y clase; el sink las hace idempotentes. */
export const BUDGET_RULES: FinanceRuleInput[] = [
  {
    rule_key: 'presupuesto_supuesto_sin_firma',
    nombre: 'Plan de gasto sin supuesto firmado',
    descripcion:
      'El plan de gasto se armó con un crecimiento que nadie firmó. Un 0 % inventado es ' +
      'indistinguible de un 0 % decidido, y congelar el gasto es una decisión legítima: por eso ' +
      'la firma es el HECHO de que una persona tocó los supuestos, no un valor.',
    clase: 'riesgo',
  },
  {
    rule_key: 'presupuesto_partida_sin_consumo',
    nombre: 'Partida con gasto devengado y cero registrado',
    descripcion:
      'El perfil mensual del plan dice que esta partida ya devengó, y el ledger no registra un ' +
      'peso. No afirma que no se haya gastado: afirma que no se ANOTÓ, que es otra cosa y la ' +
      'arregla otra persona.',
    clase: 'error_captura',
  },
  {
    rule_key: 'presupuesto_partida_sobre_perfil',
    nombre: 'Partida consumida por encima de su perfil',
    descripcion:
      'Consumido (reserva + compromiso + ejercido) por encima de lo que el plan devengó hasta el ' +
      'último mes cerrado. El ledger no guarda mes, así que sin esto un sobre-ejercicio no se ve ' +
      'hasta el cierre del ejercicio.',
    clase: 'riesgo',
  },
  {
    rule_key: 'presupuesto_sin_freno_duro',
    nombre: 'Gasto autorizado sin bloqueo de sobregiro',
    descripcion:
      'Partidas de gasto cuyo control_level no es "bloqueo": un sobregiro pasa con aviso o en ' +
      'silencio. NO afirma que esté mal — el nivel es decisión de Dirección. Afirma el monto ' +
      'expuesto, para que la decisión se tome con la cifra a la vista.',
    clase: 'riesgo',
  },
];

/** Un ejercicio, ya medido. `plan_total` en `null` = no se pudo medir: no se inventa. */
export interface EjercicioMedido {
  budget_id: string;
  fiscal_year: number;
  nombre: string;
  is_test: boolean;
  supuesto_firmado: boolean;
  plan_total: number | null;
}

/** Una partida con su veredicto de ritmo ya calculado por `budget-phasing`. */
export interface PartidaMedida {
  budget_id: string;
  fiscal_year: number;
  is_test: boolean;
  line_id: string;
  account_code: string;
  concept: string | null;
  estado: string;
  deberia: number | null;
  consumido: number;
  brecha: number | null;
  control_level: string | null;
  original_amount: number | null;
}

const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ⚠️ `Number(null)` es 0, no `NaN`. Una cifra ausente convertida a 0 se publica como un hallazgo
 * de importe cero y se hunde al fondo de cualquier bandeja ordenada por monto. Se chequea ANTES.
 */
const cifra = (v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : v;

/** El ejercicio de prueba nunca produce hallazgos: duplicaría cada uno con el mismo texto. */
const operable = (x: { is_test: boolean }) => x.is_test !== true;

export function hallazgosDeEjercicio(ejercicios: readonly EjercicioMedido[]): FinanceFindingInput[] {
  const out: FinanceFindingInput[] = [];
  for (const e of ejercicios ?? []) {
    if (!operable(e) || e.supuesto_firmado) continue;
    const total = cifra(e.plan_total);
    // Sin total medido no se emite: un hallazgo sin importe no se puede priorizar y ensucia.
    if (total == null || total <= 0) continue;
    out.push({
      rule_key: 'presupuesto_supuesto_sin_firma',
      clase: 'riesgo',
      severity: 'warn',
      score: 0.8,
      titulo: `${e.nombre}: el plan de gasto no tiene supuesto firmado`,
      resumen:
        `El plan de ${e.fiscal_year} publica ${money(total)} armado con un crecimiento que nadie ` +
        `firmó. Mientras no haya firma es una propuesta, no un presupuesto.`,
      entity: { budget_id: e.budget_id, fiscal_year: e.fiscal_year },
      periodo: String(e.fiscal_year),
      importe: total,
      evidencia: { plan_total: total, supuesto_firmado: false },
      dedup_key: `presupuesto_supuesto_sin_firma:${e.budget_id}`,
    });
  }
  return out;
}

export function hallazgosDePartida(partidas: readonly PartidaMedida[]): FinanceFindingInput[] {
  const out: FinanceFindingInput[] = [];
  for (const p of partidas ?? []) {
    if (!operable(p)) continue;

    if (p.estado === 'sin_consumo') {
      const deberia = cifra(p.deberia);
      if (deberia == null || deberia <= 0) continue;
      out.push({
        rule_key: 'presupuesto_partida_sin_consumo',
        clase: 'error_captura',
        severity: 'warn',
        score: 0.7,
        titulo: `${p.concept ?? p.account_code}: ${money(deberia)} devengados sin un peso registrado`,
        resumen:
          `El perfil del plan dice que esta partida ya devengó ${money(deberia)} y el ledger está ` +
          `en cero. No dice que no se haya gastado: dice que no se anotó.`,
        entity: { budget_id: p.budget_id, line_id: p.line_id, account_code: p.account_code },
        periodo: String(p.fiscal_year),
        importe: deberia,
        evidencia: { deberia, consumido: p.consumido, estado: p.estado },
        dedup_key: `presupuesto_partida_sin_consumo:${p.line_id}`,
      });
      continue;
    }

    if (p.estado === 'sobre_perfil') {
      const brecha = cifra(p.brecha);
      if (brecha == null || brecha <= 0) continue;
      out.push({
        rule_key: 'presupuesto_partida_sobre_perfil',
        clase: 'riesgo',
        severity: 'critical',
        score: 0.9,
        titulo: `${p.concept ?? p.account_code}: ${money(brecha)} por encima de su perfil`,
        resumen:
          `Lleva ${money(p.consumido)} consumidos contra ${money(cifra(p.deberia) ?? 0)} que el ` +
          `plan devengó hasta el último mes cerrado.`,
        entity: { budget_id: p.budget_id, line_id: p.line_id, account_code: p.account_code },
        periodo: String(p.fiscal_year),
        importe: brecha,
        evidencia: { deberia: p.deberia, consumido: p.consumido, brecha },
        dedup_key: `presupuesto_partida_sobre_perfil:${p.line_id}`,
      });
    }
  }
  return out;
}

/**
 * El freno duro se agrega POR EJERCICIO, no por partida: 26 hallazgos idénticos diciendo «esta
 * partida no tiene bloqueo» son 26 formas de no leer ninguno. Lo accionable es el monto total
 * expuesto y la decisión, que es una sola.
 */
export function hallazgoDeFreno(
  ejercicio: EjercicioMedido,
  partidas: readonly PartidaMedida[],
): FinanceFindingInput | null {
  if (!operable(ejercicio)) return null;
  const sinFreno = (partidas ?? []).filter(
    (p) => operable(p) && p.budget_id === ejercicio.budget_id && p.control_level !== 'bloqueo',
  );
  if (!sinFreno.length) return null;
  let expuesto = 0;
  for (const p of sinFreno) {
    const m = cifra(p.original_amount);
    if (m == null) continue;
    expuesto += m;
  }
  if (expuesto <= 0) return null;
  return {
    rule_key: 'presupuesto_sin_freno_duro',
    clase: 'riesgo',
    severity: 'warn',
    score: 0.6,
    titulo: `${ejercicio.nombre}: ${money(expuesto)} de gasto sin bloqueo de sobregiro`,
    resumen:
      `${sinFreno.length} partidas con control distinto de "bloqueo": un sobregiro pasa con aviso ` +
      `o en silencio. Qué nivel corresponde es decisión de Dirección; esto sólo pone el monto.`,
    entity: { budget_id: ejercicio.budget_id, fiscal_year: ejercicio.fiscal_year },
    periodo: String(ejercicio.fiscal_year),
    importe: expuesto,
    evidencia: { partidas_sin_freno: sinFreno.length, expuesto },
    dedup_key: `presupuesto_sin_freno_duro:${ejercicio.budget_id}`,
  };
}

/** Arma todo lo que el carril tiene para decir, en un solo lote. */
export function hallazgosDePresupuesto(
  ejercicios: readonly EjercicioMedido[],
  partidas: readonly PartidaMedida[],
): FinanceFindingInput[] {
  const out = [...hallazgosDeEjercicio(ejercicios), ...hallazgosDePartida(partidas)];
  for (const e of ejercicios ?? []) {
    const f = hallazgoDeFreno(e, partidas);
    if (f) out.push(f);
  }
  return out;
}
