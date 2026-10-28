import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { SupplierPaymentAccountsService } from './supplier-payment-accounts.service';
// `[PGP.20]` El DTO va por `import type`: viaja en una firma DECORADA y con emitDecoratorMetadata
// un import de valor lo convierte en TS1272. Lo caza `tsc`, no vitest.
import type { CreateAccountChangeRequestDto } from './supplier-payment-accounts.service';
import type { SupplierPaymentAccountRow, SupplierPaymentAccountRequestRow } from './supplier-payment-accounts.service';
import type { CuentasPagoFaltantesResponse, CuentaPagoPropuesta } from '@megadulces/contracts';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor. Solicitar (alta/cambio/baja)
 * usa COMPRAS_OBLIGACIONES_GESTIONAR; aprobar/rechazar exige FINANCE_PAYMENT_CALENDAR_AUTORIZAR
 * (el MISMO permiso que libera el lote del Calendario de Pagos) — separación real: quien pide
 * el cambio no puede aprobarlo.
 */
@ApiTags('finance-supplier-payment-accounts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/supplier-payment-accounts')
export class SupplierPaymentAccountsController {
  constructor(private readonly svc: SupplierPaymentAccountsService) {}

  /**
   * `[PGP.1]` A quién le falta cuenta, ordenado por el dinero que destraba.
   *
   * ⭐ Lo ven **los dos lados del circuito**: Compras es quien abre la solicitud de alta y
   * Tesorería es quien tiene la CLABE en la banca en línea. Por eso `RequireAnyPermission` y no
   * el `COMPRAS_OBLIGACIONES_VER` del resto del módulo — con ése, quien tiene el dato no podría
   * ver la lista. No expone ningún dato bancario: el control sigue en solicitar y aprobar.
   */
  @Get('faltantes')
  @RequireAnyPermission(Permission.COMPRAS_OBLIGACIONES_VER, Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'PGP.1 — proveedores que cobran por banco y no tienen cuenta de pago, por dinero descendente.' })
  listMissing(@Query('dias') dias?: string): Promise<CuentasPagoFaltantesResponse> {
    return this.svc.listMissingAccounts(dias ? Number(dias) : 120);
  }

  /**
   * `[PGP.29]` (objetivo **O6**) — la cuenta que cada acreedor YA declaró en su propio REP.
   *
   * ⭐ Mismo permiso que `faltantes` y por la misma razón: lo miran **los dos lados** —Compras
   * abre la solicitud, Tesorería la firma—, y con el permiso de Compras solo, quien firma no
   * vería de dónde salió la cuenta.
   *
   * ⚠️ Expone una CLABE, que `faltantes` a propósito no hacía. Es la misma CLABE que el
   * proveedor nos declaró **para que le paguemos**, y sin verla no se puede decidir el alta.
   * El control sigue donde estaba: **aprobar** exige `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`.
   */
  @Get('propuestas')
  @RequireAnyPermission(Permission.COMPRAS_OBLIGACIONES_VER, Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'PGP.29 — la cuenta que el proveedor declaro en su REP timbrado, con su evidencia. Solo propone: no da de alta.' })
  listProposals(): Promise<CuentaPagoPropuesta[]> {
    return this.svc.listAccountProposals();
  }

  @Get('by-supplier/:supplierId')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  listAccounts(@Param('supplierId') supplierId: string): Promise<SupplierPaymentAccountRow[]> {
    return this.svc.listAccounts(supplierId);
  }

  @Get('solicitudes')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Bandeja de solicitudes de alta/cambio/baja de cuenta. Default: pendientes.' })
  listRequests(@Query('status') status?: string): Promise<SupplierPaymentAccountRequestRow[]> {
    return this.svc.listRequests(status);
  }

  @Post('adjunto')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Sube el JPG/PDF de la solicitud de pago (evita errores de captura contra la factura/recibo).' })
  uploadAttachment(@Body() body: { file_base64?: string }): Promise<{ url: string; kind: string }> {
    return this.svc.uploadAttachment(body?.file_base64 || '');
  }

  @Post('solicitudes')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Solicita alta/cambio/baja de una cuenta de pago a proveedor. Requiere motivo. NO se aplica sola.' })
  createRequest(@Body() dto: CreateAccountChangeRequestDto, @Req() req: AuthedRequest): Promise<SupplierPaymentAccountRequestRow> {
    return this.svc.createRequest(dto, req.user?.username || 'sistema');
  }

  @Post('solicitudes/:id/aprobar')
  @RequirePermissions(Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
  @ApiOperation({ summary: 'Aprueba y APLICA la solicitud (crea/modifica/desactiva la cuenta real). Permiso restringido.' })
  approve(@Param('id') id: string, @Body() body: { decision_notes?: string }, @Req() req: AuthedRequest): Promise<SupplierPaymentAccountRequestRow> {
    return this.svc.approveRequest(id, req.user?.username || 'sistema', body?.decision_notes);
  }

  @Post('solicitudes/:id/rechazar')
  @RequirePermissions(Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
  reject(@Param('id') id: string, @Body() body: { decision_notes?: string }, @Req() req: AuthedRequest): Promise<SupplierPaymentAccountRequestRow> {
    return this.svc.rejectRequest(id, req.user?.username || 'sistema', body?.decision_notes);
  }
}
