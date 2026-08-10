import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PromoterBrandsService } from './promoter-brands.service';

/**
 * Fase P2.6 — Promotores de marca propia. `mine` lo lee cualquier capturador
 * (scoping del Control de Caducidades); la gestión (asignar marcas a un usuario)
 * requiere USUARIOS_GESTIONAR.
 */
@ApiTags('commercial-promoter-brands')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/promoter-brands')
export class PromoterBrandsController {
  constructor(private readonly service: PromoterBrandsService) {}

  @Get('mine')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Marcas del usuario logueado (vacío = no es promotor → ve todo)' })
  mine() {
    return this.service.mine();
  }

  @Get()
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Admin — lista de promotores con sus marcas' })
  list() {
    return this.service.listPromoters();
  }

  @Get('brands')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Admin — marcas asignables (con productos activos)' })
  brands(@Query('search') search?: string) {
    return this.service.assignableBrands(search);
  }

  @Get('users')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Admin — usuarios candidatos a promotor' })
  users(@Query('search') search?: string) {
    return this.service.candidateUsers(search);
  }

  @Put(':userId')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Admin — reemplaza el set de marcas de un usuario' })
  setBrands(@Param('userId') userId: string, @Body() body: { brand_ids?: string[] }) {
    return this.service.setUserBrands(userId, body?.brand_ids || []);
  }
}
