import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { BandejaFueraDeNorma, DecidirNormaDto, DecisionTomada, RevocarDecisionNormaDto } from '@megadulces/contracts';

import { FacturasFueraDeNormaService } from './facturas-fuera-de-norma.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * `[PGP.229]` **Facturas fuera de norma** (anexo NF): la bandeja de lo que espera la decisión de Administración o
 * Contabilidad (S01, régimen ≠ 612), y decidir o revocar.
 *
 * - Ver: quien ve el Calendario (`FINANCE_PAYMENTS_VER`): el 409 del Calendario manda aquí, y quien lo recibe tiene
 *   que poder ver por qué. También quien decide.
 * - Decidir y revocar: `FINANCE_CFDI_NORMA_DECIDIR`, clave PROPIA repartida a `contabilidad` y `direccion` (D-NF2,
 *   Francisco, 2026-11-26: basta una firma). `FINANCE_PAYMENTS_GESTIONAR` la tienen también Compras y Tesorería.
 */
@ApiTags('finance-payment-calendar')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/norma-fiscal')
export class FacturasFueraDeNormaController {
  constructor(private readonly svc: FacturasFueraDeNormaService) {}

  @Get('bandeja')
  @RequireAnyPermission(Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_CFDI_NORMA_DECIDIR)
  @ApiOperation({ summary: '[PGP.229] Las facturas recibidas que esperan decisión (S01, régimen), las que ya están en un pago primero, y las decididas.' })
  bandeja(): Promise<BandejaFueraDeNorma> {
    return this.svc.bandeja();
  }

  @Post(':uuid/decision')
  @RequirePermissions(Permission.FINANCE_CFDI_NORMA_DECIDIR)
  @ApiOperation({ summary: '[PGP.229] Decide una regla de una factura: «se usa» o «no se usa», con su motivo. Basta una firma.' })
  decidir(@Param('uuid') uuid: string, @Body() dto: DecidirNormaDto, @Req() req: AuthedRequest): Promise<DecisionTomada> {
    return this.svc.decidir(uuid, dto, req?.user?.username ?? '');
  }

  @Post('decisiones/:id/revocar')
  @RequirePermissions(Permission.FINANCE_CFDI_NORMA_DECIDIR)
  @ApiOperation({ summary: '[PGP.229] Revoca una decisión (con su motivo): la factura vuelve a pedir decisión. Nada se borra.' })
  revocar(@Param('id') id: string, @Body() dto: RevocarDecisionNormaDto, @Req() req: AuthedRequest): Promise<{ id: string; revocada: true }> {
    return this.svc.revocar(id, dto, req?.user?.username ?? '');
  }
}
