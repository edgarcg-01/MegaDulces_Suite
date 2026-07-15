import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { HorusToolsService } from './horus-tools.service';

/**
 * HIQ.0 — "Pregúntale a Horus": agente conversacional del supervisor (réplica
 * por dominio del loop ReAct de Thot Chat, ADR-026).
 *
 * Bucle tool-use con Claude: el modelo pide tools → las ejecutamos (deterministas,
 * tenant explícito) → le devolvemos el JSON → repite hasta responder. El LLM
 * ORQUESTA y NARRA; nunca calcula. Self-correction: los errores de tool vuelven
 * como texto accionable. Sin API key → degrada con mensaje claro (igual que el
 * briefing de Horus.2).
 */

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL =
  process.env.HORUS_CHAT_MODEL || process.env.THOT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_THINK_MODEL =
  process.env.HORUS_CHAT_THINK_MODEL || process.env.THOT_CHAT_THINK_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 6;
const MAX_TOKENS = 1500;
const THINK_BUDGET = 1536;
const THINK_MAX_TOKENS = 4096;
const THINK_TIMEOUT_MS = 60_000;
const DEEP_ITERATIONS = 12;
const DEEP_DIRECTIVE =
  '\n\nMODO INVESTIGACIÓN PROFUNDA: investigá de forma exhaustiva. Usá varias tools y ' +
  'cruzá los resultados (salud + hallazgos + baseline + timeline + visión). No te conformes ' +
  'con el primer dato; entregá un diagnóstico completo citando la evidencia de cada afirmación.';

export interface HorusChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface HorusToolTrace {
  name: string;
  input: any;
  /** Resultado crudo de la tool (para render estructurado en el front). */
  result: any;
}

export interface HorusChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: HorusToolTrace[];
  iterations: number;
}

const mxToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

@Injectable()
export class HorusChatService {
  private readonly logger = new Logger(HorusChatService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly tools: HorusToolsService,
  ) {}

  /** Registra el intercambio en commercial.horus_chat_log (tenant explícito, best-effort). */
  async logExchange(
    user: any,
    question: string,
    res: HorusChatResult,
  ): Promise<string | null> {
    const tenantId = user?.tenant_id;
    if (!tenantId) return null;
    try {
      const [row] = await this.knex('commercial.horus_chat_log')
        .insert({
          tenant_id: tenantId,
          user_id: user?.sub || user?.id || null,
          user_name: user?.username || user?.nombre || null,
          question: question.slice(0, 4000),
          answer: (res.answer || '').slice(0, 8000),
          tools_used: JSON.stringify(res.tools_used.map((t) => ({ name: t.name, input: t.input }))),
          iterations: res.iterations,
          source: res.source,
        })
        .returning('id');
      return row?.id || null;
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar horus_chat_log: ${e?.message || e}`);
      return null;
    }
  }

  /** Voto 👍/👎 sobre una respuesta (feedback loop, mismo patrón TC.5a). */
  async recordFeedback(user: any, logId: string, vote: number): Promise<{ ok: boolean }> {
    const tenantId = user?.tenant_id;
    if (!tenantId) return { ok: false };
    const v = vote > 0 ? 1 : vote < 0 ? -1 : 0;
    await this.knex('commercial.horus_chat_log')
      .where({ tenant_id: tenantId, id: logId })
      .update({ feedback: v });
    return { ok: true };
  }

  async ask(
    user: any,
    input: { history: HorusChatTurn[]; think?: boolean; deepSearch?: boolean },
  ): Promise<HorusChatResult> {
    const think = !!input.think;
    const deep = !!input.deepSearch;
    const maxIterations = deep ? DEEP_ITERATIONS : MAX_ITERATIONS;
    const history = (input.history || [])
      .filter((t) => t && t.content && typeof t.content === 'string')
      .slice(-12);
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return { answer: 'No recibí ninguna pregunta.', source: 'error', tools_used: [], iterations: 0 };
    }

    if (!this.apiKey) {
      return {
        answer:
          'El asistente no está configurado (falta ANTHROPIC_API_KEY). Pedile al administrador que la configure.',
        source: 'no_api_key',
        tools_used: [],
        iterations: 0,
      };
    }

    let system = this.tools.systemPrompt({
      today: mxToday(),
      userName: user?.nombre || user?.username || undefined,
    });
    if (deep) system += DEEP_DIRECTIVE;
    const toolDefs = this.tools.definitions();
    const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));
    const traces: HorusToolTrace[] = [];

    let iterations = 0;
    while (iterations < maxIterations) {
      iterations++;
      let resp: any;
      try {
        resp = await this.callClaude(system, messages, toolDefs, think);
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
        const answer = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
          .trim();
        return { answer: answer || 'No pude generar una respuesta.', source: 'llm', tools_used: traces, iterations };
      }

      messages.push({ role: 'assistant', content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const result = await this.tools.execute(tu.name, tu.input, user);
        traces.push({ name: tu.name, input: tu.input, result });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return {
      answer:
        'La consulta requería demasiados pasos. Reformulá la pregunta de forma más específica (ej: un colaborador o una tienda concretos).',
      source: 'llm',
      tools_used: traces,
      iterations,
    };
  }

  private async callClaude(system: string, messages: any[], tools: any[], think = false): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), think ? THINK_TIMEOUT_MS : TIMEOUT_MS);
    try {
      const body: any = {
        model: think ? CLAUDE_THINK_MODEL : CLAUDE_MODEL,
        max_tokens: think ? THINK_MAX_TOKENS : MAX_TOKENS,
        system,
        tools,
        messages,
      };
      if (think) body.thinking = { type: 'enabled', budget_tokens: THINK_BUDGET };
      const res = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(body),
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
