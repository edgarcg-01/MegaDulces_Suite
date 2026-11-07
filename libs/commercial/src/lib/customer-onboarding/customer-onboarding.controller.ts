import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
  TenantContextService,
  isPlatformAdminRole,
} from '@megadulces/platform-core';
import type {
  BandejaAlta,
  CatalogosAlta,
  CrearSolicitudRespuesta,
  DecidirCreditoBody,
  LigarSolicitudBody,
  RevisionAlta,
  SolicitudAlta,
  SolicitudAltaBody,
  SubirConstanciaBody,
  SubirConstanciaRespuesta,
} from '@megadulces/contracts';
import { CustomerOnboardingService, type ActorAlta } from './customer-onboarding.service';

interface UsuarioDeLaPeticion {
  permissions?: Record<string, boolean>;
  roles_frescos?: string[];
  role_name?: string;
}

/**
 * `[ALC.2]` Alta de clientes — `/commercial/customer-onboarding`.
 *
 * Dos llaves (decisión de Francisco, 2026-11-04): `COMMERCIAL_ALTA_CLIENTES` captura, ve y liga;
 * `COMMERCIAL_ALTA_CLIENTES_CREDITO` decide crédito, plazo y descuento. Quien sólo decide crédito
 * también ve la bandeja. Una tercera, `COMMERCIAL_ALTA_CLIENTES_VER` `[ALC.0.6]` (Francisco,
 * 2026-11-06), es sólo consulta: abre las cuatro lecturas (`VER_BANDEJA`) y ninguna escritura —
 * lo fija `customer-onboarding.controller.spec.ts`. El alcance por sucursal lo pone `ScopeService`
 * en el servicio.
 */
const VER_BANDEJA = [
  Permission.COMMERCIAL_ALTA_CLIENTES,
  Permission.COMMERCIAL_ALTA_CLIENTES_CREDITO,
  Permission.COMMERCIAL_ALTA_CLIENTES_VER,
] as const;

@ApiTags('commercial-customer-onboarding')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/customer-onboarding')
export class CustomerOnboardingController {
  constructor(
    private readonly service: CustomerOnboardingService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private actor(req: { user?: UsuarioDeLaPeticion }): ActorAlta {
    const u = req?.user;
    const ctx = this.tenantCtx.get();
    const esAdmin = (u?.roles_frescos ?? []).some((r) => isPlatformAdminRole(r));
    return {
      userId: ctx?.userId ?? null,
      roleName: ctx?.roleName ?? u?.role_name ?? null,
      puedeCredito: esAdmin || u?.permissions?.[Permission.COMMERCIAL_ALTA_CLIENTES_CREDITO] === true,
    };
  }

  @Get('catalogs')
  @RequireAnyPermission(...VER_BANDEJA)
  @ApiOperation({ summary: 'Sucursales de tu alcance y, de la elegida, vendedores, grupos y zonas de Kepler; régimen fiscal del SAT' })
  catalogs(@Query('branch') branch: string, @Query() query: Record<string, unknown>): Promise<CatalogosAlta> {
    return this.service.catalogos(branch, query);
  }

  @Post('constancia')
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES)
  @ApiOperation({ summary: 'Lee la Constancia de Situación Fiscal (PDF del SAT), la guarda y prellena la ficha. No crea nada.' })
  constancia(@Body() body: SubirConstanciaBody, @Query() query: Record<string, unknown>): Promise<SubirConstanciaRespuesta> {
    return this.service.subirConstancia(body, query);
  }

  @Post('validate')
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES)
  @ApiOperation({ summary: 'Revisa una solicitud sin guardarla: hallazgos, duplicados en Kepler y casillas que no caben' })
  validate(@Body() body: SolicitudAltaBody, @Query() query: Record<string, unknown>): Promise<RevisionAlta> {
    return this.service.revisar(body, query);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES)
  @ApiOperation({ summary: 'Crea la solicitud de alta (de contado → lista para Kepler; con crédito → a Crédito y Cobranza)' })
  create(@Body() body: SolicitudAltaBody, @Query() query: Record<string, unknown>): Promise<CrearSolicitudRespuesta> {
    return this.service.crear(body, query);
  }

  @Get()
  @RequireAnyPermission(...VER_BANDEJA)
  @ApiOperation({ summary: 'Bandeja de solicitudes de tu alcance, con las fichas de Kepler que ya tienen su RFC' })
  inbox(@Query() query: Record<string, unknown>, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<BandejaAlta> {
    return this.service.bandeja(query, this.actor(req));
  }

  @Get(':id')
  @RequireAnyPermission(...VER_BANDEJA)
  @ApiOperation({ summary: 'Una solicitud de alta' })
  one(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<SolicitudAlta> {
    return this.service.una(id, query);
  }

  @Get(':id/constancia')
  @RequireAnyPermission(...VER_BANDEJA)
  @ApiOperation({ summary: 'Liga temporal (10 min) para ver la constancia guardada' })
  constanciaUrl(@Param('id') id: string, @Query() query: Record<string, unknown>): Promise<{ url: string }> {
    return this.service.urlConstancia(id, query);
  }

  @Post(':id/credit')
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES_CREDITO)
  @ApiOperation({ summary: 'Crédito y Cobranza decide crédito, plazo y descuento, con motivo' })
  credit(
    @Param('id') id: string,
    @Body() body: DecidirCreditoBody,
    @Query() query: Record<string, unknown>,
    @Req() req: { user?: UsuarioDeLaPeticion },
  ): Promise<SolicitudAlta> {
    return this.service.decidirCredito(id, body, this.actor(req), query);
  }

  @Post(':id/link')
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES)
  @ApiOperation({ summary: 'Liga la solicitud con la clave que le dio Kepler (verifica que exista y que el RFC coincida)' })
  link(@Param('id') id: string, @Body() body: LigarSolicitudBody, @Query() query: Record<string, unknown>): Promise<SolicitudAlta> {
    return this.service.ligar(id, body, query);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_ALTA_CLIENTES)
  @ApiOperation({ summary: 'Cancela una solicitud que no se va a dar de alta (con motivo)' })
  cancel(@Param('id') id: string, @Body() body: { motivo?: string }, @Query() query: Record<string, unknown>): Promise<SolicitudAlta> {
    return this.service.cancelar(id, body?.motivo, query);
  }
}
