import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CashLedgerService, type CreateMovementInput } from './cash-ledger.service';
import { CajaAutofillService, type AutofillInput } from './caja-autofill.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string; username?: string } }

/**
 * CG.13/CG.17 — Caja General: el libro donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Distinto de `CajaGeneralController` (`/finance/caja`, CG.1-CG.7), que es la lectura del
 * ESPEJO del Access y seguirá viva durante el traslape. Éste es el lado que escribe.
 *
 * Permisos PROPIOS (§CG.14): hasta ahora todo `/finanzas/caja` colgaba de `FINANCE_BANK_VER`,
 * que es de Bancos. VER consulta · GESTIONAR captura · AUTORIZAR (fuera de todo MODULE_GROUP)
 * cierra el corte y confirma el mapa de conceptos. Capturar ≠ autorizar.
 */
@ApiTags('finance-cash-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cash-ledger')
export class CashLedgerController {
  constructor(
    private readonly svc: CashLedgerService,
    private readonly autofill: CajaAutofillService,
  ) {}

  /** El JWT trae el id con nombres distintos según el emisor; se toma el primero que exista. */
  private user(req: AuthedRequest) {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  @Get()
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Libro de caja: movimientos + KPIs del MISMO filtro. from/to, tipo, sucursal, cuenta, search.' })
  list(
    @Query('from') from?: string, @Query('to') to?: string, @Query('tipo') tipo?: string,
    @Query('sucursal') sucursal?: string, @Query('cuenta') cuenta?: string,
    @Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string,
  ) {
    return this.svc.list({
      from, to, tipo, sucursal, cuenta, search,
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('conceptos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Catálogo de conceptos de Kepler (vista derivada del ODS). El concepto es POR SUCURSAL.' })
  conceptos(@Query('sucursal') sucursal?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.conceptos({ sucursal, search, limit: limit ? Number(limit) : undefined });
  }

  @Get('cobertura')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Cobertura del catálogo de conceptos y del mapa HITL. Va SIEMPRE a la pantalla: "0 conceptos" por carril caído no puede verse igual que "no hay conceptos".' })
  cobertura() {
    return this.svc.coverage();
  }

  @Post('autofill')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'PROPONE los campos del movimiento con su procedencia y confianza. No guarda nada. Lo que no puede proponer sale en null con motivo.' })
  suggest(@Body() body: AutofillInput) {
    return this.autofill.suggest(body ?? {});
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Registra un movimiento. Folio atómico, par cuenta/concepto validado contra el catálogo vivo y arqueo que cuadra o no se guarda.' })
  create(@Body() body: CreateMovementInput, @Req() req: AuthedRequest) {
    return this.svc.create(body, this.user(req));
  }

  @Get(':id')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Detalle del movimiento con su desglose por denominación y el cuadre del arqueo ya calculado.' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }
}
