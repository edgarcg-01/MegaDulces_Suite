import { Body, Controller, Get, Header, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { EmisionService } from './emision.service';
import { EmitirFacturaInput, IssuerConfigInput, NotaCreditoInput } from './emision.types';

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

  @Post(':uuid/nota-credito')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @Throttle({ long: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'FE.12: emite una nota de crédito (CFDI de Egreso, TipoRelacion 01) sobre una factura emitida. El receptor se deriva del original.' })
  notaCredito(@Param('uuid') uuid: string, @Body() body: NotaCreditoInput) {
    return this.svc.emitirNotaCredito(uuid, body);
  }

  @Get(':uuid/xml')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @Header('Content-Type', 'application/xml')
  @ApiOperation({ summary: 'Descarga el XML timbrado de una factura emitida.' })
  xml(@Param('uuid') uuid: string) { return this.svc.getXml(uuid); }

  @Get(':uuid/pdf')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'FE.4: PDF (representación impresa, base64) de una factura emitida.' })
  async pdf(@Param('uuid') uuid: string) {
    return { pdf_base64: await this.svc.getPdf(uuid) };
  }

  @Post(':uuid/cancelar')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({ summary: 'FE.10: cancela una factura ante el SAT (motivo 01-04; 01 requiere UUID de sustitución). Devuelve estatus + acuse.' })
  cancelar(@Param('uuid') uuid: string, @Body() body: { motivo?: string; folioSustitucion?: string; reason?: string }) {
    return this.svc.cancelar(uuid, body?.motivo, body?.folioSustitucion, body?.reason);
  }

  @Get(':uuid/estatus')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'FE.10: consulta el estatus del CFDI ante el SAT y actualiza la fila (vigente/cancelado/en proceso).' })
  estatus(@Param('uuid') uuid: string) { return this.svc.consultarEstatus(uuid); }

  @Get(':uuid/acuse')
  @RequirePermissions(Permission.FISCAL_FACTURAR_VER)
  @ApiOperation({ summary: 'FE.10: acuse de cancelación del SAT (XML/base64) de una factura cancelada.' })
  async acuse(@Param('uuid') uuid: string) {
    return { acuse: await this.svc.getAcuse(uuid) };
  }
}
