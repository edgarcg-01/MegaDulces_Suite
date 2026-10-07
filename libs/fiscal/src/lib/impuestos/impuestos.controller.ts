import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ImpuestosService } from './impuestos.service';

/** FISCAL.18 — API de pago provisional (ISR + IVA). Cálculo de apoyo — validar con contador. */
@ApiTags('fiscal-impuestos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/impuestos')
export class ImpuestosController {
  constructor(private readonly svc: ImpuestosService) {}

  @Get('provisional')
  @RequirePermissions(Permission.FISCAL_IMPUESTOS_VER)
  @ApiOperation({ summary: 'Pago provisional mensual ISR+IVA (period=YYYY-MM, cu=coeficiente de utilidad). Apoyo — validar con contador.' })
  provisional(@Query() q: any) {
    return this.svc.pagoProvisional(q.period, {
      coeficiente_utilidad: Number(q.cu),
      tasa_isr: q.tasa != null ? Number(q.tasa) : undefined,
      ptu_pagada: Number(q.ptu) || 0,
      perdidas_pendientes: Number(q.perdidas) || 0,
      pagos_provisionales_previos: Number(q.pagos_previos) || 0,
      isr_retenido: Number(q.retenido) || 0,
    });
  }
}
