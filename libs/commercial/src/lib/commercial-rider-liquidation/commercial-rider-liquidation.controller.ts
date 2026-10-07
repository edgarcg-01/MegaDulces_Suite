import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialRiderLiquidationService } from './commercial-rider-liquidation.service';
import { CloseLiquidationDto, OpenLiquidationDto } from './dto/rider-liquidation.dto';

@ApiTags('commercial-rider-liquidation')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/rider-liquidations')
export class CommercialRiderLiquidationController {
  constructor(private readonly service: CommercialRiderLiquidationService) {}

  /** Abre (o devuelve) el corte del día para un repartidor. */
  @Post()
  @RequirePermissions(Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR)
  @ApiOperation({ summary: 'Abre el corte de caja del día para un repartidor.' })
  open(@Body() dto: OpenLiquidationDto) {
    return this.service.open(dto);
  }

  /** Lista los cortes (filtro por sucursal/fecha/estado). */
  @Get()
  @RequirePermissions(Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR)
  @ApiOperation({ summary: 'Lista los cortes de caja (cierre por sucursal).' })
  list(
    @Query('branch_store_id') branch_store_id?: string,
    @Query('business_date') business_date?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list({ branch_store_id, business_date, status });
  }

  /** Preview: totales computados del día sin cerrar (para armar el arqueo). */
  @Get(':id/preview')
  @RequirePermissions(Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR)
  @ApiOperation({ summary: 'Totales del día del repartidor (esperado) sin cerrar.' })
  preview(@Param('id') id: string) {
    return this.service.preview(id);
  }

  /** Cierra el corte con el arqueo por denominación. */
  @Post(':id/close')
  @RequirePermissions(Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR)
  @ApiOperation({ summary: 'Cierra el corte con el arqueo (billetes/monedas) y calcula la diferencia.' })
  close(@Param('id') id: string, @Body() dto: CloseLiquidationDto) {
    return this.service.close(id, dto);
  }

  /**
   * Fase LM.11 — ARQUEO CIEGO: el repartidor cierra SU corte del día contando el
   * efectivo sin ver lo esperado; la diferencia se revela en la respuesta.
   * Auto-scoped por JWT (no recibe rider_user_id).
   */
  @Post('my/blind-close')
  @RequirePermissions(Permission.REPARTO_ENTREGAR)
  @ApiOperation({ summary: 'Arqueo ciego del repartidor (cuenta sin ver lo esperado; revela diferencia).' })
  blindCloseOwn(@Body() dto: { business_date?: string; cash_breakdown: Record<string, number>; notes?: string }) {
    return this.service.blindCloseOwn(dto);
  }

  /** Fase LM.11 — el encargado reconcilia un corte ciego ya cerrado. */
  @Post(':id/reconcile')
  @RequirePermissions(Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR)
  @ApiOperation({ summary: 'Reconcilia (valida) un corte ciego cerrado por el repartidor.' })
  reconcile(@Param('id') id: string, @Body() dto: { notes?: string }) {
    return this.service.reconcile(id, dto?.notes);
  }
}
