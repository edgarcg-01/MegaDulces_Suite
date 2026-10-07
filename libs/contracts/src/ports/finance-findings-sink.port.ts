// Port de inversión de dependencia: el motor Fiscal (libs/fiscal) detecta
// hallazgos (proveedores en listas SAT, RFC con problema) pero la BANDEJA
// unificada de hallazgos vive en Maat (libs/finance → finance.findings +
// finance.rule_registry). fiscal NO puede cruzar la frontera de dominio, así
// que empuja sus hallazgos por este token + interface (@Optional); el binding al
// impl real (MaatFindingsSinkService) se hace en el composition root (app.module).
//
// Si no hay binding (o Maat está apagado), fiscal sigue corriendo sin consolidar
// —los hallazgos igual viven en las bandejas fiscal.*—: es best-effort.

export const FINANCE_FINDINGS_SINK_PORT = 'FINANCE_FINDINGS_SINK_PORT';

export type FinanceFindingClase = 'riesgo' | 'error_captura' | 'oportunidad';
export type FinanceFindingSeverity = 'info' | 'warn' | 'critical';

export interface FinanceFindingInput {
  rule_key: string;
  clase: FinanceFindingClase;
  severity: FinanceFindingSeverity;
  score: number;
  titulo: string;
  resumen: string;
  entity: Record<string, unknown>;
  periodo: string | null;
  importe: number;
  evidencia: Record<string, unknown>;
  dedup_key: string;
}

export interface FinanceRuleInput {
  rule_key: string;
  nombre: string;
  descripcion: string;
  clase: FinanceFindingClase;
  params?: Record<string, unknown>;
}

export interface FinanceFindingsSinkPort {
  /**
   * Registra (idempotente, preservando calibración humana) las reglas y hace
   * UPSERT de los hallazgos en finance.findings (dedup por dedup_key). Respeta
   * la auto-supresión L2 de Maat: no inserta hallazgos de reglas suprimidas.
   * Best-effort: nunca lanza hacia el caller.
   */
  pushFindings(
    tenantId: string,
    findings: FinanceFindingInput[],
    rules?: FinanceRuleInput[],
  ): Promise<{ inserted: number; skipped: number }>;
}
