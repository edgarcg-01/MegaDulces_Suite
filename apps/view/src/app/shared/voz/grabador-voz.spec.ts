import { vi } from 'vitest';
import { GrabadorVoz, elegirMimeAudio, mensajeErrorMicrofono, mensajeErrorTranscripcion, mmss, unirDictado, type EntornoGrabacion, type GrabadorLike } from './grabador-voz';

/** Un `MediaRecorder` de mentira: entrega un trozo al arrancar y avisa `onstop` al detenerse. */
function falso(opts: { vacio?: boolean } = {}) {
  const pistas = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const g: GrabadorLike & { stops: number } = {
    state: 'inactive', mimeType: 'audio/webm', ondataavailable: null, onstop: null, stops: 0,
    start() { this.state = 'recording'; if (!opts.vacio) this.ondataavailable?.({ data: new Blob(['hola'], { type: 'audio/webm' }) }); },
    stop() { this.stops++; this.state = 'inactive'; this.onstop?.(); },
  };
  const entorno: EntornoGrabacion = { pedirMicrofono: async () => ({ getTracks: () => pistas }), crearGrabador: () => g, soportaMime: () => true };
  return { g, pistas, entorno };
}

describe('[MS.DICTADO] utilidades de voz', () => {
  it('elige el primer tipo soportado, en orden de preferencia', () => {
    expect(elegirMimeAudio(() => true)).toBe('audio/webm;codecs=opus');
    expect(elegirMimeAudio((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(elegirMimeAudio(() => false)).toBe('');
  });

  it('unirDictado: no pega palabras, no duplica espacios y vacío no cambia nada', () => {
    expect(unirDictado('', ' hola ')).toBe('hola');
    expect(unirDictado('No abre', 'el sistema')).toBe('No abre el sistema');
    expect(unirDictado('No abre ', 'el sistema')).toBe('No abre el sistema');
    expect(unirDictado('Línea uno\n', 'línea dos')).toBe('Línea uno\nlínea dos');
    expect(unirDictado('texto', '   ')).toBe('texto');
  });

  it('mmss', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(75)).toBe('1:15');
  });

  it('los mensajes de error distinguen permiso, sin micrófono y lo demás', () => {
    expect(mensajeErrorMicrofono({ name: 'NotAllowedError' })).toMatch(/permiso/i);
    expect(mensajeErrorMicrofono({ name: 'NotFoundError' })).toMatch(/micrófono conectado/i);
    expect(mensajeErrorMicrofono(new Error('x'))).toMatch(/No se pudo usar/i);
    expect(mensajeErrorTranscripcion('no_key')).toMatch(/no está configurado/i);
    expect(mensajeErrorTranscripcion('too_big')).toMatch(/demasiado larga/i);
    expect(mensajeErrorTranscripcion('stt_failed')).toMatch(/No se pudo transcribir/i);
    expect(mensajeErrorTranscripcion(undefined)).toMatch(/No se pudo transcribir/i);
  });
});

describe('[MS.DICTADO] GrabadorVoz', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('graba, entrega el audio y SUELTA el micrófono', async () => {
    const { pistas, entorno } = falso();
    const gr = new GrabadorVoz(entorno, { alCorrer: () => undefined, alLlegarAlLimite: () => undefined });
    await gr.iniciar();
    expect(gr.grabando).toBe(true);
    const r = await gr.detener();
    expect(r?.blob.size).toBeGreaterThan(0);
    expect(r?.mime).toBe('audio/webm');
    expect(pistas.every((p) => p.stop.mock.calls.length === 1)).toBe(true);
    expect(gr.grabando).toBe(false);
  });

  it('cuenta los segundos y avisa al llegar al tope (no se detiene solo: lo decide quien lo usa)', async () => {
    const { entorno } = falso();
    const ticks: number[] = [];
    const limite = vi.fn();
    const gr = new GrabadorVoz(entorno, { alCorrer: (s) => ticks.push(s), alLlegarAlLimite: limite }, 3);
    await gr.iniciar();
    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([1, 2]);
    expect(limite).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(limite).toHaveBeenCalledTimes(1);
    gr.cancelar();
  });

  it('⛔ NEGATIVA — una grabación sin audio devuelve null (no se manda nada a transcribir)', async () => {
    const { entorno } = falso({ vacio: true });
    const gr = new GrabadorVoz(entorno, { alCorrer: () => undefined, alLlegarAlLimite: () => undefined });
    await gr.iniciar();
    expect(await gr.detener()).toBeNull();
  });

  it('⛔ NEGATIVA — cancelar descarta el audio, suelta el micrófono y no entrega nada', async () => {
    const { g, pistas, entorno } = falso();
    const gr = new GrabadorVoz(entorno, { alCorrer: () => undefined, alLlegarAlLimite: () => undefined });
    await gr.iniciar();
    gr.cancelar();
    expect(g.stops).toBe(1);
    expect(pistas.every((p) => p.stop.mock.calls.length === 1)).toBe(true);
    expect(gr.grabando).toBe(false);
    expect(await gr.detener()).toBeNull();
  });

  it('⛔ NEGATIVA — si el navegador niega el micrófono, el error original llega y no queda nada grabando', async () => {
    const err = Object.assign(new Error('denegado'), { name: 'NotAllowedError' });
    const entorno: EntornoGrabacion = { pedirMicrofono: () => Promise.reject(err), crearGrabador: () => { throw new Error('no debe crearse'); }, soportaMime: () => true };
    const gr = new GrabadorVoz(entorno, { alCorrer: () => undefined, alLlegarAlLimite: () => undefined });
    await expect(gr.iniciar()).rejects.toBe(err);
    expect(gr.grabando).toBe(false);
  });

  it('iniciar dos veces no abre dos grabaciones', async () => {
    const { entorno } = falso();
    const pedir = vi.spyOn(entorno, 'pedirMicrofono');
    const gr = new GrabadorVoz(entorno, { alCorrer: () => undefined, alLlegarAlLimite: () => undefined });
    await gr.iniciar();
    await gr.iniciar();
    expect(pedir).toHaveBeenCalledTimes(1);
    gr.cancelar();
  });
});
