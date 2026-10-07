import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialVendorSalesService } from './commercial-vendor-sales.service';
import {
  CrearVendorSaleDto,
  ListVendorSalesQuery,
  VendorSalesReportQuery,
} from './dto/vendor-sale.dto';

@ApiTags('commercial-vendor-sales')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/vendor-sales')
export class CommercialVendorSalesController {
  constructor(private readonly service: CommercialVendorSalesService) {}

  /** Registra las líneas de venta de una captura del vendedor. */
  @Post()
  @RequirePermissions(Permission.CAPTURE_TICKET_USE)
  @ApiOperation({ summary: 'Registra líneas de venta (productos OCR del ticket) ancladas a la tienda.' })
  crear(@Body() dto: CrearVendorSaleDto) {
    return this.service.crear(dto);
  }

  /** Lista las líneas de venta del propio vendedor. */
  @Get()
  @RequirePermissions(Permission.CAPTURE_TICKET_USE)
  @ApiOperation({ summary: 'Lista las líneas de venta del vendedor autenticado.' })
  listMine(@Query() q: ListVendorSalesQuery) {
    return this.service.listMine(q);
  }

  // Reportes admin.
  @Get('reports/por-tienda')
  @RequirePermissions(Permission.COMMERCIAL_VENDOR_SALES_VER)
  @ApiOperation({ summary: 'Venta por tienda/cliente (capturas, líneas, unidades).' })
  porTienda(@Query() q: VendorSalesReportQuery) {
    return this.service.porTienda(q);
  }

  @Get('reports/por-captura')
  @RequirePermissions(Permission.COMMERCIAL_VENDOR_SALES_VER)
  @ApiOperation({ summary: 'Venta por captura/ticket de vendedor.' })
  porCaptura(@Query() q: VendorSalesReportQuery) {
    return this.service.porCaptura(q);
  }

  @Get('reports/por-ruta')
  @RequirePermissions(Permission.COMMERCIAL_VENDOR_SALES_VER)
  @ApiOperation({ summary: 'Venta por ruta del vendedor.' })
  porRuta(@Query() q: VendorSalesReportQuery) {
    return this.service.porRuta(q);
  }

  @Get('reports/captura-lines')
  @RequirePermissions(Permission.COMMERCIAL_VENDOR_SALES_VER)
  @ApiOperation({ summary: 'Líneas de una captura/ticket específico (drill-down).' })
  capturaLines(@Query('capture_ref') captureRef: string) {
    return this.service.linesByCapture(captureRef);
  }
}
