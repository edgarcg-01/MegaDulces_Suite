import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase PU.1 — Presupuestos: motor de egresos (ADR-066).
 *
 * El ledger de 5 estados vive en la PARTIDA (`budget.budget_lines`), no en la obligación. Reproduce
 * la spec §8.1/§8.2:
 *   disponible = vigente − reservas − compromisos − ejercido   (el PAGADO va aparte, no se resta).
 * Cada transición SUSTITUYE el saldo anterior (no suma dos veces) y deja un movimiento inmutable en
 * `budget.line_movements`. Validación y registro son ATÓMICOS (lock `FOR UPDATE` de la partida en la
 * misma trx) para que dos operaciones simultáneas no sobregiren. Idempotencia por (origen, documento,
 * tipo): reintentar un evento NO vuelve a consumir saldo.
 *
 * ⚠️ El mapeo evento→transición (qué evento reserva/compromete/ejerce por tipo de partida, spec §16.3)
 * es una decisión de negocio pendiente (PU.0.5). Este motor expone las transiciones como primitivas;
 * el default de cableado (solicitud→reserva, orden→compromiso, comprobación/póliza→ejercido, pago→pago)
 * se aplica en la capa que llame a estas primitivas y es CONFIGURABLE.
 */

export interface CreateBudgetDto {
  name: string;
  fiscal_year: number;
  entity?: string | null;
  currency?: string;
  notes?: string | null;
}

export interface CreateBudgetLineDto {
  concept: string;
  line_type?: 'ingreso' | 'costo_ventas' | 'gasto' | 'compra_inventario' | 'inversion' | 'flujo';
  area?: string | null;
  cost_center?: string | null;
  account_code?: string | null;
  responsible?: string | null;
  period_month?: string | null;
  original_amount: number;
  control_level?: 'informativo' | 'advertencia' | 'bloqueo';
  /** Gasto operativo (spec §9): clasificación fijo/variable y recurrente/no. Solo aplica a line_type='gasto'. */
  expense_class?: 'fijo' | 'variable' | null;
  recurrence?: 'recurrente' | 'no_recurrente' | null;
}

export interface MovementOpts {
  sourceKind?: string;
  sourceRef?: string;
  note?: string;
  /** compromiso: convertir desde una reserva previa en vez de consumir disponible nuevo. */
  fromReserva?: boolean;
}

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

