import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '@megadulces/platform-core';
import { HrIngestGuard } from './hr-ingest.guard';
import { HrAttendanceIngestService } from './attendance-ingest.service';
import type { HeartbeatBody, IngestResult, OrdenParaAgente } from './attendance-ingest.service';
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
 *
 * El agente de Mega Talento, sin cambiarle una línea, entra por `HrAttendanceMtCompatController`
 * (sus rutas y su encabezado). Ésta es la entrada para el lector que viva en el monorepo.
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

  @Get('commands')
  @ApiOperation({ summary: 'RH — órdenes pendientes para un reloj (renombrar, restaurar).' })
  ordenes(@Query('serie') serie: string): Promise<OrdenParaAgente[]> {
    return this.service.ordenesPendientes(serie);
  }

  @Post('commands/:id')
  @ApiOperation({ summary: 'RH — el lector reporta cómo le fue con una orden.' })
  reportar(@Param('id') id: string, @Body() body: { estado?: string; detalle?: string; respaldo?: unknown }): Promise<{ ok: true }> {
    return this.service.reportarOrden(id, body);
  }
}

/**
 * Fase RH · `[RH.1.2]` — la MISMA entrada, con las rutas y el encabezado del agente de Mega Talento.
 *
 * El agente que hoy corre en producción tiene fijas sus rutas (`/checador/ingesta`, `/latido`,
 * `/relojes`, `/comandos`) y manda la llave en `X-Agente-Token`. Con esta entrada, el corte de
 * asistencia es sólo configuración: en su `config.json`,
 *
 *   apiUrl = https://<suite>/api/hr/attendance/ingest/mt      token = <HR_INGEST_KEY>
 *
 * y el agente llama `<apiUrl>/checador/ingesta…` sin cambiarle código. Así el corte no depende
 * de mudar el lector al servidor (`[RH.1.3]`): son dos pasos que pueden ir en cualquier orden.
 * Mismo servicio, mismas respuestas; nada se reimplementa aquí.
 */
@ApiTags('hr')
@Controller('hr/attendance/ingest/mt/checador/ingesta')
@Public()
@SkipThrottle()
@UseGuards(HrIngestGuard)
export class HrAttendanceMtCompatController {
  constructor(private readonly service: HrAttendanceIngestService) {}

  @Post()
  @ApiOperation({ summary: 'RH — compatibilidad: lote del agente de Mega Talento.' })
  async ingest(@Body() body: IncomingBatch, @Res({ passthrough: true }) res: Response): Promise<IngestResult> {
    const r = await this.service.ingest(body);
    if (r.estado === 'serie_desconocida') res.status(409);
    else if (r.estado === 'pendiente') res.status(202);
    return r;
  }

  @Post('latido')
  @ApiOperation({ summary: 'RH — compatibilidad: latido del agente de Mega Talento.' })
  async latido(@Body() body: HeartbeatBody, @Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const r = await this.service.heartbeat(body);
    res.status(r.status);
    return r.body;
  }

  @Get('relojes')
  @ApiOperation({ summary: 'RH — compatibilidad: padrón de relojes para el agente de Mega Talento.' })
  relojes(@Query('sucursalId') sucursalId?: string, @Query('modo') modo?: string): Promise<Array<Record<string, unknown>>> {
    return this.service.registry({ sucursalId, modo });
  }

  @Get('comandos')
  @ApiOperation({ summary: 'RH — compatibilidad: órdenes pendientes para el agente de Mega Talento.' })
  comandos(@Query('serie') serie: string): Promise<OrdenParaAgente[]> {
    return this.service.ordenesPendientes(serie);
  }

  @Post('comandos/:id')
  @ApiOperation({ summary: 'RH — compatibilidad: resultado de una orden del agente de Mega Talento.' })
  reportar(@Param('id') id: string, @Body() body: { estado?: string; detalle?: string; respaldo?: unknown }): Promise<{ ok: true }> {
    return this.service.reportarOrden(id, body);
  }
}
