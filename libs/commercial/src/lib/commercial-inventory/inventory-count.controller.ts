import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryCountService } from './inventory-count.service';
import type {
  OpenCountDto,
  SubmitCountDto,
  ResolveItemDto,
} from './inventory-count.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * Inventario físico (Fase I). Endpoints gateados por la jerarquía:
 *   CONTAR      → enviar conteos (ciego).
 *   SUPERVISAR  → abrir folio, ver avance/items, calcular discrepancias, resolver.
 *   RECONCILIAR → autorizar el ajuste de saldo y cerrar.
 */
@ApiTags('commercial-inventory-counts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/counts')
export class InventoryCountController {
  constructor(private readonly service: InventoryCountService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Listar folios de inventario' })
  list(@Query('warehouse_id') warehouseId?: string) {
    return this.service.listCounts(warehouseId);
  }

  @Post('open')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Abrir folio + snapshot del teórico (por almacén)' })
  open(@Body() body: OpenCountDto) {
    return this.service.openCount(body);
  }

  @Post(':id/count')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_CONTAR)
  @ApiOperation({ summary: 'Registrar conteo CIEGO (barcode o product_id)' })
  submit(@Param('id') id: string, @Body() body: SubmitCountDto) {
    return this.service.submitCount(id, body);
  }

  @Get(':id/count-progress')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_CONTAR)
  @ApiOperation({ summary: 'Avance CIEGO para el contador (sin teórico ni varianza)' })
  countProgress(@Param('id') id: string) {
    return this.service.counterProgress(id);
  }

  @Get(':id/progress')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Tablero del supervisor: avance, discrepancias, valor en riesgo' })
  progress(@Param('id') id: string) {
    return this.service.getProgress(id);
  }

  @Get(':id/items')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Items del folio con teórico + varianza (no para contadores)' })
  items(@Param('id') id: string, @Query('status') status?: string) {
    return this.service.listItems(id, status);
  }

  @Post(':id/compute')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Calcular discrepancias y pasar a review' })
  compute(@Param('id') id: string) {
    return this.service.computeDiscrepancies(id);
  }

  @Post(':id/items/:itemId/resolve')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Resolver manualmente el valor final de un item' })
  resolve(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: ResolveItemDto,
  ) {
    return this.service.resolveItem(id, itemId, body);
  }

  @Post(':id/reconcile')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECONCILIAR)
  @ApiOperation({ summary: 'Reconciliar: ajustar stock al físico + cerrar folio' })
  reconcile(@Param('id') id: string) {
    return this.service.reconcile(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECONCILIAR)
  @ApiOperation({ summary: 'Cancelar folio' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }
}
