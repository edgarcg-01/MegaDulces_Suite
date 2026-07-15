import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Horus — Agente del parte diario (Sprint Horus.2).
 *
 * Invariante ADR-020 (heredado de ADR-016): el motor DECIDE, el agente COMUNICA.
 * Este service NO calcula nada del negocio: lee findings (deterministas) +
 * resumen del feature store y le pide a Claude Haiku que REDACTE el parte diario
 * (titular + resumen + ranking de atención). El LLM nunca inventa números ni
 * decide hallazgos — solo traduce datos provistos a lenguaje de supervisor.
 *
 * Degradación graciosa: sin ANTHROPIC_API_KEY o si Claude falla → fallback
 * DETERMINISTA por plantilla. El parte SIEMPRE funciona, porque el motor es la
 * fuente de verdad y el agente es la capa de comunicación (opcional).
 *
 * Replica el patrón de llamada de LlmExtractorService (mismo model/endpoint/
 * tool_use) en vez de acoplar platform-core a un caso de uso de Trade.
 */
type Finding = {
  finding_type: string;
  severity: string;
  subject_type: string;
  label: string | null;
  score: number | null;
  evidence: any;
};

type Briefing = {
  headline: string;
  summary: string;
  attention: Array<{ subject: string; why: string; severity: string }>;
  stats: {
    collaborators: number;
    findings_total: number;
    critical: number;
    warn: number;
    by_type: Record<string, number>;
  };
  comparison: Comparison;
  source: 'agent' | 'engine';
  generated_at: string;
};

/**
 * HIQ.1 — paquete comparativo DETERMINISTA (memoria del briefing): qué cambió
 * desde ayer/semana. El motor lo calcula; el agente solo lo narra.
 */
type Comparison = {
  yesterday_headline: string | null;
  findings_new_24h: number;
  findings_resolved_24h: number;
  persistent: Array<{ subject: string; type: string; days_open: number }>;
  team_score_now: number | null;
  team_score_week_ago: number | null;
  team_score_delta: number | null;
  outcomes_7d: Array<{ subject: string; action_type: string; verdict: string; delta: number | null }>;
};

const SEVERITIES = ['info', 'warn', 'critical'];

