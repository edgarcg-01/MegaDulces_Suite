import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { Customer360Service } from './customer-360.service';
import { Customer360RefreshService } from './customer-360-refresh.service';
import { DecisionEngineService } from './decision-engine.service';
import { CommerceAgentService } from './commerce-agent.service';
import { FeedbackService, RecordSignalDto } from './feedback.service';

@ApiTags('commercial-intelligence')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/intelligence')
export class CommercialIntelligenceController {
  constructor(
    private readonly customer360: Customer360Service,
    private readonly refresh: Customer360RefreshService,
    private readonly engine: DecisionEngineService,
    private readonly agent: CommerceAgentService,
    private readonly feedback: FeedbackService,
  ) {}

  // ─── Customer 360 (feature store) ───

  @Get('customer-360/my')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Customer 360 del JWT (Portal B2B). Recomputa si stale (>24h).' })
  my() {
    return this.customer360.getForMyCustomer();
  }

  @Get('customer-360/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Customer 360 de un customer (admin/vendor). Recomputa si stale.' })
  getForCustomer(@Param('customer_id') customerId: string) {
    return this.customer360.getForCustomer(customerId);
  }

  @Post('customer-360/:customer_id/compute')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Forzar recómputo del Customer 360 de un customer' })
  compute(@Param('customer_id') customerId: string) {
    return this.customer360.computeForCustomer(customerId);
  }

  @Post('customer-360/refresh')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_GESTIONAR)
  @ApiOperation({ summary: 'Trigger manual del cron: recomputa customer_360 de TODOS los tenants (admin)' })
  refreshAll() {
    return this.refresh.refreshAllTenants();
  }

  // ─── Next-Best-Action (Motor de Decisión) ───

  @Get('nba')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Customers due-for-reorder hoy (más urgentes primero). Para vendor/admin.' })
  nbaList(@Query('limit') limit?: string) {
    return this.engine.listDueForReorder(limit ? parseInt(limit, 10) || 50 : 50);
  }

  @Get('nba/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Next-Best-Action de un customer (¿toca reorden?)' })
  nba(@Param('customer_id') customerId: string) {
    return this.engine.nextBestAction(customerId);
  }

  @Get('nba/:customer_id/basket')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Canasta sugerida de reorden (categoría base de la canasta estratégica)' })
  basket(@Param('customer_id') customerId: string) {
    return this.engine.suggestedBasket(customerId);
  }

  @Get('nba/:customer_id/message')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Mensaje de reorden redactado (agente). Datos del motor; Claude solo redacta, fallback a plantilla.' })
  message(@Param('customer_id') customerId: string) {
    return this.agent.composeReorderMessage(customerId);
  }

  // ─── Feedback loop (oferta → resultado) ───

  @Post('signals')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Registra una señal del feedback loop (oferta/impresión) para un customer.' })
  recordSignal(@Body() dto: RecordSignalDto) {
    return this.feedback.record(dto);
  }

  @Post('signals/my')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Registra una señal para el customer del JWT (Portal B2B).' })
  recordMySignal(@Body() dto: { signal_type: string; channel: string; context?: Record<string, unknown> }) {
    return this.feedback.recordForMyCustomer(dto);
  }

  @Get('signals/summary')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Conversión del feedback loop: ofertas → pedidos en ventana (default 30d).' })
  signalsSummary(@Query('days') days?: string) {
    return this.feedback.conversionSummary(days ? parseInt(days, 10) || 30 : 30);
  }
}
