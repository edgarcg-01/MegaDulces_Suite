import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { MaatToolsService, MaatScope } from './maat-tools.service';

/**
 * MAAT.3 — Agente conversacional de Maat (ADR-028; port del patrón Thot
 * Chat/ADR-026 con frontera propia — finance no importa commercial).
 *
 * Bucle tool-use con Claude: el modelo pide tools → las ejecutamos (deterministas,
 * tenant-scoped) → le devolvemos el JSON → repite hasta responder. El LLM ORQUESTA
 * y NARRA; nunca calcula ni toca SQL. Los errores de tool vuelven como texto
 * accionable (self-correction). Sin API key → degrada con mensaje claro.
 *
 * Audit: cada intercambio queda en finance.chat_sessions/chat_messages con las
 * tool calls y tokens — el 👍/👎 por mensaje es el colector de feedback (L2).
 */

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.MAAT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const CLAUDE_THINK_MODEL = process.env.MAAT_CHAT_THINK_MODEL || 'claude-sonnet-4-6';
const TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 8;
// max_tokens de la respuesta final. 1500 truncaba las respuestas detalladas
// (análisis por sucursal, tablas) → render_response quedaba cortado y narrative
// volvía vacío ("No pude generar una respuesta"). 4096 cubre respuestas ricas.
const MAX_TOKENS = 4096;
// Reintento cuando aún así se corta por longitud (respuesta excepcional).
const RETRY_MAX_TOKENS = 8192;
const THINK_BUDGET = 1536;
const THINK_MAX_TOKENS = 8192;
const THINK_TIMEOUT_MS = 60_000;
const DEEP_ITERATIONS = 12;
const DEEP_DIRECTIVE =
  '\n\nMODO BÚSQUEDA PROFUNDA: investiga de forma exhaustiva. Usa varias tools y ' +
  'cruza los resultados (compara períodos, segmenta por cuenta/proveedor/sucursal, valida ' +
  'contra totales). No te conformes con el primer dato; entrega un análisis completo, ' +
  'citando los números que respaldan cada afirmación.';

export interface MaatChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MaatToolTrace {
  name: string;
  input: any;
  result: any;
}

export interface MaatChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: MaatToolTrace[];
  iterations: number;
  tokens_in: number;
  tokens_out: number;
  /** Repreguntas sugeridas (extraídas del marcador [[SEGUIR]] de la respuesta). */
  suggestions: string[];
}

/** Separa el marcador [[SEGUIR]] a|b|c del texto visible. */
function splitSuggestions(answer: string): { text: string; suggestions: string[] } {
  const m = answer.match(/\[\[SEGUIR\]\]\s*(.+?)\s*$/s);
  if (!m) return { text: answer.trim(), suggestions: [] };
  const suggestions = m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3);
  return { text: answer.slice(0, m.index).trim(), suggestions };
}

const mxToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

@Injectable()
export class MaatChatService {
  private readonly logger = new Logger(MaatChatService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tools: MaatToolsService,
  ) {}

  async ask(
    scope: MaatScope,
    input: { history: MaatChatTurn[]; think?: boolean; deepSearch?: boolean; image?: { mediaType: string; data: string } },
    onStep?: (step: { label: string; tool?: string }) => void,
  ): Promise<MaatChatResult> {
    const think = !!input.think;
    const deep = !!input.deepSearch;
    const maxIterations = deep ? DEEP_ITERATIONS : MAX_ITERATIONS;
    const history = (input.history || []).filter((t) => t && t.content && typeof t.content === 'string').slice(-12);
    const empty: Omit<MaatChatResult, 'answer' | 'source'> = { tools_used: [], iterations: 0, tokens_in: 0, tokens_out: 0, suggestions: [] };
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return { answer: 'No recibí ninguna pregunta.', source: 'error', ...empty };
    }
    if (!this.apiKey) {
      return {
        answer: 'Maat no está configurada (falta ANTHROPIC_API_KEY). Pídele al administrador que la configure.',
        source: 'no_api_key', ...empty,
      };
    }

