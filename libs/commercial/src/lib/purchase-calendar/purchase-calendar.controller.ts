import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CalendarioCompras, DefinirOcasionalesDto, DefinirOcasionalesRespuesta, FueraDeCicloDto, GuardarReglaDto, GuardarReglaRespuesta,
  MarcarRevisionDto, PropuestasCalendario, ResponsablesCalendario,
} from '@megadulces/contracts';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import { PurchaseCalendarService } from './purchase-calendar.service';

interface Sesion {
  user?: { sub?: string; username?: string };
}

const quien = (req: Sesion) => ({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null });

/**
 * `[PQ.3.4]` Compras › Calendario de compras (anexo C §10, DC7). Leer con cualquiera de las tres claves
 * (quien define el ciclo o marca el día también lee); marcar el día con `COMPRAS_CALENDARIO_GESTIONAR`;
 * definir, dar de baja o sacar del ciclo una regla, sólo con `COMPRAS_CALENDARIO_CICLO` (DC8: la gerencia de
 * compras). `[PQ.3.6]` Encima de la clave, el alcance por sucursal: cada quien ve y escribe sólo las reglas
 * que caben en sus sucursales (lo resuelve el servicio con `ScopeService`, área `compras`).
 */
@ApiTags('compras-calendario')
@Controller('compras/calendario')
export class PurchaseCalendarController {
  constructor(private readonly service: PurchaseCalendarService) {}

  @Get()
  @RequireAnyPermission(Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR, Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.4: las reglas de revisión con su estado de hoy (rezagada, toca hoy, al día…) leído de Kepler y de las marcas' })
  calendario(): Promise<CalendarioCompras> {
    return this.service.calendario();
  }

  /**
   * `[PQ.3.6]` Sólo con `COMPRAS_CALENDARIO_CICLO`: «Sin regla» son proveedores de TODA la empresa (no se recortan
   * por sucursal) y sólo sirven para definir la regla. La pantalla ya la escondía sin la clave; la prueba visual
   * encontró que la API se la daba igual a un encargado con la URL a mano.
   */
  @Get('propuestas')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.4: lo que Kepler propone (vista PQ.3.1) para los proveedores con compra y SIN regla (PQ.3.6: sólo quien define ciclos)' })
  propuestas(): Promise<PropuestasCalendario> {
    return this.service.propuestas();
  }

  /** `[PQ.3.22]` Quién puede ser responsable de una regla (DC30), con dónde escribe: sólo lo usa quien define reglas. */
  @Get('responsables')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.22: las personas activas que pueden marcar (llave efectiva) y las sucursales donde escriben en Compras' })
  responsables(): Promise<ResponsablesCalendario> {
    return this.service.responsables();
  }

  @Post('reglas')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.4: definir la regla de un proveedor en un alcance (si ya hay una viva, se reemplaza su patrón). PQ.3.21: con varias zonas o sucursales, una regla por lugar, todas o ninguna' })
  guardarRegla(@Body() dto: GuardarReglaDto, @Req() req: Sesion): Promise<GuardarReglaRespuesta> {
    return this.service.guardarRegla(quien(req), dto);
  }

  /** `[PQ.3.18]` (c) Los ocasionales en bloque (DC27): sólo las claves que HOY son ocasionales sin regla; las demás vuelven como omitidas. */
  @Post('reglas/ocasionales')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.18: los ocasionales en bloque: regla «cada 180 días» y fuera de ciclo 26 semanas, con motivo (sólo los que hoy son ocasionales sin regla)' })
  definirOcasionales(@Body() dto: DefinirOcasionalesDto, @Req() req: Sesion): Promise<DefinirOcasionalesRespuesta> {
    return this.service.definirOcasionales(quien(req), dto);
  }

  @Post('reglas/:id/baja')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.4: dar de baja una regla (queda con quién y cuándo; nunca se borra)' })
  darDeBaja(@Param('id', ParseUUIDPipe) id: string, @Req() req: Sesion): Promise<{ id: string }> {
    return this.service.darDeBaja(quien(req), id);
  }

  @Post('reglas/:id/fuera-de-ciclo')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_CICLO)
  @ApiOperation({ summary: 'PQ.3.4: sacar una regla del ciclo hasta una fecha, con motivo (o regresarla con hasta = null)' })
  fueraDeCiclo(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FueraDeCicloDto, @Req() req: Sesion): Promise<{ id: string }> {
    return this.service.fueraDeCiclo(quien(req), id, dto);
  }

  @Post('reglas/:id/marcas')
  @RequirePermissions(Permission.COMPRAS_CALENDARIO_GESTIONAR)
  @ApiOperation({ summary: 'PQ.3.4: marcar una fecha: se pidió fuera de Kepler, u hoy no se pide con motivo (y nueva fecha)' })
  marcar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MarcarRevisionDto, @Req() req: Sesion): Promise<{ id: string; accion: 'creada' | 'corregida' }> {
    return this.service.marcar(quien(req), id, dto);
  }
}
