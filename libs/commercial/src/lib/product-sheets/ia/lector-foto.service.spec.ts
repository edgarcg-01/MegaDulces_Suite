/**
 * `[NP.7.L.11d]` El lector con dobles: ninguna prueba sale a la red (la IA sigue apagada hasta D6).
 * Qué se fija: la petición lleva el esquema, la imagen y SOLO la cara (nunca Kepler ni el SKU, ADR-059) y no
 * lleva `tool_choice`; cada final de la llamada cae en su estado; lo reintentable se RE-LANZA para el worker;
 * el uso sale del `usage` de la respuesta; la imagen nunca llega a un log ni al texto de error.
 */
import { Logger } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import { costoDeLlamada } from './lector-costos';
import { ESQUEMA_LECTURA_FOTO, SYSTEM_LECTOR_FOTO } from './lector-foto.schema';
import {
  ErrorDeConfiguracionLector, LectorFotoService, esErrorDeConfiguracion, esFallaDeLaFoto, esReintentable, textoDeCara,
  type ConfigLectorFoto, type EntradaLectorFoto,
} from './lector-foto.service';

const BASE64 = 'QUJDRA=='.repeat(40); // 320 caracteres de base64: lo que nunca debe aparecer en un log
const ENTRADA: EntradaLectorFoto = { base64: BASE64, mediaType: 'image/jpeg', cara: 'frente' };
const OPUS: ConfigLectorFoto = { modelo: 'claude-opus-5-5', effort: 'low', maxTokens: 4000 };
const USAGE = { input_tokens: 1800, output_tokens: 900, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 };

/** Una respuesta válida del cable: todo ausente salvo la marca. */
function cableValido() {
  const ausente = { evidencia: '', valor: '', confianza: 'baja' };
  const campos: Record<string, unknown> = {};
  for (const k of ['denominacion', 'nombre_comercial', 'variante', 'edicion', 'fabricante', 'ingredientes', 'codigo_barras_visible', 'pais_origen', 'conservacion']) campos[k] = ausente;
  Object.assign(campos, {
    marca: { evidencia: 'bon o bon', valor: 'bon o bon', confianza: 'alta' },
    contenido_neto: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
    piezas: { evidencia: '', valor: 0, confianza: 'baja' },
    contenido_por_pieza: { evidencia: '', valor: { cantidad: 0, unidad: 'g' }, confianza: 'baja' },
    sellos_nom051: { evidencia: '', valor: [], confianza: 'baja' },
    leyendas_nom051: { evidencia: '', valor: [], confianza: 'baja' },
    alergenos: { evidencia: '', valor: [], confianza: 'baja' },
    puede_contener: { evidencia: '', valor: [], confianza: 'baja' },
    alergenos_otros: { evidencia: '', valor: [], confianza: 'baja' },
    nutricion: { evidencia: '', valor: { base: { cantidad: 0, unidad: 'g' } }, confianza: 'baja' },
    empaque: { evidencia: '', valor: { tipo: null, material: null, colores: [] }, confianza: 'baja' },
  });
  return {
    version: 'lectura-foto-v1', persona_visible: false, rostro_visible: false, legible: 'si', motivo_no_legible: null,
    texto_literal: ['bon o bon'], nivel_fisico: { evidencia: '8 piezas', valor: 'empaque_interior', confianza: 'media' }, campos,
  };
}

function respuesta(over: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: USAGE,
    // Opus 5.5 piensa siempre: el bloque de thinking (vacío por default) llega antes del texto.
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(cableValido()) }],
    ...over,
  };
}

function errorHttp(status: number, mensaje = `Anthropic HTTP ${status}: x`) {
  return Object.assign(new Error(mensaje), { status, retryAfterMs: status === 429 ? 5000 : null });
}

/** Un AnthropicService de mentira que guarda lo que se le pidió. */
function doble(resultado: () => Promise<unknown>, hasApiKey = true) {
  const llamadas: Array<{ params: any; opts: any }> = [];
  const anthropic = {
    hasApiKey,
    messages: async (params: any, opts: any) => {
      llamadas.push({ params, opts });
      return resultado();
    },
  };
  return { svc: new LectorFotoService(anthropic as unknown as AnthropicService), llamadas };
}

