/**
 * CG.17 — Motor de autorrelleno de Caja General: LA DECISIÓN, en funciones PURAS (ADR-070 §8).
 *
 * Acá no hay Postgres, ni HTTP, ni fecha del sistema. Todo entra por parámetro y todo sale
 * como valor. Es a propósito: la lógica que decide qué se le propone a un capturista —y que
 * por lo tanto decide a qué cuenta contable va el dinero— tiene que poder probarse sin
 * levantar nada, y tiene que dar el mismo resultado siempre.
 *
 * El servicio (`caja-autofill.service.ts`) hace los SELECT y le pasa las filas a estas
 * funciones. Si alguna vez hay que discutir por qué el sistema propuso X, se discute acá.
 *
 * Las cinco reglas del §8.5 que este archivo hace cumplir:
 *   1. El motor PROPONE, no guarda            → todo devuelve `Proposal`, nunca escribe.
 *   2. Cada campo declara procedencia          → `source` + `confidence` obligatorios.
 *   3. Lo que no se puede proponer va VACÍO    → `null` + `reason`. NUNCA un default.
 *   4. Se mide la tasa de corrección           → `isSuppressed` saca de juego a la regla.
 *   5. La captura a mano nunca desaparece      → nada acá es obligatorio para guardar.
 */

/** De dónde salió un campo autorrellenado. El orden es el de certeza decreciente (§8.1). */
export type AutofillSource =
  | 'contexto'      // nivel 0 — sesión/JWT/secuencia. Certeza.
  | 'documento'     // nivel 1 — CFDI, cobro, pago, banco. Se LIGA, no se teclea.
  | 'aprendido'     // nivel 2 — lo que contabilidad ya posteó (expense_entries).
  | 'regla'         // nivel 3 — regla explícita editable en DB.
  | 'ocr';          // nivel 4 — extracción del papel.

/** Por qué un campo quedó vacío. Un vacío sin motivo es indistinguible de un olvido. */
export type NoProposalReason =
  | 'sin_historia'          // nunca se posteó nada para este sujeto
  | 'soporte_insuficiente'  // hay historia, pero muy poca para arriesgar una propuesta
  | 'empate'                // hay historia repartida entre varios pares: elegir sería inventar
  | 'sin_regla'             // ninguna regla activa hizo match
  | 'sin_documento';        // no se encontró documento origen

export interface Proposal<T = string> {
  /** El valor propuesto, o `null` cuando el motor decide NO proponer. */
  value: T | null;
  /** Nivel del que salió. `null` si no hubo propuesta. */
  source: AutofillSource | null;
  /** 0..1. Qué tan respaldada está. `null` si no hubo propuesta. */
  confidence: number | null;
  /** Cuántas observaciones la respaldan (nivel `aprendido`). */
  support?: number;
  /** Dominancia 0..1 del valor elegido sobre el resto (nivel `aprendido`). */
  supportRatio?: number;
  /** Obligatorio cuando `value === null`: por qué no se propuso. */
  reason?: NoProposalReason;
  /** Identificador de lo que produjo la propuesta (regla, documento) para la telemetría. */
  originId?: string;
}

/** Par contable de Kepler. Siempre viaja completo: media propuesta es peor que ninguna. */
export interface ConceptPair {
  kepler_cuenta: string;
  kepler_concepto: string;
}

export interface ClassifyRule {
  id: string;
  priority: number;
  match_tipo: string | null;
  match_glosa: string | null;
  match_beneficiario: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  centro_costo?: string | null;
  active: boolean;
  suppressed_at: Date | string | null;
  applied_count?: number;
  corrected_count?: number;
}

export interface ClassifyInput {
  tipo?: string | null;
  glosa?: string | null;
  beneficiario?: string | null;
}

/** Una observación histórica: "contabilidad posteó este par N veces". */
export interface HistoryRow {
  kepler_cuenta: string;
  kepler_concepto: string;
  n: number;
}

/**
 * Umbrales del nivel `aprendido`. Son perillas explícitas, no números mágicos enterrados:
 * suben el listón de cuándo el motor se atreve a proponer.
 *
 * `minSupport` = 3 y `minRatio` = 0.60 salen del criterio de §8.3: "las últimas 47 veces"
 * es una propuesta; "3 usos repartidos en 3 conceptos" NO lo es. Se afinan con la medición
 * de arranque de CG.17 contra los 12,253 movimientos de 2026, no antes.
 */
