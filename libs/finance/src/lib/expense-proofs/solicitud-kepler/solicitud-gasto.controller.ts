import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  AcreedorDeGasto, CatalogoDeLaSolicitud, CrearSolicitudGastoDto, DetalleDeLaSolicitud, DisponibilidadDeLaSolicitud, DuplicadoProbable,
  EstadoKeplerDeLaSolicitud, SolicitudKeplerCancelada, CancelacionDeSolicitudDisponible, LecturaDelComprobante, PrecargaDeLaSolicitud, SolicitudGastoCreada, SucursalesAbiertasDeLaSolicitud,
} from '@megadulces/contracts';

import { SolicitudGastoService } from './solicitud-gasto.service';

interface AuthedRequest { user?: { sub?: string; username?: string; full_name?: string } }

/**
 * `[PGP.122]` **La solicitud de gasto nace en la Suite.** Ruta base propia (no `finance/expenses/proofs/...`:
 * ahí `GET :id` se comería «catalogo», como pasó con `[PGP.79]`).
 *
 * Pedir/registrar usa los mismos permisos que la captura del vale de hoy (`VER` o `CAPTURAR`, 115
 * personas con `CAPTURAR`). Reintentar la escritura en Kepler es de quien firma (`COMPROBAR`). La firma
 * misma sigue en `POST /finance/expenses/proofs/:id/approve`: es ahí donde se escribe en Kepler.
 */
@ApiTags('finance-expense-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/solicitudes')
export class SolicitudGastoController {
  constructor(private readonly svc: SolicitudGastoService) {}

  @Get('disponibilidad')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] ¿La puerta «Pedir o registrar» está abierta en esa sucursal? Sólo con la escritura en Kepler encendida de punta a punta; si no, por qué.' })
  disponibilidad(@Query('sucursal') sucursal: string): Promise<DisponibilidadDeLaSolicitud> {
    return this.svc.disponibilidad(sucursal);
  }

  @Get('abiertas')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Las sucursales donde hoy se puede pedir (la misma regla que disponibilidad): la pestaña sólo se muestra donde hay algo que abrir.' })
  abiertas(): Promise<SucursalesAbiertasDeLaSolicitud> {
    return this.svc.abiertas();
  }

  @Get(':id/detalle')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR, Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.122] Lo que se escribe en Kepler al firmar la solicitud (renglones con su cuenta, IVA y total): quien firma lo ve antes.' })
  detalle(@Param('id') id: string): Promise<DetalleDeLaSolicitud> {
    return this.svc.detalle(id);
  }

  @Post('leer-comprobante')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Lee el comprobante ya subido y PROPONE: importe, IVA, fecha, folio, el acreedor por RFC y la factura del SAT. Nunca decide.' })
  leerComprobante(@Body() body: { sucursal: string; archivo: { public_id?: string; url?: string; kind?: string } }): Promise<LecturaDelComprobante> {
    return this.svc.leerComprobante(body?.sucursal, body?.archivo ?? {});
  }

  @Get('catalogo')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Conceptos (con su cuenta y si entran en el alcance v1), proyectos y departamentos del catálogo de Kepler de esa sucursal.' })
  catalogo(@Query('sucursal') sucursal: string): Promise<CatalogoDeLaSolicitud> {
    return this.svc.catalogo(sucursal);
  }

  @Get('acreedores')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Acreedores de gasto (G…, sin nómina ni bancos) de esa sucursal: los frecuentes primero, con el buscador compartido.' })
  acreedores(@Query('sucursal') sucursal: string, @Query('q') q?: string, @Query('limit') limit?: string): Promise<AcreedorDeGasto[]> {
    return this.svc.buscarAcreedores(sucursal, q, Number(limit) || 20);
  }

  @Get('precarga')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] «Como la última vez» con ese acreedor: sus conceptos frecuentes, último proyecto y departamento, y forma de pago.' })
  precarga(@Query('sucursal') sucursal: string, @Query('acreedor') acreedor: string): Promise<PrecargaDeLaSolicitud> {
    return this.svc.precarga(sucursal, acreedor);
  }

  @Get('duplicados')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Mismo acreedor e importe el mismo día, en la Suite y en Kepler. Es un AVISO (50 % de ruido medido), no un bloqueo.' })
  duplicados(@Query('sucursal') sucursal: string, @Query('acreedor') acreedor: string, @Query('total') total: string, @Query('fecha') fecha: string): Promise<DuplicadoProbable[]> {
    return this.svc.duplicados(sucursal, acreedor, Number(total), String(fecha ?? ''));
  }

  @Post()
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122] Pide o registra un gasto. Nace sin folio de Kepler; al firmarse se escribe en Kepler ya autorizado.' })
  crear(@Body() dto: CrearSolicitudGastoDto, @Req() req: AuthedRequest): Promise<SolicitudGastoCreada> {
    return this.svc.crear(dto, { nombre: req?.user?.full_name || req?.user?.username || '', usuario: req?.user?.username || '' });
  }

  @Post(':id/cancelar-en-kepler')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.122] F3 (DS40): cancela en Kepler la solicitud que escribió la Suite (sin gasto X-A-10 vivo, con motivo) y cierra el vale.' })
  cancelarEnKepler(@Param('id') id: string, @Body() body: { motivo?: unknown }, @Req() req: AuthedRequest): Promise<EstadoKeplerDeLaSolicitud> {
    return this.svc.cancelarEnKepler(id, body?.motivo, req?.user?.full_name || req?.user?.username || '');
  }

  @Get('cancelacion')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.122.6] Las sucursales donde hoy se puede cancelar una solicitud desde la Suite (interruptor cancela_solicitud_gasto).' })
  cancelacionDisponible(): Promise<CancelacionDeSolicitudDisponible> {
    return this.svc.cancelacionDisponible();
  }

  @Post('kepler/:sucursal/:folio/cancelar')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.122.6] «Cancela sol gasto»: cancela en Kepler la X-A-15 (también la capturada en Kepler; sin gasto vivo, con motivo) y cierra sus vales.' })
  cancelarSolicitudKepler(@Param('sucursal') sucursal: string, @Param('folio') folio: string, @Body() body: { motivo?: unknown }, @Req() req: AuthedRequest): Promise<SolicitudKeplerCancelada> {
    return this.svc.cancelarSolicitudKepler(sucursal, folio, body?.motivo, req?.user?.full_name || req?.user?.username || '');
  }

  @Post(':id/reintentar-kepler')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[PGP.122] Reintenta escribir en Kepler una solicitud firmada (también las atoradas o rechazadas, una vez corregido el motivo).' })
  reintentar(@Param('id') id: string, @Req() req: AuthedRequest): Promise<EstadoKeplerDeLaSolicitud | null> {
    return this.svc.reintentar(id, req?.user?.full_name || req?.user?.username || '');
  }
}
