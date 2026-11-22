import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService, type AnthropicMessagesParams } from '@megadulces/platform-core';
import { costoDeLlamada } from '../../product-sheets/ia/lector-costos';
import type { UsoLlamada } from '../../product-sheets/ia/lectura-foto.contract';
import type { ConfigLecturaAlta } from './lectura-documento.config';
import { lecturaDocumentoDesdeModelo, type LecturaDocumentoIA } from './lectura-documento';
import { ESQUEMA_LECTURA_ALTA, SYSTEM_LECTURA_ALTA } from './lectura-documento.schema';

/**
 * `[ALC.4.3]` El lector: UNA llamada con todos los archivos del cliente → `LecturaDocumentoIA`.
 *
 * Reusa el transporte compartido (`AnthropicService`, ADR-056: no un cliente propio) y la forma del
 * lector de NP.7 (`lector-foto.service.ts`): structured outputs —los modelos 5.5 rechazan el
 * `tool_choice` forzado—, sin `thinking` (cada modelo usa su default) y `refusal`/`max_tokens` como
 * lectura fallida, nunca como datos.
 *
 * ⛔ Lo que NO hace: no decide si se llama (interruptor y tope: el servicio), no valida RFC ni
 * catálogos (`lectura-documento.ts`) y **nunca registra los archivos** (ni en logs ni en errores).
 */

export interface ArchivoParaModelo {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
}

export type ResultadoLecturaAlta =
  | { estado: 'leida'; lectura: LecturaDocumentoIA; uso: UsoLlamada }
  | { estado: 'ilegible' | 'rechazada' | 'incompleta' | 'fallida'; motivo: string; uso: UsoLlamada | null };

/** Imagen + razonamiento + un JSON de ~30 campos; la primera llamada con un esquema nuevo además lo compila. */
export const TIMEOUT_MS = 120_000;

const sinBase64 = (t: string): string => t.replace(/[A-Za-z0-9+/=]{100,}/g, '[base64 omitido]');

interface RespuestaMensajes {
  model?: unknown;
  usage?: unknown;
  stop_reason?: unknown;
  stop_details?: { category?: unknown } | null;
  content?: unknown;
}

@Injectable()
export class LectorDocumentoAltaService {
  private readonly logger = new Logger(LectorDocumentoAltaService.name);

  constructor(private readonly anthropic: AnthropicService) {}

  get tieneLlave(): boolean {
    return this.anthropic.hasApiKey;
  }

  async leer(archivos: ArchivoParaModelo[], cfg: ConfigLecturaAlta): Promise<ResultadoLecturaAlta> {
    if (!this.anthropic.hasApiKey) return { estado: 'fallida', motivo: 'Falta la llave de la IA en el servidor (ANTHROPIC_API_KEY).', uso: null };
    const bloques = archivos.map((a) => (a.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.base64 } }));
    const params: AnthropicMessagesParams = {
      model: cfg.modelo,
      maxTokens: cfg.maxTokens,
      system: SYSTEM_LECTURA_ALTA,
      messages: [{
        role: 'user',
        content: [...bloques, { type: 'text', text: `Archivos del mismo cliente: ${archivos.length}. Copia sus datos.` }],
      }],
      outputFormat: { type: 'json_schema', schema: ESQUEMA_LECTURA_ALTA },
    };
    if (cfg.effort) params.effort = cfg.effort;

    let resp: RespuestaMensajes;
    try {
      resp = (await this.anthropic.messages(params, { cachePrefix: true, timeoutMs: TIMEOUT_MS })) as RespuestaMensajes;
    } catch (e) {
      const motivo = sinBase64((e as Error)?.message ?? 'sin respuesta').slice(0, 300);
      this.logger.warn(`[ALC] lectura con IA falló: ${motivo}`);
      return { estado: 'fallida', motivo: `La IA no respondió: ${motivo}`, uso: null };
    }
    const modelo = typeof resp?.model === 'string' && resp.model ? resp.model : cfg.modelo;
    const uso = costoDeLlamada(modelo, resp?.usage);
    if (resp?.stop_reason === 'refusal') {
      const cat = resp.stop_details?.category;
      return { estado: 'rechazada', motivo: `El modelo no quiso leerlo (${typeof cat === 'string' ? cat : 'sin categoría'}): captúralo a mano.`, uso };
    }
    if (resp?.stop_reason === 'max_tokens') return { estado: 'incompleta', motivo: 'La respuesta de la IA se cortó: vuelve a intentar.', uso };
    const texto = Array.isArray(resp?.content)
      ? (resp.content as Array<{ type?: unknown; text?: unknown }>).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
      : '';
    let crudo: unknown = null;
    try { crudo = JSON.parse(texto); } catch { crudo = null; }
    const lectura = lecturaDocumentoDesdeModelo(crudo);
    if (!lectura) return { estado: 'fallida', motivo: 'La respuesta de la IA no tiene la forma esperada.', uso };
    if (lectura.legible === 'no') return { estado: 'ilegible', motivo: 'La IA no pudo leer los archivos: toma la foto otra vez, de frente y con luz.', uso };
    return { estado: 'leida', lectura, uso };
  }
}
