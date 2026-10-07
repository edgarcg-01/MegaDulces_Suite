import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, AnthropicService } from '@megadulces/platform-core';
import { ThotToolProvider, ThotScope } from './thot-tool-provider';
import { ThotExamplesService } from './thot-examples.service';

/**
 * TC.1 — Agente conversacional de Thot (ADR-026).
 *
 * Bucle tool-use con Claude: el modelo pide tools → las ejecutamos (deterministas,
 * RLS) → le devolvemos el JSON → repite hasta responder. El LLM ORQUESTA y NARRA;
 * nunca calcula ni toca SQL. Self-correction: los errores de tool vuelven como
 * texto accionable para que reintente. Sin API key → degrada con mensaje claro.
 */

const CLAUDE_MODEL = process.env.THOT_CHAT_MODEL || 'claude-haiku-4-5-20251001';
// Sonnet 5: el modelo "listo". Lo usa Think (con adaptive thinking) y el auto-routing
// por complejidad (sin thinking). Haiku conduce el grueso barato/rápido.
const CLAUDE_THINK_MODEL = process.env.THOT_CHAT_THINK_MODEL || 'claude-sonnet-5';
const TIMEOUT_MS = 30_000;
const MAX_ITERATIONS = 6;
const MAX_TOKENS = 1500;
// Auto-routing (FIQ.1): una pregunta compleja sube a Sonnet 5 aunque el user no prenda
// Think. Sonnet sin thinking necesita algo más de techo que Haiku para análisis ricos.
const SONNET_MAX_TOKENS = 3000;

// ── Modos opt-in (toggles del input) ──────────────────────────────────────
// Think = adaptive thinking de Claude (Sonnet 5): el modelo decide cuánto razonar;
// effort 'medium' gobierna profundidad/costo. budget_tokens ya no existe en Sonnet 5.
const THINK_MAX_TOKENS = 8192;      // headroom para thinking + respuesta
const THINK_TIMEOUT_MS = 60_000;    // el razonamiento agrega latencia
// Deep Search = más iteraciones para cruzar más tools + directiva exhaustiva.
const DEEP_ITERATIONS = 12;
const DEEP_DIRECTIVE =
  '\n\nMODO BÚSQUEDA PROFUNDA: investigá de forma exhaustiva. Usá varias tools y ' +
  'cruzá los resultados (compará períodos, segmentá por marca/cliente/categoría, validá ' +
  'contra totales). No te conformes con el primer dato; entregá un análisis completo y ' +
  'contextualizado, citando los números que respaldan cada afirmación.';

