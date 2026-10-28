import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { ReposicionSucursales } from '@megadulces/contracts';
import { CajaReposicionService } from './caja-reposicion.service';

/**
 * `[CGA-A.61]` Reposición por sucursal. Ruta PROPIA y no `finance/cash-ledger/reposicion`: ese
 * controlador tiene `@Get(':id')`, y un segundo controlador con el mismo prefijo depende del orden
 * de registro para no caer en él. Las escrituras (vincular, cambiar de retiro) son de supervisión y
 * viven con los vínculos de CAOS (`CaosController`, sólo superadmin); «Reponer» es el lote de
 * siempre (`POST finance/cash-ledger/lote` con `caos_retiro`).
 */
@ApiTags('finance-caja-reposicion')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/caja-reposicion')
export class CajaReposicionController {
  constructor(private readonly svc: CajaReposicionService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGA-A.61] Por sucursal y día de pago: documentos X-D-26 contra la 0011 de la sucursal, egresos del libro, de qué retiro de CAOS salió cada peso, lo que falta y la propuesta de vínculos. Sólo lectura.' })
  reposicion(@Query('desde') desde?: string, @Query('hasta') hasta?: string): Promise<ReposicionSucursales> {
    return this.svc.reposicion({ desde, hasta });
  }
}
