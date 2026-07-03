import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialOrdersService } from '../commercial-orders/commercial-orders.service';
import {
  DeliverAndCollectDto,
  PAYMENT_METHODS,
  PaymentMethod,
  PaymentRow,
  RecordKeplerPaymentDto,
  RecordPaymentDto,
} from './dto/payment.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CENT = 0.005; // tolerancia de redondeo (medio centavo)

/**
 * Fase LM.1 — cobros sobre un pedido (multi-método: cash/transfer/card/prepaid).
 *
 * Cierra la deuda "PaymentsService deferred" de Fase B: la tabla commercial.payments
 * existía vacía; este servicio la escribe. Reglas:
 *   - Lock FOR UPDATE del pedido (anti doble-cobro, patrón OrderStockService).
 *   - Actualiza orders.paid_amount / balance_due de forma atómica.
 *   - `card` = SOLO registro (terminal externa cobró); NO hay pasarela.
 *   - `transfer`/`card` nacen 'received' → el encargado verifica el comprobante.
 *   - Idempotente por (order_id, reference) para reintento offline del repartidor.
 *
 * El LLM/pasarela NO tocan el dinero (ADR-016/027): esto es puro ledger determinista.
 */
@Injectable()
export class CommercialPaymentsService {
  private readonly logger = new Logger(CommercialPaymentsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly orders: CommercialOrdersService,
  ) {}

  private requireUserId(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Usuario no identificado en el contexto');
    return userId;
  }

  private assertMethod(method: PaymentMethod): void {
    if (!PAYMENT_METHODS.includes(method))
      throw new BadRequestException(`método de pago inválido: ${method}`);
  }

  private toRow(r: any): PaymentRow {
    return {
      id: r.id,
      order_id: r.order_id,
      customer_id: r.customer_id,
      amount: Number(r.amount),
      payment_method: r.payment_method,
      status: r.status,
      reference: r.reference ?? null,
      cash_received: r.cash_received != null ? Number(r.cash_received) : null,
      change_given: r.change_given != null ? Number(r.change_given) : null,
      proof_url: r.proof_url ?? null,
      received_by: r.received_by,
      received_at: r.received_at,
      notes: r.notes ?? null,
    };
  }

  /**
   * Inserta un pago dentro de una transacción existente y actualiza los totales
   * del pedido. Reutilizable desde recordPayment (standalone) y deliverAndCollect.
   */
  private async insertPayment(trx: any, dto: RecordPaymentDto): Promise<PaymentRow> {
    if (!UUID_RE.test(dto.order_id)) throw new BadRequestException('order_id inválido');
    this.assertMethod(dto.method);
    const amount = Number(dto.amount);
    if (!(amount > 0)) throw new BadRequestException('amount debe ser > 0');

    // Lock del pedido: evita doble-cobro concurrente (repartidor + reintento offline).
    const order = await trx('commercial.orders').where({ id: dto.order_id }).forUpdate().first();
    if (!order) throw new NotFoundException(`Order ${dto.order_id} no encontrada`);

    // Idempotencia: mismo (order_id, reference) no reversado → devuelve el existente.
    if (dto.reference) {
      const existing = await trx('commercial.payments')
        .where({ order_id: dto.order_id, reference: dto.reference })
        .whereNot({ status: 'reversed' })
        .whereNull('deleted_at')
        .first();
      if (existing) return this.toRow(existing);
    }

    const balanceDue = Number(order.balance_due);
    if (balanceDue <= CENT)
      throw new ConflictException('El pedido ya está liquidado (balance_due = 0)');
    if (amount > balanceDue + CENT)
      throw new BadRequestException(
        `amount (${amount}) excede el saldo pendiente (${balanceDue})`,
      );

    // Cambio: solo cash con efectivo recibido. amount = lo aplicado a la venta.
    let changeGiven: number | null = null;
    if (dto.method === 'cash' && dto.cash_received != null) {
      const received = Number(dto.cash_received);
      if (received + CENT < amount)
        throw new BadRequestException('cash_received es menor al monto a cobrar');
      changeGiven = Math.round((received - amount) * 100) / 100;
    }

    const userId = this.requireUserId();
    const tenantId = this.tenantCtx.requireTenantId();

    const [payment] = await trx('commercial.payments')
      .insert({
        tenant_id: tenantId,
        order_id: dto.order_id,
        customer_id: order.customer_id,
        amount,
        payment_method: dto.method,
        status: 'received',
        reference: dto.reference ?? null,
        cash_received: dto.method === 'cash' ? (dto.cash_received ?? null) : null,
        change_given: changeGiven,
        proof_url: dto.proof_url ?? null,
        received_by: userId,
        notes: dto.notes ?? null,
        created_by: userId,
      })
      .returning('*');

    const newPaid = Math.round((Number(order.paid_amount) + amount) * 100) / 100;
    const newBalance = Math.round((Number(order.total) - newPaid) * 100) / 100;
    await trx('commercial.orders')
      .where({ id: dto.order_id })
      .update({
        paid_amount: newPaid,
        balance_due: newBalance,
        updated_at: trx.fn.now(),
        updated_by: userId,
      });

    return this.toRow(payment);
  }

