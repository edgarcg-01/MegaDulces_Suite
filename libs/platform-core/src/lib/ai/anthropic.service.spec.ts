/**
 * `[NP.7.L.11d]` El transporte compartido gana `output_config.format` y un error con `status` y `retryAfterMs`
 * SIN cambiar nada para los ~10 servicios que ya lo usan: sin `outputFormat` el body es byte a byte el de
 * antes, y el mensaje de error es el mismo texto. Todo con `fetch` simulado: ninguna llamada sale a la red.
 */
import { AnthropicService, type ErrorHttpAnthropic } from './anthropic.service';

describe('[NP.7.L.11d] AnthropicService', () => {
  const original = { fetch: globalThis.fetch, key: process.env['ANTHROPIC_API_KEY'] };
  let cuerpoEnviado = '';
  let respuesta: () => Response;

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'llave-de-prueba';
    cuerpoEnviado = '';
    respuesta = () => new Response(JSON.stringify({ content: [], stop_reason: 'end_turn', usage: {} }), { status: 200 });
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      cuerpoEnviado = init.body;
      return respuesta();
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original.fetch;
    if (original.key === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = original.key;
  });

  const ESQUEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };

  it('outputFormat viaja como output_config.format, junto a effort si viene', async () => {
    const svc = new AnthropicService();
    await svc.messages({ model: 'm', maxTokens: 10, messages: [], outputFormat: { type: 'json_schema', schema: ESQUEMA } });
    expect(JSON.parse(cuerpoEnviado).output_config).toEqual({ format: { type: 'json_schema', schema: ESQUEMA } });

    await svc.messages({ model: 'm', maxTokens: 10, messages: [], effort: 'low', outputFormat: { type: 'json_schema', schema: ESQUEMA } });
    expect(JSON.parse(cuerpoEnviado).output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: ESQUEMA } });
  });

  it('sin outputFormat el body es IDÉNTICO al de antes (mismas llaves, mismo orden)', async () => {
    const svc = new AnthropicService();
    const params = {
      model: 'claude-haiku-4-5-20251001', maxTokens: 500, messages: [{ role: 'user', content: 'hola' }],
      system: 'sistema', tools: [{ name: 't', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' }, effort: 'medium', toolChoice: { type: 'auto' },
    };
    await svc.messages(params, { cachePrefix: true });
    // El body que armaba la versión anterior, literal: es el contrato con los consumidores de hoy.
    const antes = JSON.stringify({
      model: params.model, max_tokens: params.maxTokens, messages: params.messages,
      system: [{ type: 'text', text: 'sistema', cache_control: { type: 'ephemeral' } }],
      tools: params.tools, thinking: params.thinking, output_config: { effort: 'medium' }, tool_choice: params.toolChoice,
    });
    expect(cuerpoEnviado).toBe(antes);

    // Y sin effort ni outputFormat, no aparece output_config.
    await svc.messages({ model: 'm', maxTokens: 10, messages: [] });
    expect(cuerpoEnviado).toBe(JSON.stringify({ model: 'm', max_tokens: 10, messages: [] }));
  });

  it('un 429 lanza el MISMO mensaje, con status y retryAfterMs (de retry-after en segundos)', async () => {
    respuesta = () => new Response('{"type":"error","error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': '7' } });
    const err = (await new AnthropicService().messages({ model: 'm', maxTokens: 10, messages: [] }).catch((e) => e)) as ErrorHttpAnthropic;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Anthropic HTTP 429: {"type":"error","error":{"type":"rate_limit_error"}}');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
  });

  it('sin retry-after (o con una forma que no es segundos) retryAfterMs es null, no cero', async () => {
    respuesta = () => new Response('caido', { status: 529 });
    const sin = (await new AnthropicService().messages({ model: 'm', maxTokens: 10, messages: [] }).catch((e) => e)) as ErrorHttpAnthropic;
    expect(sin.status).toBe(529);
    expect(sin.retryAfterMs).toBeNull();

    respuesta = () => new Response('x', { status: 503, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    const fecha = (await new AnthropicService().messages({ model: 'm', maxTokens: 10, messages: [] }).catch((e) => e)) as ErrorHttpAnthropic;
    expect(fecha.status).toBe(503);
    expect(fecha.retryAfterMs).toBeNull();
  });
});