export interface ThotChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// ── VG.2 — "Ventas Generales": Thot compone un tablero desde lenguaje natural ──────
// El LLM SOLO emite el `spec` (qué bloques y a qué métrica/dimensión). NO calcula ni
// devuelve cifras — el frontend rellena con datos deterministas (ADR-016/042).
const SV_METRICS = ['ventas', 'margen', 'unidades', 'tickets', 'ticket_promedio'];
const SV_DIMS = ['canal', 'marca', 'categoria', 'sucursal', 'producto', 'cliente', 'tiempo'];
const SV_VIZ = ['bars-table', 'bars', 'table'];
const SV_DIM_METRICS: Record<string, string[]> = {
  canal: ['ventas', 'margen', 'unidades', 'tickets', 'ticket_promedio'],
  marca: ['ventas', 'margen', 'unidades'],
  categoria: ['ventas', 'margen', 'unidades'],
  sucursal: ['ventas', 'unidades', 'tickets'],
  producto: ['ventas', 'margen', 'unidades'],
  cliente: ['ventas'],
  tiempo: ['ventas', 'unidades', 'tickets'],
};
const SV_TOOL = {
  name: 'compose_sales_view',
  description: 'Arma el tablero de "Ventas Generales" que responde la pregunta del usuario. Devolvés SOLO la estructura (bloques); los números los pone el sistema. Siempre empezá con un bloque kpi.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título corto del tablero.' },
      narrative: { type: 'string', description: '1-2 frases en español que expliquen qué muestra el tablero. NO inventes cifras.' },
      filters: {
        type: 'object',
        description: 'Alcance (WHERE) que recorta TODO el tablero. Usalo cuando la pregunta es sobre algo específico (un producto, una marca, una categoría, un canal). Vacío = toda la red.',
        properties: {
          sku: { type: 'string', description: 'Código/SKU exacto del producto si la pregunta lo menciona (ej. "79141").' },
          brand: { type: 'string', description: 'Nombre de la marca si la pregunta es de una marca específica.' },
          category: { type: 'string', description: 'Nombre de la categoría si la pregunta es de una categoría específica.' },
          channel: { type: 'string', description: 'Canal de venta si la pregunta lo acota (ej. "mostrador", "credito", "ruta").' },
        },
      },
      blocks: {
        type: 'array',
        description: 'Bloques del tablero, en orden. Empezá con un kpi.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['kpi', 'breakdown', 'series'] },
            title: { type: 'string' },
            metric: { type: 'string', enum: SV_METRICS },
            dimension: { type: 'string', enum: SV_DIMS, description: 'Solo para breakdown.' },
            viz: { type: 'string', enum: SV_VIZ, description: 'Solo para breakdown.' },
            range: { type: 'string', enum: ['30d', '90d', '12m'], description: 'Solo para series (histórico).' },
            limit: { type: 'integer', description: 'Top-N para breakdown (5-100).' },
            span: { type: 'integer', enum: [4, 6, 12], description: 'Ancho en grilla de 12; 12=fila completa, 6=media.' },
          },
          required: ['type'],
        },
      },
    },
    required: ['blocks'],
  },
};
const SV_SYSTEM = (today: string) =>
  `Sos Thot, el motor de ventas de Mega Dulces. Tu tarea: traducir una pregunta de ventas en un TABLERO, ` +
  `llamando SIEMPRE a la tool compose_sales_view. NUNCA escribas números ni SQL: solo elegís qué medir y cómo mostrarlo; ` +
  `el sistema rellena los datos reales. Hoy es ${today} (America/Mexico_City).\n\n` +
  `Catálogo (no inventes fuera de esto):\n` +
  `- métricas: ventas (monto $, DEFAULT), margen, unidades, tickets, ticket_promedio.\n` +
  `- dimensiones: canal, marca, categoria, sucursal, producto, cliente, tiempo.\n` +
  `- viz de breakdown: bars-table (default), bars, table.\n` +
  `- series (histórico) usa range: 30d, 90d, 12m.\n\n` +
  `Reglas:\n` +
  `1. Primer bloque SIEMPRE type:kpi (span 12).\n` +
  `2. "ventas" = monto por default (revenue-first); usá unidades solo si lo piden explícito.\n` +
  `3. margen aplica a canal/marca/categoria/producto. "márgenes por proveedor" → usá dimension:marca con metric:margen.\n` +
  `4. histórico / evolución / tendencia → un bloque series.\n` +
  `5. Si la pregunta es amplia ("centro de control", "todas mis ventas"), armá 3-5 bloques (kpi + varios breakdown/series, span 6).\n` +
  `6. Si es puntual ("ventas por canal"), kpi + 1 breakdown span 12.\n` +
  `7. Poné títulos claros en español en cada bloque.\n` +
  `8. ALCANCE: si la pregunta es sobre algo específico, llená filters — producto por código/SKU (ej. "ventas del producto 79141" → filters.sku:"79141"), marca (filters.brand), categoría (filters.category) o canal (filters.channel). ` +
  `Con filters.sku, el desglose útil es por canal o por tiempo (NO por producto). El filtro recorta TODO el tablero (KPIs incluidos), así que las cifras serán las de ese alcance, no las de la red.`;

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
    private readonly tk: TenantKnexService,
    private readonly examples: ThotExamplesService,
    private readonly anthropic: AnthropicService,
  ) {}

  /** Registra el intercambio en commercial.thot_chat_log (auditable). Best-effort. Devuelve el id (o null) para el feedback 👍/👎. */
  async logExchange(meta: { userId?: string; userName?: string; profile?: string; question: string }, res: ThotChatResult): Promise<string | null> {
    try {
      return await this.tk.run(async (trx) => {
        const [row] = await trx('commercial.thot_chat_log')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            user_id: meta.userId || null,
            user_name: meta.userName || null,
            question: meta.question.slice(0, 4000),
            answer: (res.answer || '').slice(0, 8000),
            tools_used: JSON.stringify(res.tools_used.map((t) => ({ name: t.name, input: t.input }))),
            iterations: res.iterations,
            source: res.source,
          })
          .returning('id');
        return row?.id || null;
      });
    } catch (e: any) {
      this.logger.warn(`No se pudo registrar thot_chat_log: ${e?.message || e}`);
      return null;
    }
  }

  /** Registra el voto 👍/👎 sobre una respuesta. */
  async recordFeedback(logId: string, vote: number): Promise<{ ok: boolean }> {
    const v = vote > 0 ? 1 : vote < 0 ? -1 : 0;
    await this.tk.run(async (trx) => {
      await trx('commercial.thot_chat_log').where({ id: logId }).update({ feedback: v });
    });
    return { ok: true };
  }

  /**
   * VG.2 — compone el tablero de "Ventas Generales" desde lenguaje natural. Una sola
   * llamada a Claude con la tool `compose_sales_view` FORZADA: el modelo devuelve el
   * `spec` (bloques) y nada más. Lo saneamos contra el catálogo antes de devolverlo →
   * el LLM no puede pedir una métrica/dimensión inexistente ni colar cifras. Los datos
   * los pone el frontend con endpoints deterministas (ADR-016/042).
   */
  async composeSalesView(input: { question: string; history?: ThotChatTurn[] }): Promise<{
    spec: { title?: string; narrative?: string; blocks: any[] };
    source: 'llm' | 'no_api_key' | 'error';
  }> {
    const q = (input.question || '').trim();
    if (!q) return { spec: this.fallbackSpec('Escribí una pregunta de ventas.'), source: 'error' };
    if (!this.apiKey) {
      return { spec: this.fallbackSpec('El asistente no está configurado (falta ANTHROPIC_API_KEY).'), source: 'no_api_key' };
    }
    const hist = (input.history || []).filter((t) => t && typeof t.content === 'string').slice(-6);
    const messages: any[] = [...hist.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: q }];
    try {
      const resp = await this.anthropic.messages(
        {
          model: CLAUDE_MODEL,
          maxTokens: 1200,
          system: SV_SYSTEM(mxToday()),
          tools: [SV_TOOL],
          toolChoice: { type: 'tool', name: 'compose_sales_view' },
          messages,
        },
        { timeoutMs: TIMEOUT_MS, cachePrefix: true },
      );
      const tu = (Array.isArray(resp.content) ? resp.content : []).find((b: any) => b.type === 'tool_use' && b.name === 'compose_sales_view');
      if (!tu?.input) return { spec: this.fallbackSpec('No pude interpretar la pregunta; te muestro las ventas por canal.'), source: 'llm' };
      return { spec: this.sanitizeSpec(tu.input), source: 'llm' };
    } catch (e: any) {
      this.logger.warn(`composeSalesView error: ${e?.message || e}`);
      return { spec: this.fallbackSpec('Tuve un problema; te muestro las ventas por canal.'), source: 'error' };
    }
  }

  /** Tablero por default cuando no hay LLM o falla: KPIs + ventas por canal. */
  private fallbackSpec(narrative: string): { title?: string; narrative?: string; blocks: any[] } {
    return {
      title: 'Ventas generales',
      narrative,
      blocks: [
        { type: 'kpi', span: 12 },
        { type: 'breakdown', metric: 'ventas', dimension: 'canal', viz: 'bars-table', span: 12, title: 'Ventas por canal' },
      ],
    };
  }

  /** Sanea el spec del LLM contra el catálogo: descarta bloques inválidos, coerciona métrica
   *  no soportada por la dimensión, asegura un kpi al inicio, y acota límites/span/textos. */
  private sanitizeSpec(input: any): { title?: string; narrative?: string; blocks: any[] } {
    const raw = Array.isArray(input?.blocks) ? input.blocks : [];
    const clampSpan = (s: any) => ([4, 6, 12].includes(Number(s)) ? Number(s) : 12);
    // Filtros de alcance del LLM (texto libre acotado). Se inyectan en CADA bloque para que
    // el renderer determinista los pase al endpoint semántico y recorte todo el tablero.
    const scope = this.sanitizeScope(input?.filters);
    const withScope = (blk: any) => (scope ? { ...blk, filters: scope } : blk);
    const blocks: any[] = [];
    let hasKpi = false;
    for (const b of raw) {
      const type = ['kpi', 'breakdown', 'series'].includes(b?.type) ? b.type : null;
      if (!type) continue;
      if (type === 'kpi') { if (!hasKpi) { blocks.push(withScope({ type: 'kpi', span: 12 })); hasKpi = true; } continue; }
      let metric = SV_METRICS.includes(b?.metric) ? b.metric : 'ventas';
      const title = typeof b?.title === 'string' ? b.title.slice(0, 80) : undefined;
      if (type === 'breakdown') {
        // Con filtro de un producto (sku), agrupar por producto no aporta → forzar canal.
        let dimension = SV_DIMS.includes(b?.dimension) && b.dimension !== 'tiempo' ? b.dimension : 'canal';
        if (scope?.sku && dimension === 'producto') dimension = 'canal';
        if (!SV_DIM_METRICS[dimension].includes(metric)) metric = 'ventas';
        const viz = SV_VIZ.includes(b?.viz) ? b.viz : 'bars-table';
        const limit = Math.min(100, Math.max(5, Number(b?.limit) || 20));
        blocks.push(withScope({ type: 'breakdown', metric, dimension, viz, limit, span: clampSpan(b?.span), title }));
      } else {
        if (!['ventas', 'unidades', 'tickets'].includes(metric)) metric = 'ventas';
        const range = ['30d', '90d', '12m'].includes(b?.range) ? b.range : '30d';
        blocks.push(withScope({ type: 'series', metric, range, span: clampSpan(b?.span), title }));
      }
    }
    if (!blocks.length) return this.fallbackSpec('');
    if (!hasKpi) blocks.unshift(withScope({ type: 'kpi', span: 12 }));
    return {
      title: typeof input?.title === 'string' ? input.title.slice(0, 120) : undefined,
      narrative: typeof input?.narrative === 'string' ? input.narrative.slice(0, 600) : undefined,
      blocks: blocks.slice(0, 8),
    };
  }

  /** Sanea los filtros de alcance del LLM: solo strings acotados; null si no hay ninguno. */
  private sanitizeScope(f: any): { sku?: string; brand?: string; category?: string; channel?: string } | null {
    if (!f || typeof f !== 'object') return null;
    const clean = (v: any) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);
    const out: any = {};
    const sku = clean(f.sku), brand = clean(f.brand), category = clean(f.category), channel = clean(f.channel);
    if (sku) out.sku = sku;
    if (brand) out.brand = brand;
    if (category) out.category = category;
    if (channel) out.channel = channel;
    return Object.keys(out).length ? out : null;
  }

  /**
   * Corre el loop con el PROVIDER y SCOPE de la audiencia. El provider define qué
   * tools existen y cómo se ejecutan respetando el scope (admin/portal/vendor).
   */
  async ask(
    provider: ThotToolProvider,
    scope: ThotScope,
    input: {
      history: ThotChatTurn[];
      think?: boolean;
      deepSearch?: boolean;
      image?: { mediaType: string; data: string };
    },
  ): Promise<ThotChatResult> {
    const think = !!input.think;
    const deep = !!input.deepSearch;
    const maxIterations = deep ? DEEP_ITERATIONS : MAX_ITERATIONS;
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

    let system = provider.systemPrompt(scope, { today: mxToday() });
    if (deep) system += DEEP_DIRECTIVE;
    // TC.4a — few-shot: ejemplos verificados parecidos a la pregunta (semilla + curados).
    const lastQ = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const fewShot = await this.examples.promptFragment(scope.profile, lastQ).catch(() => '');
    if (fewShot) system += `\n\n${fewShot}`;
    // Memoria de Thot (admin): hechos que el usuario le enseñó (thot_remember), inyectados
    // al system para que los "recuerde" entre sesiones. Best-effort (tabla puede no existir).
    if (scope.profile === 'admin') {
      const memory = await this.recallNotes().catch(() => '');
      if (memory) system += `\n\n${memory}`;
    }
    // Auto-routing de modelo (FIQ.1): Think (explícito) o pregunta compleja → Sonnet 5.
    const useSonnet = think || this.isComplex(lastQ, history.length);
    const toolDefs = provider.definitions(scope);
    // Estado del diálogo en formato Anthropic (content puede ser string o blocks).
    const messages: any[] = history.map((t) => ({ role: t.role, content: t.content }));

    // Adjunto de imagen (Claude vision): se inyecta como bloque en el último turno
    // del usuario, junto al texto. El modelo puede "leer" la foto (reporte, etiqueta…).
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

    const traces: ThotToolTrace[] = [];

    let iterations = 0;
    while (iterations < maxIterations) {
      iterations++;
      let resp: any;
      try {
        resp = await this.callClaude(system, messages, toolDefs, useSonnet, think);
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
        const result = await provider.execute(tu.name, tu.input, scope);
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

  /**
   * Memoria de Thot (admin): trae los hechos que el usuario le enseñó (thot_remember)
   * para inyectarlos al system y que Thot los "recuerde" entre sesiones. Tope de chars
   * para no inflar el prompt. Best-effort: si la tabla aún no existe (migración pendiente
   * en prod) el caller ignora el error.
   */
  private async recallNotes(): Promise<string> {
    const rows = await this.tk.run(async (trx) =>
      trx('commercial.thot_notes')
        .where('tenant_id', trx.raw('public.current_tenant_id()'))
        .orderBy('pinned', 'desc')
        .orderBy('updated_at', 'desc')
        .limit(40)
        .select('title', 'body'),
    );
    if (!rows.length) return '';
    let out = 'MEMORIA (hechos que te enseñaron en conversaciones anteriores; tenelos en cuenta y no los contradigas):\n';
    for (const r of rows as any[]) {
      const line = `- ${r.title}: ${r.body}\n`;
      if (out.length + line.length > 4000) break;
      out += line;
    }
    return out.trim();
  }

  /**
   * FIQ.1 (port de WhatsApp) — auto-routing de modelo por complejidad. Heurístico y
   * barato (sin llamada extra): mensajes largos, hilo ya extenso, o señales de
   * análisis/comparación/estrategia → Sonnet 5; el resto, Haiku. El motor sigue
   * poniendo los números (ADR-016) sin importar el modelo.
   */
  private isComplex(text: string, historyLen: number): boolean {
    const t = (text || '').toLowerCase();
    return (
      t.length > 160 ||
      historyLen >= 8 ||
      /(analiz|compar|por qu|porqu|explica|diagn[oó]st|tendenc|proyect|estrateg|recomien|\bplan\b|cruza|relacion|correlacion|evoluci[oó]n|escenario|qu[eé] pasa si|optimiz|prioriz|deber[ií]a|an[aá]lisis|desglos)/i.test(t)
    );
  }

  private callClaude(system: string, messages: any[], tools: any[], useSonnet = false, think = false): Promise<any> {
    // Transporte compartido (AnthropicService) + prompt caching del prefijo tools+system:
    // el system y las defs se reenvían en cada iteración del loop ReAct → tras el 1er
    // request se cobran ~0.1x. El bloque `thinking` que devuelve Claude se re-emite tal
    // cual al apilar el turno del assistant (con `content` completo). Modelo/thinking los
    // sigue decidiendo Thot (parity ADR-016).
    return this.anthropic.messages(
      {
        model: useSonnet ? CLAUDE_THINK_MODEL : CLAUDE_MODEL,
        maxTokens: think ? THINK_MAX_TOKENS : useSonnet ? SONNET_MAX_TOKENS : MAX_TOKENS,
        system,
        tools,
        messages,
        thinking: think ? { type: 'adaptive' } : undefined,
        effort: think ? 'medium' : undefined,
      },
      { timeoutMs: think ? THINK_TIMEOUT_MS : TIMEOUT_MS, cachePrefix: true },
    );
  }
}
