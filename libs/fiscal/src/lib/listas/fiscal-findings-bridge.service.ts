import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  FINANCE_FINDINGS_SINK_PORT,
  FinanceFindingsSinkPort,
  FinanceFindingInput,
  FinanceRuleInput,
} from '@megadulces/contracts';
import { SAT_LISTS } from './sat-lists.config';

/**
 * FISCAL.1.1 — Bridge: consolida los hallazgos fiscales (proveedores en listas
 * SAT + RFC con problema) en la bandeja unificada de Maat (finance.findings) vía
 * el port FINANCE_FINDINGS_SINK_PORT (@Optional: si Maat no está, no-op).
 *
 * Las bandejas fiscal.* siguen siendo la fuente; esto es una VISTA consolidada
 * para que Finanzas vea todo en un lugar. Determinista, sin LLM. Best-effort.
 */
@Injectable()
export class FiscalFindingsBridgeService {
  private readonly logger = new Logger(FiscalFindingsBridgeService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  syncCurrent(): Promise<{ pushed: number; inserted: number; skipped: number }> {
    return this.syncForTenant(this.tenantCtx.requireTenantId());
  }

  async syncForTenant(tenantId: string): Promise<{ pushed: number; inserted: number; skipped: number }> {
    if (!this.sink) {
      this.logger.debug('FINANCE_FINDINGS_SINK_PORT no ligado — bridge no-op.');
      return { pushed: 0, inserted: 0, skipped: 0 };
    }

    // Leer bandejas fiscales del tenant (RLS vía tk.run). Excluye lo descartado.
    const { matches, issues } = await this.tk.run(tenantId, async (trx) => {
      const matches = await trx('fiscal.sat_list_matches')
        .whereNot({ estado: 'descartado' })
        .select('lista', 'rfc', 'nombre', 'situacion', 'doc_count', 'importe_total', 'iva_total', 'primera_fecha', 'ultima_fecha', 'list_hash');
      const issues = await trx('fiscal.rfc_issues')
        .whereNot({ estado: 'descartado' })
        .select('rfc', 'issue_type', 'doc_count', 'importe_total', 'primera_fecha', 'ultima_fecha');
      return { matches, issues };
    });

    const findings: FinanceFindingInput[] = [];
    const rules = new Map<string, FinanceRuleInput>();

    for (const m of matches) {
      const cfg = SAT_LISTS[m.lista];
      const situ = String(m.situacion || '').toLowerCase();
      // Solo situaciones de riesgo (definitivo/presunto/firme/…). Las "limpias"
      // (desvirtuado/sentencia favorable) no generan hallazgo.
      if (!cfg || !cfg.riesgo.includes(situ)) continue;
      const rule = this.ruleForLista(m.lista, cfg.label);
      rules.set(rule.rule_key, rule);
      const importe = Number(m.importe_total || 0);
      findings.push({
        rule_key: rule.rule_key,
        clase: 'riesgo',
        severity: this.severityForSituacion(situ),
        score: this.severityForSituacion(situ) === 'critical' ? 0.95 : 0.7,
        titulo: `Proveedor en lista ${rule.label_corto} — ${m.nombre || m.rfc}`,
        resumen: `${m.nombre || m.rfc} (RFC ${m.rfc}): situación "${m.situacion}" en ${cfg.label}. ${m.doc_count} documento(s) por ${this.money(importe)}.`,
        entity: { rfc: m.rfc, lista: m.lista, situacion: m.situacion, beneficiario: m.nombre },
        periodo: this.ym(m.ultima_fecha),
        importe,
        evidencia: { doc_count: Number(m.doc_count || 0), iva_total: Number(m.iva_total || 0), primera_fecha: m.primera_fecha, ultima_fecha: m.ultima_fecha, list_hash: m.list_hash, fuente: 'fiscal.sat_list_matches' },
        dedup_key: `proveedor_lista|${m.lista}|${m.rfc}`,
      });
    }

    for (const it of issues) {
      const rule = this.ruleForIssue(it.issue_type);
      if (!rule) continue;
      rules.set(rule.rule_key, rule);
      const importe = Number(it.importe_total || 0);
      findings.push({
        rule_key: rule.rule_key,
        clase: 'error_captura',
        severity: it.issue_type === 'formato_invalido' ? 'warn' : 'info',
        score: 0.6,
        titulo: `${rule.label_corto} — RFC ${it.rfc}`,
        resumen: `RFC "${it.rfc}" ${rule.descripcion}. ${it.doc_count} documento(s) por ${this.money(importe)}.`,
        entity: { rfc: it.rfc, issue_type: it.issue_type },
        periodo: this.ym(it.ultima_fecha),
        importe,
        evidencia: { doc_count: Number(it.doc_count || 0), primera_fecha: it.primera_fecha, ultima_fecha: it.ultima_fecha, fuente: 'fiscal.rfc_issues' },
        dedup_key: `rfc_issue|${it.issue_type}|${it.rfc}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const res = await this.sink.pushFindings(tenantId, findings, [...rules.values()]);
    this.logger.log(`bridge tenant ${tenantId}: ${findings.length} hallazgos → Maat (${res.inserted} nuevos, ${res.skipped} omitidos).`);
    return { pushed: findings.length, ...res };
  }

  private ruleForLista(lista: string, label: string): FinanceRuleInput & { label_corto: string } {
    if (lista === '69B') {
      return { rule_key: 'proveedor_efos', nombre: 'Proveedor en lista EFOS 69-B', descripcion: 'Proveedor del tenant en la lista negra EFOS (CFF Art. 69-B): operaciones potencialmente no deducibles.', clase: 'riesgo', label_corto: 'EFOS 69-B' };
    }
    if (lista === '69') {
      return { rule_key: 'proveedor_lista69', nombre: 'Proveedor en lista Art. 69', descripcion: 'Proveedor con créditos firmes/cancelados/no localizados (CFF Art. 69).', clase: 'riesgo', label_corto: 'Art. 69' };
    }
    return { rule_key: `proveedor_lista_${lista.toLowerCase()}`, nombre: `Proveedor en lista ${label}`, descripcion: `Proveedor del tenant en la lista SAT ${label}.`, clase: 'riesgo', label_corto: label };
  }

  private ruleForIssue(issueType: string): (FinanceRuleInput & { label_corto: string }) | null {
    if (issueType === 'formato_invalido') {
      return { rule_key: 'rfc_formato_invalido', nombre: 'RFC de proveedor con formato inválido', descripcion: 'no cumple la estructura de un RFC válido (posible error de captura)', clase: 'error_captura', label_corto: 'RFC formato inválido' };
    }
    if (issueType === 'rfc_generico') {
      return { rule_key: 'rfc_generico', nombre: 'Proveedor con RFC genérico', descripcion: 'es un RFC genérico (público en general / extranjero) — revisar si corresponde', clase: 'error_captura', label_corto: 'RFC genérico' };
    }
    return null;
  }

  /** 'YYYY-MM' robusto: pg devuelve `date` como objeto Date (tz local) → usar
   *  componentes locales, no toISOString (que voltea a UTC). Acepta string ISO también. */
  private ym(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'string') return v.slice(0, 7);
    if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
    return null;
  }

  private severityForSituacion(situ: string): 'info' | 'warn' | 'critical' {
    if (situ === 'definitivo' || situ === 'firme') return 'critical';
    return 'warn';
  }

  private money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
