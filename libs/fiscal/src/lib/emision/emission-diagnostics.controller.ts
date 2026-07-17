import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { EmissionDiagnosticsService } from './emission-diagnostics.service';
import { EmissionErrorKind } from './emission-errors.service';

/**
 * FD.2 — API del tablero de Diagnóstico de facturación. Lecturas con
 * FISCAL_FACTURAR_VER; descartar con FISCAL_FACTURAR_GESTIONAR. El reintento del
 * timbrado ligado a pedido lo hace Comercial (POST /commercial/orders/retry-invoices).
 */
@ApiTags('fiscal-diagnostics')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/diagnostics')
export class EmissionDiagnosticsController {
  constructor(private readonly svc: EmissionDiagnosticsService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'Errores de emisión capturados, enriquecidos con la solución sugerida (SAT/PAC).' })
  list(@Query() q: { status?: 'open' | 'resolved' | 'all'; kind?: EmissionErrorKind; limit?: number }) {
    return this.svc.list(q);
  }

  @Get('stats')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'KPIs del tablero: abiertos, críticos, por tipo y severidad.' })
  stats() {
    return this.svc.stats();
  }

  @Get('catalog')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'Base de conocimiento SAT/PAC (códigos → causa + solución).' })
  catalog() {
    return this.svc.catalog();
  }

  @Get('health')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'FD.3 — revisión preventiva: emisor, e.firma y cobertura de código agrupador.' })
  health() {
    return this.svc.health();
  }

  @Get(':id')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'Detalle de un error (incluye el sobre crudo del PAC).' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  @Post(':id/dismiss')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({ summary: 'Descarta un error (ya atendido / no aplica).' })
  dismiss(@Param('id') id: string) {
    return this.svc.dismiss(id);
  }
}
