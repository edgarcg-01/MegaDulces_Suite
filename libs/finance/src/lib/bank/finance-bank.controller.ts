import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { FinanceBankService, ListMovementsQuery } from './finance-bank.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * CB.2 — Conciliación bancaria (ADR-033). Lectura del tablero (cuentas, catálogo,
 * estados de cuenta, movimientos, CONCENTRADO) + reclasificación de movimientos.
 * Lectura = FINANCE_EXPENSES_VER · reclasificar = FINANCE_FINDINGS_GESTIONAR.
 */
@ApiTags('finance-bank')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank')
export class FinanceBankController {
  constructor(private readonly svc: FinanceBankService) {}

  @Get('accounts')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Cuentas de banco/caja/factoraje.' })
  accounts() { return this.svc.accounts(); }

  @Get('categories')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Catálogo de categorías limpias (alineado a Kepler).' })
  categories() { return this.svc.categories(); }

  @Get('periods')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Periodos con estados de cuenta cargados.' })
  periods() { return this.svc.periods(); }

  @Get('statements')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Estados de cuenta de un periodo (por cuenta) con totales.' })
  statements(@Query('period') period?: string) { return this.svc.statements(period); }

  @Get('concentrado')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Tablero CONCENTRADO: pivote cuenta × grupo + totales.' })
  concentrado(@Query('period') period?: string) { return this.svc.concentrado(period); }

  @Get('movements')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Movimientos filtrados (grid), paginados.' })
  movements(
    @Query('period') period?: string,
    @Query('account_id') account_id?: string,
    @Query('category_id') category_id?: string,
    @Query('group_key') group_key?: string,
    @Query('uncategorized') uncategorized?: string,
    @Query('recon_status') recon_status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const q: ListMovementsQuery = {
      period, account_id, category_id, group_key, uncategorized, recon_status, search,
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    };
    return this.svc.movements(q);
  }

  @Patch('movements/:id/category')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'Reclasifica un movimiento (asigna/limpia categoría).' })
  reclassify(@Param('id') id: string, @Body() body: { category_id?: string | null }, @Req() req: AuthedRequest) {
    return this.svc.reclassify(id, body?.category_id ?? null, req?.user?.full_name || req?.user?.username);
  }
}