export const LEARNED_DEFAULTS = { minSupport: 3, minRatio: 0.6 } as const;

/** Tasa de corrección a partir de la cual una regla deja de proponer (§8.5 regla 4). */
export const RULE_SUPPRESSION_RATIO = 0.3;

/** Normaliza para comparar: mayúsculas, sin acentos, espacios colapsados. */
export function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Una regla juega si está activa y no fue suprimida por su propia tasa de corrección. */
export function isRulePlayable(r: ClassifyRule): boolean {
  return r.active === true && !r.suppressed_at;
}

/**
 * ¿Esta regla se ganó la supresión? Sólo con evidencia suficiente: suprimir por 1 de 1
 * corrección es tan ciego como no suprimir nunca.
 */
export function shouldSuppressRule(r: ClassifyRule, minApplied = 5): boolean {
  const applied = r.applied_count ?? 0;
  const corrected = r.corrected_count ?? 0;
  if (applied < minApplied) return false;
  return corrected / applied >= RULE_SUPPRESSION_RATIO;
}

/**
 * Motor de reglas — molde `bank_classify_rules` (CB.6): ordenadas por `priority` (menor
 * primero), **la primera que aplica GANA**, y una regla aplica si TODOS sus matchers
 * no-nulos hacen match. Si ninguna aplica, NO propone (`sin_regla`) — jamás un default.
 *
 * ⚠️ Una regex inválida en la tabla NO puede tumbar la captura: esa regla se salta.
 */
export function classifyByRules(rules: ClassifyRule[], input: ClassifyInput): Proposal<ConceptPair> {
  const tipo = normalize(input.tipo);
  const glosa = normalize(input.glosa);
  const benef = normalize(input.beneficiario);

  const playable = rules.filter(isRulePlayable).sort((a, b) => a.priority - b.priority);

  for (const r of playable) {
    const matchers: Array<[string | null, string]> = [
      [r.match_tipo, tipo],
      [r.match_glosa, glosa],
      [r.match_beneficiario, benef],
    ];
    // Una regla sin ningún matcher aplicaría a todo (la DB lo impide con un CHECK, pero el
    // motor no confía en eso: si llegara una, se ignora en vez de clasificarlo todo).
    if (matchers.every(([pat]) => !pat)) continue;

    let all = true;
    for (const [pat, val] of matchers) {
      if (!pat) continue;
      let re: RegExp;
      try { re = new RegExp(pat, 'i'); } catch { all = false; break; }
      if (!re.test(val)) { all = false; break; }
    }
    if (all) {
      return {
        value: { kepler_cuenta: r.kepler_cuenta, kepler_concepto: r.kepler_concepto },
        source: 'regla',
        confidence: 0.7,
        originId: r.id,
      };
    }
  }
  return { value: null, source: null, confidence: null, reason: 'sin_regla' };
}

/**
 * Nivel `aprendido` — el par que contabilidad YA usó para este sujeto (§8.3).
 *
 * No adivina: cuenta. Y se niega a proponer cuando la historia no alcanza o está repartida,
 * porque **un default disfrazado es peor que un campo vacío** — se acepta sin mirarlo.
 */
