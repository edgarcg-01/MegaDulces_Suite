import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExpenseCaptureLinksService, IssueLinkDto } from './expense-capture-links.service';

interface AuthedRequest { user?: { sub?: string; username?: string; full_name?: string }; }

/**
 * GX.9 — administración de los links de captura de gasto (lado interno, con sesión).
 *
 * Emitir un link es **repartir una credencial de subida**: con él, alguien sin cuenta puede
 * escribir en `finance.expense_proofs`. Por eso emitir y revocar piden el permiso del que
 * decide sobre el gasto (`FINANCE_EXPENSES_COMPROBAR`), no el de captura. Listarlos alcanza
 * con ver gastos.
 *
 * No se creó un permiso nuevo a propósito: un permiso recién declarado no queda REPARTIDO
 * en prod hasta que una migración lo siembra por rol, y un módulo con el permiso sin repartir
 * no lo puede abrir nadie (lección de LC.6.2). Si el reparto amerita separarse, se hace con
 * su migración de backfill, no inventando la clave acá.
 */
@ApiTags('finance-expense-capture-links')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/capture-links')
export class ExpenseCaptureLinksController {
  constructor(private readonly svc: ExpenseCaptureLinksService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Links emitidos, con vigencia y cuántas capturas trajo cada uno.' })
  list() {
    return this.svc.list();
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Emite el link de captura de una persona y devuelve la URL para compartir.' })
  issue(@Body() body: IssueLinkDto, @Req() req: AuthedRequest) {
    return this.svc.issue(body, req?.user?.full_name || req?.user?.username);
  }

  @Delete(':id')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Da de baja el link. Surte efecto en el siguiente uso, sin esperar a que venza el token.' })
  revoke(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.revoke(id, req?.user?.full_name || req?.user?.username);
  }
}
