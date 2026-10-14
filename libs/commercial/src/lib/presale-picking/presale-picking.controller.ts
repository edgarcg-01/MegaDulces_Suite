import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import type {
  PresalePickDetail,
  PresalePickFinishRequest,
  PresalePickFinishResponse,
  PresalePickInboxResponse,
  PresalePickInboxRow,
  PresaleSellerStatusResponse,
} from '@megadulces/contracts';
import { PresalePickingService } from './presale-picking.service';

/**
 * `[MCP.3]` Bandeja del surtidor de la sucursal: los pedidos de preventa de SU almacén, por día,
 * y su surtido pedido por pedido. Cuelga de los permisos del surtido (`COMMERCIAL_PICKING_*`), que
 * son los que tiene el rol `surtidor`; el alcance por sucursal lo pone `ScopeService`.
 */
@ApiTags('warehouse-presale-picking')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/presale-picking')
export class PresalePickingController {
  constructor(private readonly service: PresalePickingService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Pedidos de preventa por surtir de mi sucursal, por día' })
  inbox(@Query() query: Record<string, unknown>): Promise<PresalePickInboxResponse> {
    return this.service.inbox(query);
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Un pedido para surtir, con sus renglones en la unidad capturada' })
  detail(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<PresalePickDetail> {
    return this.service.detail(id, query);
  }

  @Post(':id/start')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Empezar a surtir: registra quién y a qué hora' })
  start(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<PresalePickInboxRow> {
    return this.service.start(id, query);
  }

  @Post(':id/finish')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Terminar: hubo todo, o se quita del pedido lo que no hubo y se avisa a la vendedora' })
  finish(
    @Param('id') id: string,
    @Body() body: PresalePickFinishRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PresalePickFinishResponse> {
    return this.service.finish(id, body, query);
  }
}

/**
 * `[MCP.8]` El avance de los pedidos de la VENDEDORA en sesión. Sólo devuelve lo que ella levantó
 * (`orders.user_id`), así que basta con poder entrar a la app de vendedor o ver pedidos.
 */
@ApiTags('vendor-presale-status')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('vendor/presale-status')
export class PresaleSellerStatusController {
  constructor(private readonly service: PresalePickingService) {}

  @Get()
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Mis pedidos de preventa: agendado, surtido, cobrado, entregado' })
  status(): Promise<PresaleSellerStatusResponse> {
    return this.service.sellerStatus();
  }

  @Get('unseen')
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Cuántos reportes de surtido no he visto (globito de la barra)' })
  unseen(): Promise<{ unseen_reports: number }> {
    return this.service.sellerUnseen();
  }

  @Post('seen')
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Marcar como vistos mis reportes de surtido' })
  seen(): Promise<{ updated: number }> {
    return this.service.sellerSeen();
  }
}
