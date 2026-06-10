import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { DecisionEngineService } from './decision-engine.service';
import { FeedbackService } from './feedback.service';
import { ReorderMessage } from './customer-360.types';

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 15_000;
const MAX_BASKET_IN_MSG = 6;

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
}
