import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  LogisticsCartaporteService,
  EmisorProfileDto,
} from './logistics-cartaporte.service';

@ApiTags('logistics-cartaporte')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('logistics/cartaporte')
export class LogisticsCartaporteController {
  constructor(private readonly service: LogisticsCartaporteService) {}

  @Get('emisor')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_VER)
  @ApiOperation({ summary: 'Perfil fiscal del emisor (transportista)' })
  getEmisor() {
    return this.service.getEmisorProfile();
  }

  @Put('emisor')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_GESTIONAR)
  @ApiOperation({ summary: 'Crear/actualizar perfil fiscal del emisor' })
  upsertEmisor(@Body() body: EmisorProfileDto) {
    return this.service.upsertEmisorProfile(body);
  }

  @Get('shipment/:id/validate')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_VER)
  @ApiOperation({ summary: 'Datos faltantes para timbrar (vacío = listo)' })
  validate(@Param('id') id: string) {
    return this.service.validateShipment(id);
  }

  @Post('shipment/:id/stamp')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_GESTIONAR)
  @ApiOperation({ summary: 'Timbrar Carta Porte (CFDI Traslado) del embarque' })
  stamp(@Param('id') id: string) {
    return this.service.stampShipment(id);
  }

  @Get('shipment/:id')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_VER)
  @ApiOperation({ summary: 'Documentos Carta Porte de un embarque' })
  byShipment(@Param('id') id: string) {
    return this.service.findByShipment(id);
  }

  @Get(':id')
  @RequirePermissions(Permission.LOGISTICS_CARTAPORTE_VER)
  @ApiOperation({ summary: 'Documento Carta Porte por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }
}
