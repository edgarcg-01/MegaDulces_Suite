import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  ReqUser,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { ProspectsService } from './prospects.service';
import {
  ConvertProspectDto,
  IngestAreaDto,
  IngestNearbyDto,
  ProspectConfigDto,
  ProspectListFilterDto,
} from './dto/prospects.dto';

/**
 * Prospección DENUE: descubrir PdV reales que aún no son clientes y mostrarlos
 * como capa de oportunidad en el mapa comercial. Lectura gateada por VER; la
 * cosecha/dedup/alta/config por GESTIONAR.
 */
@ApiTags('commercial-map-prospects')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('commercial-map/prospects')
export class ProspectsController {
  constructor(private readonly service: ProspectsService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_VER)
  @ApiOperation({ summary: 'Tiendas de oportunidad (prospectos DENUE) para la capa del mapa' })
  list(@ReqUser() user: any, @Query() filters: ProspectListFilterDto) {
    return this.service.list(user, filters);
  }

  @Get('counts')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_VER)
  @ApiOperation({ summary: 'Conteo de prospectos por estado' })
  counts(@ReqUser() user: any) {
    return this.service.counts(user);
  }

  @Get('config')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_VER)
  @ApiOperation({ summary: 'Config de cosecha del tenant (SCIAN, área, radio)' })
  getConfig(@ReqUser() user: any) {
    return this.service.getConfig(user);
  }

  @Put('config')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Actualiza la config de cosecha' })
  updateConfig(@ReqUser() user: any, @Body() dto: ProspectConfigDto) {
    return this.service.updateConfig(user, dto);
  }

  @Get('quantify')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Cuantifica el universo DENUE por SCIAN en el área (planeación)' })
  quantify(@ReqUser() user: any) {
    return this.service.quantify(user);
  }

  @Post('ingest-nearby')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Cosecha POIs DENUE a ≤radius de un punto + dedup' })
  ingestNearby(@ReqUser() user: any, @Body() dto: IngestNearbyDto) {
    return this.service.ingestNearby(user, dto.lat, dto.lng, dto.radius);
  }

  @Post('ingest-area')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Cosecha sistemática por SCIAN en entidad/municipio + dedup' })
  ingestArea(@ReqUser() user: any, @Body() dto: IngestAreaDto) {
    return this.service.ingestArea(user, dto.entidad, dto.municipio);
  }

  @Post('dedup')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Re-corre el dedup contra stores + clientes' })
  dedup(@ReqUser() user: any) {
    return this.service.dedup(user);
  }

  @Post(':id/dismiss')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Descarta un prospecto' })
  dismiss(@ReqUser() user: any, @Param('id') id: string) {
    return this.service.dismiss(user, id);
  }

  @Post(':id/convert')
  @RequirePermissions(Permission.COMMERCIAL_MAP_PROSPECTS_GESTIONAR)
  @ApiOperation({ summary: 'Marca un prospecto como convertido (alta real vía clientes)' })
  convert(@ReqUser() user: any, @Param('id') id: string, @Body() dto: ConvertProspectDto) {
    return this.service.markConverted(user, id, dto.customer_id);
  }
}
