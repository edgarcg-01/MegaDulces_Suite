import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { ThotToolsService } from './thot-tools.service';
import { buildThotSystemPrompt } from './thot-semantic';

/**
 * TC.1 — Agente conversacional de Thot (ADR-026).
 *
 * Bucle tool-use con Claude: el modelo pide tools → las ejecutamos (deterministas,
 * RLS) → le devolvemos el JSON → repite hasta responder. El LLM ORQUESTA y NARRA;
 * nunca calcula ni toca SQL. Self-correction: los errores de tool vuelven como
 * texto accionable para que reintente. Sin API key → degrada con mensaje claro.
 */

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.THOT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 6;
const MAX_TOKENS = 1500;

export interface ThotChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ThotToolTrace {
  name: string;
  input: any;
  /** Resultado crudo de la tool (para render estructurado en el front). */
  result: any;
}

export interface ThotChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: ThotToolTrace[];
  iterations: number;
}

const mxToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

@Injectable()
export class ThotChatService {
  private readonly logger = new Logger(ThotChatService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    private readonly tools: ThotToolsService,
    private readonly tk: TenantKnexService,
  ) {}

  /** Registra el intercambio en commercial.thot_chat_log (auditable). Best-effort. */
  async logExchange(meta: { userId?: string; userName?: string; question: string }, res: ThotChatResult): Promise<void> {
    try {
      await this.tk.run(async (trx) => {
        await trx('commercial.thot_chat_log').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          user_id: meta.userId || null,
          user_name: meta.userName || null,
          question: meta.question.slice(0, 4000),
          answer: (res.answer || '').slice(0, 8000),
          tools_used: JSON.stringify(res.tools_used.map((t) => ({ name: t.name, input: t.input }))),
          iterations: res.iterations,
          source: res.source,
        });
      });
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar thot_chat_log: ${e?.message || e}`);
    }
  }

  async ask(input: { history: ThotChatTurn[]; userName?: string }): Promise<ThotChatResult> {
    const history = (input.history || []).filter((t) => t && t.content && typeof t.content === 'string').slice(-12);
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return { answer: 'No recibí ninguna pregunta.', source: 'error', tools_used: [], iterations: 0 };
    }

    if (!this.apiKey) {
      return {
        answer: 'El asistente no está configurado (falta ANTHROPIC_API_KEY). Pedile al administrador que la configure.',
        source: 'no_api_key',
        tools_used: [],
        iterations: 0,
      };
    }

    const system = buildThotSystemPrompt({ today: mxToday(), userName: input.userName });
    const toolDefs = this.tools.definitions();
    // Estado del diálogo en formato Anthropic (content puede ser string o blocks).
    const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));
    const traces: ThotToolTrace[] = [];

    let iterations = 0;
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      let resp: any;
      try {
        resp = await this.callClaude(system, messages, toolDefs);
      } catch (e: any) {
        this.logger.warn(`Claude error: ${e?.message || e}`);
        return {
          answer: 'Tuve un problema consultando los datos en este momento. Probá de nuevo en unos segundos.',
          source: 'error',
          tools_used: traces,
          iterations,
        };
      }

      const content = Array.isArray(resp.content) ? resp.content : [];
      const toolUses = content.filter((b: any) => b.type === 'tool_use');

      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
        const answer = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
        return { answer: answer || 'No pude generar una respuesta.', source: 'llm', tools_used: traces, iterations };
      }

      // Persistimos el turno del assistant (con sus tool_use) y respondemos cada uno.
      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const result = await this.tools.execute(tu.name, tu.input);
        traces.push({ name: tu.name, input: tu.input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    // Se acabaron las iteraciones — pedir un cierre con lo que ya tiene.
    return {
      answer: 'La consulta requería demasiados pasos. Reformulá la pregunta de forma más específica (ej: un período o un producto concreto).',
      source: 'llm',
      tools_used: traces,
      iterations,
    };
  }

  private async callClaude(system: string, messages: any[], tools: any[]): Promise<any> {
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
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, system, tools, messages }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Claude HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
