import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '@megadulces/platform-core';
import {
  DEMASIADAS_PAGINAS, TIPOS_DOCUMENTO, esErrorDeTamano, sinRevisar, veredictoCv, visionPuedeLeer, type ValidacionCv,
} from './validar-cv';

/**
 * Fase RH · `[RH.3.3.2]` — revisa con VISIÓN si el archivo que mandó como CV lo es (la regla está en `validar-cv.ts`).
 * Mismo cliente compartido que la IA del registro; mismo modelo de Mega Talento para visión (Haiku). Sin
 * `ANTHROPIC_API_KEY`, con un error o con un formato que la visión no lee, ACEPTA y marca para revisión.
 */

const MODELO = process.env['HR_BOT_VISION_MODEL'] || 'claude-haiku-4-5-20251001';
const TIEMPO_MAX_MS = 20_000;
const HERRAMIENTA = 'clasificar_archivo';

const SISTEMA = 'Revisas lo que un candidato mandó por WhatsApp cuando se le pidió su CURRÍCULUM para postularse a un '
  + 'empleo en una cadena mexicana de dulcerías.\n\nClasifica el archivo:\n'
  + '· cv — currículum / hoja de vida: trae historial laboral o estudios y datos de contacto. Cuenta aunque sea sencillo, '
  + 'de una hoja, hecho en Word o escrito a mano.\n'
  + '· solicitud_empleo — hoja de solicitud de empleo llenada (esas de papelería con casillas de datos personales, empleos '
  + 'anteriores y referencias). TAMBIÉN ES VÁLIDA.\n'
  + '· identificacion — INE, licencia, pasaporte, CURP, RFC, NSS, acta de nacimiento.\n'
  + '· comprobante — recibo de luz, agua, estado de cuenta, comprobante de domicilio.\n'
  + '· certificado_estudios — certificado, título, diploma o boleta de calificaciones SOLO.\n'
  + '· carta_recomendacion — carta de recomendación o de trabajo, sin historial completo.\n'
  + '· otro_documento — cualquier otro papel (contratos, cotizaciones, capturas, temario…).\n'
  + '· foto_persona — una foto de una persona, un selfie o un retrato, sin texto de CV.\n'
  + '· ilegible — se ve tan borroso, cortado u oscuro que no se puede saber qué es.\n\n'
  + '`seguro`: true SOLO si no te queda duda. Si podría ser un CV mal escaneado, sencillo o incompleto, pon false.\n'
  + '`que_es`: una frase corta y CONCRETA de lo que ves ("es un recibo de CFE", "es el frente de una credencial del INE"). '
  + 'Se le dice a la persona para que sepa qué mandó, así que sé específico. No copies datos personales completos.';

interface RespuestaMensajes { content?: Array<{ type: string; name?: string; input?: unknown }> }

@Injectable()
export class HrCvValidatorService {
  private readonly logger = new Logger(HrCvValidatorService.name);

  constructor(private readonly anthropic: AnthropicService) {}

  async validar(buffer: Buffer, contentType: string): Promise<ValidacionCv> {
    if (!this.anthropic.hasApiKey) return sinRevisar('IA no disponible');
    if (!visionPuedeLeer(contentType)) return sinRevisar(`formato que la visión no lee (${contentType})`);
    const data = buffer.toString('base64');
    const bloque = contentType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: contentType, data } };
    try {
      const resp: RespuestaMensajes = await this.anthropic.messages({
        model: MODELO,
        maxTokens: 400,
        system: SISTEMA,
        messages: [{ role: 'user', content: [bloque, { type: 'text', text: '¿Qué mandó? Clasifícalo.' }] }],
        toolChoice: { type: 'tool', name: HERRAMIENTA },
        tools: [{
          name: HERRAMIENTA,
          description: 'Clasifica el archivo que mandó el candidato.',
          input_schema: {
            type: 'object',
            properties: {
              tipo: { type: 'string', enum: [...TIPOS_DOCUMENTO] },
              seguro: { type: 'boolean' },
              que_es: { type: 'string' },
            },
            required: ['tipo', 'seguro', 'que_es'],
          },
        }],
      }, { timeoutMs: TIEMPO_MAX_MS });
      const uso = (resp.content ?? []).find((b) => b.type === 'tool_use' && b.name === HERRAMIENTA);
      return veredictoCv(uso && uso.input && typeof uso.input === 'object' ? (uso.input as { tipo?: unknown }) : null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (esErrorDeTamano(msg)) return DEMASIADAS_PAGINAS;
      this.logger.warn(`[RH.3.3.2] no se pudo revisar el CV (se acepta y se marca): ${msg}`);
      return sinRevisar('error al revisar');
    }
  }
}
