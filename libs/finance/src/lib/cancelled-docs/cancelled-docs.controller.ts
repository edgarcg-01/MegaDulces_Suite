import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CancelledDocsService } from './cancelled-docs.service';

/**
 * Apartado de documentos cancelados de Kepler (c43='C'). Read-only sobre
 * analytics.kepler_cancelled_docs. Permiso FINANCE_BANK_VER (misma persona que los cuadres
 * de Caja/Bancos, que es de donde se excluyen).
 */
@ApiTags('finance-cancelled-docs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cancelled-docs')
export class CancelledDocsController {
  constructor(private readonly svc: CancelledDocsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Documentos cancelados de Kepler (pago/entrada/cobro) del periodo. Filtros: month, categoria, search.' })
  list(@Query('month') month?: string, @Query('categoria') categoria?: string, @Query('search') search?: string) {
    return this.svc.list({ month, categoria, search });
  }

  @Get('facets')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Meses y categorías disponibles para el filtro.' })
  facets() {
    return this.svc.facets();
  }
}
