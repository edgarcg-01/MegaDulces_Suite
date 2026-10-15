import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantContextService } from '@megadulces/platform-core';
import { RECRUITMENT_OUTBOUND_PORT, type HrPedirDocumentosResultadoDto, type RecruitmentOutboundPort } from '@megadulces/contracts';
import { HrRecruitmentBotService } from './recruitment-bot.service';
import { ventanaAbierta } from './documentos';

/**
 * Fase RH · `[RH.3.3.4b]` — RH le pide sus documentos a un candidato desde la ficha.
 *
 *   1. El bot registra la petición (`pedirDocumentos`): la conversación queda en `pidiendo_documentos` con la lista, así
 *      lo que mande se acomoda solo, aunque el mensaje no se le pueda mandar.
 *   2. Si escribió al número de reclutamiento en las últimas 24 h, se le manda el mensaje por WhatsApp (puerto de salida).
 *      Fuera de esa ventana Meta no deja mandar texto libre: NO se intenta (fallaría en silencio) — se le devuelve a RH el
 *      motivo y el texto, para avisarle por otro medio. En cuanto la persona escriba, el bot le contesta con la lista.
 *
 * Vive aparte del bot a propósito: la ingesta de WhatsApp depende del bot, así que si el bot dependiera de la salida de
 * WhatsApp habría un ciclo de dependencias.
 *
 * No hace: plantillas aprobadas de Meta para escribirle fuera de la ventana (`[RH.3.6]`).
 */
@Injectable()
export class HrDocumentRequestService {
  private readonly logger = new Logger(HrDocumentRequestService.name);

  constructor(
    private readonly bot: HrRecruitmentBotService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(RECRUITMENT_OUTBOUND_PORT) private readonly salida?: RecruitmentOutboundPort,
  ) {}

  async pedir(candidateId: string, slots?: string[] | null, ahora: Date = new Date()): Promise<HrPedirDocumentosResultadoDto> {
    const tenantId = this.tenantCtx.requireTenantId();
    const p = await this.bot.pedirDocumentos(tenantId, candidateId, slots);
    const base = { solicitados: p.solicitados, mensaje: p.mensaje, ultimo_mensaje_en: p.ultimo_mensaje_en };
    if (!p.mensaje) return { ...base, enviado: false, motivo: 'nada_que_pedir' };
    if (!ventanaAbierta(p.ultimo_mensaje_en, ahora)) return { ...base, enviado: false, motivo: 'fuera_de_ventana' };
    if (!this.salida) return { ...base, enviado: false, motivo: 'sin_whatsapp' };
    const r = await this.salida.sendText(tenantId, p.telefono_wa, p.mensaje);
    if (!r.encolado) {
      this.logger.warn(`[RH.3.3.4b] no se pudo avisar al candidato ${candidateId}: ${r.motivo ?? 'sin motivo'}`);
      return { ...base, enviado: false, motivo: 'sin_whatsapp' };
    }
    return { ...base, enviado: true, motivo: 'enviado' };
  }
}
