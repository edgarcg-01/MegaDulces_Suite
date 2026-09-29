import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type {
  CreatePurchaseDeliveryDto, DeliveryDateBasis, DeliveryRecipient, PendingReceiptsResponse, PurchaseDeliveryDetail,
  PurchaseDeliveryStatus, PurchaseDeliverySummary,
} from '@megadulces/contracts';
import { PurchaseDeliveriesService } from './purchase-deliveries.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * `[RE.32]` — Entrega de compras recibidas a Finanzas.
 *
 * Permisos (ninguno nuevo):
 *   · pendientes / armar la entrega / cancelarla → Compras (`COMPRAS_OBLIGACIONES_*`): el auxiliar.
 *   · ver entregas y su detalle (PDF) → Compras O Finanzas (`RequireAnyPermission`): las dos puntas
 *     del papel tienen que poder abrirlo (GOTCHAS §4: cada vista funciona con SUS permisos).
 *   · confirmar / rechazar renglones → `FINANCE_PAYMENTS_GESTIONAR` y, además, SER la persona a quien
 *     se le entregó (lo valida el servicio: una llave amplia no basta para firmar por otro).
 */
@ApiTags('commercial-purchase-deliveries')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/purchase-deliveries')
export class PurchaseDeliveriesController {
  constructor(private readonly svc: PurchaseDeliveriesService) {}

  @Get('pending')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Compras recibidas sin entregar a Finanzas. date_basis = recepcion | factura; from/to YYYY-MM-DD; sucursal opcional. Orden: sucursal, fecha, proveedor A-Z.' })
  pending(
    @Query('date_basis') date_basis?: DeliveryDateBasis,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sucursal') sucursal?: string,
  ): Promise<PendingReceiptsResponse> {
    return this.svc.pending({ date_basis, from, to, sucursal });
  }

  @Get('recipients')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Personas de Finanzas/Tesorería que pueden recibir una entrega.' })
  recipients(): Promise<DeliveryRecipient[]> {
    return this.svc.recipients();
  }

  @Get()
  @RequireAnyPermission(Permission.COMPRAS_OBLIGACIONES_VER, Permission.FINANCE_PAYMENTS_GESTIONAR)
  list(@Query('status') status?: PurchaseDeliveryStatus, @Query('mine') mine?: string, @Req() req?: AuthedRequest): Promise<PurchaseDeliverySummary[]> {
    // `mine=1` = las que me entregaron a mí (bandeja de Finanzas).
    return this.svc.list({ status, mine: mine ? req?.user?.username : undefined });
  }

  @Get(':id')
  @RequireAnyPermission(Permission.COMPRAS_OBLIGACIONES_VER, Permission.FINANCE_PAYMENTS_GESTIONAR)
  detail(@Param('id') id: string): Promise<PurchaseDeliveryDetail> {
    return this.svc.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Genera la entrega (folio ENT-YYYY-NNNNN) con las entradas marcadas y la persona de Finanzas que recibe.' })
  create(@Body() dto: CreatePurchaseDeliveryDto, @Req() req: AuthedRequest): Promise<PurchaseDeliveryDetail> {
    return this.svc.create(dto, req.user?.username || 'sistema');
  }

  @Post(':id/recibir')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Finanzas confirma la entrega. Los renglones en `rejections` (con motivo) regresan a pendientes; el resto queda aceptado.' })
  receive(@Param('id') id: string, @Body() body: { rejections?: { line_id: string; reason: string }[] }, @Req() req: AuthedRequest): Promise<PurchaseDeliveryDetail> {
    return this.svc.receive(id, body || {}, req.user?.username || 'sistema');
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Compras cancela una entrega que Finanzas todavía no confirma (con motivo). Todo regresa a pendientes.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest): Promise<PurchaseDeliveryDetail> {
    return this.svc.cancel(id, body?.reason, req.user?.username || 'sistema');
  }
}
