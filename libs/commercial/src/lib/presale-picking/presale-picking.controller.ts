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
  RouteBatchDetail,
  RouteBatchFinishRequest,
  RouteBatchFinishResponse,
  RouteBatchInboxResponse,
  RouteBatchRow,
  SellerRouteDay,
} from '@megadulces/contracts';
import { PresalePickingService } from './presale-picking.service';
import { PresaleRouteService } from './presale-route.service';

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
  constructor(
    private readonly service: PresalePickingService,
    private readonly rutas: PresaleRouteService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Pedidos de preventa por surtir de mi sucursal, por día' })
  inbox(@Query() query: Record<string, unknown>): Promise<PresalePickInboxResponse> {
    return this.service.inbox(query);
  }

  // ── [MCP.3.6] La ruta del vendedor como UN pedido global ──
  // ⚠️ Van ANTES de `@Get(':id')`: declaradas después, Nest toma `routes` por un id de pedido.

  @Get('routes')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'Rutas de hoy (y de ayer sin surtir) con pedidos de mi sucursal' })
  routes(@Query() query: Record<string, unknown>): Promise<RouteBatchInboxResponse> {
    return this.rutas.routes(query);
  }

  @Get('routes/:id')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_VER)
  @ApiOperation({ summary: 'El pedido global de una ruta: cada producto con su total y a quién le toca' })
  routeDetail(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<RouteBatchDetail> {
    return this.rutas.routeDetail(id, query);
  }

  @Post('routes/:id/start')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Empezar a surtir la ruta: registra quién y a qué hora' })
  routeStart(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<RouteBatchRow> {
    return this.rutas.routeStart(id, query);
  }

  @Post('routes/:id/finish')
  @RequirePermissions(Permission.COMMERCIAL_PICKING_GESTIONAR)
  @ApiOperation({ summary: 'Terminar la ruta: reparte lo encontrado en una bolsa por cliente y quita lo que no hubo' })
  routeFinish(
    @Param('id') id: string,
    @Body() body: RouteBatchFinishRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<RouteBatchFinishResponse> {
    return this.rutas.routeFinish(id, body, query);
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

/**
 * `[MCP.3.6]` La ruta del día del VENDEDOR en sesión: iniciarla, ver cuántos pedidos lleva y
 * finalizarla. Al finalizar, al surtidor le llega UN pedido global con todo lo de la ruta.
 */
@ApiTags('vendor-route-day')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('vendor/route-day')
export class SellerRouteDayController {
  constructor(private readonly rutas: PresaleRouteService) {}

  @Get()
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Mi ruta de hoy: sin iniciar, en ruta o finalizada, con sus pedidos' })
  myDay(): Promise<SellerRouteDay> {
    return this.rutas.myDay();
  }

  @Post('start')
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Iniciar mi ruta de hoy (idempotente)' })
  start(): Promise<SellerRouteDay> {
    return this.rutas.startDay();
  }

  @Post('finish')
  @RequireAnyPermission(Permission.VENDOR_APP_ACCESS, Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Finalizar mi ruta: sus pedidos le llegan al surtidor como uno solo' })
  finish(): Promise<SellerRouteDay> {
    return this.rutas.finishDay();
  }
}
