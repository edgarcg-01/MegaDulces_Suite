import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { DecisionEngineService } from './decision-engine.service';
import { FeedbackService } from './feedback.service';
import { ReorderMessage } from './customer-360.types';

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15_000;
const MAX_BASKET_IN_MSG = 6;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Agente comunicador (Fase M, Sprint M.2) — capa "el agente comunica" de ADR-016.
 *
 * INVARIANTE: el motor DECIDE (NBA + canasta), el agente solo REDACTA. El LLM
 * nunca inventa productos, precios ni cantidades — recibe los datos del motor
 * como hechos fijos y solo mejora la redacción. Sin API key o ante error, cae
 * a una plantilla determinista. NO crea pedidos (eso es camino determinista).
 */
@Injectable()
export class CommerceAgentService {
  private readonly logger = new Logger(CommerceAgentService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly engine: DecisionEngineService,
    private readonly feedback: FeedbackService,
  ) {}

  /**
   * Mensaje de recordatorio de reorden para un customer due-for-reorder.
   * Si no aplica (no due), devuelve action='none' y message=null.
   */
  async composeReorderMessage(customerId: string): Promise<ReorderMessage> {
    const nba = await this.engine.nextBestAction(customerId);
    if (nba.action !== 'due_for_reorder') {
      return {
        customer_id: customerId,
        action: nba.action,
        urgency: nba.urgency,
        channel_hint: null,
        message: null,
        generated_by: 'none',
        basket: [],
        reason: nba.reason,
      };
    }

    const basket = await this.engine.suggestedBasket(customerId);
    const customer = await this.tk.run(async (trx) =>
      trx('commercial.customers').where({ id: customerId }).first('name', 'code'),
    );
    const name = customer?.name || 'estimado cliente';

    const items = basket.items.slice(0, MAX_BASKET_IN_MSG).map((i) => ({
      product_id: i.product_id,
      product_name: i.product_name,
      sample_price: i.sample_price,
    }));

    const cadence = nba.next_order_estimate && nba.days_overdue !== null
      ? Math.max(1, Math.round(nba.days_overdue))
      : null;

    const draft = this.template(name, items, nba.reason);

    let message = draft;
    let generatedBy: ReorderMessage['generated_by'] = 'template';
    if (this.apiKey && items.length > 0) {
      try {
        message = await this.rephrase(name, draft, items, nba.reason);
        generatedBy = 'llm';
      } catch (e: any) {
        this.logger.warn(`Claude rephrase fallback (${e.message})`);
      }
    }

    try {
      await this.feedback.record({
        customer_id: customerId,
        signal_type: 'offer_message',
        channel: 'whatsapp',
        context: { generated_by: generatedBy, urgency: nba.urgency, items: items.length },
      });
    } catch {
      /* best-effort: el feedback no debe romper la generación del mensaje */
    }

    return {
      customer_id: customerId,
      action: 'due_for_reorder',
      urgency: nba.urgency,
      channel_hint: 'whatsapp',
      message,
      generated_by: generatedBy,
      basket: items,
      reason: nba.reason,
    };
  }

  /** Plantilla determinista — fuente de verdad de los hechos del mensaje. */
  private template(
    name: string,
    items: { product_name: string }[],
    reason: string,
  ): string {
    if (items.length === 0) {
      return `Hola ${name}, ya va siendo hora de tu pedido (${reason}). ¿Te preparamos el de siempre?`;
    }
    const list = items.map((i) => i.product_name).join(', ');
    return `Hola ${name}, ya va siendo hora de reabastecer. ¿Te preparamos tu pedido habitual? Incluiría: ${list}. Responde "Sí" y lo dejamos listo.`;
  }

