/**
 * `[DEV.6]` Dictado: lo que se dice se va escribiendo en el objetivo del proyecto.
 *
 * Usa la Web Speech API del navegador (`SpeechRecognition`, `webkitSpeechRecognition` en
 * Chrome/Edge). ⚠️ Dos límites que se DECLARAN en pantalla, no se esconden:
 *  · Firefox y Safari de escritorio no la implementan → el botón se apaga con su motivo.
 *  · En Chrome el audio lo transcribe un servicio de Google, no este servidor. Para notas de
 *    trabajo es aceptable; no es para dictar contraseñas ni datos personales de clientes.
 *
 * La lógica de armar el texto vive en funciones puras (abajo) para poder probarla sin micrófono.
 */

/** Comandos de voz. ⛔ NO se incluye «punto» ni «coma» sueltos: en este negocio se dice
 *  «punto de venta» todo el día, y convertirlo en «. de venta» arruinaría la frase. */
const VOICE_COMMANDS: readonly [RegExp, string][] = [
  [/\s*\bpunto y aparte\b\s*/gi, '.\n'],
  [/\s*\b(nueva l[ií]nea|nuevo rengl[oó]n)\b\s*/gi, '\n'],
];

export function applyVoiceCommands(fragment: string): string {
  let out = fragment;
  for (const [re, rep] of VOICE_COMMANDS) out = out.replace(re, rep);
  return out;
}

/** Mayúscula al inicio de texto y después de punto/salto. */
export function capitalizeSentences(s: string): string {
  return s.replace(/(^\s*|[.!?]\s+|\n\s*)([a-záéíóúñü])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

/**
 * Une lo que ya estaba escrito con lo dictado, cuidando el espacio de en medio: ni pegado
 * («ideaNueva»), ni doble espacio, ni espacio después de un salto de línea.
 */
export function joinDictation(base: string, spoken: string): string {
  let s = applyVoiceCommands(spoken.trim());
  if (!s.trim()) return base;
  // Lo que la persona ya había escrito NO se toca: las mayúsculas se aplican sólo a lo dictado.
  // El primer carácter va en mayúscula sólo si arranca oración (texto vacío, tras punto o salto).
  const startsSentence = !base.trim() || /[.!?]\s*$|\n\s*$/.test(base);
  // A media oración se antepone un ancla para que el primer carácter no cuente como «inicio»;
  // así no se le cambia la caja a lo que el reconocedor ya entregó (p. ej. «Kepler»).
  s = startsSentence ? capitalizeSentences(s) : capitalizeSentences(`x ${s}`).slice(2);
  if (!base) return s;
  const sep = /\s$/.test(base) || s.startsWith('\n') || s.startsWith('.') ? '' : ' ';
  return base + sep + s;
}

/** Lo mínimo que usamos de `SpeechRecognition` (los tipos DOM no lo traen en TS). */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionFactory = () => RecognitionLike | null;

export const browserRecognitionFactory: RecognitionFactory = () => {
  const w = globalThis as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
};

/** Traducción de los errores del navegador a algo que la persona pueda resolver. */
export function dictationErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'El navegador no dio permiso al micrófono. Actívalo en el candado de la barra de direcciones.';
    case 'audio-capture':
      return 'No se encontró un micrófono conectado.';
    case 'network':
      return 'Sin conexión con el servicio de dictado del navegador.';
    case 'language-not-supported':
      return 'El navegador no reconoce español de México.';
    default:
      return `El dictado se detuvo (${code}).`;
  }
}

/**
 * Controla una sesión de dictado. Cada vez que cambia el texto llama a `onText(texto)` con el
 * objetivo COMPLETO (lo que había + lo dictado + lo que todavía se está reconociendo).
 *
 * Chrome corta el reconocimiento tras unos segundos de silencio aunque `continuous` esté en true;
 * mientras la persona no aprieta «Detener», se re-arranca solo para que no tenga que volver a
 * pulsar el botón a cada pausa.
 */
export class DictationController {
  private rec: RecognitionLike | null = null;
  private base = '';
  private finals = '';
  private wanted = false;

  constructor(
    private readonly factory: RecognitionFactory,
    private readonly cb: {
      onText: (text: string) => void;
      onState: (listening: boolean) => void;
      onError: (message: string) => void;
    },
    private readonly lang = 'es-MX',
  ) {}

  get supported(): boolean {
    const probe = this.factory();
    return probe !== null;
  }

  get listening(): boolean {
    return this.wanted;
  }

  start(currentText: string): boolean {
    if (this.wanted) return true;
    const rec = this.factory();
    if (!rec) {
      this.cb.onError('Este navegador no permite dictado. Usa Chrome o Edge.');
      return false;
    }
    this.rec = rec;
    this.base = currentText ?? '';
    this.finals = '';
    this.wanted = true;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript ?? '';
        if (r.isFinal) this.finals = `${this.finals} ${t}`.trim();
        else interim += t;
      }
      this.cb.onText(joinDictation(this.base, `${this.finals} ${interim}`));
    };
    rec.onerror = (ev) => {
      // `no-speech` y `aborted` son parte del ciclo normal (silencio / detener), no fallas.
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      this.wanted = false;
      this.cb.onError(dictationErrorMessage(ev.error));
      this.cb.onState(false);
    };
    rec.onend = () => {
      if (!this.wanted) return;
      // Re-arranque tras el corte por silencio: lo ya reconocido pasa a ser la nueva base.
      this.base = joinDictation(this.base, this.finals);
      this.finals = '';
      try {
        rec.start();
      } catch {
        this.wanted = false;
        this.cb.onState(false);
      }
    };
    try {
      rec.start();
    } catch {
      this.wanted = false;
      this.cb.onError('No se pudo iniciar el dictado.');
      return false;
    }
    this.cb.onState(true);
    return true;
  }

  stop(): void {
    this.wanted = false;
    try {
      this.rec?.stop();
    } catch {
      /* ya estaba detenido */
    }
    this.cb.onState(false);
  }
}