@Injectable()
export class BudgetLinesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ── Cabecera ────────────────────────────────────────────────────────────────────────────

  async createBudget(dto: CreateBudgetDto, username: string) {
    if (!dto.name?.trim()) throw new BadRequestException('name es requerido');
    if (!(Number(dto.fiscal_year) >= 2000)) throw new BadRequestException('fiscal_year inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('budget.budgets').insert({
        tenant_id: tenantId,
        name: dto.name.trim(),
        fiscal_year: dto.fiscal_year,
        entity: dto.entity ?? null,
        currency: dto.currency ?? 'MXN',
        notes: dto.notes ?? null,
        created_by: username,
      }).returning('*');
      return row;
    });
  }

  async listBudgets() {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('budget.budgets').orderBy([{ column: 'fiscal_year', order: 'desc' }, { column: 'created_at', order: 'desc' }]));
  }

  async getBudget(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.budgets').where({ id }).first());
    if (!row) throw new NotFoundException('Presupuesto no encontrado');
    return row;
  }

  /** borrador → pendiente (listo para autorizar). */
  async submitBudget(id: string, username: string) {
    return this.transitionBudget(id, ['borrador', 'en_revision'], 'pendiente', username);
  }

  /** pendiente → aprobado/vigente. No se puede autoaprobar la propia captura (spec §8.3). */
  async approveBudget(id: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (b.status !== 'pendiente') throw new BadRequestException(`Solo se aprueba un presupuesto 'pendiente' (está '${b.status}')`);
      if (b.created_by && b.created_by === username) throw new BadRequestException('No puedes autorizar tu propio presupuesto (separación de funciones)');
      const [row] = await trx('budget.budgets').where({ tenant_id: tenantId, id })
        .update({ status: 'aprobado', authorized_by: username, authorized_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() })
        .returning('*');
      return row;
    });
  }

  async closeBudget(id: string, username: string) {
    return this.transitionBudget(id, ['aprobado'], 'cerrado', username);
  }

  private async transitionBudget(id: string, from: string[], to: string, username: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!from.includes(b.status)) throw new BadRequestException(`Transición inválida: '${b.status}' → '${to}'`);
      const [row] = await trx('budget.budgets').where({ tenant_id: tenantId, id })
        .update({ status: to, updated_by: username, updated_at: trx.fn.now() }).returning('*');
      return row;
    });
  }

  // ── Partidas ────────────────────────────────────────────────────────────────────────────

  async createLine(budgetId: string, dto: CreateBudgetLineDto, username: string) {
    if (!dto.concept?.trim()) throw new BadRequestException('concept es requerido');
    if (!(Number(dto.original_amount) >= 0)) throw new BadRequestException('original_amount debe ser >= 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
      if (!b) throw new NotFoundException('Presupuesto no encontrado');
      if (!['borrador', 'en_revision'].includes(b.status)) {
        throw new BadRequestException(`No se pueden agregar partidas a un presupuesto '${b.status}' (solo en borrador/revisión). Usa una adecuación autorizada.`);
      }
      const original = round2(dto.original_amount);
      const [line] = await trx('budget.budget_lines').insert({
        tenant_id: tenantId,
        budget_id: budgetId,
        concept: dto.concept.trim(),
        line_type: dto.line_type ?? 'gasto',
        area: dto.area ?? null,
        cost_center: dto.cost_center ?? null,
        account_code: dto.account_code ?? null,
        responsible: dto.responsible ?? null,
        period_month: dto.period_month ?? null,
        original_amount: original,
        vigente_amount: original,
        control_level: dto.control_level ?? 'bloqueo',
        expense_class: dto.expense_class ?? null,
        recurrence: dto.recurrence ?? null,
        created_by: username,
      }).returning('*');
      if (original > 0) {
        await trx('budget.line_movements').insert({
          tenant_id: tenantId, budget_line_id: line.id, movement_type: 'apertura',
          amount: original, source_kind: 'apertura', note: 'Autorización original', created_by: username,
        });
      }
      return this.decorate(line);
    });
  }

  async listLines(budgetId: string) {
    this.tenantCtx.requireTenantId();
    const rows = await this.tk.run((trx) => trx('budget.budget_lines').where({ budget_id: budgetId }).orderBy('created_at'));
    return rows.map((r) => this.decorate(r));
  }

  async getLine(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.budget_lines').where({ id }).first());
    if (!row) throw new NotFoundException('Partida no encontrada');
    return this.decorate(row);
  }

  async movements(lineId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('budget.line_movements').where({ budget_line_id: lineId }).orderBy('created_at'));
  }

  /** disponible = vigente − reservas − compromisos − ejercido. Pagado aparte. */
  private decorate(r: any) {
    const disponible = round2(Number(r.vigente_amount) - Number(r.reserved_amount) - Number(r.committed_amount) - Number(r.exercised_amount));
    return { ...r, available_amount: disponible };
  }

  // ── Ejecución (las primitivas del ledger) ────────────────────────────────────────────────

  reservar(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'reserva', amount, opts, username);
  }
  comprometer(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'compromiso', amount, opts, username);
  }
  ejercer(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'ejercido', amount, opts, username);
  }
  pagar(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'pago', amount, opts, username);
  }
  ampliar(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'ampliacion', amount, opts, username);
  }
  reducir(lineId: string, amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'reduccion', amount, opts, username);
  }
  /** Cancela una reserva o un compromiso pendiente, liberando disponible. */
  cancelar(lineId: string, target: 'reserva' | 'compromiso', amount: number, opts: MovementOpts, username: string) {
    return this.applyMovement(lineId, 'cancelacion', amount, { ...opts, note: opts.note ?? `cancelacion de ${target}`, }, username, target);
  }

  /** Transferencia autorizada entre dos partidas (vigente): sale de una, entra a otra, misma trx. */
  async transferir(fromLineId: string, toLineId: string, amount: number, opts: MovementOpts, username: string) {
    if (fromLineId === toLineId) throw new BadRequestException('Origen y destino no pueden ser la misma partida');
    const amt = round2(amount);
    if (!(amt > 0)) throw new BadRequestException('El monto debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const from = await this.lockLine(trx, tenantId, fromLineId);
      const to = await this.lockLine(trx, tenantId, toLineId);
      await this.assertBudgetAprobado(trx, tenantId, from.budget_id);
      await this.assertBudgetAprobado(trx, tenantId, to.budget_id);
      // Salida: como una reducción (no puede dejar la partida por debajo de lo consumido).
      const consumedFrom = Number(from.reserved_amount) + Number(from.committed_amount) + Number(from.exercised_amount);
      if (round2(Number(from.vigente_amount) - amt) < round2(consumedFrom)) {
        throw new BadRequestException('La transferencia dejaría la partida origen por debajo de lo ya reservado/comprometido/ejercido');
      }
      await this.writeMovement(trx, tenantId, from.id, 'transferencia_out', amt, { ...opts, counterpart: to.id }, username);
      await trx('budget.budget_lines').where({ tenant_id: tenantId, id: from.id })
        .update({ vigente_amount: round2(Number(from.vigente_amount) - amt), updated_by: username, updated_at: trx.fn.now() });
      await this.writeMovement(trx, tenantId, to.id, 'transferencia_in', amt, { ...opts, counterpart: from.id }, username);
      await trx('budget.budget_lines').where({ tenant_id: tenantId, id: to.id })
        .update({ vigente_amount: round2(Number(to.vigente_amount) + amt), updated_by: username, updated_at: trx.fn.now() });
      return {
        from: this.decorate(await trx('budget.budget_lines').where({ tenant_id: tenantId, id: from.id }).first()),
        to: this.decorate(await trx('budget.budget_lines').where({ tenant_id: tenantId, id: to.id }).first()),
      };
    });
  }

  private async lockLine(trx: any, tenantId: string, lineId: string) {
    const line = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId }).forUpdate().first();
    if (!line) throw new NotFoundException('Partida no encontrada');
    if (line.status !== 'activa') throw new BadRequestException('La partida está cerrada');
    return line;
  }

  private async assertBudgetAprobado(trx: any, tenantId: string, budgetId: string) {
    const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
    if (!b) throw new NotFoundException('Presupuesto no encontrado');
    if (b.status !== 'aprobado') throw new BadRequestException(`El presupuesto no está vigente (está '${b.status}'); no se pueden mover saldos`);
  }

  /** Idempotencia: si ya existe el movimiento (origen, documento, tipo), lo devuelve sin re-aplicar. */
  private async findIdempotent(trx: any, tenantId: string, lineId: string, type: string, opts: MovementOpts) {
    if (!opts.sourceRef) return null;
    return trx('budget.line_movements').where({
      tenant_id: tenantId, budget_line_id: lineId, movement_type: type,
      source_kind: opts.sourceKind ?? null, source_ref: opts.sourceRef,
    }).first();
  }

  private async writeMovement(trx: any, tenantId: string, lineId: string, type: string, amount: number, opts: MovementOpts & { counterpart?: string }, username: string) {
    try {
      const [mov] = await trx('budget.line_movements').insert({
        tenant_id: tenantId, budget_line_id: lineId, movement_type: type, amount,
        counterpart_line_id: opts.counterpart ?? null,
        source_kind: opts.sourceKind ?? null, source_ref: opts.sourceRef ?? null,
        note: opts.note ?? null, created_by: username,
      }).returning('*');
      return mov;
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException('Movimiento duplicado (misma clave de idempotencia)');
      throw e;
    }
  }

  private async applyMovement(
    lineId: string, type: 'reserva' | 'compromiso' | 'ejercido' | 'pago' | 'ampliacion' | 'reduccion' | 'cancelacion',
    amount: number, opts: MovementOpts, username: string, cancelTarget?: 'reserva' | 'compromiso',
  ) {
    const amt = round2(amount);
    if (!(amt > 0)) throw new BadRequestException('El monto debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const existing = await this.findIdempotent(trx, tenantId, lineId, type, opts);
      if (existing) {
        const line = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId }).first();
        return { line: this.decorate(line), movement: existing, idempotent: true, warning: null as string | null };
      }
      const line = await this.lockLine(trx, tenantId, lineId);
      await this.assertBudgetAprobado(trx, tenantId, line.budget_id);

      const vigente = Number(line.vigente_amount);
      let reserved = Number(line.reserved_amount);
      let committed = Number(line.committed_amount);
      let exercised = Number(line.exercised_amount);
      let paid = Number(line.paid_amount);
      const disponible = round2(vigente - reserved - committed - exercised);
      let warning: string | null = null;

      const overdraftGate = (extra: number) => {
        if (round2(extra) > disponible) {
          if (line.control_level === 'bloqueo') {
            throw new BadRequestException(`Sobregiro bloqueado: disponible ${disponible}, se pidio ${round2(extra)}`);
          }
          warning = `Sobregiro (${line.control_level}): disponible ${disponible}, se comprometió ${round2(extra)}`;
        }
      };

      switch (type) {
        case 'reserva':
          overdraftGate(amt);
          reserved = round2(reserved + amt);
          break;
        case 'compromiso':
          if (opts.fromReserva) {
            if (round2(reserved) < amt) throw new BadRequestException(`Reserva insuficiente para comprometer: reservado ${round2(reserved)}, se pidió ${amt}`);
            reserved = round2(reserved - amt);
            committed = round2(committed + amt);
          } else {
            overdraftGate(amt);
            committed = round2(committed + amt);
          }
          break;
        case 'ejercido':
          if (round2(committed) < amt) throw new BadRequestException(`Compromiso insuficiente para ejercer: comprometido ${round2(committed)}, se pidió ${amt}`);
          committed = round2(committed - amt);
          exercised = round2(exercised + amt);
          break;
        case 'pago':
          if (round2(paid + amt) > round2(exercised)) throw new BadRequestException(`No se puede pagar más de lo ejercido: ejercido ${round2(exercised)}, pagado ${round2(paid)} + ${amt}`);
          paid = round2(paid + amt);
          break;
        case 'ampliacion':
          break; // afecta vigente abajo
        case 'reduccion':
          if (round2(vigente - amt) < round2(reserved + committed + exercised)) {
            throw new BadRequestException('La reducción dejaría la partida por debajo de lo ya reservado/comprometido/ejercido');
          }
          break;
        case 'cancelacion':
          if (cancelTarget === 'reserva') {
            if (round2(reserved) < amt) throw new BadRequestException(`No hay tanta reserva para cancelar: reservado ${round2(reserved)}`);
            reserved = round2(reserved - amt);
          } else {
            if (round2(committed) < amt) throw new BadRequestException(`No hay tanto compromiso para cancelar: comprometido ${round2(committed)}`);
            committed = round2(committed - amt);
          }
          break;
      }

      const newVigente = type === 'ampliacion' ? round2(vigente + amt) : type === 'reduccion' ? round2(vigente - amt) : vigente;

      const mov = await this.writeMovement(trx, tenantId, lineId, type, amt, opts, username);
      const [updated] = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId })
        .update({
          vigente_amount: newVigente, reserved_amount: reserved, committed_amount: committed,
          exercised_amount: exercised, paid_amount: paid, updated_by: username, updated_at: trx.fn.now(),
        }).returning('*');
      return { line: this.decorate(updated), movement: mov, idempotent: false, warning };
    });
  }
}
