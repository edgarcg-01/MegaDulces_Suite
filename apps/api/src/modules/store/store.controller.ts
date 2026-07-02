import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public, RequirePermissions, Permission } from '@megadulces/platform-core';
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
  ingest(@Body() body: { tickets: LiveTicket[] }) {
    return this.service.ingest(body?.tickets || []);
  }

  /** Snapshot inicial para el navegador al conectar (KPIs día + horas + últimos). */
  @Get('snapshot')
  @RequirePermissions(Permission.STORE_LIVE_VER)
  @ApiOperation({ summary: 'TDA — snapshot del día: KPIs por sucursal + curva horaria + últimos tickets.' })
  snapshot() {
    return this.service.snapshot();
  }
}
