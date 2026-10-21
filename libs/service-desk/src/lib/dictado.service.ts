/**
 * `[MS.DICTADO]` Dictado de la descripción de una solicitud: audio → texto.
 *
 * Se reusa la transcripción compartida de `platform-core` (Groq Whisper, español): no se inventa otro
 * proveedor. Lo propio de la Mesa es la REGLA — no se dicta en un área confidencial (`domain/dictado.ts`) — y
 * que el audio **no se guarda**: se transcribe en memoria y se devuelve sólo el texto, que la persona revisa
 * y puede corregir antes de enviar.
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { SdTranscribeDto, SdTranscribeResult } from '@megadulces/contracts';
import { SpeechToTextService, TenantKnexService } from '@megadulces/platform-core';
import { decidirDictado } from './domain/dictado';

@Injectable()
export class ServiceDeskDictationService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly stt: SpeechToTextService,
  ) {}

  async transcribir(dto: Partial<SdTranscribeDto> | undefined): Promise<SdTranscribeResult> {
    const queueId = typeof dto?.queue_id === 'string' ? dto.queue_id : undefined;
    // Un id mal formado nunca llega a la consulta: el área no se puede resolver → misma respuesta que «no existe».
    const cola = queueId && /^[0-9a-f-]{36}$/i.test(queueId)
      ? await this.tk.run((trx) => trx('servicedesk.queues').where({ id: queueId }).whereNull('deleted_at').first('confidential'))
      : null;
    const d = decidirDictado(queueId, cola ? { confidential: cola.confidential === true } : null);
    if (!d.ok) {
      if (d.status === 403) throw new ForbiddenException(d.mensaje);
      if (d.status === 404) throw new NotFoundException(d.mensaje);
      throw new BadRequestException(d.mensaje);
    }
    return this.stt.transcribe(String(dto?.audio ?? ''), dto?.mime || 'audio/webm');
  }
}
