/**
 * CB.6 — Motor de clasificación desde DB (finance.bank_classify_rules).
 * Reglas ordenadas por priority; una aplica si TODOS sus matchers no-nulos
 * (regex sobre M/C/concepto) hacen match. La primera que aplica gana.
 * Reemplaza la función classify() hardcodeada (ahora las reglas viven en DB,
 * editables desde la vista Admin). Patrones inválidos se ignoran (best-effort).
 *
 * `[CB.61]` Vive aparte de `finance-bank.service.ts` (que lo re-exporta) para que la clasificación
 * de la descarga del banco lo use sin cargar todo el servicio.
 */
export const normKey = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

export interface ClassifyRuleRow {
  priority: number; match_type: string | null; match_code: string | null;
  match_concept: string | null; category_code: string;
}
export interface CompiledRule { reType: RegExp | null; reCode: RegExp | null; reConcept: RegExp | null; category: string; }

export function compileRules(rules: ClassifyRuleRow[]): CompiledRule[] {
  const safe = (p: string | null): RegExp | null => {
    if (!p) return null;
    try { return new RegExp(p, 'i'); } catch { return null; }
  };
  return [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => ({ reType: safe(r.match_type), reCode: safe(r.match_code), reConcept: safe(r.match_concept), category: r.category_code }));
}

export function classifyWith(compiled: CompiledRule[], M: unknown, C: unknown, concept: unknown): string {
  const m = normKey(M), c = normKey(C), t = normKey(concept);
  for (const r of compiled) {
    if (r.reType && !r.reType.test(m)) continue;
    if (r.reCode && !r.reCode.test(c)) continue;
    if (r.reConcept && !r.reConcept.test(t)) continue;
    return r.category;
  }
  return 'sin_clasificar';
}
