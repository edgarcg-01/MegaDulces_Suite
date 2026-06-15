import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { ThotService } from './thot.service';
import { PushDirectivesService, CreateDirectiveDto } from './push-directives.service';

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
    private readonly thot: ThotService,
    private readonly directives: PushDirectivesService,
  ) {}

  // ─── Thot T.2: empuje dirigido (el negocio decide qué empujar) ───

  @Get('directives')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_VER)
  @ApiOperation({ summary: 'Lista las directrices de empuje (marca foco / producto / categoría) con su target.' })
  listDirectives() {
    return this.directives.list();
  }

  @Get('directives/brands')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Marcas comerciales (picker de marca foco). ?search=' })
  directiveBrands(@Query('search') search?: string) {
    return this.directives.listBrands(search);
  }

  @Post('directives')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Crea una directriz de empuje (focus_brand / manual_product / manual_category).' })
  createDirective(@Body() body: CreateDirectiveDto) {
    return this.directives.create(body);
  }

  @Patch('directives/:id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Edita una directriz (boost / reason / sponsor / active / valid_to).' })
  updateDirective(
    @Param('id') id: string,
    @Body() body: { boost?: number; reason?: string; sponsor?: string; active?: boolean; valid_to?: string | null },
  ) {
    return this.directives.update(id, body);
  }

  @Delete('directives/:id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Elimina (soft) una directriz de empuje.' })
  removeDirective(@Param('id') id: string) {
    return this.directives.remove(id);
  }

  // ─── Thot: recomendación producto-first (afinidad + zona + rotación + margen) ───

  @Get('thot/suggest/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Thot sugiere qué ofrecer a un cliente. ?cart=id,id (afinidad/completá canasta) · ?zona= · ?limit= · ?log=<canal> registra la oferta (items+reason) para el feedback loop',
  })
  async thotSuggest(
    @Param('customer_id') customerId: string,
    @Query('cart') cart?: string,
    @Query('zona') zona?: string,
    @Query('limit') limit?: string,
    @Query('log') log?: string,
  ) {
    const suggestions = await this.thot.suggest(customerId, {
      cartProductIds: cart ? cart.split(',').filter(Boolean) : [],
      zona: zona || null,
      limit: limit ? parseInt(limit, 10) || 12 : 12,
    });
    // Feedback loop: registrar la oferta con sus items+reason (atribución product-level).
    // Best-effort: el log nunca debe romper la recomendación. El caller pasa ?log solo
    // en la carga inicial (no en recálculos por carrito) para no inflar impresiones.
    if (log && suggestions.length > 0) {
      this.feedback
        .record({
          customer_id: customerId,
          signal_type: 'offer_shown',
          channel: log.slice(0, 20),
          context: { source: 'thot', items: suggestions.map((s) => ({ p: s.product_id, r: s.reason })) },
        })
        .catch(() => undefined);
    }
    return suggestions;
  }

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

  @Get('signals/conversion-by-reason')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary: 'Conversión ATRIBUIDA por razón de Thot (whitespace/recompra/afinidad/...). Producto ofrecido → comprado en ventana. ?days= ?attribution_days=',
  })
  conversionByReason(@Query('days') days?: string, @Query('attribution_days') attr?: string) {
    return this.feedback.conversionByReason(
      days ? parseInt(days, 10) || 30 : 30,
      attr ? parseInt(attr, 10) || 7 : 7,
    );
  }
}
