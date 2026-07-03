import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Public, RequirePermissions, Permission, ReqUser } from '@megadulces/platform-core';
import { StoreService } from './store.service';
import { StoreIngestGuard } from './store-ingest.guard';
import { LiveTicket } from './store.types';

@ApiTags('store')
@Controller('store/live')
export class StoreController {
  constructor(private readonly service: StoreService) {}

  /** Ingesta del poller on-prem (máquina-a-máquina, header x-store-ingest-key). */
  @Public()
  @UseGuards(StoreIngestGuard)
  @Post('ingest')
  @ApiOperation({ summary: 'TDA — ingesta de tickets en vivo desde el runner on-prem (upsert + emite por WS /store).' })
  ingest(@Body() body: { tickets: LiveTicket[]; emit?: boolean }) {
    // emit=false → backfill histórico del día (solo llena el buffer, sin emitir
    // por WS ni disparar alertas). El navegador lo recibe vía snapshot.
    return this.service.ingest(body?.tickets || [], body?.emit !== false);
  }

  /** Snapshot inicial para el navegador al conectar (KPIs día + horas + últimos). */
  @Get('snapshot')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiQuery({ name: 'warehouse', required: false, description: "Filtro por sucursal ('00'..'05'). Ignorado si el usuario ya está scopeado a una sucursal." })
  @ApiOperation({ summary: 'TDA — snapshot del día: KPIs por sucursal + curva horaria + tickets del día.' })
  snapshot(@ReqUser() user: { warehouse_code?: string } | undefined, @Query('warehouse') warehouse?: string) {
    // Usuario con sucursal asignada → SIEMPRE su sucursal (no puede ampliar).
    // Rol global (sin warehouse_code) → filtro opcional del UI.
    const effective = user?.warehouse_code || warehouse || undefined;
    return this.service.snapshot(effective);
  }
}