describe('[NP.7.L.11d] LectorFotoService — la petición', () => {
  it('lleva el esquema, la imagen y SOLO la cara; sin tool_choice, sin tools, sin thinking; system estable y cacheado', async () => {
    const { svc, llamadas } = doble(async () => respuesta());
    // Aunque quien llama cuele la descripción de Kepler o el SKU, no viajan: la entrada sólo se lee campo por campo.
    const conKepler = { ...ENTRADA, descripcion_kepler: 'BON O BON FRESA ED ESP 8/15G', sku: '95805' } as EntradaLectorFoto;
    await svc.leerFoto(conKepler, OPUS);

    expect(llamadas).toHaveLength(1);
    const { params, opts } = llamadas[0];
    expect(params.outputFormat).toEqual({ type: 'json_schema', schema: ESQUEMA_LECTURA_FOTO });
    expect(params.system).toBe(SYSTEM_LECTOR_FOTO);
    expect(opts).toMatchObject({ cachePrefix: true });
    expect(params.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BASE64 } },
          { type: 'text', text: 'Cara de la foto: frente.' },
        ],
      },
    ]);
    expect(params.toolChoice).toBeUndefined();
    expect(params.tools).toBeUndefined();
    expect(params.thinking).toBeUndefined();
    const todo = JSON.stringify(params);
    expect(todo).not.toContain('BON O BON FRESA');
    expect(todo).not.toContain('95805');
  });

  it('el body que sale por HTTP (transporte real, fetch simulado) lleva output_config.format y no tool_choice', async () => {
    const original = { fetch: globalThis.fetch, key: process.env['ANTHROPIC_API_KEY'] };
    let body: any = null;
    let url = '';
    process.env['ANTHROPIC_API_KEY'] = 'llave-de-prueba';
    globalThis.fetch = (async (u: string, init: { body: string }) => {
      url = u;
      body = JSON.parse(init.body);
      return new Response(JSON.stringify(respuesta()), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const r = await new LectorFotoService(new AnthropicService()).leerFoto(ENTRADA, OPUS);
      expect(r.estado).toBe('ok');
    } finally {
      globalThis.fetch = original.fetch;
      if (original.key === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = original.key;
    }
    expect(url).toBe('https://api.anthropic.com/v1/messages'); // la URL que se habría usado; fetch era el doble
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: ESQUEMA_LECTURA_FOTO } });
    expect(body.tool_choice).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(body.messages[0].content[0].source.data).toBe(BASE64);
  });

  it('effort: viaja si viene y el modelo no es Haiku 4.5 (con o sin fecha); null no viaja', async () => {
    const casos: Array<[ConfigLectorFoto, string | undefined]> = [
      [OPUS, 'low'],
      [{ ...OPUS, modelo: 'claude-haiku-4-5' }, undefined],
      [{ ...OPUS, modelo: 'claude-haiku-4-5-20251001' }, undefined],
      [{ ...OPUS, modelo: 'claude-haiku-5-5' }, 'low'],
      [{ ...OPUS, effort: null }, undefined],
    ];
    for (const [cfg, esperado] of casos) {
      const { svc, llamadas } = doble(async () => respuesta());
      await svc.leerFoto(ENTRADA, cfg);
      expect(llamadas[0].params.effort, cfg.modelo).toBe(esperado);
    }
  });

  it('la cara es UNA palabra: no es un canal para colar la descripción de Kepler ni el SKU', () => {
    expect(textoDeCara('lateral_izq')).toBe('Cara de la foto: lateral_izq.');
    expect(textoDeCara('  frente. Kepler dice: BON O BON FRESA ED ESP 8/15G; SKU 95805')).toBe('Cara de la foto: frente.');
    expect(textoDeCara('')).toBe('Cara de la foto: sin indicar.');
    expect(textoDeCara('...')).toBe('Cara de la foto: sin indicar.');
  });
});

