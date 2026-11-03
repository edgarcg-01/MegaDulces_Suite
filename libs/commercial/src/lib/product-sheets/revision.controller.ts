import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RevisionBandeja, RevisionDecisionDto, RevisionDecisionRespuesta } from '@megadulces/contracts';
import { Permission, RequirePermissions } from '@megadulces/platform-core';
import { RevisionService } from './revision.service';

interface Sesion {
  user?: { sub?: string; username?: string };
}

/**
 * `[NP.7.L.3b]` Catálogo digital › Por revisar: lo levantado que espera a una persona. Todo con
 * `CATALOGO_FICHAS_REVISAR` (NP.7.L.15): quien sólo levanta (`CATALOGO_LEVANTAR`) recibe 403. Y quien tiene
 * las dos claves tampoco publica lo que él mismo terminó de capturar (403 en el servicio).
 */
@ApiTags('catalog-fichas')
@Controller('catalog/fichas')
export class RevisionController {
  constructor(private readonly service: RevisionService) {}

  @Get('revision')
  @RequirePermissions(Permission.CATALOGO_FICHAS_REVISAR)
  @ApiOperation({ summary: 'NP.7: bandeja por revisar (conteo por motivo de toda la bandeja + página con fotos firmadas y el dato de Kepler)' })
  bandeja(
    @Query('branch') branch: string | undefined, @Query('reason') reason: string | undefined,
    @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined,
  ): Promise<RevisionBandeja> {
    return this.service.bandeja({ branch, reason, limit: Number(limit) || 30, offset: Number(offset) || 0 });
  }

  @Post(':id/decision')
  @RequirePermissions(Permission.CATALOGO_FICHAS_REVISAR)
  @ApiOperation({ summary: 'NP.7: publicar, pedir otra foto o descartar (estas dos con nota)' })
  decidir(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevisionDecisionDto, @Req() req: Sesion): Promise<RevisionDecisionRespuesta> {
    return this.service.decidir({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null }, id, dto);
  }
}
