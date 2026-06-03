import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialRouteControlService } from './commercial-route-control.service';
import {
  GuardarRouteTicketDto,
  ListRouteTicketsQuery,
  RouteReportQuery,
  RouteTicketType,
  UpdateRouteTicketDto,
} from './dto/route-ticket.dto';

@ApiTags('commercial-route-control')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/route-tickets')
export class CommercialRouteControlController {
  constructor(private readonly service: CommercialRouteControlService) {}

  /** OCR del ticket (Claude vision) sin guardar — preview para revisión. */
  @Post('procesar')
  @RequirePermissions(Permission.ROUTE_TICKET_CAPTURE)
  @Throttle({ long: { ttl: 60_000, limit: 15 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({ summary: 'Sube foto de ticket de ruta → campos OCR (sin guardar).' })
  procesar(
    @UploadedFile() file: Express.Multer.File,
    @Body('ticket_type') ticketType: RouteTicketType,
  ) {
    return this.service.procesar(file, ticketType);
  }

  /** Guarda el ticket revisado. */
  @Post()
  @RequirePermissions(Permission.ROUTE_TICKET_CAPTURE)
  @ApiOperation({ summary: 'Guarda un ticket de ruta revisado.' })
  guardar(@Body() dto: GuardarRouteTicketDto) {
    return this.service.guardar(dto);
  }

  /** Lista los tickets del propio vendedor. */
  @Get()
  @RequirePermissions(Permission.ROUTE_TICKET_CAPTURE)
  @ApiOperation({ summary: 'Lista los tickets de ruta del vendedor autenticado.' })
  listMine(@Query() q: ListRouteTicketsQuery) {
    return this.service.listMine(q);
  }

  // Reportes admin — declarados ANTES de :id para no colisionar.
  @Get('reports/resumen')
  @RequirePermissions(Permission.ROUTE_CONTROL_VER)
  @ApiOperation({ summary: 'Resumen de ruta (ventas, gasto combustible, rentabilidad). carga excluido de gasto.' })
  resumen(@Query() q: RouteReportQuery) {
    return this.service.resumen(q);
  }

  @Get('reports/por-ruta')
  @RequirePermissions(Permission.ROUTE_CONTROL_VER)
  @ApiOperation({ summary: 'Totales por código de ruta (carga excluida).' })
  porRuta(@Query() q: RouteReportQuery) {
    return this.service.porRuta(q);
  }

  @Get('reports/por-usuario')
  @RequirePermissions(Permission.ROUTE_CONTROL_VER)
  @ApiOperation({ summary: 'Totales por vendedor (carga excluida).' })
  porUsuario(@Query() q: RouteReportQuery) {
    return this.service.porUsuario(q);
  }

  @Get(':id')
  @RequirePermissions(Permission.ROUTE_TICKET_CAPTURE)
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ROUTE_TICKET_CAPTURE)
  update(@Param('id') id: string, @Body() dto: UpdateRouteTicketDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.ROUTE_CONTROL_VER)
  @ApiOperation({ summary: 'Soft-delete de un ticket (admin).' })
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
