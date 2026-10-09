import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BudgetLineMovement } from '@megadulces/contracts';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  BudgetLinesService, CreateBudgetDto, CreateBudgetLineDto, MovementOpts,
} from './budget-lines.service';
import { BudgetGenerationService } from './budget-generation.service';
import { BudgetAutopilotService } from './budget-autopilot.service';
import { BudgetMaterializeService } from './budget-materialize.service';

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
  constructor(
    private readonly svc: BudgetLinesService,
    private readonly materialize: BudgetMaterializeService,
    private readonly generation: BudgetGenerationService,
    private readonly autopilot: BudgetAutopilotService,
  ) {}

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

  /**
   * `[VE.8]` Dispara la pasada del piloto AHORA, sin esperar a las 03:30.
   *
   * No existía: `BudgetAutopilotService.run()` era público pero ningún controller lo exponía, así
   * que la única forma de ejercerlo era esperar al cron — y con eso cada corrección tardaba un día
   * en poder comprobarse.
   *
   * ⚠️ Es la MISMA pasada que corre de noche, no una versión recortada: deriva supuestos, propone
   * los dos planes, proyecta a meses y materializa partidas, respetando todo lo capturado a mano.
   * Pide `PRESUPUESTOS_GESTIONAR` porque escribe.
   */
  @Post('autopilot/run')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  // [PU.V7] Decía «la misma del cron 03:30» y [PU.V4] lo movió a las 07:30 — corría ANTES del
  // refresco de analytics que lo alimenta. Y no toma id: barre TODOS los ejercicios del tenant,
  // que es lo que el tooltip del botón también decía mal.
  @ApiOperation({ summary: '[VE.8] Corre la pasada del piloto ahora (la misma del cron de las 07:30), sobre TODOS los ejercicios: supuestos + plan de ventas + plan de gastos + proyección + partidas. Respeta lo manual.' })
  runAutopilot() { return this.autopilot.run(); }

  @Get('budgets/:id/completeness')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: '[VE.5-F] Qué le falta al ejercicio para poder ir a firma. Separa bloqueos (impiden submit) de avisos (se declaran).' })
  completeness(@Param('id') id: string) { return this.generation.completeness(id); }

  @Post('budgets/:id/submit')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  submit(@Param('id') id: string, @Req() req: AuthedRequest) { return this.svc.submitBudget(id, this.who(req)); }

  // `[PVI.10]` ⛔ Acá **preparar y autorizar eran la misma llave**: este endpoint pedía
  // `PRESUPUESTOS_GESTIONAR`, igual que `submit` y que editar una partida — tanto que la
  // descripción de esa clave decía textual «crear **y aprobar** el ejercicio presupuestal». El
  // único freno era no poder auto-aprobar la propia captura, que separa PERSONAS, no FACULTADES:
  // dos personas que preparan se aprueban el ejercicio entre sí sin que nadie autorice nada.
  //
  // ⚠️ `submit` se queda en `GESTIONAR` a propósito: mandar a firma es el último acto de quien
  //    prepara. Y `close` también, por ahora — cerrar no autoriza dinero, termina el ejercicio;
  //    si debe exigir autoridad es una pregunta aparte y se declara, no se amplía de contrabando.
  //
  // ⛔ El orden de entrega NO es libre: la migración que reparte la clave va **antes** que este
  //    código. Al revés, `direccion` pierde la aprobación en el instante del deploy (sólo
  //    `superadmin` seguiría pasando, por god-mode de rol) — fail-closed sobre gente real.
  @Post('budgets/:id/approve')
  @RequirePermissions(Permission.PRESUPUESTOS_APROBAR)
  @ApiOperation({ summary: 'Aprueba/hace vigente + materializa las partidas del plan. Exige PRESUPUESTOS_APROBAR (preparar ≠ autorizar). No se puede autoaprobar la propia captura.' })
  async approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    const who = this.who(req);
    const budget = await this.svc.approveBudget(id, who);
    // Materialización automática del plan → ledger (PR.1/ADR-074). Best-effort: no tumba la aprobación.
    let materialization: unknown = null;
    try { materialization = await this.materialize.materialize(id, who); }
    catch (e) { materialization = { error: (e as Error)?.message || 'materialización falló' }; }
    return { budget, materialization };
  }

  @Post('budgets/:id/materialize')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Materializa (re-sincroniza) las partidas del ledger desde los planes de ventas y gastos.' })
  materializeBudget(@Param('id') id: string, @Req() req: AuthedRequest) { return this.materialize.materialize(id, this.who(req)); }

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
  movements(@Param('id') id: string): Promise<BudgetLineMovement[]> { return this.svc.movements(id); }

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
