import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BinLocationService, CreateBinDto, PutAwayDto } from './bin-location.service';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level, ADR-044).
 * Bins (layout) = ASIGNAR · put-away = RECIBIR · lecturas = VER.
 */
@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory')
export class BinLocationController {
  constructor(private readonly service: BinLocationService) {}

  @Post('bins')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Crear un bin (posición física)' })
  createBin(@Body() body: CreateBinDto) {
    return this.service.createBin(body);
  }

  @Get('bins')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Listar bins (?warehouse_id=) + unidades ubicadas' })
  listBins(@Query('warehouse_id') warehouseId?: string) {
    return this.service.listBins(warehouseId);
  }

  @Delete('bins/:id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Eliminar un bin (debe estar vacío)' })
  deleteBin(@Param('id') id: string) {
    return this.service.deleteBin(id);
  }

  @Get('bins/:id/contents')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Contenido de un bin (lotes + cantidades)' })
  binContents(@Param('id') id: string) {
    return this.service.binContents(id);
  }

  @Post('put-away')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Ubicar (put-away) cantidad de un lote en un bin (por bin_id o bin_code)' })
  putAway(@Body() body: PutAwayDto) {
    return this.service.putAway(body);
  }

  @Get('locations')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Auxiliar de ubicaciones: dónde está cada lote (?warehouse_id=&product_id=)' })
  locations(@Query('warehouse_id') warehouseId?: string, @Query('product_id') productId?: string) {
    return this.service.locations({ warehouse_id: warehouseId, product_id: productId });
  }

  @Get('unlocated')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'Lotes con cantidad por ubicar (recibidos, no colocados aún)' })
  unlocated(@Query('warehouse_id') warehouseId?: string, @Query('product_id') productId?: string) {
    return this.service.unlocated({ warehouse_id: warehouseId, product_id: productId });
  }

  @Get('pick-suggestion')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_VER)
  @ApiOperation({ summary: 'FEFO físico: bins de un producto ordenados por caducidad (surtí primero el 1º)' })
  pickSuggestion(@Query('warehouse_id') warehouseId: string, @Query('product_id') productId: string) {
    return this.service.pickSuggestion(warehouseId, productId);
  }
}
