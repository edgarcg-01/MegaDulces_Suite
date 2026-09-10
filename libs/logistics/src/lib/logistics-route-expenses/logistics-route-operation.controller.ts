import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { LogisticsRouteOperationService, OdometroDto } from './logistics-route-operation.service';

/** RD.5 — odómetro, $/km y rendimiento de la Ruta Directa. Ver el header del service. */
@ApiTags('logistics-route-operation')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('logistics/route-operation')
export class LogisticsRouteOperationController {
  constructor(private readonly service: LogisticsRouteOperationService) {}

  @Get('periods')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({
    summary: 'Operación por ruta × quincena: km, litros, km/L, $/km',
    description: 'Query: anio, route_code, solo_problemas. Devuelve `km_status` y `costo_status` crudos y la cobertura aparte — lo que no se pudo medir se declara, no se dibuja como cero.',
  })
  periods(@Query() q: Record<string, string>) {
    return this.service.periodos({
      anio: q.anio ? Number(q.anio) : undefined,
      route_code: q.route_code,
      solo_problemas: q.solo_problemas === 'true',
    });
  }

  @Get('period-catalog')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({ summary: 'Las quincenas del año, para que la captura no invente el periodo' })
  periodCatalog(@Query('anio') anio?: string) {
    return this.service.periodos_catalogo(anio ? Number(anio) : undefined);
  }

  @Get('cost-sheets')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({ summary: 'Fichas de costo fijo por ruta y el $/km que sale de ellas' })
  costSheets() { return this.service.fichas(); }

  @Post('odometer')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR)
  @ApiOperation({
    summary: 'Captura o corrige una lectura de odómetro (UPSERT por ruta × año × quincena)',
    description: 'Un km_final menor que el inicial SE PUEDE guardar —el dato real lo hace— pero exige notas: un retroceso sin motivo no se distingue de un error de captura.',
  })
  upsertOdometer(@Body() dto: OdometroDto) { return this.service.upsert(dto); }

  @Delete('odometer/:id')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete de una lectura' })
  removeOdometer(@Param('id') id: string) { return this.service.remove(id); }
}
