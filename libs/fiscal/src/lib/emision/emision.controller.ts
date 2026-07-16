import { Body, Controller, Get, Header, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { EmisionService } from './emision.service';
import { EmitirFacturaInput, IssuerConfigInput } from './emision.types';

/**
 * FE.2 — API de emisión de facturas CFDI 4.0 (timbrado vía PAC SW/Conectia).
 */
@ApiTags('fiscal-facturas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/facturas')
export class EmisionController {
  constructor(private readonly svc: EmisionService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'Lista de facturas emitidas (fiscal.cfdis rol=emitidas).' })
  list(@Query() q: { from?: string; to?: string; search?: string; limit?: number; offset?: number }) {
    return this.svc.listEmitidas(q);
  }

  @Get('issuer')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'Emisores configurados (fiscal.issuer_config).' })
  issuers() { return this.svc.listIssuers(); }

  @Put('issuer')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({ summary: 'Alta/edición del emisor (RFC, razón social, régimen, CP, serie).' })
  upsertIssuer(@Body() body: IssuerConfigInput) { return this.svc.upsertIssuer(body); }

  @Post()
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @Throttle({ long: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Emite y timbra una factura CFDI 4.0 (global o nominativa).' })
  emitir(@Body() body: EmitirFacturaInput) { return this.svc.emitir(body); }

  @Get(':uuid/xml')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @Header('Content-Type', 'application/xml')
  @ApiOperation({ summary: 'Descarga el XML timbrado de una factura emitida.' })
  xml(@Param('uuid') uuid: string) { return this.svc.getXml(uuid); }

  @Post(':uuid/cancelar')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({ summary: 'Cancela una factura emitida ante el SAT (motivo 01-04).' })
  cancelar(@Param('uuid') uuid: string, @Body() body: { motivo?: string; folioSustitucion?: string }) {
    return this.svc.cancelar(uuid, body?.motivo, body?.folioSustitucion);
  }
}
