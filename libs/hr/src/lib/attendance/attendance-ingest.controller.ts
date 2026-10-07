import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '@megadulces/platform-core';
import { HrIngestGuard } from './hr-ingest.guard';
import { HrAttendanceIngestService } from './attendance-ingest.service';
import type { HeartbeatBody, IngestResult } from './attendance-ingest.service';
import type { IncomingBatch } from './ingest-batch';

/**
 * Fase RH · `[RH.1.2]` — lo que llama el lector de relojes (máquina a máquina).
 *
 * `@Public()` porque no hay sesión de usuario; la puerta es la llave `x-hr-ingest-key`
 * (`HrIngestGuard`, falla cerrado en producción). Sin límite de peticiones: en una lectura
 * completa el lector manda cientos de lotes seguidos, y el límite por IP los cortaría.
 *
 * Códigos de respuesta, los mismos que ya entiende el agente de Mega Talento:
 *   409 serie desconocida · 202 reloj en pausa (lote guardado sin aplicar) · 200 aplicado.
 * El agente NO reintenta un 409 ni un 202: el lote ya quedó guardado.
 */
@ApiTags('hr')
@Controller('hr/attendance/ingest')
@Public()
@SkipThrottle()
@UseGuards(HrIngestGuard)
export class HrAttendanceIngestController {
  constructor(private readonly service: HrAttendanceIngestService) {}

  @Post()
  @ApiOperation({ summary: 'RH — un lote de checadas del lector de relojes (idempotente).' })
  async ingest(@Body() body: IncomingBatch, @Res({ passthrough: true }) res: Response): Promise<IngestResult> {
    const r = await this.service.ingest(body);
    if (r.estado === 'serie_desconocida') res.status(409);
    else if (r.estado === 'pendiente') res.status(202);
    return r;
  }

  @Post('heartbeat')
  @ApiOperation({ summary: 'RH — el lector avisa que sigue vivo (y qué falla).' })
  async heartbeat(@Body() body: HeartbeatBody, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const r = await this.service.heartbeat(body);
    res.status(r.status);
    return r.body;
  }

  @Get('devices')
  @ApiOperation({ summary: 'RH — el padrón de relojes que le toca al lector.' })
  registry(@Query('sucursalId') sucursalId?: string, @Query('modo') modo?: string): Promise<Array<Record<string, unknown>>> {
    return this.service.registry({ sucursalId, modo });
  }
}
