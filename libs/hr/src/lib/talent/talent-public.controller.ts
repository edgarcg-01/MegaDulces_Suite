import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@megadulces/platform-core';
import type { HrPostulacionPublica, HrPostulacionResultadoDto, HrVacantePublicaDto } from '@megadulces/contracts';
import { HrTalentIntakeService } from './talent-intake.service';

/**
 * Fase RH · `[RH.2.4]` — la superficie PÚBLICA de reclutamiento: la bolsa de trabajo, sin cuenta ni sesión.
 *
 * Reglas que hay que sostener si alguien agrega un endpoint aquí:
 *   · **Sólo publica vacantes y recibe postulaciones.** Ningún listado de candidatos, ningún expediente.
 *     (En Mega Talento `GET`/`PATCH /candidatos/:id` eran públicos con el UUID como única llave; aquí NO.)
 *   · **Rate limit propio**, mucho más apretado que el global: es la puerta de internet del módulo.
 *   · **Lo que se contesta no revela nada** de otra persona (ver `respuestaPublica`).
 */
@ApiTags('hr-talent-public')
@Controller('hr/talent/public')
export class HrTalentPublicController {
  constructor(private readonly intake: HrTalentIntakeService) {}

  @Public()
  @Throttle({ medium: { limit: 30, ttl: 10_000 } })
  @Get('jobs')
  @ApiOperation({ summary: 'Bolsa de trabajo — las vacantes publicadas (sólo lo que se publica).' })
  vacantes(): Promise<HrVacantePublicaDto[]> {
    return this.intake.vacantesPublicas();
  }

  /** Postularse. 2 por cada 10 s y 5 por cada 10 min desde la misma conexión. */
  @Public()
  @Throttle({ medium: { limit: 2, ttl: 10_000 }, long: { limit: 5, ttl: 600_000 } })
  @Post('applications')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bolsa de trabajo — postularse (CV obligatorio). Un proceso a la vez por teléfono.' })
  postular(@Body() b: HrPostulacionPublica): Promise<HrPostulacionResultadoDto> {
    return this.intake.postularWeb(b);
  }
}
