/**
 * `[RH.3.3.1]` El servicio compartido de transcripción gana nombre de archivo, pista y temperatura SIN cambiar lo que
 * ya mandaba a sus consumidores de antes (el dictado de caducidades): sin opciones, el formulario es el mismo.
 */
import { SpeechToTextService } from './speech-to-text.service';

describe('[RH.3.3.1] SpeechToTextService', () => {
  const original = { fetch: globalThis.fetch, key: process.env['GROQ_API_KEY'] };
  let enviado: FormData | null = null;
  beforeEach(() => {
    process.env['GROQ_API_KEY'] = 'llave-de-prueba';
    enviado = null;
    globalThis.fetch = (async (_url: string, init: { body: FormData }) => {
      enviado = init.body;
      return new Response(JSON.stringify({ text: ' hola ' }), { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original.fetch;
    if (original.key === undefined) delete process.env['GROQ_API_KEY']; else process.env['GROQ_API_KEY'] = original.key;
  });

  it('sin opciones: el mismo formulario de antes (audio.webm, sin pista ni temperatura)', async () => {
    const r = await new SpeechToTextService().transcribe(Buffer.from('x').toString('base64'));
    expect(r).toEqual({ text: 'hola' });
    expect((enviado?.get('file') as File).name).toBe('audio.webm');
    expect(enviado?.has('prompt')).toBe(false);
    expect(enviado?.has('temperature')).toBe(false);
    expect(enviado?.get('language')).toBe('es');
  });

  it('con opciones: el nombre lleva el formato, y viajan la pista y la temperatura (también el 0)', async () => {
    await new SpeechToTextService().transcribe(Buffer.from('x').toString('base64'), 'audio/ogg', {
      filename: 'nota.ogg', prompt: 'anaquelista, CURP', temperature: 0,
    });
    expect((enviado?.get('file') as File).name).toBe('nota.ogg');
    expect(enviado?.get('prompt')).toBe('anaquelista, CURP');
    expect(enviado?.get('temperature')).toBe('0');
  });

  it('sin llave no llama y lo dice', async () => {
    delete process.env['GROQ_API_KEY'];
    expect(await new SpeechToTextService().transcribe('eA==')).toEqual({ text: '', error: 'no_key' });
    expect(enviado).toBeNull();
  });
});
