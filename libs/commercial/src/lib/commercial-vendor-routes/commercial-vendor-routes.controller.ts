import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialVendorRoutesService,
  AssignRouteDto,
  SetRouteOrderDto,
  CheckInDto,
} from './commercial-vendor-routes.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

/**
 * V.0 Modo Vendedor v2 — gestión de cartera (vendedor → rutas de venta) y orden
 * de visita. Gestión gateada por USUARIOS_ASIGNAR_RUTA (lo tiene supervisor_ventas);
 * la lectura de "mi cartera" por COMMERCIAL_CUSTOMERS_VER (lo tiene el vendedor).
 */
@ApiTags('commercial-vendor-routes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/vendor-routes')
export class CommercialVendorRoutesController {
  constructor(private readonly service: CommercialVendorRoutesService) {}

  @Get('sales-routes')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Rutas de venta del tenant (distinct) + conteo de clientes + a quién están asignadas' })
  listSalesRoutes() {
    return this.service.listSalesRoutes();
  }

  @Get('vendors')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Vendedores asignables (usuarios de campo activos)' })
  listVendors() {
    return this.service.listVendors();
  }

  @Get('customers')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Clientes de una ruta (?sales_route=) ordenados por visit_sequence, para reordenar' })
  customersByRoute(@Query('sales_route') salesRoute: string) {
    return this.service.customersByRoute(salesRoute);
  }

  @Get('my')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({ summary: 'Cartera del vendedor logueado: sus rutas de venta' })
  myRoutes() {
    return this.service.myRoutes();
  }

  @Get('coverage')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary: 'V.4: cobertura del día — cartera del vendedor anotada con visited_today + última visita',
  })
  coverage() {
    return this.service.myCoverageToday();
  }

  @Post('check-in')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'V.4: registra un check-in de visita del vendedor a un cliente' })
  checkIn(@Body() body: CheckInDto) {
    return this.service.checkIn(body);
  }

  @Get()
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Asignaciones cartera (vendedor → rutas). ?user_id filtra por vendedor.' })
  listAssignments(@Query('user_id') userId?: string) {
    return this.service.listAssignments(userId);
  }

  @Post()
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Asigna una ruta de venta a un vendedor (idempotente)' })
  assign(@Body() body: AssignRouteDto) {
    return this.service.assign(body);
  }

  @Put('order')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Setea el orden de visita (visit_sequence 1..N) de los clientes de una ruta' })
  setOrder(@Body() body: SetRouteOrderDto) {
    return this.service.setRouteOrder(body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiOperation({ summary: 'Quita una asignación de ruta a vendedor' })
  unassign(@Param('id') id: string) {
    return this.service.unassign(id);
  }
}
