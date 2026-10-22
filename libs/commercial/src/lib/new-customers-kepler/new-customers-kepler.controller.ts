import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  KeplerCustomerLookup,
  LinkKeplerRequest,
  LinkKeplerResponse,
  NewCustomersInboxResponse,
  NewCustomersSummary,
  SimilarCustomersResponse,
} from '@megadulces/contracts';
import { NewCustomersKeplerService } from './new-customers-kepler.service';

/**
 * `[MCP.3.8]` Bandeja «Clientes nuevos por dar de alta en Kepler» de la sucursal.
 *
 * Cuelga de los permisos del surtido (`COMMERCIAL_PICKING_*`, decisión del usuario 2026-10-21):
 * el surtidor ya los tiene y no se reparte uno nuevo. Ver = `_VER`; ligar escribe = `_GESTIONAR`.
 * El alcance por sucursal lo pone `ScopeService`, como en el surtido de preventa.
 */
@ApiTags('warehouse-new-customers')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/new-customers')
export class NewCustomersKeplerController {
  constructor(private readonly service: NewCustomersKeplerService) {}

  @Get()
  @RequireAnyPermission(Permission.COMMERCIAL_PICKING_VER, Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Clientes nuevos de mi sucursal sin clave de Kepler, con sus pedidos pendientes' })
  inbox(@Query() query: Record<string, unknown>): Promise<NewCustomersInboxResponse> {
    return this.service.inbox(query);
  }

  // ⚠️ Antes de `:id/...`: si no, Nest toma `summary` por un id.
  @Get('summary')
  @RequireAnyPermission(Permission.COMMERCIAL_PICKING_VER, Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Cuántos clientes nuevos faltan por ligar y qué pedidos son suyos (aviso de Surtir)' })
  summary(@Query() query: Record<string, unknown>): Promise<NewCustomersSummary> {
    return this.service.summary(query);
  }

  @Get(':id/kepler')
  @RequireAnyPermission(Permission.COMMERCIAL_PICKING_VER, Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Busca la clave en Kepler (ODS) de la sucursal del cliente, para confirmar el nombre' })
  lookup(
    @Param('id') id: string,
    @Query('code') code: string,
    @Query() query: Record<string, unknown>,
  ): Promise<KeplerCustomerLookup> {
    return this.service.lookup(id, code, query);
  }

  @Post(':id/link')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Liga el cliente con su clave de Kepler: la misma fila toma los datos de Kepler' })
  link(
    @Param('id') id: string,
    @Body() body: LinkKeplerRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<LinkKeplerResponse> {
    return this.service.link(id, body?.erp_customer_code, query);
  }
}

/**
 * `[MCP.3.8]` «¿Es este?» del alta de cliente en la app del vendedor. Mismo permiso que el alta
 * (`POST /commercial/vendor-routes/customers` = `COMMERCIAL_CARTERA_VER`).
 */
@ApiTags('commercial-new-customers')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/new-customers')
export class SimilarCustomersController {
  constructor(private readonly service: NewCustomersKeplerService) {}

  @Get('similar')
  @RequirePermissions(Permission.COMMERCIAL_CARTERA_VER)
  @ApiOperation({ summary: 'Clientes de mi sucursal con nombre parecido, antes de dar de alta uno nuevo' })
  similar(@Query('name') name: string): Promise<SimilarCustomersResponse> {
    return this.service.similar(name);
  }
}
