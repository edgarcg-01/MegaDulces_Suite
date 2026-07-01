import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import {
  CommercialTeleventaService,
  LogCallDto,
} from './commercial-televenta.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * Autorización: lecturas exigen COMMERCIAL_TELEVENTA_VER; acciones (reservar /
 * liberar / registrar llamada) exigen COMMERCIAL_TELEVENTA_OPERATE. Antes este
 * controller NO tenía guard ni permisos → cualquier usuario autenticado accedía
 * a la cola/dashboard y podía operar. tele_operator tiene ambas claves;
 * supervisor tiene VER (lectura del dashboard) pero no OPERATE.
 */
@ApiTags('commercial-televenta')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/televenta')
export class CommercialTeleventaController {
  constructor(private readonly service: CommercialTeleventaService) {}

  @Get('queue')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_VER)
  @ApiOperation({
    summary:
      'Cola priorizada de clientes a llamar. Excluye los reservados activamente por otros operadores.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getQueue(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 50;
    return this.service.getQueue(Math.min(Math.max(n, 1), 200));
  }

  @Get('my-reservations')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_VER)
  @ApiOperation({ summary: 'Reservas activas del operador con TTL restante.' })
  getMyReservations() {
    return this.service.getMyReservations();
  }

  @Post('leads/:customer_id/reserve')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_OPERATE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reservar lead (TTL 30min). 409 si ya hay reserva activa.',
  })
  @ApiResponse({ status: 200, description: 'ReservationRecord' })
  @ApiResponse({ status: 404, description: 'Customer no existe.' })
  @ApiResponse({ status: 409, description: 'Ya reservado por otro.' })
  reserveLead(@Param('customer_id') customerId: string) {
    return this.service.reserveLead(customerId);
  }

  @Post('reservations/:reservation_id/release')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_OPERATE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Liberar una reserva activa del operador (manual).',
  })
  releaseLead(@Param('reservation_id') reservationId: string) {
    return this.service.releaseLead(reservationId, 'released_manual');
  }

  @Get('customers/:customer_id/snapshot')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_VER)
  @ApiOperation({
    summary:
      'Perfil cliente + últimos 5 pedidos + últimas 5 llamadas + reserva activa del operador (si la hay).',
  })
  getCustomerSnapshot(@Param('customer_id') customerId: string) {
    return this.service.getCustomerSnapshot(customerId);
  }

  @Get('customers/:customer_id/calls')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_VER)
  @ApiOperation({ summary: 'Historial de llamadas del cliente (default 20).' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getCustomerCalls(
    @Param('customer_id') customerId: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Number(limit) : 20;
    return this.service.getCustomerCallHistory(customerId, Math.min(Math.max(n, 1), 100));
  }

  @Post('calls')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_OPERATE)
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Registrar resultado de la llamada. Si release_reservation=true, cierra la reserva activa del operador sobre ese cliente. Si outcome=callback_scheduled, requiere next_action_at.',
  })
  logCall(@Body() body: LogCallDto) {
    return this.service.logCall(body);
  }

  @Get('dashboard')
  @RequirePermissions(Permission.COMMERCIAL_TELEVENTA_VER)
  @ApiOperation({
    summary: 'E.4: dashboard de métricas (KPIs hoy + conversión 7d + top operadores + outcomes breakdown + queue preview)',
  })
  dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.dashboardMetrics({ from, to });
  }
}
