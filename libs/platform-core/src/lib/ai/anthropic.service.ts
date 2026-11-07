import { Injectable, Logger } from '@nestjs/common';

/**
 * Cliente de transporte compartido para la Messages API de Anthropic.
 *
 * Reemplaza las ~10 copias de `callClaude` esparcidas por los dominios
 * (thot-chat, maat-chat, horus-chat, commerce-agent, portal-ai-order,
 * llm-extractor, supervisor-agent, photo-audit, maat-discovery, whatsapp):
 * un solo lugar para headers, timeout/AbortController, manejo de error y parse.
 *
 * NO decide modelo ni `thinking`: eso lo pasa el dominio (cada agente conserva
 * sus env vars y su lógica worker/think). Devuelve el JSON CRUDO de la respuesta
 * (content/stop_reason/usage) — el caller lo lee exactamente igual que antes.
 *
 * Es infra leaf (cero deps de dominio), igual que EmbeddingsService: cada módulo
 * que lo necesite lo agrega a su `providers`.
 */

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface AnthropicMessagesParams {
  model: string;
  maxTokens: number;
  messages: any[];
  /** string (se envuelve en bloque si cachePrefix) o bloques ya armados. */
  system?: string | any[];
  tools?: any[];
  /** { type:'enabled', budget_tokens } (modelos ≤4.6) o { type:'adaptive' } (Sonnet 5 / Opus 4.7+). */
  thinking?: any;
  /** output_config.effort ('low'|'medium'|'high'|'xhigh'|'max'). Solo modelos que lo soportan — NO Haiku 4.5 (da 400). */
  effort?: string;
  /** tool_choice passthrough (forced tool en single-shot). */
  toolChoice?: any;
  /**
   * `[NP.7.L.11d]` Structured outputs: viaja como `output_config.format` (junto a `effort` si viene).
   * La respuesta llega como JSON en el bloque de texto, validado por la API contra `schema`.
   * Existe porque los modelos 5.5 rechazan `tool_choice` forzado (400): para obligar un JSON ya no
   * sirve el truco de «una herramienta forzada». Sin este campo, el body es idéntico al de antes.
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/**
 * `[NP.7.L.11d]` Forma del error que lanza `messages()` cuando la respuesta no es 2xx: el MISMO `Error`
 * con el mismo mensaje de siempre, más `status` y `retryAfterMs`, para que un worker distinga lo que se
 * reintenta (429/529/5xx) de lo que no (400) y respete la espera que pide la API sin leer el texto.
 * Es un tipo, no una clase: los ~10 consumidores que sólo leen `message` no cambian.
 */
export type ErrorHttpAnthropic = Error & { status: number; retryAfterMs: number | null };

export interface AnthropicCallOptions {
  timeoutMs?: number;
  /**
   * Cachea el prefijo estable tools+system (cache_control ephemeral). Transparente
   * a la corrección — solo baja costo/latencia: en un loop ReAct el system + defs de
   * tools se reenvían en cada iteración; con esto se cobran ~0.1x tras el 1er request.
   * (Si el prefijo queda bajo el mínimo cacheable del modelo, no cachea y no falla.)
   */
  cachePrefix?: boolean;
}

@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY || '';

  /** Para que el dominio conserve su degradación limpia sin key. */
  get hasApiKey(): boolean {
    return !!this.apiKey;
  }

  async messages(params: AnthropicMessagesParams, opts: AnthropicCallOptions = {}): Promise<any> {
    if (!this.apiKey) throw new Error('AnthropicService: falta ANTHROPIC_API_KEY');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const body: any = {
        model: params.model,
        max_tokens: params.maxTokens,
        messages: params.messages,
      };
      const system = opts.cachePrefix ? this.withPrefixCache(params.system) : params.system;
      if (system !== undefined) body.system = system;
      if (params.tools) body.tools = params.tools;
      if (params.thinking) body.thinking = params.thinking;
      // `output_config` sólo aparece si lleva algo: sin `outputFormat` queda `{ effort }` como antes.
      const outputConfig: Record<string, unknown> = {};
      if (params.effort) outputConfig['effort'] = params.effort;
      if (params.outputFormat) outputConfig['format'] = params.outputFormat;
      if (Object.keys(outputConfig).length) body.output_config = outputConfig;
      if (params.toolChoice) body.tool_choice = params.toolChoice;

      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`Anthropic HTTP ${res.status}: ${txt.slice(0, 200)}`) as ErrorHttpAnthropic;
        err.status = res.status;
        err.retryAfterMs = esperaPedida(res.headers.get('retry-after'));
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pone cache_control ephemeral en el ÚLTIMO bloque de system. Como el orden de
   * render es tools → system → messages, ese único breakpoint cachea tools+system
   * juntos. No muta el `system` original.
   */
  private withPrefixCache(system: string | any[] | undefined): string | any[] | undefined {
    if (typeof system === 'string' && system.trim()) {
      return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (Array.isArray(system) && system.length) {
      const out = system.slice();
      out[out.length - 1] = { ...out[out.length - 1], cache_control: { type: 'ephemeral' } };
      return out;
    }
    return system;
  }
}

/**
 * `retry-after` en segundos → milisegundos. La API de Anthropic lo manda en segundos; cualquier otra
 * forma (fecha HTTP, texto, negativo) queda `null`: el worker usa su propia espera en vez de adivinar.
 */
function esperaPedida(cabecera: string | null): number | null {
  if (cabecera === null || !/^\s*\d+(\.\d+)?\s*$/.test(cabecera)) return null;
  return Math.round(Number(cabecera) * 1000);
}
