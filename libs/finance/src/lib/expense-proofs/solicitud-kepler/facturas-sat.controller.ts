import { Body, Controller, Get, Param, Post, Query, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission, RequireAnyPermission, RolesGuard } from '@megadulces/platform-core';
import type { BandejaDeFacturasSat, DescartarFacturaSatDto, DetalleDeFacturaSat, FacturaDescartada } from '@megadulces/contracts';

import { FacturasSatService } from './facturas-sat.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * `[PGP.122]` S.13 — **La bandeja de facturas del SAT por registrar** (anexo S §14). Ruta propia, debajo de la de la
 * solicitud: quien registra o pide un gasto (`FINANCE_EXPENSES_VER` o `CAPTURAR`) ve las facturas de gasto que nadie
 * ha registrado EN LAS SUCURSALES QUE SU ALCANCE LE DEJA VER (lo decide el servidor, ADR-050), las registra desde ahí
 * o las saca («no es de esta sucursal» o «para todas»). El XML se abre con ESOS permisos y sólo de facturas que la
 * bandeja de esa sucursal muestra: `/fiscal/cfdi` exige `FISCAL_CFDI_VER`, que no tienen 94 de 116 personas que
 * registran gastos.
 */
@ApiTags('finance-expense-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/solicitudes/facturas-sat')
export class FacturasSatController {
  constructor(private readonly svc: FacturasSatService) {}

  @Get()
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122 S.13] Las facturas de gasto del SAT que nadie ha registrado, para esa sucursal; las ya registradas con el documento que las cubre, y las descartadas.' })
  bandeja(@Query('sucursal') sucursal: string): Promise<BandejaDeFacturasSat> {
    return this.svc.bandeja(sucursal);
  }

  @Get(':uuid/xml')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122 S.13] El XML de una factura de la bandeja de esa sucursal.' })
  async xml(@Param('uuid') uuid: string, @Query('sucursal') sucursal: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { nombre, xml } = await this.svc.xml(uuid, sucursal);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${nombre}"`);
    return new StreamableFile(Buffer.from(xml, 'utf8'));
  }

  @Get(':uuid')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122 S.13] Una factura de la bandeja: sus conceptos (del XML), por qué está aquí o qué documento la cubre.' })
  detalle(@Param('uuid') uuid: string, @Query('sucursal') sucursal: string): Promise<DetalleDeFacturaSat> {
    return this.svc.detalle(uuid, sucursal);
  }

  @Post(':uuid/descartar')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122 S.13] Saca la factura de la bandeja, con su motivo: «no es de esta sucursal» (sólo de ésta) o «para todas». Se puede deshacer.' })
  descartar(@Param('uuid') uuid: string, @Body() dto: DescartarFacturaSatDto, @Req() req: AuthedRequest): Promise<FacturaDescartada> {
    return this.svc.descartar(uuid, dto, req?.user?.full_name || req?.user?.username || '');
  }

  @Post(':uuid/restaurar')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[PGP.122 S.13] Regresa a la bandeja una factura que esa sucursal ve en «Descartadas».' })
  restaurar(@Param('uuid') uuid: string, @Body() body: { sucursal?: string }, @Req() req: AuthedRequest): Promise<{ uuid: string; restaurada: true }> {
    return this.svc.restaurar(uuid, String(body?.sucursal ?? ''), req?.user?.full_name || req?.user?.username || '');
  }
}
