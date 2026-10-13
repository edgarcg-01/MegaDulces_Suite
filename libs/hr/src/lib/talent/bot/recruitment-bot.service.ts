import { Injectable, Logger } from '@nestjs/common';
import type { RecruitmentBotPort, RecruitmentInbound, RecruitmentReply } from '@megadulces/contracts';

/**
 * Fase RH · `[RH.3.1]` — el BOT DE RECLUTAMIENTO de la Suite, detrás de `RECRUITMENT_BOT_PORT`. La ingesta de WhatsApp le
 * pasa los mensajes del número de reclutamiento; él decide qué contestar.
 *
 * Hoy es el ESQUELETO: prueba el ida y vuelta completo (número de RH → ruteo → este servicio → respuesta desde el mismo
 * número → libro de WhatsApp) sin conversación todavía. La máquina de estados del registro es `[RH.3.2]`; mientras, el
 * número de RH sigue apuntando a Mega Talento en Meta (el corte es `[RH.3.6]`), así que esto no le contesta a nadie real.
 *
 * Contesta con un saludo honesto («estamos preparando…») en vez de callar, para que quien pruebe el número vea el ruteo
 * funcionando.
 */
@Injectable()
export class HrRecruitmentBotService implements RecruitmentBotPort {
  private readonly logger = new Logger(HrRecruitmentBotService.name);

  async handleMessage(msg: RecruitmentInbound): Promise<RecruitmentReply[]> {
    this.logger.debug(`[RH.3.1] mensaje ${msg.type} al número de reclutamiento (${msg.phoneNumberId ?? 'sin número'}).`);
    const nombre = (msg.profileName ?? '').trim().split(/\s+/)[0] || '';
    return [{
      kind: 'text',
      body: `Hola${nombre ? ` ${nombre}` : ''}, gracias por escribir a Capital Humano de Mega Dulces. `
        + 'Estamos preparando este canal; por ahora puedes postularte en nuestra página de empleo. ¡Gracias!',
    }];
  }
}
