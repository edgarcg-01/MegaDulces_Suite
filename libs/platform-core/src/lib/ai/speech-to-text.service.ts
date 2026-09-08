import { Injectable, Logger } from '@nestjs/common';

/**
 * **Transcripción de voz compartida** (Groq Whisper large-v3-turbo, español).
 *
 * Infra leaf, cero deps de dominio — mismo patrón que `AnthropicService` y
 * `EmbeddingsService`: cada módulo que la necesita la agrega a sus `providers`.
 *
 * **Por qué existe siendo que ya había un proxy de dictado:** el de Thot vive en
 * `commercial-intelligence.controller.ts` gateado con `COMMERCIAL_ORDERS_VER`, y
 * quien captura caducidades en tienda **no tiene ese permiso** (su rol lleva
 * `COMMERCIAL_EXPIRY_CAPTURAR` y nada de ventas). Reusar ese endpoint le daba un
 * 403 al primer intento de hablar, o forzaba a repartir un permiso de ventas
 * para poder dictar. La transcripción es infraestructura: cada dominio la expone
 * con SU gate.
 *
 * `thot/transcribe` conserva su copia del fetch; cuando se toque, conviene que
 * consuma este servicio para no quedar con dos.
 *
 * La API key vive solo en el server. Sin `GROQ_API_KEY` devuelve
 * `{ text: '', error: 'no_key' }` en vez de lanzar: el front muestra el motivo
 * real y la pantalla sigue sirviendo por escaneo/teclado.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_TIMEOUT_MS = 30_000;
/** ~10 MB de audio: más que eso no es un dictado, es un archivo subido por error. */
const MAX_BYTES = 10 * 1024 * 1024;

export interface TranscribeResult {
  text: string;
  error?: 'no_key' | 'too_big' | 'stt_failed' | 'stt_error';
}

@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);

  get hasApiKey(): boolean {
    return !!process.env.GROQ_API_KEY;
  }

  /**
   * @param audioBase64 audio crudo en base64 (sin el prefijo `data:`).
   * @param mime tipo que reportó `MediaRecorder` (webm/mp4/ogg según navegador).
   */
  async transcribe(audioBase64: string, mime = 'audio/webm', opts: { language?: string; timeoutMs?: number } = {}): Promise<TranscribeResult> {
    const b64 = String(audioBase64 || '');
    if (!b64) return { text: '' };
    const key = process.env.GROQ_API_KEY || '';
    if (!key) return { text: '', error: 'no_key' };

    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength > MAX_BYTES) return { text: '', error: 'too_big' };

    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), 'audio.webm');
    form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('language', opts.language || 'es');
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        this.logger.warn(`Groq STT HTTP ${res.status}: ${txt.slice(0, 200)}`);
        return { text: '', error: 'stt_failed' };
      }
      const json: any = await res.json();
      return { text: String(json?.text || '').trim() };
    } catch (e: any) {
      this.logger.warn(`Groq STT error: ${e?.message || e}`);
      return { text: '', error: 'stt_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
