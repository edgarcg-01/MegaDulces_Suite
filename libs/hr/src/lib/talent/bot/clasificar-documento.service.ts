import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import { visionPuedeLeer } from './validar-cv';
import { CASILLEROS, PISTA_CASILLERO, sinClasificar, veredictoDocumento, type ClasificacionDocumento } from './documentos';

/**
 * Fase RH · `[RH.3.3.4]` — reconoce con VISIÓN qué documento del expediente mandó (la regla está en `documentos.ts`).
 * Portado de `clasificarDocumento` de Mega Talento: mismo catálogo, mismo modelo (Haiku), y la misma prudencia — si duda
 * entre varios, «otro». Sin `ANTHROPIC_API_KEY`, con un error o con un formato que la visión no lee, no se adivina: el
 * documento entra como «otro» y RH lo acomoda.
 */

const MODELO = process.env['HR_BOT_VISION_MODEL'] || 'claude-haiku-4-5-20251001';
const TIEMPO_MAX_MS = 20_000;
const HERRAMIENTA = 'clasificar_documento';

const SISTEMA = 'Eres un clasificador de documentos oficiales mexicanos para el expediente de reclutamiento de una cadena '
  + 'de dulcerías. Te dan UNA imagen o PDF que mandó un candidato por WhatsApp y debes decir a qué casillero corresponde. '
  + 'Elige EXACTAMENTE uno por su clave:\n'
  + CASILLEROS.map((k) => `- ${k}: ${PISTA_CASILLERO[k] ?? k}`).join('\n')
  + '\nSi el documento no corresponde claramente a ninguno, responde "otro". No adivines: si dudas entre varios, elige '
  + '"otro". En "motivo" explica en una frase corta qué ves, sin copiar datos personales completos.';

interface RespuestaMensajes { content?: Array<{ type: string; name?: string; input?: unknown }> }

@Injectable()
export class HrDocumentClassifierService {
  private readonly logger = new Logger(HrDocumentClassifierService.name);

  constructor(private readonly anthropic: AnthropicService) {}

  async clasificar(buffer: Buffer, contentType: string): Promise<ClasificacionDocumento> {
    if (!this.anthropic.hasApiKey) return sinClasificar('IA no disponible');
    if (!visionPuedeLeer(contentType)) return sinClasificar(`formato que la visión no lee (${contentType})`);
    const data = buffer.toString('base64');
    const bloque = contentType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: contentType, data } };
    try {
      const resp: RespuestaMensajes = await this.anthropic.messages({
        model: MODELO,
        maxTokens: 300,
        system: SISTEMA,
        messages: [{ role: 'user', content: [bloque, { type: 'text', text: '¿Qué documento es? Clasifícalo.' }] }],
        toolChoice: { type: 'tool', name: HERRAMIENTA },
        tools: [{
          name: HERRAMIENTA,
          description: 'Dice a qué casillero del expediente corresponde el documento.',
          input_schema: {
            type: 'object',
            properties: {
              slot: { type: 'string', enum: [...CASILLEROS, 'otro'] },
              motivo: { type: 'string' },
            },
            required: ['slot', 'motivo'],
          },
        }],
      }, { timeoutMs: TIEMPO_MAX_MS });
      const uso = (resp.content ?? []).find((b) => b.type === 'tool_use' && b.name === HERRAMIENTA);
      return veredictoDocumento(uso && uso.input && typeof uso.input === 'object' ? (uso.input as { slot?: unknown; motivo?: unknown }) : null);
    } catch (err) {
      this.logger.warn(`[RH.3.3.4] no se pudo clasificar el documento (entra como «otro»): ${err instanceof Error ? err.message : String(err)}`);
      return sinClasificar('error al clasificar');
    }
  }
}