@Injectable()
export class SupervisorAgentService {
  private readonly logger = new Logger(SupervisorAgentService.name);
  private readonly endpoint = 'https://api.anthropic.com/v1/messages';
  private readonly model = 'claude-haiku-4-5-20251001';
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';
  private readonly timeoutMs = 20_000;

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }

  /**
   * HIQ.1 — computa el paquete comparativo determinista (memoria del briefing):
   * nuevos/resueltos/persistentes, tendencia del equipo desde los snapshots,
   * el titular de ayer (continuidad) y los outcomes recientes (qué funcionó).
   */
  private async buildComparison(tenantId: string): Promise<Comparison> {
    const empty: Comparison = {
      yesterday_headline: null,
      findings_new_24h: 0,
      findings_resolved_24h: 0,
      persistent: [],
      team_score_now: null,
      team_score_week_ago: null,
      team_score_delta: null,
      outcomes_7d: [],
    };
    try {
      const [newRow] = await this.knex('commercial.supervisor_findings')
        .where({ tenant_id: tenantId, status: 'open' })
        .whereRaw(`created_at >= now() - interval '24 hours'`)
        .count({ n: '*' });
      const [resolvedRow] = await this.knex('commercial.supervisor_findings')
        .where({ tenant_id: tenantId, status: 'resolved' })
        .whereRaw(`updated_at >= now() - interval '24 hours'`)
        .count({ n: '*' });
      const persistent = await this.knex('commercial.supervisor_findings')
        .where({ tenant_id: tenantId, status: 'open' })
        .whereRaw(`created_at < now() - interval '3 days'`)
        .orderBy('created_at', 'asc')
        .limit(5)
        .select(
          'label',
          'subject_type',
          'finding_type',
          this.knex.raw(`floor(extract(epoch from now() - created_at) / 86400)::int as days_open`),
        );

      // Tendencia del equipo desde los snapshots (promedio de avg_score de
      // colaboradores 30d): el snapshot más reciente vs ~7 días antes.
      const scoreAt = async (offsetDays: number): Promise<number | null> => {
        const row = await this.knex('commercial.execution_360_snapshots')
          .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 30 })
          .whereRaw(
            `snapshot_date <= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`,
            [offsetDays],
          )
          .orderBy('snapshot_date', 'desc')
          .first(this.knex.raw('snapshot_date'));
        if (!row?.snapshot_date) return null;
        const [avg] = await this.knex('commercial.execution_360_snapshots')
          .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 30 })
          .where('snapshot_date', row.snapshot_date)
          .whereNotNull('avg_score')
          .avg({ v: 'avg_score' });
        return avg?.v != null ? Math.round(Number(avg.v) * 10) / 10 : null;
      };
      const now = await scoreAt(0);
      const weekAgo = await scoreAt(7);

      const yesterday = await this.knex('commercial.briefing_history')
        .where('tenant_id', tenantId)
        .whereRaw(`briefing_date < (now() AT TIME ZONE 'America/Mexico_City')::date`)
        .orderBy('briefing_date', 'desc')
        .first('headline');

      const outcomes = await this.knex('commercial.supervisor_actions')
        .where({ tenant_id: tenantId, outcome_status: 'measured' })
        .whereRaw(`outcome_measured_at >= now() - interval '7 days'`)
        .orderBy('outcome_measured_at', 'desc')
        .limit(5)
        .select('label', 'action_type', 'outcome_verdict', 'outcome_delta');

      return {
        yesterday_headline: yesterday?.headline || null,
        findings_new_24h: Number(newRow?.n) || 0,
        findings_resolved_24h: Number(resolvedRow?.n) || 0,
        persistent: persistent.map((p: any) => ({
          subject: p.label || p.subject_type,
          type: this.findingLabel(p.finding_type),
          days_open: Number(p.days_open) || 0,
        })),
        team_score_now: now,
        team_score_week_ago: weekAgo,
        team_score_delta:
          now != null && weekAgo != null ? Math.round((now - weekAgo) * 10) / 10 : null,
        outcomes_7d: outcomes.map((o: any) => ({
          subject: o.label || '',
          action_type: o.action_type,
          verdict: o.outcome_verdict,
          delta: o.outcome_delta != null ? Number(o.outcome_delta) : null,
        })),
      };
    } catch (e: any) {
      this.logger.warn(`buildComparison falló (${e?.message}); briefing sin memoria`);
      return empty;
    }
  }

  /** HIQ.1 — persiste el parte del día (memoria narrativa). Best-effort. */
  private async persistBriefing(tenantId: string, b: Briefing): Promise<void> {
    try {
      await this.knex('commercial.briefing_history')
        .insert({
          tenant_id: tenantId,
          briefing_date: this.knex.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date`),
          headline: (b.headline || '').slice(0, 300),
          summary: b.summary || '',
          attention: JSON.stringify(b.attention || []),
          stats: JSON.stringify(b.stats || {}),
          comparison: JSON.stringify(b.comparison || {}),
          source: b.source,
        })
        .onConflict(['tenant_id', 'briefing_date'])
        .merge(['headline', 'summary', 'attention', 'stats', 'comparison', 'source']);
    } catch (e: any) {
      this.logger.warn(`No se pudo persistir briefing_history: ${e?.message}`);
    }
  }

  /** Arma el parte diario del supervisor para el tenant actual. */
  async buildBriefing(user: any): Promise<Briefing> {
    const tenantId = this.tenantId(user);
    const nowIso = new Date().toISOString();

    const findings: Finding[] = tenantId
      ? await this.knex('commercial.supervisor_findings')
          .where({ tenant_id: tenantId, status: 'open' })
          .orderByRaw(`CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END`)
          .orderBy('score', 'desc')
          .limit(40)
          .select('finding_type', 'severity', 'subject_type', 'label', 'score', 'evidence')
      : [];

    const collabRows: Array<{ label: string | null }> = tenantId
      ? await this.knex('commercial.execution_360')
          .where({ tenant_id: tenantId, subject_type: 'collaborator', window_days: 30 })
          .select('label')
      : [];

    const stats = {
      collaborators: collabRows.length,
      findings_total: findings.length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      by_type: findings.reduce((acc: Record<string, number>, f) => {
        acc[f.finding_type] = (acc[f.finding_type] || 0) + 1;
        return acc;
      }, {}),
    };

    const comparison: Comparison = tenantId
      ? await this.buildComparison(tenantId)
      : {
          yesterday_headline: null,
          findings_new_24h: 0,
          findings_resolved_24h: 0,
          persistent: [],
          team_score_now: null,
          team_score_week_ago: null,
          team_score_delta: null,
          outcomes_7d: [],
        };

    if (findings.length === 0 && stats.collaborators === 0) {
      return {
        headline: 'Sin novedades',
        summary: 'No hay capturas ni hallazgos en el período. Corré el cómputo si esperabas datos.',
        attention: [],
        stats,
        comparison,
        source: 'engine',
        generated_at: nowIso,
      };
    }

    let drafted: Pick<Briefing, 'headline' | 'summary' | 'attention'> | null = null;
    if (this.apiKey) {
      drafted = await this.draftWithClaude(findings, stats, comparison).catch((e: any) => {
        this.logger.warn(`briefing LLM falló (${e.message}); fallback determinista`);
        return null;
      });
    }
    const body = drafted ?? this.draftDeterministic(findings, stats, comparison);

    const briefing: Briefing = {
      ...body,
      stats,
      comparison,
      source: drafted ? 'agent' : 'engine',
      generated_at: nowIso,
    };
    if (tenantId) await this.persistBriefing(tenantId, briefing);
    return briefing;
  }

  // ── R3: explicación del razonamiento de UNA recomendación ──────────────────
  // El motor arma la CADENA determinista (evidencia→diagnóstico→decisión→confianza→
  // impacto, auditable); el agente la REDACTA en prosa. Fallback determinista sin LLM.
  // El LLM nunca decide: recibe la decisión ya tomada y solo la hace legible (ADR-016/020).

  async explainAction(
    id: string,
    user: any,
  ): Promise<{
    narrative: string;
    source: 'agent' | 'engine';
    reasoning_chain: Array<{ step: string; text: string }>;
    action: { id: string; title: string; action_type: string; confidence: number | null; root_cause: string | null };
  }> {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');
    const tenantId = this.tenantId(user);

    let q = this.knex('commercial.supervisor_actions').where('id', id);
    if (tenantId) q = q.where('tenant_id', tenantId);
    const action = await q.first();
    if (!action) throw new NotFoundException('Acción no encontrada');

    let diagnosis: any = null;
    let finding: any = null;
    if (action.diagnosis_id && tenantId) {
      diagnosis = await this.knex('commercial.supervisor_diagnoses')
        .where({ id: action.diagnosis_id, tenant_id: tenantId })
        .first();
    } else if (action.finding_id && tenantId) {
      finding = await this.knex('commercial.supervisor_findings')
        .where({ id: action.finding_id, tenant_id: tenantId })
        .first();
    }

    const chain = this.buildChain(action, diagnosis, finding);

    let narrative: string | null = null;
    if (this.apiKey) {
      narrative = await this.draftExplanation(action, chain).catch((e: any) => {
        this.logger.warn(`explain LLM falló (${e.message}); fallback determinista`);
        return null;
      });
    }
    const source: 'agent' | 'engine' = narrative ? 'agent' : 'engine';
    if (!narrative) narrative = this.deterministicExplanation(action, chain);

    return {
      narrative,
      source,
      reasoning_chain: chain,
      action: {
        id: action.id,
        title: action.title,
        action_type: action.action_type,
        confidence: action.confidence != null ? Number(action.confidence) : null,
        root_cause: action.root_cause ?? null,
      },
    };
  }

  /** Cadena de razonamiento determinista y auditable a partir de la decisión ya tomada. */
  private buildChain(
    action: any,
    diagnosis: any,
    finding: any,
  ): Array<{ step: string; text: string }> {
    const chain: Array<{ step: string; text: string }> = [];

    let evidencia = '';
    if (diagnosis) {
      const ev = safeParse(typeof diagnosis.evidence === 'string' ? diagnosis.evidence : JSON.stringify(diagnosis.evidence || {}));
      const symptoms = Array.isArray(ev.symptoms) ? ev.symptoms : [];
      evidencia = symptoms.map((s: any) => s.phrase).filter(Boolean).join('; ');
    } else if (finding) {
      evidencia = `${this.findingLabel(finding.finding_type)} — ${this.evidenceText({
        finding_type: finding.finding_type,
        severity: finding.severity,
        subject_type: finding.subject_type,
        label: finding.label,
        score: finding.score,
        evidence: finding.evidence,
      } as any)}`;
    }
    chain.push({ step: 'evidencia', text: evidencia || '—' });

    if (diagnosis) {
      chain.push({ step: 'diagnóstico', text: diagnosis.summary || 'causa raíz correlacionada' });
    } else if (finding) {
      chain.push({ step: 'síntoma', text: this.findingLabel(finding.finding_type) });
    }

    chain.push({ step: 'decisión', text: action.title });

    if (action.confidence != null) {
      chain.push({
        step: 'confianza',
        text: `${Math.round(Number(action.confidence) * 100)}% (precisión histórica de la regla × corroboración)`,
      });
    }
    const imp = safeParse(typeof action.expected_impact === 'string' ? action.expected_impact : JSON.stringify(action.expected_impact || {}));
    if (imp && imp.baseline_mean != null) {
      chain.push({ step: 'impacto', text: `volver a su normal ≈ ${Math.round(Number(imp.baseline_mean))}%` });
    }
    return chain;
  }

  private deterministicExplanation(action: any, chain: Array<{ step: string; text: string }>): string {
    const who = action.label || action.subject_type;
    const get = (s: string) => chain.find((c) => c.step === s)?.text;
    const parts: string[] = [`${who}.`];
    const diag = get('diagnóstico');
    if (diag) parts.push(`${diag}.`);
    const ev = get('evidencia');
    if (ev && ev !== '—') parts.push(`Señales: ${ev}.`);
    parts.push(`Acción sugerida: ${action.title}.`);
    const conf = get('confianza');
    if (conf) parts.push(`Confianza ${conf}.`);
    const imp = get('impacto');
    if (imp) parts.push(`Impacto esperado: ${imp}.`);
    return parts.join(' ');
  }

  /** Claude redacta la explicación a partir de la cadena YA decidida (no recalcula nada). */
  private async draftExplanation(
    action: any,
    chain: Array<{ step: string; text: string }>,
  ): Promise<string> {
    const lines = [
      'Eres el asistente de un supervisor de ventas de campo (trade marketing).',
      'El MOTOR ya decidió esta recomendación y su cadena de razonamiento. NO recalcules ni inventes',
      'números, nombres o tiendas: usá SOLO lo provisto. Redacta una explicación breve (2-3 frases',
      'en español) de POR QUÉ se recomienda esta acción, en tono de supervisor, con la herramienta',
      'explain_recommendation.',
      '',
      `Sujeto: ${action.label || action.subject_type}`,
      `Acción propuesta: ${action.title}`,
      'Cadena de razonamiento (motor, determinista):',
      ...chain.map((c) => `- ${c.step}: ${c.text}`),
    ];
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          tool_choice: { type: 'tool', name: 'explain_recommendation' },
          tools: [
            {
              name: 'explain_recommendation',
              description:
                'Explica al supervisor por qué conviene esta acción, a partir de la cadena de ' +
                'razonamiento YA calculada por el motor. Usá SOLO lo provisto; no inventes datos.',
              input_schema: {
                type: 'object',
                properties: {
                  explanation: {
                    type: 'string',
                    description: 'Explicación de 2-3 frases en español, tono de supervisor.',
                  },
                },
                required: ['explanation'],
              },
            },
          ],
          messages: [{ role: 'user', content: lines.join('\n') }],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { content: Array<{ type: string; name?: string; input?: any }> };
    const toolUse = json.content?.find((c) => c.type === 'tool_use' && c.name === 'explain_recommendation');
    const txt = toolUse?.input?.explanation;
    if (typeof txt !== 'string' || !txt.trim()) throw new Error('Claude no devolvió explanation');
    return txt.trim();
  }

  // ── Helpers de presentación (deterministas) ───────────────────────────────

  private findingLabel(type: string): string {
    return (
      {
        score_drop: 'caída de score',
        low_score: 'score bajo',
        competitor_dominance: 'competencia domina el exhibidor',
        store_at_risk: 'tienda sin visita',
        vision_stockout: 'quiebre de stock (foto)',
        vision_mismatch: 'declarado ≠ observado (foto)',
        vision_invalid: 'fotos inválidas',
        over_declaration: 'declara más de lo que la foto muestra',
        fraud_impossible_speed: 'salto imposible entre capturas',
        fraud_overlap: 'capturas solapadas en el tiempo',
        fraud_gps_mismatch: 'captura lejos de la tienda',
        fraud_fast_visit: 'visita demasiado corta',
        fraud_recycled_photo: 'foto reciclada',
        sales_execution_gap: 'ejecuta bien pero sin venta registrada',
      } as Record<string, string>
    )[type] || type;
  }

  private evidence(f: Finding): Record<string, any> {
    return typeof f.evidence === 'string' ? safeParse(f.evidence) : f.evidence || {};
  }

  private evidenceText(f: Finding): string {
    const e = this.evidence(f);
    switch (f.finding_type) {
      case 'score_drop':
        return `bajó ${Math.abs(Number(e.score_trend ?? 0))} pts en 7d`;
      case 'low_score':
        return `score ${e.avg_score ?? '?'}% (mínimo ${e.threshold ?? '?'}%)`;
      case 'competitor_dominance':
        return `competencia ${e.competitor_share_pct ?? '?'}% del exhibidor`;
      case 'store_at_risk':
        return `${e.days_since_last_visit ?? '?'} días sin visita`;
      case 'vision_stockout':
        return `quiebre de stock en ${e.stockout_photos ?? '?'} foto(s)`;
      case 'vision_mismatch':
        return `${e.mismatch_photos ?? '?'} foto(s) declaradas propio muestran competencia`;
      case 'vision_invalid':
        return `${e.pct ?? '?'}% de fotos inválidas o sin anaquel`;
      case 'fraud_impossible_speed':
        return `${e.events ?? '?'} salto(s), hasta ${e.max_speed_kmh ?? '?'} km/h`;
      case 'fraud_overlap':
        return `${e.events ?? '?'} captura(s) solapada(s) en el tiempo`;
      case 'fraud_gps_mismatch':
        return `${e.events ?? '?'} captura(s) a más de ${e.threshold_m ?? '?'} m (máx ${e.max_distance_m ?? '?'} m)`;
      case 'fraud_fast_visit':
        return `${e.events ?? '?'} visita(s) muy cortas (mín ${e.min_duration_sec ?? '?'}s)`;
      case 'fraud_recycled_photo':
        return `${e.events ?? '?'} foto(s) reutilizada(s)`;
      case 'sales_execution_gap':
        return `salud ${e.exec_score ?? '?'} y 0 venta registrada en 30d`;
      default:
        return '';
    }
  }

  // ── Fallback determinista (sin LLM) ────────────────────────────────────────

  private draftDeterministic(
    findings: Finding[],
    stats: Briefing['stats'],
    comparison: Comparison,
  ): Pick<Briefing, 'headline' | 'summary' | 'attention'> {
    const headline =
      stats.findings_total === 0
        ? `${stats.collaborators} colaboradores activos · sin hallazgos`
        : `${stats.findings_total} hallazgos (${stats.critical} críticos) · ${stats.collaborators} colaboradores`;

    const parts: string[] = [
      `En los últimos 30 días, ${stats.collaborators} colaboradores registraron visitas.`,
    ];
    if (stats.findings_total > 0) {
      parts.push(
        `El motor detectó ${stats.findings_total} hallazgos abiertos${stats.critical ? `, ${stats.critical} críticos` : ''}.`,
      );
      const byType = Object.entries(stats.by_type)
        .map(([k, v]) => `${v} ${this.findingLabel(k)}`)
        .join(', ');
      if (byType) parts.push(`Distribución: ${byType}.`);
    } else {
      parts.push('Sin hallazgos abiertos.');
    }
    // HIQ.1 — memoria: qué cambió y qué persiste.
    if (comparison.findings_new_24h || comparison.findings_resolved_24h) {
      parts.push(
        `Desde ayer: ${comparison.findings_new_24h} nuevo(s), ${comparison.findings_resolved_24h} resuelto(s).`,
      );
    }
    if (comparison.team_score_delta != null) {
      const dir = comparison.team_score_delta >= 0 ? 'subió' : 'bajó';
      parts.push(
        `El score promedio del equipo ${dir} ${Math.abs(comparison.team_score_delta)} pts vs la semana pasada (${comparison.team_score_week_ago}% → ${comparison.team_score_now}%).`,
      );
    }
    if (comparison.persistent.length) {
      const p = comparison.persistent[0];
      parts.push(`Seguimiento: ${p.subject} sigue con ${p.type} desde hace ${p.days_open} días.`);
    }

    const attention = findings.slice(0, 8).map((f) => ({
      subject: f.label || f.subject_type,
      why: `${this.findingLabel(f.finding_type)} (${this.evidenceText(f)})`,
      severity: f.severity,
    }));

    return { headline, summary: parts.join(' '), attention };
  }

  // ── Redacción con Claude (solo comunica; no calcula) ───────────────────────

  private async draftWithClaude(
    findings: Finding[],
    stats: Briefing['stats'],
    comparison: Comparison,
  ): Promise<Pick<Briefing, 'headline' | 'summary' | 'attention'>> {
    const prompt = this.buildPrompt(findings, stats, comparison);
    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          tool_choice: { type: 'tool', name: 'daily_briefing' },
          tools: [
            {
              name: 'daily_briefing',
              description:
                'Redacta el parte diario de un supervisor de ventas de campo a partir de datos YA ' +
                'calculados por el motor. NO inventes nombres, números ni tiendas: usá SOLO lo provisto.',
              input_schema: {
                type: 'object',
                properties: {
                  headline: { type: 'string', description: 'Titular del día, una línea.' },
                  summary: { type: 'string', description: 'Resumen ejecutivo, 2-4 frases en español.' },
                  attention: {
                    type: 'array',
                    description: 'Ranking de qué priorizar hoy, basado SOLO en los hallazgos provistos.',
                    items: {
                      type: 'object',
                      properties: {
                        subject: { type: 'string', description: 'Colaborador o tienda del hallazgo.' },
                        why: { type: 'string', description: 'Motivo conciso (qué pasó y el dato).' },
                        severity: { type: 'string', enum: ['info', 'warn', 'critical'] },
                      },
                      required: ['subject', 'why', 'severity'],
                    },
                  },
                },
                required: ['headline', 'summary', 'attention'],
              },
            },
          ],
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tId);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: any }>;
    };
    const toolUse = json.content?.find((c) => c.type === 'tool_use' && c.name === 'daily_briefing');
    if (!toolUse) throw new Error('Claude no devolvió daily_briefing');

    const inp = toolUse.input || {};
    const attention = Array.isArray(inp.attention)
      ? inp.attention
          .filter((a: any) => a && a.subject && a.why)
          .slice(0, 10)
          .map((a: any) => ({
            subject: String(a.subject).slice(0, 160),
            why: String(a.why).slice(0, 300),
            severity: SEVERITIES.includes(a.severity) ? a.severity : 'warn',
          }))
      : [];
    return {
      headline: typeof inp.headline === 'string' ? inp.headline.trim() : '',
      summary: typeof inp.summary === 'string' ? inp.summary.trim() : '',
      attention,
    };
  }

  private buildPrompt(findings: Finding[], stats: Briefing['stats'], comparison: Comparison): string {
    const lines: string[] = [
      'Eres el asistente de un supervisor de ventas de campo (trade marketing / auditoría de exhibición en tiendas).',
      'Te doy datos YA CALCULADOS por el motor. NO los recalcules ni inventes nombres, números o tiendas: usá SOLO lo provisto.',
      'Redacta un parte diario conciso en español con la herramienta daily_briefing.',
      'El parte debe tener MEMORIA: arrancá por lo que CAMBIÓ desde ayer (nuevos/resueltos/tendencia),',
      'dá seguimiento explícito a lo que persiste ("X sigue igual desde hace N días"), y si un coaching',
      'aprobado FUNCIONÓ, reconocelo en una línea. No repitas como novedad lo que ya venía de días previos.',
      '',
      'Resumen del período (últimos 30 días):',
      `- Colaboradores activos: ${stats.collaborators}`,
      `- Hallazgos abiertos: ${stats.findings_total} (críticos: ${stats.critical}, advertencias: ${stats.warn})`,
    ];
    const byType = Object.entries(stats.by_type)
      .map(([k, v]) => `${this.findingLabel(k)}=${v}`)
      .join(', ');
    if (byType) lines.push(`- Por tipo: ${byType}`);

    // HIQ.1 — paquete comparativo (memoria narrativa, calculado por el motor).
    lines.push('', 'Qué cambió (motor, comparativo):');
    lines.push(`- Hallazgos nuevos últimas 24h: ${comparison.findings_new_24h}`);
    lines.push(`- Hallazgos resueltos últimas 24h: ${comparison.findings_resolved_24h}`);
    if (comparison.team_score_delta != null) {
      lines.push(
        `- Score promedio del equipo: ${comparison.team_score_week_ago}% hace una semana → ${comparison.team_score_now}% hoy (delta ${comparison.team_score_delta > 0 ? '+' : ''}${comparison.team_score_delta} pts)`,
      );
    }
    if (comparison.yesterday_headline) {
      lines.push(`- Titular del parte anterior: "${comparison.yesterday_headline}"`);
    }
    if (comparison.persistent.length) {
      lines.push('- Persisten sin resolver:');
      comparison.persistent.forEach((p) =>
        lines.push(`  · ${p.subject}: ${p.type} desde hace ${p.days_open} días`),
      );
    }
    if (comparison.outcomes_7d.length) {
      lines.push('- Outcomes de acciones aprobadas (medidos esta semana):');
      comparison.outcomes_7d.forEach((o) =>
        lines.push(
          `  · ${o.subject || 'sujeto'}: ${o.action_type} → ${o.verdict}${o.delta != null ? ` (delta ${o.delta})` : ''}`,
        ),
      );
    }

    lines.push('', 'Hallazgos (ya priorizados por el motor):');
    findings.slice(0, 25).forEach((f) => {
      lines.push(
        `- [${f.severity}] ${this.findingLabel(f.finding_type)} — ${f.label || f.subject_type} (${this.evidenceText(f)})`,
      );
    });
    return lines.join('\n');
  }
}

function safeParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}
