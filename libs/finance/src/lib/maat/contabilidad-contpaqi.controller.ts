import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaatToolsService } from './maat-tools.service';

/**
 * Fase CP (ADR-040) — superficie ContPAQi en el proyecto **Contabilidad** (`/contabilidad/contpaqi`).
 * REST directo (no vía el chat de Maat) sobre los libros de ContPAQi, **reusando la lógica de
 * `MaatToolsService`** (misma query, cero duplicación ni drift). La URL + el permiso definen el
 * proyecto (Contabilidad), no la carpeta del archivo. Perm `FISCAL_CONTAB_VER` (contabilidad electrónica).
 */
@ApiTags('contabilidad-contpaqi')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('contabilidad/contpaqi')
export class ContabilidadContpaqiController {
  constructor(private readonly maat: MaatToolsService) {}

  @Get('balanza')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Balanza fiscal ContPAQi: cargos/abonos/neto por cuenta|familia|mes|agrupador_sat.' })
  balanza(
    @Query('group_by') group_by?: string,
    @Query('from_mes') from_mes?: string,
    @Query('to_mes') to_mes?: string,
    @Query('familia') familia?: string,
    @Query('cuenta') cuenta?: string,
    @Query('limit') limit?: string,
  ) {
    return this.maat.contpaqiBalanza({ group_by: group_by || 'familia', from_mes, to_mes, familia, cuenta, limit: limit ? Number(limit) : undefined });
  }

  @Get('bank')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Auxiliar bancario ContPAQi: depósitos/retiros/neto por banco|mes (resuelve el 102 compartido de Kepler).' })
  bank(
    @Query('group_by') group_by?: string,
    @Query('banco') banco?: string,
    @Query('from_mes') from_mes?: string,
    @Query('to_mes') to_mes?: string,
    @Query('limit') limit?: string,
  ) {
    return this.maat.contpaqiBanco({ group_by: group_by || 'banco', banco, from_mes, to_mes, limit: limit ? Number(limit) : undefined });
  }

  @Get('efos')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Proveedores de la contabilidad ContPAQi en la lista negra del SAT (69 / 69B EFOS).' })
  efos(
    @Query('solo_69b') solo_69b?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.maat.contpaqiEfos({ solo_69b: solo_69b === 'true', search, limit: limit ? Number(limit) : undefined });
  }

  @Get('libros-vs-operacion')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Contraste ingresos: libros (ContPAQi) vs operación (Kepler) mes a mes, con Δ y ratio.' })
  librosVsOperacion(
    @Query('from_mes') from_mes?: string,
    @Query('to_mes') to_mes?: string,
    @Query('sucursal') sucursal?: string,
  ) {
    return this.maat.librosVsOperacion({ from_mes, to_mes, sucursal });
  }
}