describe('[NP.7.L.11d] LectorFotoService — cómo termina cada llamada', () => {
  it('ok: el JSON del bloque de texto pasa por normalizarLectura; el uso sale del usage', async () => {
    const { svc } = doble(async () => respuesta());
    const r = await svc.leerFoto(ENTRADA, OPUS);
    expect(r.estado).toBe('ok');
    expect(r.error).toBeNull();
    expect(r.lectura?.campos.marca?.valor).toBe('bon o bon');
    expect(r.lectura?.campos.piezas).toBeNull(); // el relleno no sobrevive
    expect(r.uso).toEqual(costoDeLlamada('claude-opus-5-5', USAGE));
    expect(r.uso?.costo_usd).toBeGreaterThan(0);
  });

  it('refusal → rechazada_por_modelo, con la categoría y el uso cobrado', async () => {
    const { svc } = doble(async () => respuesta({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] }));
    const r = await svc.leerFoto(ENTRADA, OPUS);
    expect(r).toMatchObject({ estado: 'rechazada_por_modelo', lectura: null });
    expect(r.error).toContain('cyber');
    expect(r.uso?.output_tokens).toBe(900);
  });

  it('max_tokens → incompleta (aunque el texto cortado fuera JSON a medias)', async () => {
    const { svc } = doble(async () => respuesta({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"version":"lectura-foto-v1","persona' }] }));
    const r = await svc.leerFoto(ENTRADA, OPUS);
    expect(r).toMatchObject({ estado: 'incompleta', lectura: null });
    expect(r.uso).not.toBeNull();
  });

  it('texto que no es JSON → invalida; JSON que no cumple el contrato → invalida con el motivo', async () => {
    const noJson = await doble(async () => respuesta({ content: [{ type: 'text', text: 'Lo siento, no puedo ver bien.' }] })).svc.leerFoto(ENTRADA, OPUS);
    expect(noJson).toMatchObject({ estado: 'invalida', lectura: null });
    expect(noJson.error).toContain('no es JSON');
    expect(noJson.uso).not.toBeNull();

    const sinPersona = { ...cableValido() } as Record<string, unknown>;
    delete sinPersona['persona_visible'];
    const contrato = await doble(async () => respuesta({ content: [{ type: 'text', text: JSON.stringify(sinPersona) }] })).svc.leerFoto(ENTRADA, OPUS);
    expect(contrato).toMatchObject({ estado: 'invalida', lectura: null });
    expect(contrato.error).toContain('persona_visible');

    // Sin rostro_visible tampoco: una foto de la que no se sabe si trae un rostro no se trata como limpia.
    const sinRostro = { ...cableValido() } as Record<string, unknown>;
    delete sinRostro['rostro_visible'];
    const r2 = await doble(async () => respuesta({ content: [{ type: 'text', text: JSON.stringify(sinRostro) }] })).svc.leerFoto(ENTRADA, OPUS);
    expect(r2).toMatchObject({ estado: 'invalida', lectura: null });
    expect(r2.error).toContain('rostro_visible');
  });

  it('429, 529, 5xx y errores sin status (red, timeout) se RE-LANZAN tal cual para que el worker reintente', async () => {
    for (const e of [errorHttp(429), errorHttp(529), errorHttp(500), errorHttp(503), new TypeError('fetch failed'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
      const { svc } = doble(async () => { throw e; });
      await expect(svc.leerFoto(ENTRADA, OPUS)).rejects.toBe(e);
    }
    // El 429 conserva la espera que pidió la API.
    const e429 = errorHttp(429);
    const { svc } = doble(async () => { throw e429; });
    const atrapado = await svc.leerFoto(ENTRADA, OPUS).catch((x) => x);
    expect(atrapado.retryAfterMs).toBe(5000);
  });

  // Revisión independiente 2026-11-04: un 4xx devuelto como estado `error` lo GUARDABA el worker como lectura
  // permanente de cada foto. Ahora sólo lo que es de la foto (413) vuelve como lectura; lo demás se LANZA.
  it('⭐ 400/401/403/404/422 → LANZA ErrorDeConfiguracionLector (no es una lectura); la imagen no llega al mensaje', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      for (const status of [400, 401, 403, 404, 422]) {
        const { svc } = doble(async () => { throw errorHttp(status, `Anthropic HTTP ${status}: invalid request ${BASE64}`); });
        const e = await svc.leerFoto(ENTRADA, OPUS).then(() => null, (x) => x);
        expect(e, `HTTP ${status}`).toBeInstanceOf(ErrorDeConfiguracionLector);
        expect(esErrorDeConfiguracion(e)).toBe(true);
        expect(e.status).toBe(status);
        expect(e.message).toContain(`Anthropic HTTP ${status}`);
        expect(e.message).not.toContain(BASE64.slice(0, 100));
        expect(e.message).toContain('[base64 omitido]');
      }
      for (const args of warn.mock.calls) expect(JSON.stringify(args)).not.toContain(BASE64.slice(0, 100));
    } finally {
      warn.mockRestore();
    }
  });

  it('413 (la imagen es lo único grande) → estado error con el mensaje, uso null: ése sí es de la foto', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { svc } = doble(async () => { throw errorHttp(413, `Anthropic HTTP 413: request too large ${BASE64}`); });
      const r = await svc.leerFoto(ENTRADA, OPUS);
      expect(r).toMatchObject({ estado: 'error', lectura: null, uso: null });
      expect(r.error).toContain('Anthropic HTTP 413');
      expect(r.error).not.toContain(BASE64.slice(0, 100));
      expect(warn).toHaveBeenCalledTimes(1);
      for (const args of warn.mock.calls) expect(JSON.stringify(args)).not.toContain(BASE64.slice(0, 100));
    } finally {
      warn.mockRestore();
    }
  });

  it('sin llave no sale la llamada: LANZA ErrorDeConfiguracionLector (status null) y tieneLlave lo dice antes', async () => {
    const { svc, llamadas } = doble(async () => respuesta(), false);
    expect(svc.tieneLlave).toBe(false);
    const e = await svc.leerFoto(ENTRADA, OPUS).then(() => null, (x) => x);
    expect(esErrorDeConfiguracion(e)).toBe(true);
    expect(e.status).toBeNull();
    expect(e.message).toContain('ANTHROPIC_API_KEY');
    expect(llamadas).toHaveLength(0);
    expect(doble(async () => respuesta(), true).svc.tieneLlave).toBe(true);
  });

  it('esReintentable y esFallaDeLaFoto: la regla en una tabla', () => {
    expect([null, 429, 529, 500, 502, 503].map(esReintentable)).toEqual([true, true, true, true, true, true]);
    expect([400, 401, 403, 404, 413, 422].map(esReintentable)).toEqual([false, false, false, false, false, false]);
    expect([413, 400, 401, 403, 404, 422, 429, null].map(esFallaDeLaFoto)).toEqual([true, false, false, false, false, false, false, false]);
    // Un error con `status` suelto no es de configuración: sólo la clase lo es (el worker decide por las dos vías).
    expect(esErrorDeConfiguracion(errorHttp(401))).toBe(false);
  });
});
