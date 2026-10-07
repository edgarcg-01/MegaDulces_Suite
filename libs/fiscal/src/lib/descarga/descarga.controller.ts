import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { DescargaService, CrearSolicitudInput } from './descarga.service';

interface AuthedRequest { user?: { id?: string; sub?: string } }

/**
 * FISCAL.4 — API de la descarga masiva de CFDI. Crear dispara el pipeline (WS SAT
 * sobre fiscal.jobs); la bandeja muestra estado (1-6 del doc) + paquetes.
 */
@ApiTags('fiscal-descarga')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/descarga')
export class DescargaController {
  constructor(private readonly svc: DescargaService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_DESCARGA_VER)
  @ApiOperation({ summary: 'Bandeja de solicitudes de descarga (estado + nº CFDIs + paquetes).' })
  list(@Query('estado') estado?: string) { return this.svc.list(estado); }

  @Get(':id')
  @RequirePermissions(Permission.FISCAL_DESCARGA_VER)
  @ApiOperation({ summary: 'Detalle de una solicitud + sus paquetes.' })
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Post()
  @RequirePermissions(Permission.FISCAL_DESCARGA_GESTIONAR)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Crea una solicitud de descarga y arranca el pipeline (solicitud→verificación→paquete).' })
  crear(@Body() body: CrearSolicitudInput, @Req() req: AuthedRequest) {
    return this.svc.crear(body, req.user?.id ?? req.user?.sub);
  }
}
