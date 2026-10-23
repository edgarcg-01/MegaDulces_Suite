import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  CajaCustodiaService, type ClasificarRetiroInput, type CerrarCustodiaInput, type CustodiaListado,
} from './caja-custodia.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string; username?: string } }

/**
 * ⭐ `[CGA-A.51]` El retiro de CAOS que se lleva una persona (ADR-101).
 *
 * Ruta propia (`/finance/caja-custodia`) y no bajo `/finance/cash-ledger`: ahí `@Get(':id')`
 * se comería `custodia` como si fuera el id de un movimiento.
 */
@ApiTags('finance-cash-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/caja-custodia')
export class CajaCustodiaController {
  constructor(private readonly svc: CajaCustodiaService) {}

  private user(req: AuthedRequest): { id?: string; username?: string } {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  @Get('retiros')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGA-A.51] Retiros de CAOS con su destino y lo que le queda a cada uno; saldo a cargo por persona' })
  listar(@Query('from') from?: string, @Query('to') to?: string): Promise<CustodiaListado> {
    return this.svc.listar({ from, to });
  }

  @Post('clasificar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CGA-A.51] Un retiro de CAOS fue al cajón o queda a cargo de una persona' })
  clasificar(@Body() body: ClasificarRetiroInput, @Req() req: AuthedRequest): Promise<{ custodia_id: string }> {
    return this.svc.clasificar(body, this.user(req));
  }

  @Post(':id/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CGA-A.51] Cierra una custodia: regreso a CAOS, entrega al cajón o faltante' })
  cerrar(
    @Param('id') id: string, @Body() body: CerrarCustodiaInput, @Req() req: AuthedRequest,
  ): Promise<{ custodia_id: string; tipo: CerrarCustodiaInput['tipo']; monto: number; dia: string }> {
    return this.svc.cerrar(id, body, this.user(req));
  }
}
