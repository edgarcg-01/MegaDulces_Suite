import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { EstatusService } from './estatus.service';

/** FISCAL.6 — API de validación de estatus CFDI ante el SAT. */
@ApiTags('fiscal-estatus')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/estatus')
export class EstatusController {
  constructor(private readonly svc: EstatusService) {}

  @Post('check')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @Throttle({ long: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Consulta el estatus (vigente/cancelado) de un lote de CFDI del tenant ante el SAT.' })
  check(@Body() body: { limit?: number }) { return this.svc.checkCurrent(Math.min(Number(body?.limit) || 200, 1000)); }
}
