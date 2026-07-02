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
  SetLocationDto,
  FinishVisitDto,
  CreateVendorCustomerDto,
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
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({ summary: 'Rutas de venta del tenant (distinct) + conteo de clientes + a quién están asignadas' })
  listSalesRoutes() {
    return this.service.listSalesRoutes();
  }

  @Get('vendors')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({ summary: 'Vendedores asignables (usuarios de campo activos)' })
  listVendors() {
    return this.service.listVendors();
  }

  @Get('customers')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
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

  @Get('home')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary: 'V.5: feed "Mi ruta" — cartera anotada (visitado/ordenado hoy + pedidos pendientes) de un fetch',
  })
  home() {
    return this.service.myHome();
  }

  @Post('check-in')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'V.4: registra un check-in de visita del vendedor a un cliente (acepta lat/lng → backfill capture-on-visit)' })
  checkIn(@Body() body: CheckInDto) {
    return this.service.checkIn(body);
  }

  @Post('visits/finish')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'V.7: cierra la visita con su resultado (had_order/had_ticket/no_sale_reason); reusa la visita abierta de hoy o crea una' })
  finishVisit(@Body() body: FinishVisitDto) {
    return this.service.finishVisit(body);
  }

  @Get('nearby')
  @RequirePermissions(Permission.COMMERCIAL_CUSTOMERS_VER)
  @ApiOperation({
    summary: 'V.6: clientes de la cartera cerca del vendedor (?lat&lng&radius), ordenados por distancia',
  })
  nearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
  ) {
    return this.service.nearbyCustomers(
      Number(lat),
      Number(lng),
      radius != null ? Number(radius) : undefined,
    );
  }

  @Post('customers/:id/location')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({
    summary: 'V.6: setea/corrige las coords del cliente con guard anti-traslape (force para confirmar pese a colisión)',
  })
  setLocation(@Param('id') id: string, @Body() body: SetLocationDto) {
    return this.service.setCustomerLocation(id, body);
  }

  @Post('customers')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({
    summary:
      'Alta rápida de cliente desde la app del vendedor (auto-genera code + price list default + geo opcional). Solo crea.',
  })
  createCustomer(@Body() body: CreateVendorCustomerDto) {
    return this.service.createCustomer(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({ summary: 'Asignaciones cartera (vendedor → rutas). ?user_id filtra por vendedor.' })
  listAssignments(@Query('user_id') userId?: string) {
    return this.service.listAssignments(userId);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_GESTIONAR)
  @ApiOperation({ summary: 'Asigna una ruta de venta a un vendedor (idempotente)' })
  assign(@Body() body: AssignRouteDto) {
    return this.service.assign(body);
  }

  @Put('order')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_GESTIONAR)
  @ApiOperation({ summary: 'Setea el orden de visita (visit_sequence 1..N) de los clientes de una ruta' })
  setOrder(@Body() body: SetRouteOrderDto) {
    return this.service.setRouteOrder(body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_GESTIONAR)
  @ApiOperation({ summary: 'Quita una asignación de ruta a vendedor' })
  unassign(@Param('id') id: string) {
    return this.service.unassign(id);
  }
}
