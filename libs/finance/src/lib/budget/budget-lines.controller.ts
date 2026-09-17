import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  BudgetLinesService, CreateBudgetDto, CreateBudgetLineDto, MovementOpts,
} from './budget-lines.service';

interface AuthedRequest { user?: { username?: string } }
interface MovementBody { amount: number; sourceKind?: string; sourceRef?: string; note?: string; fromReserva?: boolean }

const optsOf = (b: MovementBody): MovementOpts => ({ sourceKind: b.sourceKind, sourceRef: b.sourceRef, note: b.note, fromReserva: b.fromReserva });

/**
 * Fase PU.1 — Presupuestos: motor de egresos (ADR-066). Cabecera + partidas + las primitivas del
 * ledger de 5 estados. Reusa `PRESUPUESTOS_VER/GESTIONAR` (Fase TP). La no-autoaprobación la valida
 * el servicio (created_by ≠ quien aprueba).
 */
@ApiTags('finance-budget')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetLinesController {
  constructor(private readonly svc: BudgetLinesService) {}

  private who(req: AuthedRequest) { return req.user?.username || 'sistema'; }

  // ── Cabecera ──
  @Get('budgets')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  listBudgets() { return this.svc.listBudgets(); }

  @Post('budgets')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  createBudget(@Body() dto: CreateBudgetDto, @Req() req: AuthedRequest) { return this.svc.createBudget(dto, this.who(req)); }

  @Get('budgets/:id')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  getBudget(@Param('id') id: string) { return this.svc.getBudget(id); }

  @Post('budgets/:id/submit')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  submit(@Param('id') id: string, @Req() req: AuthedRequest) { return this.svc.submitBudget(id, this.who(req)); }

  @Post('budgets/:id/approve')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Aprueba/hace vigente. No se puede autoaprobar la propia captura.' })
  approve(@Param('id') id: string, @Req() req: AuthedRequest) { return this.svc.approveBudget(id, this.who(req)); }

  @Post('budgets/:id/close')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  close(@Param('id') id: string, @Req() req: AuthedRequest) { return this.svc.closeBudget(id, this.who(req)); }

  // ── Partidas ──
  @Get('budgets/:id/lines')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  listLines(@Param('id') id: string) { return this.svc.listLines(id); }

  @Post('budgets/:id/lines')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  createLine(@Param('id') id: string, @Body() dto: CreateBudgetLineDto, @Req() req: AuthedRequest) { return this.svc.createLine(id, dto, this.who(req)); }

  @Get('lines/:id')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  getLine(@Param('id') id: string) { return this.svc.getLine(id); }

  @Get('lines/:id/movements')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  movements(@Param('id') id: string) { return this.svc.movements(id); }

  // ── Ejecución (primitivas del ledger) ──
  @Post('lines/:id/reservar')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  reservar(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.reservar(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/comprometer')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  comprometer(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.comprometer(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/ejercer')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  ejercer(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.ejercer(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/pagar')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  pagar(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.pagar(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/ampliar')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  ampliar(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.ampliar(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/reducir')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  reducir(@Param('id') id: string, @Body() b: MovementBody, @Req() req: AuthedRequest) { return this.svc.reducir(id, b.amount, optsOf(b), this.who(req)); }

  @Post('lines/:id/cancelar')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  cancelar(@Param('id') id: string, @Body() b: MovementBody & { target: 'reserva' | 'compromiso' }, @Req() req: AuthedRequest) {
    return this.svc.cancelar(id, b.target, b.amount, optsOf(b), this.who(req));
  }

  @Post('lines/transferir')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  transferir(@Body() b: MovementBody & { from: string; to: string }, @Req() req: AuthedRequest) {
    return this.svc.transferir(b.from, b.to, b.amount, optsOf(b), this.who(req));
  }
}
