import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type {
  CreditTermsFilter, SupplierCreditTermsHistoryRow, SupplierCreditTermsResponse, SupplierCreditTermsUpdated,
  UpdateSupplierCreditTermsDto,
} from '@megadulces/contracts';
import { SupplierCreditTermsService } from './supplier-credit-terms.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * `[RE.30]` — Plazo de pago por proveedor.
 *
 * Leer usa el permiso de la PÁGINA que lo muestra: la pestaña vive en `/compras/obligaciones`,
 * así que es `COMPRAS_OBLIGACIONES_VER` (GOTCHAS §4: cada vista funciona con SUS permisos).
 * Cambiarlo exige `COMPRAS_PLAZOS_AUTORIZAR`: el plazo lo negocian el comprador o dirección, no
 * quien opera las obligaciones (el auxiliar tiene `_GESTIONAR` y NO esta llave).
 */
@ApiTags('commercial-supplier-credit-terms')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/supplier-credit-terms')
export class SupplierCreditTermsController {
  constructor(private readonly svc: SupplierCreditTermsService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Lista de trabajo: proveedores con recepciones en 12 meses, su plazo y lo que dice Kepler. filter = pendientes | sin_plazo | sin_confirmar | confirmado | interno | difiere | todos.' })
  list(@Query('filter') filter?: CreditTermsFilter, @Query('search') search?: string): Promise<SupplierCreditTermsResponse> {
    return this.svc.list({ filter, search });
  }

  @Get(':id/history')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  history(@Param('id', ParseUUIDPipe) id: string): Promise<SupplierCreditTermsHistoryRow[]> {
    return this.svc.history(id);
  }

  @Put(':id')
  @RequirePermissions(Permission.COMPRAS_PLAZOS_AUTORIZAR)
  @ApiOperation({ summary: 'Fija el plazo pactado: días exactos + desde cuándo corre (factura/recepción), o marca el proveedor como interno con motivo. Guarda historial.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierCreditTermsDto, @Req() req: AuthedRequest): Promise<SupplierCreditTermsUpdated> {
    return this.svc.update(id, dto, req.user?.username || 'sistema');
  }
}
