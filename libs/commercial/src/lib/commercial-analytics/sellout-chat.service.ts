import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import { SelloutChatToolsService } from './sellout-chat-tools.service';

/**
 * BI.5 — "Pregúntale al Sell-Out": loop ReAct conversacional (ADR-016).
 *
 * El modelo pide tools -> las ejecutamos (deterministas, tenant-scoped) -> le
 * devolvemos el JSON -> repite hasta llamar render_response. El LLM ORQUESTA y
 * NARRA; jamás calcula ni toca SQL. Sin API key degrada con mensaje claro.
 *
 * DEUDA declarada (ADR-056): este loop es un CALCO lean de MaatChatService /
 * ThotChatService. La extracción a un motor genérico (AiChatEngineService en
 * platform-core, parametrizado por un ChatToolProvider como ya hizo Thot) queda
 * como BI.5.1 — hoy hay 3 copias del loop (thot/maat/sellout).
 */

const CHAT_MODEL = process.env.SELLOUT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const THINK_MODEL = process.env.SELLOUT_CHAT_THINK_MODEL || 'claude-sonnet-5';
const MAX_ITERATIONS = 6;
const MAX_TOKENS = 1500;
const SONNET_MAX_TOKENS = 3000;
const TIMEOUT_MS = 30_000;

export interface SelloutChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface SelloutChatBlock {
  tool: string;
  input: any;
  result: any;
}
export interface SelloutChatResult {
  narrative: string;
  blocks: SelloutChatBlock[];
  suggestions: string[];
  source: 'llm' | 'no_api_key' | 'error';
  model?: string;
  tokens?: { in: number; out: number };
}

@Injectable()
export class SelloutChatService {
  private readonly logger = new Logger(SelloutChatService.name);

  constructor(
    private readonly anthropic: AnthropicService,
    private readonly tools: SelloutChatToolsService,
  ) {}

  private today(): string {
    return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  }
  private isComplex(text: string, historyLen: number): boolean {
    return text.length > 160 || historyLen >= 8 || /analiz|compar|por qu|explica|tendencia|investig|fraud/i.test(text);
  }

  async ask(input: { history?: SelloutChatTurn[]; message: string; think?: boolean }): Promise<SelloutChatResult> {
    const message = (input.message || '').trim();
    if (!message) return { narrative: 'Escribe una pregunta sobre la venta.', blocks: [], suggestions: [], source: 'error' };
    if (!this.anthropic.hasApiKey) {
      return { narrative: 'El asistente no está configurado (falta ANTHROPIC_API_KEY). Usa los filtros del reporte mientras tanto.', blocks: [], suggestions: [], source: 'no_api_key' };
    }

    const history = (input.history || []).filter((t) => t && t.content).slice(-8);
    const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: message });

    const system = this.tools.buildSystemPrompt({ today: this.today() });
    const toolDefs = this.tools.definitions();
    const useSonnet = input.think || this.isComplex(message, history.length);
    const model = useSonnet ? THINK_MODEL : CHAT_MODEL;
    const maxTokens = useSonnet ? SONNET_MAX_TOKENS : MAX_TOKENS;

    const blocks: SelloutChatBlock[] = [];
    let tokIn = 0, tokOut = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const forceFinal = i === MAX_ITERATIONS - 1;
      let res: any;
      try {
        res = await this.anthropic.messages(
          {
            model, maxTokens, system, messages, tools: toolDefs,
            ...(input.think ? { thinking: { type: 'adaptive' }, effort: 'medium' } : {}),
            ...(forceFinal ? { toolChoice: { type: 'tool', name: 'render_response' } } : {}),
          },
          { cachePrefix: true, timeoutMs: input.think ? 60_000 : TIMEOUT_MS },
        );
      } catch (e: any) {
        this.logger.warn(`sellout-chat LLM error: ${e?.message}`);
        return { narrative: 'No pude consultar al asistente en este momento. Intenta de nuevo.', blocks, suggestions: [], source: 'error', model };
      }
      tokIn += res?.usage?.input_tokens || 0;
      tokOut += res?.usage?.output_tokens || 0;

      const content: any[] = Array.isArray(res?.content) ? res.content : [];
      const render = content.find((c) => c.type === 'tool_use' && c.name === 'render_response');
      if (render) {
        return {
          narrative: String(render.input?.narrative || '').trim() || 'Listo.',
          blocks,
          suggestions: Array.isArray(render.input?.suggested_follow_ups) ? render.input.suggested_follow_ups.slice(0, 3) : [],
          source: 'llm', model, tokens: { in: tokIn, out: tokOut },
        };
      }

      const toolUses = content.filter((c) => c.type === 'tool_use');
      if (res?.stop_reason !== 'tool_use' || !toolUses.length) {
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        return { narrative: text || 'No tengo una respuesta para eso.', blocks, suggestions: [], source: 'llm', model, tokens: { in: tokIn, out: tokOut } };
      }

      messages.push({ role: 'assistant', content });
      const results = await Promise.all(
        toolUses.map(async (tu: any) => {
          const out = await this.tools.execute(tu.name, tu.input || {});
          blocks.push({ tool: tu.name, input: tu.input || {}, result: out });
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return { narrative: 'La consulta fue muy larga. Reformula la pregunta de forma más específica.', blocks, suggestions: [], source: 'llm', model, tokens: { in: tokIn, out: tokOut } };
  }
}