export function learnConceptFromHistory(
  rows: HistoryRow[],
  opts: { minSupport?: number; minRatio?: number } = {},
): Proposal<ConceptPair> {
  const minSupport = opts.minSupport ?? LEARNED_DEFAULTS.minSupport;
  const minRatio = opts.minRatio ?? LEARNED_DEFAULTS.minRatio;

  const clean = (rows || []).filter((r) => r && r.kepler_cuenta && r.kepler_concepto && r.n > 0);
  if (clean.length === 0) {
    return { value: null, source: null, confidence: null, reason: 'sin_historia' };
  }

  // Se agrupa por par: la misma combinación puede venir partida en varias filas.
  const byPair = new Map<string, { pair: ConceptPair; n: number }>();
  for (const r of clean) {
    const k = `${r.kepler_cuenta}|${r.kepler_concepto}`;
    const prev = byPair.get(k);
    if (prev) prev.n += r.n;
    else byPair.set(k, { pair: { kepler_cuenta: r.kepler_cuenta, kepler_concepto: r.kepler_concepto }, n: r.n });
  }

  const total = [...byPair.values()].reduce((a, b) => a + b.n, 0);
  // Desempate ESTABLE: por n desc y, a igual n, por el par alfabéticamente. Sin esto, dos
  // corridas con el mismo dato podrían proponer cosas distintas según el orden de las filas.
  const ordered = [...byPair.values()].sort((a, b) =>
    b.n - a.n
    || a.pair.kepler_cuenta.localeCompare(b.pair.kepler_cuenta)
    || a.pair.kepler_concepto.localeCompare(b.pair.kepler_concepto));

  const top = ordered[0];
  const ratio = top.n / total;

  if (total < minSupport) {
    return { value: null, source: null, confidence: null, reason: 'soporte_insuficiente', support: total, supportRatio: ratio };
  }
  // Empate exacto: elegir uno sería inventar.
  if (ordered.length > 1 && ordered[1].n === top.n) {
    return { value: null, source: null, confidence: null, reason: 'empate', support: total, supportRatio: ratio };
  }
  if (ratio < minRatio) {
    return { value: null, source: null, confidence: null, reason: 'empate', support: total, supportRatio: ratio };
  }

  return {
    value: top.pair,
    source: 'aprendido',
    confidence: Number(ratio.toFixed(4)),
    support: total,
    supportRatio: Number(ratio.toFixed(4)),
  };
}

/** Prefijo de folio por tipo. Se lee de un vistazo cuál es cuál. */
const FOLIO_PREFIX: Record<string, string> = { ingreso: 'CI', gasto: 'CG', deposito: 'CD' };

/**
 * Folio del movimiento. El número lo da la secuencia atómica de Postgres; acá sólo se le da
 * forma. El Access lo calculaba con `DMax+1` en el cliente y produjo 34 duplicados (§5.2).
 */
export function buildFolio(tipo: string, year: number, seq: number): string {
  const p = FOLIO_PREFIX[tipo];
  if (!p) throw new Error(`tipo de movimiento desconocido: ${tipo}`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`consecutivo inválido: ${seq}`);
  return `${p}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * La cascada del §8.1: gana el nivel de MÁS certeza que haya producido un valor. Si ninguno
 * produjo, devuelve el vacío MÁS INFORMATIVO — el motivo que más le dice al humano por qué
 * tiene que teclearlo él ('empate' explica más que 'sin_regla').
 */
const REASON_RANK: Record<NoProposalReason, number> = {
  empate: 5, soporte_insuficiente: 4, sin_historia: 3, sin_documento: 2, sin_regla: 1,
};

export function pickBest<T>(...proposals: Array<Proposal<T> | null | undefined>): Proposal<T> {
  const list = (proposals.filter(Boolean) as Array<Proposal<T>>);
  const withValue = list.filter((p) => p.value !== null && p.value !== undefined);
  if (withValue.length > 0) return withValue[0];

  const withReason = list.filter((p) => p.reason);
  if (withReason.length === 0) return { value: null, source: null, confidence: null, reason: 'sin_historia' };
  return withReason.sort((a, b) => REASON_RANK[b.reason!] - REASON_RANK[a.reason!])[0];
}

/**
 * Lo que se guarda en `cash_ledger.autofill`: qué campo vino de qué nivel y con qué
 * confianza. Sin esto un campo lleno es indistinguible de uno inventado (ADR-056 / VP.2.1).
 * Los campos que el humano tecleó NO aparecen — su ausencia es la señal de que fue manual.
 */
export function buildProvenance(fields: Record<string, Proposal<unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(fields)) {
    if (!p || p.value === null || p.value === undefined) continue;
    out[k] = {
      source: p.source,
      confidence: p.confidence,
      ...(p.support !== undefined ? { support: p.support } : {}),
      ...(p.supportRatio !== undefined ? { support_ratio: p.supportRatio } : {}),
      ...(p.originId ? { origin_id: p.originId } : {}),
    };
  }
  return out;
}
