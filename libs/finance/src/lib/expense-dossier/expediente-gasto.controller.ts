import { Controller, Get, Header, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { ExpedienteGastoService } from './expediente-gasto.service';
import { ExpedienteGastoDocumentService } from './expediente-gasto-document.service';

interface AuthedRequest {
  user?: { sub?: string; username?: string; full_name?: string; role_name?: string; permissions?: Record<string, boolean> };
}

/**
 * `[GX.15]` — El expediente del gasto: los cuatro eslabones juntos, y su PDF.
 *
 * Las dos rutas abren a **VER o CAPTURAR**: quien captura tiene que poder abrir e imprimir
 * lo suyo (es su respaldo), y el servicio ya lo acota por áreas — exigir `VER` lo dejaría
 * afuera, que son los 75 usuarios medidos en GX.10.
 */
@ApiTags('finance-expediente-gasto')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/expediente')
export class ExpedienteGastoController {
  constructor(
    private readonly svc: ExpedienteGastoService,
    private readonly doc: ExpedienteGastoDocumentService,
  ) {}

  /**
   * Lo que ya se puede comprobar. Va ANTES de `:sucursal/:folio` a propósito: declarada
   * después, Nest haría que `listas-para-comprobar` entrara como sucursal.
   */
  @Get('listas-para-comprobar')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.15] Gastos ya aplicados en Kepler y sin comprobación, dentro del alcance de quien pregunta. Ventana en días (default 90, tope 365): sin acote la consulta cruza dos vistas del ODS sobre toda la historia y no termina.' })
  listasParaComprobar(@Query('dias') dias?: string, @Query('limit') limit?: string, @Req() req?: AuthedRequest) {
    return this.svc.listasParaComprobar(req?.user, dias ? Number(dias) : undefined, limit ? Number(limit) : undefined);
  }

  @Get(':sucursal/:folio')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: '[GX.15] El expediente completo de una solicitud: solicitud (XA1501) + expediente propio + gastos aplicados (XA1001, pueden ser varios) + comprobaciones, con la etapa del trámite y qué falta.' })
  expediente(@Param('sucursal') sucursal: string, @Param('folio') folio: string, @Req() req?: AuthedRequest) {
    return this.svc.expediente(sucursal, folio, req?.user);
  }

  @Get(':sucursal/:folio/pdf')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '[GX.15] El mismo expediente, imprimible. Respaldo interno: NO es comprobante fiscal ni póliza, y las evidencias no viajan embebidas (se listan).' })
  async pdf(
    @Param('sucursal') sucursal: string,
    @Param('folio') folio: string,
    @Res() res: Response,
    @Req() req?: AuthedRequest,
  ): Promise<void> {
    const { pdf, nombre } = await this.doc.render(sucursal, folio, req?.user);
    res.setHeader('Content-Type', 'application/pdf');
    // `inline`: el caso normal es mirarlo, y el navegador igual deja guardarlo. Con
    // `attachment` se descarga a ciegas y hay que abrir el archivo para ver si era el que
    // se buscaba.
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(pdf);
  }
}