  /** Registra un cobro standalone (no combinado con la entrega). */
  async recordPayment(dto: RecordPaymentDto): Promise<PaymentRow> {
    return this.tk.run((trx) => this.insertPayment(trx, dto));
  }

  /**
   * Entrega + cobro atómicos (repartidor en la parada). Fulfill (consume stock,
   * idempotente si no está confirmed) + registra el pago en la MISMA transacción.
   * Omitir `payment` si el pedido es prepago.
   */
  async deliverAndCollect(
    orderId: string,
    dto: DeliverAndCollectDto,
  ): Promise<{ order: any; payment: PaymentRow | null }> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('orderId inválido');
    if (dto.payment && dto.payment.order_id && dto.payment.order_id !== orderId)
      throw new BadRequestException('payment.order_id no coincide con la orden');

    return this.tk.run(async (trx) => {
      const order = await this.orders.fulfillInTransaction(trx, orderId);
      let payment: PaymentRow | null = null;
      if (dto.payment) {
        payment = await this.insertPayment(trx, { ...dto.payment, order_id: orderId });
      }
      return { order, payment };
    });
  }

  /**
   * Fase LM-K.3 — cobro COD ligado a un FOLIO de Kepler (sin commercial.orders).
   * No actualiza balance de ninguna orden; solo registra el efectivo/no-efectivo
   * cobrado por el repartidor → entra al arqueo (LM.5) vía received_by. Idempotente
   * por (kepler_folio, reference).
   */
  async recordKeplerPayment(dto: RecordKeplerPaymentDto): Promise<PaymentRow> {
    if (!dto?.kepler_folio) throw new BadRequestException('kepler_folio requerido');
    this.assertMethod(dto.method);
    const amount = Number(dto.amount);
    if (!(amount > 0)) throw new BadRequestException('amount debe ser > 0');

    return this.tk.run(async (trx) => {
      if (dto.reference) {
        const existing = await trx('commercial.payments')
          .where({ kepler_folio: dto.kepler_folio, reference: dto.reference })
          .whereNot({ status: 'reversed' })
          .whereNull('deleted_at')
          .first();
        if (existing) return this.toRow(existing);
      }

      let changeGiven: number | null = null;
      if (dto.method === 'cash' && dto.cash_received != null) {
        const received = Number(dto.cash_received);
        if (received + CENT < amount)
          throw new BadRequestException('cash_received es menor al monto a cobrar');
        changeGiven = Math.round((received - amount) * 100) / 100;
      }

      const userId = this.requireUserId();
      const tenantId = this.tenantCtx.requireTenantId();
      const [payment] = await trx('commercial.payments')
        .insert({
          tenant_id: tenantId,
          order_id: null,
          customer_id: null,
          amount,
          payment_method: dto.method,
          status: 'received',
          reference: dto.reference ?? null,
          cash_received: dto.method === 'cash' ? (dto.cash_received ?? null) : null,
          change_given: changeGiven,
          kepler_folio: dto.kepler_folio,
          kepler_serie: dto.kepler_serie ?? null,
          kepler_warehouse_code: dto.kepler_warehouse_code ?? null,
          received_by: userId,
          notes: dto.notes ?? null,
          created_by: userId,
        })
        .returning('*');
      return this.toRow(payment);
    });
  }

  /** El encargado verifica el comprobante de una transferencia/tarjeta. */
  async verifyTransfer(paymentId: string): Promise<PaymentRow> {
    if (!UUID_RE.test(paymentId)) throw new BadRequestException('paymentId inválido');
    return this.tk.run(async (trx) => {
      const p = await trx('commercial.payments').where({ id: paymentId }).forUpdate().first();
      if (!p) throw new NotFoundException(`Payment ${paymentId} no encontrado`);
      if (p.status === 'reversed')
        throw new ConflictException('El cobro está reversado; no se puede verificar');
      if (!['transfer', 'card'].includes(p.payment_method))
        throw new BadRequestException('Solo transferencia/tarjeta requieren verificación');
      const [updated] = await trx('commercial.payments')
        .where({ id: paymentId })
        .update({ status: 'verified', updated_at: trx.fn.now(), updated_by: this.requireUserId() })
        .returning('*');
      return this.toRow(updated);
    });
  }

  /** Reversa un cobro (error de captura). Devuelve el saldo al pedido. */
  async reversePayment(paymentId: string, reason?: string): Promise<PaymentRow> {
    if (!UUID_RE.test(paymentId)) throw new BadRequestException('paymentId inválido');
    return this.tk.run(async (trx) => {
      const p = await trx('commercial.payments').where({ id: paymentId }).forUpdate().first();
      if (!p) throw new NotFoundException(`Payment ${paymentId} no encontrado`);
      if (p.status === 'reversed') return this.toRow(p); // idempotente

      const order = await trx('commercial.orders').where({ id: p.order_id }).forUpdate().first();
      const userId = this.requireUserId();
      const [updated] = await trx('commercial.payments')
        .where({ id: paymentId })
        .update({
          status: 'reversed',
          notes: reason ? `${p.notes ? p.notes + ' | ' : ''}reversa: ${reason}` : p.notes,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');

      if (order) {
        const newPaid = Math.round((Number(order.paid_amount) - Number(p.amount)) * 100) / 100;
        const newBalance = Math.round((Number(order.total) - newPaid) * 100) / 100;
        await trx('commercial.orders')
          .where({ id: p.order_id })
          .update({
            paid_amount: newPaid < 0 ? 0 : newPaid,
            balance_due: newBalance,
            updated_at: trx.fn.now(),
            updated_by: userId,
          });
      }
      return this.toRow(updated);
    });
  }

  /**
   * Fase LM.7.1 — cobros por transferencia/tarjeta pendientes de verificación
   * (status='received'). El encargado los revisa contra el comprobante y verifica.
   */
  async listPendingVerification(): Promise<any[]> {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.payments')
        .where({ status: 'received' })
        .whereIn('payment_method', ['transfer', 'card'])
        .whereNull('deleted_at')
        .orderBy('received_at', 'desc')
        .limit(200);
      return rows.map((r: any) => ({
        ...this.toRow(r),
        order_id: r.order_id ?? null,
        kepler_folio: r.kepler_folio ?? null,
      }));
    });
  }

  /** Lista los cobros de un pedido (no borrados), más recientes primero. */
  async listByOrder(orderId: string): Promise<PaymentRow[]> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('orderId inválido');
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.payments')
        .where({ order_id: orderId })
        .whereNull('deleted_at')
        .orderBy('received_at', 'desc');
      return rows.map((r: any) => this.toRow(r));
    });
  }
}
