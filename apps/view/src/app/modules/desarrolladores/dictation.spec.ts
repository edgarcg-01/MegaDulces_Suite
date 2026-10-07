import {
  DictationController, applyVoiceCommands, capitalizeSentences, dictationErrorMessage, joinDictation,
  type RecognitionLike,
} from './dictation';

/**
 * `[DEV.6]` El dictado se prueba sin micrófono: el reconocedor del navegador se reemplaza por uno
 * falso al que el test le «dicta» resultados, igual que los entrega Chrome (parciales que luego
 * se vuelven finales, cortes por silencio, errores).
 */

class FakeRecognition implements RecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  starts = 0;
  stops = 0;
  start(): void { this.starts += 1; }
  stop(): void { this.stops += 1; }

  /** Simula `onresult` con una lista de [texto, ¿final?] desde `resultIndex`. */
  say(results: [string, boolean][], resultIndex = 0): void {
    const arr = results.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t } }));
    this.onresult?.({ resultIndex, results: arr });
  }
}

function setup(supported = true) {
  const recs: FakeRecognition[] = [];
  const texts: string[] = [];
  const states: boolean[] = [];
  const errors: string[] = [];
  const ctl = new DictationController(
    () => {
      if (!supported) return null;
      const r = new FakeRecognition();
      recs.push(r);
      return r;
    },
    { onText: (t) => texts.push(t), onState: (s) => states.push(s), onError: (e) => errors.push(e) },
  );
  return { ctl, recs, texts, states, errors, last: () => texts[texts.length - 1] };
}

describe('[DEV.6] joinDictation', () => {
  it('texto vacío: lo dictado arranca con mayúscula', () => {
    expect(joinDictation('', 'crear el portal de proveedores')).toBe('Crear el portal de proveedores');
  });

  it('a media oración NO pone mayúscula ni pega las palabras', () => {
    expect(joinDictation('Revisar', 'el inventario')).toBe('Revisar el inventario');
  });

  it('tras un punto, mayúscula', () => {
    expect(joinDictation('Primero esto.', 'luego aquello')).toBe('Primero esto. Luego aquello');
  });

  it('no mete doble espacio si lo escrito ya termina en espacio o salto', () => {
    expect(joinDictation('Hola ', 'mundo')).toBe('Hola mundo');
    expect(joinDictation('Paso 1\n', 'paso dos')).toBe('Paso 1\nPaso dos');
  });

  it('⛔ no le cambia la caja a lo que la persona ya había escrito', () => {
    expect(joinDictation('integrar api de kepler.', 'y probar')).toBe('integrar api de kepler. Y probar');
  });

  it('⛔ a media oración respeta la mayúscula que el reconocedor ya entregó (nombre propio)', () => {
    expect(joinDictation('Leer de', 'Kepler y Wincaja')).toBe('Leer de Kepler y Wincaja');
  });

  it('dictado vacío no cambia nada', () => {
    expect(joinDictation('Algo', '   ')).toBe('Algo');
  });
});

describe('[DEV.6] comandos de voz', () => {
  it('«nueva línea» y «nuevo renglón» cambian de renglón', () => {
    expect(applyVoiceCommands('uno nueva línea dos')).toBe('uno\ndos');
    expect(applyVoiceCommands('uno nuevo renglón dos')).toBe('uno\ndos');
  });

  it('«punto y aparte» cierra la oración y cambia de renglón', () => {
    expect(joinDictation('', 'primer paso punto y aparte segundo paso')).toBe('Primer paso.\nSegundo paso');
  });

  it('⛔ «punto de venta» NO se convierte en puntuación', () => {
    expect(joinDictation('', 'mejorar el punto de venta')).toBe('Mejorar el punto de venta');
  });

  it('capitalizeSentences sube la letra tras punto, signo o salto', () => {
    expect(capitalizeSentences('hola. adiós! sí\nno')).toBe('Hola. Adiós! Sí\nNo');
  });
});

describe('[DEV.6] DictationController', () => {
  it('configura español de México, continuo y con parciales', () => {
    const { ctl, recs } = setup();
    expect(ctl.start('')).toBe(true);
    expect(recs[0]).toMatchObject({ lang: 'es-MX', continuous: true, interimResults: true, starts: 1 });
    expect(ctl.listening).toBe(true);
  });

  it('va escribiendo mientras se habla: parcial primero, final después', () => {
    const { ctl, recs, last } = setup();
    ctl.start('Objetivo:');
    recs[0].say([['crear', false]]);
    expect(last()).toBe('Objetivo: crear');
    recs[0].say([['crear un tablero', true]]);
    expect(last()).toBe('Objetivo: crear un tablero');
    recs[0].say([['crear un tablero', true], ['de ventas', false]], 1);
    expect(last()).toBe('Objetivo: crear un tablero de ventas');
  });

  it('tras un corte por silencio se re-arranca solo y no pierde lo dictado', () => {
    const { ctl, recs, last } = setup();
    ctl.start('');
    recs[0].say([['primera parte', true]]);
    recs[0].onend?.(); // Chrome cortó por silencio
    expect(recs[0].starts).toBe(2);
    recs[0].say([['segunda parte', true]]);
    expect(last()).toBe('Primera parte segunda parte');
  });

  it('⛔ al detener NO se re-arranca', () => {
    const { ctl, recs, states } = setup();
    ctl.start('');
    ctl.stop();
    recs[0].onend?.();
    expect(recs[0].starts).toBe(1);
    expect(recs[0].stops).toBe(1);
    expect(states[states.length - 1]).toBe(false);
    expect(ctl.listening).toBe(false);
  });

  it('el silencio («no-speech») no es una falla', () => {
    const { ctl, recs, errors } = setup();
    ctl.start('');
    recs[0].onerror?.({ error: 'no-speech' });
    expect(errors).toEqual([]);
    expect(ctl.listening).toBe(true);
  });

  it('⛔ permiso de micrófono negado: avisa con qué hacer y se apaga', () => {
    const { ctl, recs, errors } = setup();
    ctl.start('');
    recs[0].onerror?.({ error: 'not-allowed' });
    expect(errors[0]).toMatch(/permiso al micrófono/);
    expect(ctl.listening).toBe(false);
    recs[0].onend?.();
    expect(recs[0].starts).toBe(1);
  });

  it('⛔ navegador sin soporte: lo declara, no finge escuchar', () => {
    const { ctl, errors } = setup(false);
    expect(ctl.supported).toBe(false);
    expect(ctl.start('')).toBe(false);
    expect(errors[0]).toMatch(/Chrome o Edge/);
    expect(ctl.listening).toBe(false);
  });

  it('traduce los errores conocidos y nombra el desconocido', () => {
    expect(dictationErrorMessage('audio-capture')).toMatch(/micrófono/);
    expect(dictationErrorMessage('raro')).toContain('raro');
  });
});
