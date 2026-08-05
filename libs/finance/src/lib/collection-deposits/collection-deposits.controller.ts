import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CollectionDepositsService, ListCobrosQuery, AttachDepositDto } from './collection-deposits.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CC — Comprobantes de Cobranza. Lista los cobros de Kepler (UA0501) y les
 * adjunta el comprobante de depósito (imagen/PDF) con OCR. Captura/adjunto a nivel
 * VER (el capturista de oficina); validación/rechazo a nivel GESTIONAR (el revisor).
 * No escribe a Kepler.
 */
@ApiTags('finance-collection-deposits')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/collections')
export class CollectionDepositsController {
  constructor(private readonly svc: CollectionDepositsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Lista cobros de Kepler + estado de su comprobante + KPIs.' })
  list(
    @Query('estado') estado?: string,
    @Query('forma_pago') forma_pago?: string,
    @Query('tipo_cuenta') tipo_cuenta?: string,
    @Query('incluir_todas') incluir_todas?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const q: ListCobrosQuery = { estado, forma_pago, tipo_cuenta, incluir_todas, from, to, search, limit: limit ? Number(limit) : undefined };
    return this.svc.listCobros(q);
  }

  // ── Caso B: abonos en banco sin cobro (bank-first). Declarado ANTES de
  //    :sucursal/:folio para que 'bank/...' no lo capture la ruta genérica. ──
  @Get('bank/unmatched')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Abonos clasificados como cobranza que NO están ligados a ningún cobro (Caso B).' })
  unmatchedBank(
    @Query('from') from?: string, @Query('to') to?: string, @Query('search') search?: string,
    @Query('solo_huerfanos') solo_huerfanos?: string, @Query('limit') limit?: string,
  ) {
    return this.svc.listUnmatchedBank({ from, to, search, solo_huerfanos, limit: limit ? Number(limit) : undefined });
  }

  @Get('bank/:movementId/candidates')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Cobros candidatos para un abono huérfano.' })
  bankCandidates(@Param('movementId') movementId: string) {
    return this.svc.cobroCandidates(movementId);
  }

  @Post('bank/:movementId/link')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Liga (bank-first) un abono a un cobro elegido.' })
  linkBank(@Param('movementId') movementId: string, @Body() body: { sucursal?: string; folio?: string }, @Req() req: AuthedRequest) {
    return this.svc.linkBankToCobro(movementId, body?.sucursal || '', body?.folio || '', req?.user?.full_name || req?.user?.username);
  }

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Detalle del cobro + sus fichas adjuntas.' })
  detail(@Param('sucursal') sucursal: string, @Param('folio') folio: string) {
    return this.svc.detail(sucursal, folio);
  }

  @Post('ocr')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Corre OCR sobre la ficha (imagen/PDF) y devuelve los campos (preview, no guarda).' })
  ocr(@Body() body: { file_base64?: string }) {
    return this.svc.runOcr(body?.file_base64 || '');
  }

  @Post('upload')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Sube la ficha (imagen/PDF) a Cloudinary y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || 'deposito');
  }

  @Post('match-cobro')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Ficha-first: busca el cobro que corresponde al OCR de la ficha (monto + fecha).' })
  matchCobro(@Body() body: { monto?: number; fecha?: string; limit?: number }) {
    return this.svc.matchCobrosByOcr({ monto: body?.monto, fecha: body?.fecha, limit: body?.limit });
  }

  @Post('attach')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_VER)
  @ApiOperation({ summary: 'Adjunta la evidencia al cobro (con archivos ya subidos + OCR). Calcula el cuadre de monto.' })
  attach(@Body() body: AttachDepositDto, @Req() req: AuthedRequest) {
    return this.svc.attach(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Valida la evidencia del cobro. Auditado.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la evidencia (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }

  @Post(':id/bank-match')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Confirma que un abono del estado de cuenta corresponde al cobro (persiste en bank_recon_matches).' })
  confirmBank(@Param('id') id: string, @Body() body: { bank_movement_id?: string }, @Req() req: AuthedRequest) {
    return this.svc.confirmBank(id, body?.bank_movement_id || '', req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/bank-unmatch')
  @RequirePermissions(Permission.FINANCE_COLLECTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Deshace la conciliación cobro↔abono.' })
  unlinkBank(@Param('id') id: string, @Body() body: { bank_movement_id?: string }) {
    return this.svc.unlinkBank(id, body?.bank_movement_id || '');
  }
}
