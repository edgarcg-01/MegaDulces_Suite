import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

interface AuthUser {
  sub: string;
  username?: string;
  rules?: unknown[];
}

@ApiTags('stores')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get('nearby')
  @RequirePermissions(Permission.TIENDAS_VER)
  @ApiOperation({ summary: 'Buscar tiendas cercanas por GPS' })
  findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @ReqUser() user: AuthUser,
    @Query('radius') radius?: string,
  ) {
    return this.storesService.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      radius ? parseFloat(radius) : 30,
      user,
    );
  }

  @Get('version')
  @RequirePermissions(Permission.TIENDAS_VER)
  @ApiOperation({
    summary:
      'Version stamp del catalogo de tiendas. El frontend lo usa para decidir si redescargar el cache offline (IndexedDB).',
  })
  catalogVersion(@ReqUser() user: AuthUser) {
    return this.storesService.getCatalogVersion(user);
  }

  @Get('all-for-sync')
  @RequirePermissions(Permission.TIENDAS_VER)
  @ApiOperation({
    summary:
      'Catalogo completo de tiendas activas (con coords) para detection por GPS offline via Haversine en cliente.',
  })
  allForSync(@ReqUser() user: AuthUser) {
    return this.storesService.findAllForOfflineSync(user);
  }

  @Get()
  @RequirePermissions(Permission.TIENDAS_VER)
  @ApiOperation({
    summary: 'Lista de PDV activos. Scope-aware por zona del requester.',
  })
  findAll(
    @ReqUser() user: AuthUser,
    // Params canónicos en inglés. Mantenemos `zona_id`/`ruta_id` como alias
    // por compat con cualquier consumer no migrado (scripts, integraciones).
    // El EN tiene prioridad si vienen ambos.
    @Query('zone_id') zone_id?: string,
    @Query('route_id') route_id?: string,
    @Query('zona_id') zona_id?: string,
    @Query('ruta_id') ruta_id?: string,
  ) {
    return this.storesService.findAll(
      zone_id ?? zona_id,
      route_id ?? ruta_id,
      user,
    );
  }

  @Post()
  @RequirePermissions(Permission.TIENDAS_CREAR)
  @ApiOperation({ summary: 'Crear nueva tienda o supermercado' })
  create(@Body() dto: CreateStoreDto, @ReqUser() user: AuthUser) {
    return this.storesService.create(dto, user);
  }

  @Delete(':id')
  @RequirePermissions(Permission.CATALOGO_GESTIONAR)
  @ApiOperation({
    summary: 'Eliminar tienda (soft delete — mantiene historial de visitas)',
  })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqUser() user: AuthUser,
  ) {
    return this.storesService.remove(id, user);
  }

  @Put(':id')
  @RequirePermissions(Permission.TIENDAS_CREAR)
  @ApiOperation({ summary: 'Actualizar metadata física del PDV' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStoreDto,
    @ReqUser() user: AuthUser,
  ) {
    return this.storesService.update(id, dto, user);
  }
}
