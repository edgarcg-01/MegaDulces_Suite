import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CandidatosTemporada, ConfirmarFechasTemporadaDto, ConfirmarFechasTemporadaRespuesta, DecisionesTemporadaDto,
  DecisionesTemporadaRespuesta, TemporadasVista,
} from '@megadulces/contracts';
import { Permission, RequirePermissions } from '@megadulces/platform-core';
import { TemporadasService } from './temporadas.service';

interface Sesion {
  user?: { sub?: string; username?: string };
}

/**
 * `[PQ.94]` Compras › Temporadas. Plan `FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md` §19.8–§19.11.
 * Leer con `COMPRAS_TEMPORADAS_VER`; confirmar fechas y decidir productos con `COMPRAS_TEMPORADAS_GESTIONAR`
 * (D35: Compras, Mercadotecnia y Dirección). Es la ÚNICA puerta que escribe la temporada de un producto.
 */
@ApiTags('compras-temporadas')
@Controller('compras/temporadas')
export class TemporadasController {
  constructor(private readonly service: TemporadasService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_TEMPORADAS_VER)
  @ApiOperation({ summary: 'PQ.94: calendario de temporadas (fechas por año, propuesta o confirmada, y cuántos productos lleva cada una)' })
  temporadas(): Promise<TemporadasVista> {
    return this.service.temporadas();
  }

  @Get('fechas/:id/candidatos')
  @RequirePermissions(Permission.COMPRAS_TEMPORADAS_VER)
  @ApiOperation({ summary: 'PQ.94: productos que la venta propone para una temporada-año, con la decisión vigente de cada uno' })
  candidatos(@Param('id', ParseUUIDPipe) id: string): Promise<CandidatosTemporada> {
    return this.service.candidatos(id);
  }

  @Post(':id/decisiones')
  @RequirePermissions(Permission.COMPRAS_TEMPORADAS_GESTIONAR)
  @ApiOperation({ summary: 'PQ.94: confirmar o descartar productos de una temporada, por lote (respuesta parcial: guardadas y fallidas con motivo)' })
  decidir(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionesTemporadaDto, @Req() req: Sesion): Promise<DecisionesTemporadaRespuesta> {
    return this.service.decidir({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null }, id, dto);
  }

  @Post('fechas/:id/confirmar')
  @RequirePermissions(Permission.COMPRAS_TEMPORADAS_GESTIONAR)
  @ApiOperation({ summary: 'PQ.94: confirmar (y ajustar) las fechas de una temporada-año' })
  confirmarFechas(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmarFechasTemporadaDto, @Req() req: Sesion): Promise<ConfirmarFechasTemporadaRespuesta> {
    return this.service.confirmarFechas({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null }, id, dto);
  }
}