    let system = await this.tools.buildSystemPrompt(scope, { today: mxToday() });
    if (deep) system += DEEP_DIRECTIVE;
    const toolDefs = this.tools.definitions();
    const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));

    // Adjunto de imagen (Claude vision): se inyecta en el último turno del usuario
    // — típico: foto de una factura/estado de cuenta para cruzar contra libros.
    if (input.image?.data && input.image?.mediaType) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user') {
        const text = typeof last.content === 'string' ? last.content : '';
        last.content = [
          { type: 'image', source: { type: 'base64', media_type: input.image.mediaType, data: input.image.data } },
          ...(text ? [{ type: 'text', text }] : []),
        ];
      }
    }

    const traces: MaatToolTrace[] = [];
    let tokensIn = 0, tokensOut = 0;

    let iterations = 0;
    while (iterations < maxIterations) {
      iterations++;
      let resp: any;
      try {
        resp = await this.callClaude(system, messages, toolDefs, think);
      } catch (e: any) {
        this.logger.warn(`Claude error: ${e?.message || e}`);
        return {
          answer: 'Tuve un problema consultando los datos en este momento. Intenta de nuevo en unos segundos.',
          source: 'error', tools_used: traces, iterations, tokens_in: tokensIn, tokens_out: tokensOut, suggestions: [],
        };
      }
      tokensIn += Number(resp?.usage?.input_tokens || 0);
      tokensOut += Number(resp?.usage?.output_tokens || 0);

      const content = Array.isArray(resp.content) ? resp.content : [];
      const toolUses = content.filter((b: any) => b.type === 'tool_use');

      // MAAT.7 — respuesta final ESTRUCTURADA: si el modelo llama render_response,
      // ese es el turno terminal (narrative + follow-ups tipados, sin hack de texto).
      const render = toolUses.find((b: any) => b.name === 'render_response');
      if (render) {
        const inp = render.input || {};
        let narrative = String(inp.narrative || '').trim();
        let sugg = Array.isArray(inp.suggested_follow_ups) ? inp.suggested_follow_ups.map((s: any) => String(s)).filter(Boolean).slice(0, 3) : [];
        // La respuesta se cortó por longitud (max_tokens) → render_response quedó
        // truncado y narrative vino vacío. Reintenta UNA vez pidiendo concisión
        // y con techo de tokens más alto, en vez de rendirse con "No pude…".
        if (!narrative && resp.stop_reason === 'max_tokens') {
          const recovered = await this.retryConcise(system, messages, toolDefs, think);
          narrative = recovered.narrative;
          if (recovered.suggestions.length) sugg = recovered.suggestions;
        }
        return {
          answer: narrative || 'La respuesta salió demasiado extensa y se cortó. Acota la pregunta (un período o una sola sucursal) y lo intento de nuevo.',
          source: 'llm', tools_used: traces, iterations, tokens_in: tokensIn, tokens_out: tokensOut, suggestions: sugg,
        };
      }

      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
        // Fallback: el modelo respondió en texto plano (sin render_response). Aún soporta [[SEGUIR]] legacy.
        const raw = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
        let { text, suggestions } = splitSuggestions(raw);
        if (!text && resp.stop_reason === 'max_tokens') {
          const recovered = await this.retryConcise(system, messages, toolDefs, think);
          text = recovered.narrative;
          if (recovered.suggestions.length) suggestions = recovered.suggestions;
        }
        return {
          answer: text || 'La respuesta salió demasiado extensa y se cortó. Acota la pregunta (un período o una sola sucursal) y lo intento de nuevo.',
          source: 'llm', tools_used: traces, iterations, tokens_in: tokensIn, tokens_out: tokensOut, suggestions,
        };
      }

      messages.push({ role: 'assistant', content });
      // MAAT.7 — el modelo puede pedir VARIAS tools por turno: ejecútalas en PARALELO
      // (antes secuencial). Los pasos de progreso se emiten antes del batch.
      for (const tu of toolUses) onStep?.({ label: this.tools.describeStep(tu.name, tu.input), tool: tu.name });
      const settled = await Promise.all(toolUses.map(async (tu: any) => ({
        tu,
        // maat_investigar_a_fondo delega a un sub-agente Auditor (in-process, sub-loop acotado).
        result: tu.name === 'maat_investigar_a_fondo'
          ? await this.runSubAgent(String(tu.input?.tema || ''), scope, onStep)
          : await this.tools.execute(tu.name, tu.input, scope),
      })));
      const toolResults = settled.map(({ tu, result }) => {
        traces.push({ name: tu.name, input: tu.input, result });
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
      });
      messages.push({ role: 'user', content: toolResults });
      onStep?.({ label: 'Cruzando los resultados…' });
    }

    return {
      answer: 'La consulta requería demasiados pasos. Reformula la pregunta de forma más específica (ej. un período o un proveedor concreto).',
      source: 'llm', tools_used: traces, iterations, tokens_in: tokensIn, tokens_out: tokensOut, suggestions: [],
    };
  }

  /**
   * MAAT.7/3.0-P1 — Sub-agente ESPECIALISTA "Auditor" in-process (multi-agente sin
   * framework externo). Corre un sub-loop ReAct acotado con persona forense y un
   * toolset reducido (anomalías, cadena, red de proveedores, hallazgos), y devuelve
   * un dictamen conciso al agente principal. Sin recursión (no se incluye a sí mismo
   * ni render_response en su toolset).
   */
  private async runSubAgent(tema: string, scope: MaatScope, onStep?: (s: { label: string; tool?: string }) => void): Promise<any> {
    const AUDIT_TOOLS = new Set([
      'maat_egresos', 'maat_balanza', 'maat_proveedor', 'maat_documento', 'maat_buscar_documentos',
      'maat_alertas', 'maat_hallazgos', 'maat_cadena', 'maat_red_proveedores', 'maat_tomar_nota',
    ]);
    const toolDefs = this.tools.definitions().filter((t) => AUDIT_TOOLS.has(t.name));
    const system = `Eres el AUDITOR FORENSE de Maat, un sub-agente especialista. Tu único trabajo: investigar a fondo "${tema}" cruzando señales con las tools disponibles (anomalías, cadena de documentos, duplicados, saltos de precio z-score, red de proveedores por RFC, hallazgos).\n`
      + 'Método: encadena 2-4 tools relevantes, cruza los resultados, y ENTREGA UN DICTAMEN conciso en texto plano (sin markdown pesado): qué encontraste, la evidencia numérica, la severidad (baja/media/alta) y una recomendación. Cuando termines, responde SOLO con el dictamen (sin pedir más tools). Nunca inventes cifras: solo lo que devuelven las tools.';
    const messages: any[] = [{ role: 'user', content: `Investiga a fondo: ${tema}` }];
    const traces: string[] = [];
    let iter = 0;
    while (iter < 5) {
      iter++;
      let resp: any;
      try { resp = await this.callClaude(system, messages, toolDefs, false); }
      catch { return { dictamen: 'No pude completar la sub-investigación (error del modelo).', pasos: traces }; }
      const content = Array.isArray(resp.content) ? resp.content : [];
      const toolUses = content.filter((b: any) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
        const dictamen = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
        return { dictamen: dictamen || 'El auditor no encontró señales concluyentes.', pasos: traces };
      }
      messages.push({ role: 'assistant', content });
      for (const tu of toolUses) onStep?.({ label: `🔍 ${this.tools.describeStep(tu.name, tu.input)}`, tool: tu.name });
      const results = await Promise.all(toolUses.map(async (tu: any) => ({ tu, result: await this.tools.execute(tu.name, tu.input, scope) })));
      const toolResults = results.map(({ tu, result }) => { traces.push(tu.name); return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) }; });
      messages.push({ role: 'user', content: toolResults });
    }
    return { dictamen: 'Sub-investigación incompleta (límite de pasos). Reduce el alcance.', pasos: traces };
  }

  /**
   * Audit del intercambio: asegura la sesión (crea si no viene), inserta el turno
   * user + assistant (con tool calls y tokens). Best-effort — no rompe la respuesta.
   * Devuelve { session_id, message_id } (el id del mensaje assistant para el 👍/👎).
   */
  async logExchange(
    meta: { sessionId?: string | null; userId?: string; userName?: string; question: string },
    res: MaatChatResult,
  ): Promise<{ session_id: string | null; message_id: string | null }> {
    try {
      return await this.tk.run(async (trx) => {
        let sessionId = meta.sessionId || null;
        if (sessionId) {
          const found = await trx('finance.chat_sessions').where('id', sessionId).first('id');
          if (!found) sessionId = null;
        }
        if (!sessionId) {
          const [s] = await trx('finance.chat_sessions')
            .insert({
              tenant_id: trx.raw('public.current_tenant_id()'),
              user_id: meta.userId || null,
              username: meta.userName || null,
            })
            .returning('id');
          sessionId = s.id;
        } else {
          await trx('finance.chat_sessions').where('id', sessionId)
            .update({ last_at: trx.fn.now(), turns: trx.raw('turns + 1') });
        }
        const tenantRaw = () => trx.raw('public.current_tenant_id()');
        await trx('finance.chat_messages').insert({
          tenant_id: tenantRaw(), session_id: sessionId, role: 'user',
          content: meta.question.slice(0, 4000),
        });
        const [m] = await trx('finance.chat_messages')
          .insert({
            tenant_id: tenantRaw(), session_id: sessionId, role: 'assistant',
            content: (res.answer || '').slice(0, 8000),
            tool_calls: JSON.stringify(res.tools_used.map((t) => ({
              name: t.name, input: t.input,
              rows: Array.isArray(t.result?.rows) ? t.result.rows.length : undefined,
            }))),
            tokens_in: res.tokens_in, tokens_out: res.tokens_out,
          })
          .returning('id');
        return { session_id: sessionId, message_id: m?.id || null };
      });
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar chat_messages: ${e?.message || e}`);
      return { session_id: meta.sessionId || null, message_id: null };
    }
  }

  /** 👍/👎 sobre una respuesta — el colector del aprendizaje L2. */
  async recordFeedback(messageId: string, vote: number): Promise<{ ok: boolean }> {
    const v = vote > 0 ? 'up' : 'down';
    await this.tk.run(async (trx) => {
      await trx('finance.chat_messages').where({ id: messageId, role: 'assistant' }).update({ feedback: v });
    });
    return { ok: true };
  }

  /**
   * Recuperación de truncamiento: la respuesta previa se cortó por max_tokens.
   * Reintenta UNA vez con techo de tokens más alto + instrucción de concisión,
   * y extrae narrative (de render_response o texto plano). Best-effort.
   */
  private async retryConcise(system: string, messages: any[], tools: any[], think: boolean): Promise<{ narrative: string; suggestions: string[] }> {
    try {
      const nudged = system + '\n\nIMPORTANTE: tu respuesta anterior se cortó por longitud. Responde de nuevo vía render_response pero MÁS CONCISO (máximo ~450 palabras en narrative): prioriza las cifras y conclusiones esenciales, sin relleno.';
      const resp = await this.callClaude(nudged, messages, tools, think, RETRY_MAX_TOKENS);
      const content = Array.isArray(resp.content) ? resp.content : [];
      const render = content.find((b: any) => b.type === 'tool_use' && b.name === 'render_response');
      if (render?.input) {
        const sugg = Array.isArray(render.input.suggested_follow_ups) ? render.input.suggested_follow_ups.map((s: any) => String(s)).filter(Boolean).slice(0, 3) : [];
        return { narrative: String(render.input.narrative || '').trim(), suggestions: sugg };
      }
      const raw = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
      const { text, suggestions } = splitSuggestions(raw);
      return { narrative: text, suggestions };
    } catch (e: any) {
      this.logger.warn(`retryConcise falló: ${e?.message || e}`);
      return { narrative: '', suggestions: [] };
    }
  }

  private async callClaude(system: string, messages: any[], tools: any[], think = false, maxTokensOverride?: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), think ? THINK_TIMEOUT_MS : TIMEOUT_MS);
    try {
      const body: any = {
        model: think ? CLAUDE_THINK_MODEL : CLAUDE_MODEL,
        max_tokens: maxTokensOverride || (think ? THINK_MAX_TOKENS : MAX_TOKENS),
        system, tools, messages,
      };
      if (think) body.thinking = { type: 'enabled', budget_tokens: THINK_BUDGET };
      const res = await fetch(CLAUDE_ENDPOINT, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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