  /**
   * Claude solo MEJORA la redacción del draft. El prompt le prohíbe cambiar
   * productos/cantidades; los items van como hechos fijos.
   */
  private async rephrase(
    name: string,
    draft: string,
    items: { product_name: string }[],
    reason: string,
  ): Promise<string> {
    const system = `Eres un asistente de ventas B2B de una distribuidora de dulces (Mega Dulces). Reescribe el mensaje borrador para que suene cálido, natural y conciso en español mexicano, formato WhatsApp (máximo 3 líneas, máximo 1 emoji).

REGLAS ESTRICTAS:
1. NO inventes ni cambies productos. Los únicos productos válidos son: ${items.map((i) => i.product_name).join(', ') || '(ninguno)'}.
2. NO menciones precios ni cantidades específicas.
3. Conserva la intención: recordar al cliente que es buen momento para reordenar su pedido habitual e invitarlo a confirmar.
4. Contexto (no lo cites textual): ${reason}.

Devuelve SOLO el mensaje final, sin comillas ni explicación.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 512,
          system,
          messages: [{ role: 'user', content: `Borrador a reescribir:\n${draft}` }],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      const json: any = await res.json();
      const text = (json.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
        .trim();
      if (!text) throw new Error('Claude no devolvió texto');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── T.R3: explicación del razonamiento de UNA acción del co-piloto ──────────
  // El motor arma la CADENA determinista (evidencia→diagnóstico→decisión→confianza→
  // impacto $); el agente la REDACTA. Fallback determinista sin LLM. El LLM nunca
  // decide ni recalcula: recibe la decisión ya tomada (invariante ADR-016/020).

  async explainAction(id: string): Promise<{
    narrative: string;
    source: 'llm' | 'template';
    reasoning_chain: Array<{ step: string; text: string }>;
    action: { id: string; title: string; action_type: string; confidence: number | null; root_cause: string | null };
  }> {
    if (!UUID_RE.test(id || '')) throw new BadRequestException('id inválido');

    const { action, diagnosis, finding } = await this.tk.run(async (trx) => {
      const a = await trx('commercial.commercial_actions').where({ id }).first();
      if (!a) return { action: null, diagnosis: null, finding: null };
      let d = null;
      let f = null;
      if (a.diagnosis_id) d = await trx('commercial.commercial_diagnoses').where({ id: a.diagnosis_id }).first();
      else if (a.finding_id) f = await trx('commercial.commercial_findings').where({ id: a.finding_id }).first();
      return { action: a, diagnosis: d, finding: f };
    });
    if (!action) throw new NotFoundException('Acción no encontrada');

    const chain = this.buildExplainChain(action, diagnosis, finding);
    let narrative: string | null = null;
    if (this.apiKey) {
      narrative = await this.draftExplanation(action, chain).catch((e: any) => {
        this.logger.warn(`explain LLM fallback (${e.message})`);
        return null;
      });
    }
    const source: 'llm' | 'template' = narrative ? 'llm' : 'template';
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

  private parseJson(v: any): Record<string, any> {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) || {};
      } catch {
        return {};
      }
    }
    return {};
  }

  private commercialSymptomPhrase(f: any): string {
    const e = this.parseJson(f.evidence);
    const v = (x: any, suf = '') => (x != null ? `${x}${suf}` : '?');
    switch (f.finding_type) {
      case 'low_rotation_priced':
        return `rotación baja (${v(e.sales_units_30d)} u./30d)`;
      case 'margin_laggard':
        return `margen ${v(e.margin_pct, '%')}`;
      case 'distribution_gap':
        return `top ${v(e.demand_rank)} en "${v(e.zona)}" pero ${v(e.pdv_count)} PdVs`;
      case 'churn_risk':
        return `${v(e.recency_days)}d sin pedir (cadencia ${v(e.cadence_days)}d)`;
      default:
        return f.finding_type;
    }
  }

  private impactPhrase(action: any): string | null {
    const imp = this.parseJson(action.expected_impact);
    if (imp.value == null) return null;
    const v = Math.round(Number(imp.value) * 100) / 100;
    if (imp.kind === 'monthly_margin_uplift_mxn') return `+$${v}/mes de margen si se corrige`;
    if (imp.kind === 'per_unit_margin_uplift_mxn') return `+$${v} de margen por unidad si se corrige`;
    return `$${v}`;
  }

  private buildExplainChain(action: any, diagnosis: any, finding: any): Array<{ step: string; text: string }> {
    const chain: Array<{ step: string; text: string }> = [];
    let evidencia = '';
    if (diagnosis) {
      const ev = this.parseJson(diagnosis.evidence);
      const symptoms = Array.isArray(ev.symptoms) ? ev.symptoms : [];
      evidencia = symptoms.map((s: any) => s.phrase).filter(Boolean).join('; ');
    } else if (finding) {
      evidencia = this.commercialSymptomPhrase(finding);
    }
    chain.push({ step: 'evidencia', text: evidencia || '—' });
    if (diagnosis) chain.push({ step: 'diagnóstico', text: diagnosis.summary || diagnosis.root_cause });
    else if (finding) chain.push({ step: 'síntoma', text: finding.finding_type });
    chain.push({ step: 'decisión', text: action.title });
    if (action.confidence != null) {
      chain.push({ step: 'confianza', text: `${Math.round(Number(action.confidence) * 100)}% (corroboración; la afina el feedback de conversión)` });
    }
    const imp = this.impactPhrase(action);
    if (imp) chain.push({ step: 'impacto', text: imp });
    return chain;
  }

  private deterministicExplanation(action: any, chain: Array<{ step: string; text: string }>): string {
    const who = action.label || (action.subject_type === 'customer' ? 'el cliente' : 'el producto');
    const get = (s: string) => chain.find((c) => c.step === s)?.text;
    const parts: string[] = [`${who}.`];
    const diag = get('diagnóstico');
    if (diag) parts.push(`${diag}.`);
    const ev = get('evidencia');
    if (ev && ev !== '—' && !diag) parts.push(`Señales: ${ev}.`);
    parts.push(`Acción sugerida: ${action.title}.`);
    const conf = get('confianza');
    if (conf) parts.push(`Confianza ${conf}.`);
    const imp = get('impacto');
    if (imp) parts.push(`Impacto esperado: ${imp}.`);
    return parts.join(' ');
  }

  private async draftExplanation(action: any, chain: Array<{ step: string; text: string }>): Promise<string> {
    const system = `Eres el asistente de un analista comercial de una distribuidora de dulces (Mega Dulces). El MOTOR ya decidió esta recomendación y su cadena de razonamiento. NO recalcules ni inventes datos: usá SOLO lo provisto. Redacta una explicación breve (2-3 frases, español) de POR QUÉ conviene esta acción, en tono ejecutivo. Devuelve SOLO el texto.`;
    const userMsg = [
      `Acción: ${action.title}`,
      'Cadena de razonamiento (motor, determinista):',
      ...chain.map((c) => `- ${c.step}: ${c.text}`),
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: userMsg }] }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 160)}`);
      }
      const json: any = await res.json();
      const text = (json.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim();
      if (!text) throw new Error('Claude no devolvió texto');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}
