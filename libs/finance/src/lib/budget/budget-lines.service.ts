import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import type { BudgetLineMovement } from '@megadulces/contracts';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { BudgetGenerationService } from './budget-generation.service';

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

/**
 * Lo que devuelve un movimiento del ledger. `[NX.11]` 2026-09-21 — **nota para quien siga acá:**
 * este tipo se agregó porque `scripts/lint-boundary-gate.js` rechazaba `applyMovementInTrx` sin
 * anotación de retorno (regla `explicit-module-boundary-types`, ADR-052), y el gate corre en LOCAL
 * mientras el CI siga apagado (ver la cabecera de `CLAUDE.md`).
 *
 * Las filas van con **índice `unknown`** a propósito: son filas crudas de knex y acá NO se inventa
 * el esquema de `budget.budget_lines` / `budget_line_movements`. Se nombran sólo los campos que
 * este archivo lee de verdad. Verificado antes de tiparlo: **ningún llamador en TS lee campos de
 * este objeto** — los controllers lo devuelven tal cual a HTTP — así que nombrar de menos no
 * rompe nada. Si algún día hace falta indexar, el arreglo correcto es tipar la fila, no volver a
 * `any`.
 */
export interface BudgetMovementResult {
  line: { available_amount: number; [k: string]: unknown };
  movement: { [k: string]: unknown };
  /** true si el movimiento ya existía por `(sourceKind, sourceRef, tipo)` y no se volvió a aplicar. */
  idempotent: boolean;
  warning: string | null;
}

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

