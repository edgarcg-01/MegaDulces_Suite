import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@megadulces/platform-core';
import type {
  HrAptitudesEvaluacion, HrLiderazgoAvanceDto, HrLiderazgoRespuesta, HrLigaContextoDto, HrLigaCvSubida, HrPostulacionPublica, HrPostulacionResultadoDto,
  HrVacantePublicaDto,
} from '@megadulces/contracts';
import { HrTalentIntakeService } from './talent-intake.service';
import { HrTalentLinksService } from './talent-links.service';

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
  constructor(
    private readonly intake: HrTalentIntakeService,
    private readonly links: HrTalentLinksService,
  ) {}

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

  /** Lo que la página de la liga necesita mostrar: el primer nombre, el puesto y si ya mandó CV. Nada más. */
  @Public()
  @Throttle({ medium: { limit: 20, ttl: 10_000 } })
  @Get('links/:token')
  @ApiOperation({ summary: 'Liga personal — qué deja hacer y a quién saluda (sin datos del expediente).' })
  liga(@Param('token') token: string): Promise<HrLigaContextoDto> {
    return this.links.contexto(token);
  }

  /** Subir el CV desde la liga. */
  @Public()
  @Throttle({ medium: { limit: 3, ttl: 10_000 }, long: { limit: 10, ttl: 600_000 } })
  @Post('links/:token/cv')
  @HttpCode(200)
  @ApiOperation({ summary: 'Liga personal — subir el CV (un PDF, o dos fotos: frente y reverso).' })
  subirCv(@Param('token') token: string, @Body() b: HrLigaCvSubida): Promise<HrPostulacionResultadoDto> {
    return this.links.subirCv(token, b);
  }

  /** Una respuesta del cuestionario de liderazgo (se guarda al momento; 12 preguntas). */
  @Public()
  @Throttle({ medium: { limit: 20, ttl: 10_000 } })
  @Post('links/:token/liderazgo')
  @HttpCode(200)
  @ApiOperation({ summary: 'Liga personal — contestar una pregunta del cuestionario de liderazgo.' })
  responder(@Param('token') token: string, @Body() b: HrLiderazgoRespuesta): Promise<HrLiderazgoAvanceDto> {
    return this.links.responderLiderazgo(token, b);
  }

  /** La evaluación de aptitudes del jefe que entrevista (se puede corregir). */
  @Public()
  @Throttle({ medium: { limit: 5, ttl: 10_000 } })
  @Post('links/:token/aptitudes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Liga personal — guardar la evaluación de aptitudes (formato STAR).' })
  aptitudes(@Param('token') token: string, @Body() b: HrAptitudesEvaluacion): Promise<HrPostulacionResultadoDto> {
    return this.links.evaluarAptitudes(token, b);
  }
}
