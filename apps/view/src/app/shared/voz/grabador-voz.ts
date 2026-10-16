/**
 * Grabación de voz del navegador (MediaRecorder) lista para mandar a transcribir.
 *
 * Nace para el dictado de la Mesa de Servicio (`[MS.DICTADO]`). ⚠️ **Deuda declarada:** ya hay otras tres
 * copias de esta lógica (`thot-ai-input`, `media-capture`, `vendor-assistant`), cada una con su propio manejo
 * de errores y de tipo de audio. Ésta es la que se puede probar sin micrófono (el entorno del navegador entra
 * por `EntornoGrabacion`); cuando se toquen las otras, deberían consumirla en vez de seguir divergiendo.
 */

/** ~2 minutos: un dictado de descripción, no una nota de voz larga. A ~6 KB/s en opus pesa menos de 1 MB. */
export const MAX_SEGUNDOS_DICTADO = 120;

const MIMES_PREFERIDOS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'] as const;

/** Elige el primer tipo de audio que el navegador sabe grabar; `''` = que decida él. */
export function elegirMimeAudio(soportado: (tipo: string) => boolean): string {
  return MIMES_PREFERIDOS.find((t) => soportado(t)) ?? '';
}

/** Une lo que ya estaba escrito con lo dictado, sin pegar palabras ni duplicar espacios. Vacío no cambia nada. */
export function unirDictado(base: string, dictado: string): string {
  const t = (dictado ?? '').trim();
  if (!t) return base;
  if (!base.trim()) return t;
  return base + (/\s$/.test(base) ? '' : ' ') + t;
}

export function mmss(segundos: number): string {
  const m = Math.floor(segundos / 60);
  return `${m}:${String(segundos % 60).padStart(2, '0')}`;
}

/** Lo que se le dice a la persona cuando no se pudo abrir el micrófono (el `name` del error del navegador). */
export function mensajeErrorMicrofono(e: unknown): string {
  const nombre = (e as { name?: string } | null)?.name ?? '';
  if (nombre === 'NotAllowedError' || nombre === 'SecurityError') return 'El navegador no dio permiso al micrófono. Actívalo en el candado de la barra de direcciones.';
  if (nombre === 'NotFoundError' || nombre === 'OverconstrainedError') return 'No se encontró un micrófono conectado.';
  return 'No se pudo usar el micrófono.';
}

/** Lo que se le dice cuando la transcripción devolvió un código de error (ver `SpeechToTextService`). */
export function mensajeErrorTranscripcion(codigo: string | undefined): string {
  switch (codigo) {
    case 'no_key':
      return 'El dictado no está configurado en este entorno. Escribe tu mensaje.';
    case 'too_big':
      return 'La grabación es demasiado larga. Dícela en partes más cortas.';
    default:
      return 'No se pudo transcribir. Intenta de nuevo o escribe tu mensaje.';
  }
}

export function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result ?? '').split(',')[1] ?? '');
    lector.onerror = () => reject(lector.error ?? new Error('No se pudo leer el audio'));
    lector.readAsDataURL(blob);
  });
}

// ── Entorno (lo único que toca el navegador) ──────────────────────────────────────────────────────

export interface PistaLike { stop(): void }
export interface FlujoLike { getTracks(): PistaLike[] }
export interface GrabadorLike {
  state: string;
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}
export interface EntornoGrabacion {
  pedirMicrofono(): Promise<FlujoLike>;
  crearGrabador(flujo: FlujoLike, mime: string): GrabadorLike;
  soportaMime(tipo: string): boolean;
}

/** El entorno real, o `null` si este navegador no puede grabar (sin `getUserMedia` o sin `MediaRecorder`). */
export function entornoNavegador(): EntornoGrabacion | null {
  const g = globalThis as unknown as { navigator?: Navigator; MediaRecorder?: typeof MediaRecorder };
  if (!g.navigator?.mediaDevices?.getUserMedia || typeof g.MediaRecorder === 'undefined') return null;
  const MR = g.MediaRecorder;
  return {
    pedirMicrofono: () =>
      g.navigator!.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
    crearGrabador: (flujo, mime) => new MR(flujo as MediaStream, mime ? { mimeType: mime } : undefined) as unknown as GrabadorLike,
    soportaMime: (t) => MR.isTypeSupported?.(t) ?? false,
  };
}

export interface Grabacion {
  blob: Blob;
  mime: string;
}

export class GrabadorVoz {
  private flujo: FlujoLike | null = null;
  private grabador: GrabadorLike | null = null;
  private trozos: Blob[] = [];
  private reloj: ReturnType<typeof setInterval> | null = null;
  private segundos = 0;

  constructor(
    private readonly entorno: EntornoGrabacion,
    private readonly cb: { alCorrer: (segundos: number) => void; alLlegarAlLimite: () => void },
    private readonly maxSegundos = MAX_SEGUNDOS_DICTADO,
  ) {}

  get grabando(): boolean {
    return this.grabador !== null;
  }

  /** Abre el micrófono y empieza a grabar. Si el navegador lo niega, lanza el error original (ver `mensajeErrorMicrofono`). */
  async iniciar(): Promise<void> {
    if (this.grabador) return;
    const flujo = await this.entorno.pedirMicrofono();
    this.flujo = flujo;
    this.trozos = [];
    this.segundos = 0;
    const g = this.entorno.crearGrabador(flujo, elegirMimeAudio((t) => this.entorno.soportaMime(t)));
    g.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.trozos.push(ev.data);
    };
    this.grabador = g;
    g.start();
    this.reloj = setInterval(() => {
      this.segundos += 1;
      this.cb.alCorrer(this.segundos);
      if (this.segundos >= this.maxSegundos) this.cb.alLlegarAlLimite();
    }, 1000);
  }

  /** Termina y entrega lo grabado; `null` si no se grabó nada. Siempre suelta el micrófono. */
  detener(): Promise<Grabacion | null> {
    const g = this.grabador;
    if (!g) return Promise.resolve(null);
    return new Promise((resolver) => {
      const terminar = () => {
        const mime = g.mimeType || 'audio/webm';
        const blob = new Blob(this.trozos, { type: mime });
        this.liberar();
        resolver(blob.size > 0 ? { blob, mime } : null);
      };
      g.onstop = terminar;
      if (g.state !== 'inactive') g.stop();
      else terminar();
    });
  }

  /** Descarta lo grabado sin transcribir. */
  cancelar(): void {
    const g = this.grabador;
    if (g) {
      g.onstop = null;
      if (g.state !== 'inactive') g.stop();
    }
    this.liberar();
  }

  private liberar(): void {
    if (this.reloj) clearInterval(this.reloj);
    this.reloj = null;
    this.flujo?.getTracks().forEach((p) => p.stop());
    this.flujo = null;
    this.grabador = null;
    this.trozos = [];
  }
}
