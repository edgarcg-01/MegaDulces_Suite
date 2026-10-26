import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { isPlatformAdminRole, Permission, RequirePermissions } from '@megadulces/platform-core';
import type {
  AsignacionGasto, CambiosFicha, CeldaPresupuesto, DetalleUnidadCosto, FichaUnidad, LecturaOdometro, LineaGastoFlota,
  NominaAdministrativaMes, PeriodoCosto, PresupuestoAnio, ResumenCostoUnidad,
} from '@megadulces/contracts';
import { CostoUnidadService, type Actor } from './costo-unidad.service';

interface Sesion {
  user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> };
}

/** Quién escribe, leído de la SESIÓN (nunca del cuerpo). */
const actor = (req: Sesion | undefined): Actor => ({ userId: req?.user?.sub ?? null });

/** Salarios y nómina administrativa: sólo quien GESTIONA Costo por unidad (o administra la plataforma). */
export function veSalarios(req: Sesion | undefined): boolean {
  const u = req?.user;
  return isPlatformAdminRole(u?.role_name) || u?.permissions?.[Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR] === true;
}

/**
 * `[FCU.2]` Logística › Costos y reportes › Costo por unidad: lo que hacía la hoja «TRANSPORTES
 * 2026», con pantalla. Leer con `LOGISTICS_COSTO_UNIDAD_VER`; escribir con `_GESTIONAR`.
 */
@ApiTags('logistics-costo-unidad')
@Controller('logistics/costo-unidad')
export class CostoUnidadController {
  constructor(private readonly service: CostoUnidadService) {}

  @Get('resumen')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_VER)
  @ApiOperation({ summary: 'FCU: cada unidad de Transportes, presupuesto contra real en el periodo (Kepler + GPS + guías)' })
  resumen(@Query('desde') desde: string | undefined, @Query('hasta') hasta: string | undefined, @Req() req: Sesion): Promise<ResumenCostoUnidad> {
    return this.service.resumen(desde, hasta, veSalarios(req));
  }

  @Get('unidades/:id')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_VER)
  @ApiOperation({ summary: 'FCU: una unidad rubro por rubro, con sus renglones de Kepler, guías, km por mes y lecturas de odómetro' })
  detalle(@Param('id') id: string, @Query('desde') desde: string | undefined, @Query('hasta') hasta: string | undefined, @Req() req: Sesion): Promise<DetalleUnidadCosto> {
    return this.service.detalle(id, desde, hasta, veSalarios(req));
  }

  @Get('pendientes')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_VER)
  @ApiOperation({ summary: 'FCU: gastos de flota de Kepler sin unidad confirmada (por defecto, los de Logística)' })
  pendientes(@Query('desde') desde: string | undefined, @Query('hasta') hasta: string | undefined, @Query('alcance') alcance: string | undefined): Promise<{
    periodo: PeriodoCosto; lineas: LineaGastoFlota[]; unidades: Array<{ vehicle_id: string; nombre: string; plate: string; economic_number: string | null }>;
  }> {
    return this.service.pendientes(desde, hasta, alcance === 'todos' ? 'todos' : 'logistica');
  }

  @Put('asignaciones')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: confirmar la unidad de renglones de Kepler, marcarlos «no es de flota» o deshacerlo' })
  asignar(@Body() body: { items: AsignacionGasto[] }, @Req() req: Sesion): Promise<{ guardadas: number }> {
    return this.service.asignar(body?.items ?? [], actor(req));
  }

  @Put('unidades/:id/ficha')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: guardar la ficha de una unidad (VIN, seguro, compra, salario, km presupuestados, alias)' })
  ficha(@Param('id') id: string, @Body() body: CambiosFicha, @Req() req: Sesion): Promise<FichaUnidad> {
    return this.service.guardarFicha(id, body, actor(req));
  }

  @Get('presupuesto')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_VER)
  @ApiOperation({ summary: 'FCU: presupuesto anual por unidad y rubro' })
  presupuesto(@Query('anio') anio: string | undefined): Promise<PresupuestoAnio> {
    return this.service.presupuesto(Number(anio || new Date().getFullYear()));
  }

  @Put('presupuesto/:anio')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: guardar celdas del presupuesto (null = quitar)' })
  guardarPresupuesto(@Param('anio') anio: string, @Body() body: { celdas: CeldaPresupuesto[] }, @Req() req: Sesion): Promise<PresupuestoAnio> {
    return this.service.guardarPresupuesto(Number(anio), body?.celdas ?? [], actor(req));
  }

  @Get('nomina')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: nómina administrativa de Logística por mes (dato sensible: sólo GESTIONAR)' })
  nomina(@Query('anio') anio: string | undefined): Promise<NominaAdministrativaMes[]> {
    return this.service.nomina(Number(anio || new Date().getFullYear()));
  }

  @Put('nomina')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: capturar la nómina administrativa de un mes y cómo se reparte' })
  guardarNomina(@Body() body: NominaAdministrativaMes, @Req() req: Sesion): Promise<NominaAdministrativaMes[]> {
    return this.service.guardarNomina(body, actor(req));
  }

  @Post('unidades/:id/odometro')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: registrar una lectura de odómetro (unidades sin GPS)' })
  lectura(@Param('id') id: string, @Body() body: { read_on: string; odometer_km: number; notes?: string | null }, @Req() req: Sesion): Promise<LecturaOdometro[]> {
    return this.service.registrarLectura(id, body, actor(req));
  }

  @Delete('unidades/:id/odometro/:lecturaId')
  @RequirePermissions(Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR)
  @ApiOperation({ summary: 'FCU: quitar una lectura de odómetro mal capturada' })
  borrarLectura(@Param('id') id: string, @Param('lecturaId') lecturaId: string, @Req() req: Sesion): Promise<LecturaOdometro[]> {
    return this.service.borrarLectura(id, lecturaId, actor(req));
  }
}