@Injectable()
export class BudgetLinesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    /** `[VE.5-F]` La compuerta de completitud que usa `submitBudget`. */
    private readonly generation: BudgetGenerationService,
  ) {}

  // ── Cabecera ────────────────────────────────────────────────────────────────────────────

  async createBudget(dto: CreateBudgetDto, username: string) {
    if (!dto.name?.trim()) throw new BadRequestException('name es requerido');
    if (!(Number(dto.fiscal_year) >= 2000)) throw new BadRequestException('fiscal_year inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // `[PU.VA]` ⛔ El ejercicio creado a mano nacía **SIN FOLIO**, y así se ve en la pantalla:
      // el chip imprime «sin folio» donde los demás llevan `PRE-2027-002`. Sólo lo generaba
      // `ensureBudgetForYear` —el camino del piloto—, y el manual se saltaba el mostrador.
      //
      // Es exactamente lo que `[VE.5-A]` vino a resolver: *«un folio no se teclea»*. El nombre es
      // texto libre que alguien escribe una vez y queda para siempre (de ahí salió un ejercicio
      // llamado `presupesto`); el folio es lo estable con lo que todos lo nombran. Que el camino
      // manual no lo diera dejaba justo a los ejercicios excepcionales sin identificador.
      //
      // Misma secuencia atómica que el piloto (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), así
      // que los dos caminos comparten numeración y no se pisan.
      const n = await this.generation.nextFolio(trx as never, tenantId, 'ejercicio', String(dto.fiscal_year));
      const folio = `PRE-${dto.fiscal_year}-${String(n).padStart(3, '0')}`;
      const [row] = await trx('budget.budgets').insert({
        tenant_id: tenantId,
        folio,
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

  /**
   * `[PU.VG.9]` El catálogo que alimenta el selector de la pantalla.
   *
   * ⛔ **La pantalla abría sobre el ejercicio de PRUEBA**, y los tres eslabones son inocentes por
   * separado: esta lista ordena por `fiscal_year DESC, created_at DESC`, el duplicado de FY2027 es
   * **el más nuevo**, y el front hace `selectBudget(rows[0])`. Medido en prod el 2026-10-09, el
   * orden real era `[0] FY2027 [PRUEBA] · [1] FY2027 real · [2] FY2026`.
   *
   * ⭐ **Y lo que lo volvía invisible:** el duplicado es exacto al centavo, así que la cifra que se
   * publicaba era CORRECTA ($74,850,066.62 de los dos lados). No es un número falso: es el número
   * bueno leído de una fila que nadie mantiene. El día que alguien edite una de las dos, la
   * pantalla sigue anclada a la de prueba y nada cambia visualmente.
   *
   * ⛔ **NO se filtra, y es deliberado.** Esconder el ejercicio de prueba lo vuelve inalcanzable
   * desde la UI —nadie podría ni borrarlo— y es un cambio de comportamiento en silencio. Lo que
   * cambia es el ORDEN: `is_test` último. Deja de ser `rows[0]` sin desaparecer, y se arregla para
   * **todo** cliente del endpoint, no sólo para esta pantalla. El freno va en el servicio porque
   * la pantalla es un cliente entre varios.
   */
  async listBudgets() {
    this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => trx('budget.budgets').orderBy([
      // Primero lo que manda. `is_test` es NOT NULL con default false, así que no hay NULLs que
      // ordenar: un ejercicio nuevo se asume REAL y entra arriba, que es lo que se quiere.
      { column: 'is_test', order: 'asc' },
      { column: 'fiscal_year', order: 'desc' },
      { column: 'created_at', order: 'desc' },
    ]));
  }

  async getBudget(id: string) {
    this.tenantCtx.requireTenantId();
    const row = await this.tk.run((trx) => trx('budget.budgets').where({ id }).first());
    if (!row) throw new NotFoundException('Presupuesto no encontrado');
    return row;
  }

  /**
   * borrador → pendiente (listo para autorizar).
   *
   * `[VE.5-F]` ⛔ **No se manda a firma un ejercicio vacío.** El caso está vivo en prod: `prueba`
   * (FY2026) quedó en `pendiente` con **0 planes, 0 partidas y 0 supuestos**. Si alguien le da
   * Aprobar, aprueba nada — y además el ejercicio sale del alcance del piloto, que sólo trabaja
   * sobre `borrador`/`en_revision`, así que se queda vacío para siempre.
   *
   * La compuerta separa **bloqueos** de **avisos**: un plan de gastos faltante se declara y deja
   * pasar; no tener ni un renglón, o un plan de ventas que cubre 10 de 13 periodos, no.
   */
  async submitBudget(id: string, username: string) {
    const estado = await this.generation.completeness(id);
    if (!estado.listo) {
      throw new BadRequestException(
        `El ejercicio ${estado.folio ?? id} no está listo para autorizar: ${estado.bloqueos.join(' · ')}`);
    }
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

  async movements(lineId: string): Promise<BudgetLineMovement[]> {
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

  private async lockLine(trx: Knex.Transaction, tenantId: string, lineId: string) {
    const line = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId }).forUpdate().first();
    if (!line) throw new NotFoundException('Partida no encontrada');
    if (line.status !== 'activa') throw new BadRequestException('La partida está cerrada');
    return line;
  }

  private async assertBudgetAprobado(trx: Knex.Transaction, tenantId: string, budgetId: string) {
    const b = await trx('budget.budgets').where({ tenant_id: tenantId, id: budgetId }).first();
    if (!b) throw new NotFoundException('Presupuesto no encontrado');
    if (b.status !== 'aprobado') throw new BadRequestException(`El presupuesto no está vigente (está '${b.status}'); no se pueden mover saldos`);
  }

  /** Idempotencia: si ya existe el movimiento (origen, documento, tipo), lo devuelve sin re-aplicar. */
  private async findIdempotent(trx: Knex.Transaction, tenantId: string, lineId: string, type: string, opts: MovementOpts) {
    if (!opts.sourceRef) return null;
    return trx('budget.line_movements').where({
      tenant_id: tenantId, budget_line_id: lineId, movement_type: type,
      source_kind: opts.sourceKind ?? null, source_ref: opts.sourceRef,
    }).first();
  }

  private async writeMovement(trx: Knex.Transaction, tenantId: string, lineId: string, type: string, amount: number, opts: MovementOpts & { counterpart?: string; cancelTarget?: 'reserva' | 'compromiso' }, username: string) {
    try {
      const [mov] = await trx('budget.line_movements').insert({
        tenant_id: tenantId, budget_line_id: lineId, movement_type: type, amount,
        counterpart_line_id: opts.counterpart ?? null,
        source_kind: opts.sourceKind ?? null, source_ref: opts.sourceRef ?? null,
        // [PU.VG.4a] QUE acumulador bajo esta cancelacion. Antes esto viajaba SOLO en `note`, texto
        // libre que el llamador puede reemplazar -- o sea que `reserved_amount` y
        // `committed_amount` no se podian recomputar desde el ledger, y ese es el unico cuadre que
        // puede fallar (el obvio es una tautologia: `available_amount` no es columna). El CHECK de
        // la tabla exige esto en las dos direcciones, asi que una cancelacion sin objetivo ya no
        // entra. NULL = no aplica, nunca "no se" (ADR-056).
        cancel_target: type === 'cancelacion' ? (opts.cancelTarget ?? null) : null,
        // [PU.VG.4a] El gemelo del mismo defecto: un `compromiso` con fromReserva MUEVE reservado a
        // comprometido, y sin el, `committed += amt` sale del disponible y reserved no se toca.
        // Los dos escribian un movimiento IDENTICO, asi que reserved_amount tampoco se podia
        // recomputar. Va booleano y no nullable: para un movimiento que no es compromiso, `false`
        // es cierto, no una suposicion.
        from_reserva: type === 'compromiso' ? !!opts.fromReserva : false,
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
    return this.tk.run((trx) => this.applyMovementInTrx(trx, lineId, type, amount, opts, username, cancelTarget));
  }

  /**
   * Núcleo del movimiento del ledger DENTRO de una trx dada (no abre tk.run) — para que el Calendario
   * de Pagos (Fase TP, `BUDGET_LEDGER_PORT`) lo llame en SU propia transacción sin anidar `tk.run`
   * (regla del proyecto). `applyMovement` es el wrapper que abre la trx del request normal.
   */
  async applyMovementInTrx(
    trx: Knex.Transaction,
    lineId: string, type: 'reserva' | 'compromiso' | 'ejercido' | 'pago' | 'ampliacion' | 'reduccion' | 'cancelacion',
    amount: number, opts: MovementOpts, username: string, cancelTarget?: 'reserva' | 'compromiso',
  ): Promise<BudgetMovementResult> {
    const amt = round2(amount);
    if (!(amt > 0)) throw new BadRequestException('El monto debe ser > 0');
    const tenantId = this.tenantCtx.requireTenantId();
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
          // [PU.VG.4a] El `else` de abajo mandaba a `compromiso` CUALQUIER cancelTarget que no
          // fuera exactamente 'reserva' -- incluido `undefined`. O sea que un llamador que lo
          // olvidara bajaba el bucket equivocado EN SILENCIO, y el movimiento quedaba escrito sin
          // decir cual fue. Ahora se exige explicito: una ambiguedad se rechaza, no se resuelve
          // por default. (El CHECK de la tabla lo atrapa igual, pero da un 500 de constraint en
          // vez de un 400 que se entienda.)
          if (cancelTarget !== 'reserva' && cancelTarget !== 'compromiso') {
            throw new BadRequestException("cancelacion exige target explicito: 'reserva' o 'compromiso'");
          }
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

      const mov = await this.writeMovement(trx, tenantId, lineId, type, amt, { ...opts, cancelTarget }, username);
      const [updated] = await trx('budget.budget_lines').where({ tenant_id: tenantId, id: lineId })
        .update({
          vigente_amount: newVigente, reserved_amount: reserved, committed_amount: committed,
          exercised_amount: exercised, paid_amount: paid, updated_by: username, updated_at: trx.fn.now(),
        }).returning('*');
      return { line: this.decorate(updated), movement: mov, idempotent: false, warning };
  }

  /**
   * Puerto `BUDGET_LEDGER_PORT` (Fase TP → PU): aplica un movimiento sobre la partida en la trx del
   * llamador. Es el punto por el que el Calendario de Pagos une lo que PAGA con el ledger de la
   * partida — una sola verdad del gasto (ADR-066). Idempotente por (sourceKind, sourceRef, tipo).
   */
  async applyInTrx(
    trx: Knex.Transaction, budgetLineId: string,
    type: 'compromiso' | 'ejercido' | 'pago' | 'cancelacion', amount: number,
    opts: MovementOpts, username: string, cancelTarget?: 'reserva' | 'compromiso',
  ): Promise<void> {
    await this.applyMovementInTrx(trx, budgetLineId, type, amount, opts, username, cancelTarget);
  }
}
