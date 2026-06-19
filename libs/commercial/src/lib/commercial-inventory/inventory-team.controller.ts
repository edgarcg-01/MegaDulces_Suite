import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { InventoryTeamService } from './inventory-team.service';
import type { GenerateTeamsDto, SetTeamsDto } from './inventory-team.service';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';

/**
 * Fase PA.3 — Tablero de equipos por folio (staffing por pasillo).
 *   SUPERVISAR → ver el tablero.
 *   ASIGNAR    → auto-generar (parejo) + ajuste manual.
 */
@ApiTags('commercial-inventory-teams')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory')
export class InventoryTeamController {
  constructor(private readonly service: InventoryTeamService) {}

  @Get('counts/:id/aisle-teams')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Tablero de equipos del folio: pasillos + supervisor/contadores por pasillo — PA.3' })
  board(@Param('id') id: string) {
    return this.service.getBoard(id);
  }

  @Post('counts/:id/generate-teams')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Auto-generar equipos PAREJOS (1 supervisor/pasillo + contadores repartidos) — PA.3' })
  generate(@Param('id') id: string, @Body() body: GenerateTeamsDto) {
    return this.service.generate(id, body);
  }

  @Post('counts/:id/aisle-teams')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Set manual del tablero (ajuste fino tras auto-generar) — PA.3' })
  setTeams(@Param('id') id: string, @Body() body: SetTeamsDto) {
    return this.service.setTeams(id, body);
  }
}
